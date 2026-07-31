#!/usr/bin/env python3
"""Measure a QRDA document against the published Schematron, PARTITIONED by whose rule it is.

    python scripts/qrda-schematron-check.py <document.xml> [--sch <path>] [--json]

## Why this exists as a script and not a test

#360 measured QRDA Category I conformance by hand in a scratch directory. The numbers were right and
the reasoning was not reproducible, so the next person had to take them on trust — and one of them
(that `<addr>` has no nullFlavor escape) turned out to be **wrong**, which nobody could see without
re-doing the work. This makes the measurement a command.

It is NOT wired into CI: Schematron validation needs Python + lxml, which are not backend-ts
dependencies and must not become them (CLAUDE.md forbids new deps without approval). The structural
regressions it would catch are pinned by `src/fhir/qrda1-export.test.ts` instead, in TypeScript, with
each assertion citing the CONF number it stands for. This script is how those assertions get their
authority in the first place, and how you re-derive them when the IG version moves.

## The partition is the point

The CMS Schematron embeds the base HL7 conformance statements it inherits AND adds its own. The
prefix in each assert's text says which is which:

  CONF:1198-*  US Realm Header (C-CDA)          -> base HL7, our bar
  CONF:3343-*  QRDA Category I R1 STU           -> base HL7, our bar
  CONF:4509-*  QDM-based QRDA / QDM entries     -> base HL7, our bar
  CONF:1098-*, CONF:81-*, CONF:67-*, CONF:23-*  -> base HL7, our bar
  CONF:CMS-*, CONF:CMS_*                        -> CMS HOSPITAL Quality Reporting only, NOT our bar

CMS122 and CMS125 are Eligible Clinician measures. The CMS QRDA I IG is titled "for Hospital Quality
Reporting" and governs IQR/PI/OQR; ECs submit Category III. What binds an EC export is the HL7 base IG
at 45 CFR 170.205(h)(2) — referenced by §170.315(c)(1) "record and export" and (c)(2) "import and
calculate", and the IG Cypress validates Category I against. So a CONF:CMS-* failure is expected and
correct here: we deliberately do not claim the CMS document template. See ADR-050.

## Getting the Schematron

It is NOT vendored — 585 KB of third-party artifact that changes yearly, pinned by hash instead
(the ADR-036 pattern). Download "CMS QRDA I Implementation Guide, Schematron, and Sample Files" for
the reporting year from https://ecqi.healthit.gov/tool/cms-qrda-igs and point `--sch` at the `.sch`
inside. The expected SHA-256 for RY2026 v1.0 is pinned below; a mismatch WARNS rather than refuses,
because measuring against a newer IG is a legitimate thing to want to do — it just is not the same
measurement, and the output says so.
"""
import argparse
import hashlib
import json
import re
import sys
from collections import defaultdict

# 2026 CMS QRDA I v1.0 Support Files/Schematron/2026-CMS-QRDA-I-v1.0.sch
PINNED = {"1f4e1ff48e80fdd708f3291e212d143afcdd14d8fead9f5427359424dae0abc7": "2026 CMS QRDA I v1.0"}

CONF = re.compile(r"CONF:\s*([A-Za-z0-9_]+?)(?:[-_]\d+)?\s*\)")
SVRL = {"svrl": "http://purl.oclc.org/dsdl/svrl"}

# CMS-numbered asserts that are NOT CMS policy — they bind any conformant CDA, so a violation is a real
# defect at OUR bar even though the rule carries a CMS conformance number.
#
# This exists because the naive partition ("CONF:CMS-* is not our bar") reports a document with a broken
# datatype as ZERO base-HL7 errors and exits 0. Demonstrated on the real artifact: a lab result emitted
# as `<value xsi:type="PQ" value="not-a-number" nullFlavor="NI"/>` trips only a-CMS_0110 and would have
# been filed under "EXPECTED, not our bar" — and that headline number is quoted in three documents.
#
#   CMS_0105-0113  HL7 abstract datatype rules (BL, CS, CD/CE, II, INT, PQ, REAL, ST, TS):
#                  @value xor @nullFlavor, non-empty ST, and so on. Invalid CDA in any realm.
#   CMS_0115-0120  NPI and TIN validity (10 digits, all-digits, Luhn checksum, @extension xor
#                  @nullFlavor). A malformed national identifier is malformed under any programme.
#
# Deliberately NOT included: CMS_0121 ("a UTC offset should not be used anywhere in a QRDA Category I"),
# which directly CONTRADICTS base HL7's CONF:81-10130 ("if more precise than day, SHOULD include
# time-zone offset"). That one is genuinely CMS policy, and it is the clearest evidence that this
# partition is doing real work rather than bookkeeping.
GENERIC_CMS_RULES = re.compile(r"^a-CMS_(010[5-9]|011[0-3]|011[5-9]|0120)\b")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("document", help="the QRDA XML document to validate")
    ap.add_argument("--sch", default="2026-CMS-QRDA-I-v1.0.sch", help="path to the CMS QRDA Schematron")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    try:
        from lxml import etree
        from lxml.isoschematron import Schematron
    except ImportError:
        print("needs lxml:  pip install lxml", file=sys.stderr)
        return 2

    try:
        raw = open(args.sch, "rb").read()
    except OSError as e:
        print(f"cannot read Schematron: {e}\n\n{__doc__.split('## Getting the Schematron')[1]}", file=sys.stderr)
        return 2

    digest = hashlib.sha256(raw).hexdigest()
    if digest not in PINNED and not args.json:
        print(f"! Schematron sha256 {digest[:16]}… is not the pinned RY2026 artifact — results are", file=sys.stderr)
        print("! against a DIFFERENT IG version than the numbers in docs/STANDARDS_CONFORMANCE.md.\n", file=sys.stderr)

    if not args.json:
        print(f"compiling {args.sch} ({len(raw) // 1024} KB) …", flush=True)
    validator = Schematron(etree.fromstring(raw), store_report=True, store_xslt=False)
    validator.validate(etree.parse(args.document))

    buckets: dict[str, list[dict]] = defaultdict(list)
    unclassified: list[str] = []
    for failure in validator.validation_report.xpath("//svrl:failed-assert", namespaces=SVRL):
        text = " ".join("".join(failure.itertext()).split())
        aid = failure.get("id") or ""
        # EVERY conformance reference in the message, not just the first: an assert that cites both a CMS
        # number and a base one is constraining base CDA and belongs in the base bucket.
        refs = CONF.findall(text)
        non_cms = [r for r in refs if not r.startswith("CMS")]
        if non_cms:
            bucket = non_cms[0]
        elif GENERIC_CMS_RULES.match(aid):
            bucket = "generic-CDA"  # CMS-numbered, but binds any conformant CDA — see GENERIC_CMS_RULES
        elif refs or "CMS" in aid:
            bucket = "CMS"
        else:
            bucket = "?"
            unclassified.append(aid)

        # Severity from the SVRL role/flag when the artifact provides one; the id suffix is the fallback.
        # Guessing from the id alone means an IG revision that renames asserts silently downgrades every
        # error to a warning — so an id we cannot read is reported as an ERROR, not quietly demoted.
        role = (failure.get("role") or failure.get("flag") or "").lower()
        if role in ("error", "fatal", "warning", "info"):
            severity = "warning" if role in ("warning", "info") else "error"
        elif "-warning" in aid:
            severity = "warning"
        elif "-error" in aid:
            severity = "error"
        else:
            severity = "error"
            unclassified.append(f"{aid} (severity)")

        buckets[bucket].append({"id": aid, "severity": severity, "text": text, "location": failure.get("location", "")})

    base = [f for k, v in buckets.items() if k != "CMS" for f in v]
    cms = buckets.get("CMS", [])
    base_errors = [f for f in base if f["severity"] == "error"]

    if args.json:
        print(
            json.dumps(
                {"document": args.document, "schematron": digest, "base": base, "cms": cms, "unclassified": unclassified},
                indent=2,
            )
        )
        # Same contract as the human output. Returning 0 unconditionally here would make any check wired
        # to the machine-readable mode pass always — a green light that cannot go red.
        return 1 if base_errors else 0

    print(f"\n### {args.document}")
    print(f"    BASE HL7 (our bar):        {len(base_errors)} error(s), {len(base) - len(base_errors)} warning(s)")
    print(f"      of which generic-CDA:    {len(buckets.get('generic-CDA', []))} (CMS-numbered but binds any CDA)")
    print(f"    CMS Hospital-only:         {len(cms)} finding(s) — EXPECTED, not our bar")
    if unclassified:
        print(f"    ! UNCLASSIFIED:            {len(unclassified)} — counted as base errors: {unclassified[:5]}")
    print()
    for label, group in (("BASE HL7 — ERRORS", base_errors), ("BASE HL7 — warnings", [f for f in base if f["severity"] == "warning"]), ("CMS hospital-only (informational)", cms)):
        if not group:
            continue
        print(f"--- {label}")
        for f in group:
            print(f"    [{f['id']}] {f['text'][:150]}")
        print()
    # Exit non-zero only on a BASE error: a CMS-only finding is the documented, intended state.
    return 1 if base_errors else 0


if __name__ == "__main__":
    sys.exit(main())
