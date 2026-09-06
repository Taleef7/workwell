/**
 * The contract that keeps the synthetic corpus answerable by the measure CMS actually publishes:
 * **every code the corpus stamps must be a member of the official artifact's own expansion of the value
 * set it is registered under.**
 *
 * This guards a bug that no measure test can catch, because it makes the measure tests pass.
 * `bundled-ecqm-expansions.ts` supplies both the code stamped on the synthetic resource AND the offline
 * expansion the authored CQL resolves — so a wrong code is wrong in both places at once, the authored
 * retrieve still matches, and every outcome is exactly as expected. Only an EXTERNAL authority
 * disagrees, and the artifact's own terminology (ADR-036) is that authority. When this first ran, 12 of
 * 24 codes failed.
 *
 * It lives in `wiring/` rather than beside the table it checks: the table is engine data, the artifacts
 * are app wiring, and `engine/` is the future `@work-well/measure-engine` package — a test inside it that
 * imported an artifact loader would not survive extraction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_CODE_VALUE_SETS,
  ECQM_CANONICAL_CODES,
  MAMMOGRAPHY_PROCEDURE_CODES,
  bundledEcqmValueSetResolver,
} from "../engine/cql/bundled-ecqm-expansions.ts";
import { loadOfficialArtifact } from "./official-artifacts.ts";
import { loadOfficialTerminology } from "./official-terminology.ts";

type CanonicalKey = keyof typeof CANONICAL_CODE_VALUE_SETS;
const canonical = (key: CanonicalKey) => ECQM_CANONICAL_CODES[key];

/** Union of both vendored artifacts' expansions: OID → member codes. */
function officialExpansions(): Map<string, ReadonlyArray<{ system: string; code: string }>> {
  const byOid = new Map<string, ReadonlyArray<{ system: string; code: string }>>();
  for (const catalogId of ["cms122", "cms125", "cms2", "cms130", "cms165"]) {
    const artifact = loadOfficialArtifact(catalogId);
    if (!artifact) continue;
    const loaded = loadOfficialTerminology(artifact);
    if (!loaded.ok) continue;
    for (const [oid, codes] of loaded.codesByOid) if (!byOid.has(oid)) byOid.set(oid, codes);
  }
  return byOid;
}

const expansions = officialExpansions();
const skip = expansions.size > 0 ? false : "run 'pnpm vendor:official' to fetch the terminology sidecars";

test("every canonical code is a member of the official value set it is registered under", { skip }, () => {
  const failures: string[] = [];
  for (const [key, oid] of Object.entries(CANONICAL_CODE_VALUE_SETS) as [CanonicalKey, string][]) {
    const ours = canonical(key);
    const official = expansions.get(oid);
    // A value set neither artifact references cannot be checked. Reported as a failure rather than
    // skipped, because "checked and fine" is exactly the false reading this file exists to prevent.
    if (!official) {
      failures.push(`${key}: ${oid} is referenced by neither vendored artifact, so it went unchecked`);
      continue;
    }
    if (official.some((c) => c.code === ours.code && c.system === ours.system)) continue;
    failures.push(
      `${key}: ${ours.code} (${ours.system}) is not in ${oid} — ${official.length} members, e.g. ` +
        official.slice(0, 3).map((c) => c.code).join(", "),
    );
  }
  assert.deepEqual(failures, []);
});

test("no two canonical codes are registered under the same value set", () => {
  // One constant serving two value sets is how the old table went wrong: SNOMED 385763009 was written
  // for both "Hospice Encounter" and "Hospice Care Ambulatory", is a member of only the second, and so
  // read as correct from whichever side you checked.
  const byOid = new Map<string, string[]>();
  for (const [key, oid] of Object.entries(CANONICAL_CODE_VALUE_SETS)) {
    byOid.set(oid, [...(byOid.get(oid) ?? []), key]);
  }
  assert.deepEqual([...byOid].filter(([, keys]) => keys.length > 1), []);
});

test("the offline expansion serves the canonical code for every registered value set", async () => {
  // The membership test proves the TABLE is right; this proves the RESOLVER is built from it. Without
  // it the two could disagree, and the authored measures would resolve something unverified.
  for (const [key, oid] of Object.entries(CANONICAL_CODE_VALUE_SETS) as [CanonicalKey, string][]) {
    const ours = canonical(key);
    const expanded = await bundledEcqmValueSetResolver.expand(oid);
    assert.ok(
      expanded.some((c) => c.code === ours.code && c.system === ours.system),
      `${key}: offline expansion of ${oid} omits ${ours.code}`,
    );
  }
});

test("the mammography PROCEDURE codes stay outside the membership contract", { skip }, async () => {
  // CPT 77067 and HCPCS G0202 are what WebChart records and what the authored cms125 retrieves, and
  // neither is a member of VSAC's Mammography value set — that set is the Observation-flavoured LOINC
  // one, all 92 members. Pinning both halves keeps a future tidy-up from folding them into the canonical
  // table (where they would fail) or dropping them (silently breaking the authored path over real data).
  const oid = CANONICAL_CODE_VALUE_SETS.mammogram;
  // Not `!`. With only the cms122 sidecar fetched this test still runs (the skip needs BOTH absent),
  // and a non-null assertion would kill it with a TypeError instead of saying what is wrong.
  const official = expansions.get(oid);
  assert.ok(official, `${oid} is not in the fetched terminology — vendor cms125 before trusting this`);
  const offline = await bundledEcqmValueSetResolver.expand(oid);
  for (const procedureCode of MAMMOGRAPHY_PROCEDURE_CODES) {
    assert.ok(
      !official.some((c) => c.code === procedureCode.code),
      `${procedureCode.code} is now an official member — move it into ECQM_CANONICAL_CODES`,
    );
    assert.ok(
      offline.some((c) => c.code === procedureCode.code),
      `${procedureCode.code} dropped from the offline expansion — the authored cms125 retrieves it`,
    );
  }
});

/**
 * The same contract, applied to what the CORPUS ACTUALLY EMITS.
 *
 * The table check above proves each registered constant sits in its own value set. It cannot prove the
 * bundle builder USES those constants: a hand-typed code in `corpus-bundle.ts` passes the table check
 * untouched, and the resource it lands on is then silently invisible to the measure — the patient reads
 * as unscreened while the corpus believes it screened them.
 *
 * The assertion is deliberately "every emitted code IS one of the verified constants", not "every
 * emitted code is in some expansion". The weaker version does not work, and the difference is the exact
 * bug this project already shipped once: SNOMED 44441009 was registered as `colonoscopy` while actually
 * being *Flexible fiberoptic sigmoidoscopy*. It IS a member of a vendored expansion — the Flexible
 * Sigmoidoscopy one — so "in some expansion" passes it happily. Only "is a constant the table verified
 * against its OWN OID" catches it, and that composes: table test says each constant is in its correct
 * value set, this says the corpus stamps nothing else.
 */
test("the corpus stamps only codes the canonical table has verified — never a hand-typed one", async () => {
  const { corpusPatients } = await import("../engine/synthetic/corpus/corpus-patient.ts");
  const { bundleForPatient } = await import("../engine/synthetic/corpus/corpus-bundle.ts");
  const { DEFAULT_CORPUS_SEED } = await import("../engine/synthetic/corpus/corpus-parameters.ts");
  const { MAMMOGRAPHY_PROCEDURE_CPT } = await import("../engine/cql/bundled-ecqm-expansions.ts");

  // Every clinical code the corpus is allowed to stamp: the canonical table (each member verified
  // against its own OID by the test above), the mammography CPT (deliberately outside the value-set
  // contract, ADR-044), and the exception code the cms2 artifact retrieves by direct reference.
  const allowed = new Set<string>();
  for (const c of Object.values(ECQM_CANONICAL_CODES)) allowed.add(`${c.system}|${c.code}`);
  allowed.add(`${MAMMOGRAPHY_PROCEDURE_CPT.system}|${MAMMOGRAPHY_PROCEDURE_CPT.code}`);
  allowed.add("http://snomed.info/sct|720834000"); // declined depression screening (cms2 exception)

  // Systems that carry structure, not clinical meaning: FHIR/HL7 terminology for statuses, categories
  // and agent roles, and UCUM for units. Excluded by SYSTEM so a new status or unit cannot silently
  // become an offender — and so that a new CLINICAL system never gets excluded by accident.
  const NON_CLINICAL = /^(http:\/\/terminology\.hl7\.org|http:\/\/hl7\.org\/fhir|http:\/\/unitsofmeasure\.org)/;

  const offenders = new Set<string>();
  for (const patient of corpusPatients(DEFAULT_CORPUS_SEED, 500)) {
    for (const { resource } of bundleForPatient(patient, "2027-12-31").entry) {
      for (const coding of codingsOf(resource)) {
        if (NON_CLINICAL.test(coding.system)) continue;
        if (allowed.has(`${coding.system}|${coding.code}`)) continue;
        offenders.add(`${(resource as { resourceType: string }).resourceType} ${coding.system}|${coding.code}`);
      }
    }
  }
  assert.deepEqual(
    [...offenders].sort(),
    [],
    `codes the corpus stamps that are not verified canonical constants:\n${[...offenders].sort().join("\n")}`,
  );
});

/** Every `coding`-shaped `{system, code}` anywhere in a resource, however deeply nested. */
function codingsOf(resource: unknown): Array<{ system: string; code: string }> {
  const out: Array<{ system: string; code: string }> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.system === "string" && typeof record.code === "string") {
      out.push({ system: record.system, code: record.code });
    }
    Object.values(record).forEach(walk);
  };
  walk(resource);
  return out;
}
