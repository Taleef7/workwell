# Cypress CVU+ validation run — first captured results (M-B, issue #379)

Date: 2026-08-02. Supersedes nothing; it completes `CVU_FIRST_RUN_2026-08-01.md`, which stopped before
any document reached CVU+.

**This is the first CVU+ validation result this project has ever recorded.** Every number below is a
captured HTTP response from a locally running Cypress v7.5.1, not a derivation.

## 1. What ran

| Component | Value |
|---|---|
| Cypress application image | `workwell/cypress-round1:v7.5.1` |
| Image digest | `sha256:df920e01133ae2f2b22d70dc1e3694d5127257fcf1dc3b486f1194adf40906ac` |
| Cypress source commit | `d3459f0e82290d87b8e6405a2e00f0e52b001e3e` (tag `v7.5.1`) |
| Docker server | 29.4.1 |
| Supporting services | `mongo:8.0.9`, `mitrehealthdocker/cqm-execution-service:latest` (unpinned — a standing reproducibility limitation) |
| Endpoint | `http://127.0.0.1:3000`, local-only bind |

The image digest was compared against the digest recorded in `scripts/cvu/README.md` and **matched
exactly**, so this is the measured round-1 build, not a rebuild assumed equivalent.

## 2. Two blockers cleared, and only one of them was real

`CVU_FIRST_RUN_2026-08-01.md` recorded the run as blocked on (a) absent official terminology sidecars
and (b) Docker being unavailable.

**(a) was not a real blocker.** That pass executed inside a git worktree
(`.claude/worktrees/agent-a9e4176cabdd0fa10`). `terminology.json` is gitignored by design (ADR-036,
NLM-licensed content), and a gitignored file does not exist in a fresh worktree. The sidecars were
present in the primary working tree the whole time. Nothing needed regenerating and no VSAC credential
was used. The evidence doc's §5 instruction — "first make the pinned official terminology sidecars
available through the repository's approved official-vendoring process" — would have worked, but by
re-fetching content that was already on disk one directory up.

**(b) was real** and was cleared by starting Docker Desktop. The round-1 compose stack carried a restart
policy and came back on its own.

### A caution this produced

The worktree that ran the blocked pass still holds an **uncommitted, uncredentialed re-vendor** of five
official manifests — `cms122`, `cms125`, `cms130`, `cms138`, `cms165`. For cms122 it moves
`AdvancedIllness` from 2000 codes back to 1000, restores a `truncated` entry and deletes the `completion`
block, i.e. it undoes ADR-041. Committing that would make cms122/cms125 unroutable and would fail the
deploy-blocking reproducibility gate. It was left untouched. The primary working tree is clean and its
manifests are intact (cms122: 3748 codes, `truncated: []`, completion present), which is what this run
executed against.

## 3. A defect in the fixture generator, found by running it

With the sidecars in scope, the generator still produced **0 documents and 12 failures**, every one:

```text
invalid ISO date for QRDA effectiveTime: 2024-06-01T23:59:59.999ZT23:59:59.999Z
```

`officialMeasurementPeriod` returns an **asymmetric** pair, deliberately: `start` is date-only, while
`end` has already been through `normalizePeriodEnd` — the fqm-execution#371 workaround that pushes a
date-only period end to end-of-day so the last day of the period is not silently dropped.
`generate-qrda-fixtures.ts` treated both halves as date-only and appended a time suffix to each, so
`start` was correct by luck and `end` was doubled.

Fixed by guarding on the date-only shape, exactly as `normalizePeriodEnd` guards itself. `literal-diff.ts`
— the only other caller — passes the pair straight to `calculateOfficial`, which re-normalizes
idempotently, so it was never affected.

Result: **12 documents, 0 failures** — 10 QRDA Category I (5 corpus targets × CMS122/CMS125) and 2 QRDA
Category III. All 12 parse to a `ClinicalDocument` root with no nesting or escaping finding. All 10
subjects are in the official initial population, consistent with `PR9C_FLIP_SNAPSHOT_2026-07-30.md`.

## 4. Submission method

Sign-up at `POST /users` (Devise; the development settings auto-approve and auto-confirm), then multipart
`file` upload to `POST /qrda_validation/:year/:qrda_type/:organization`. Credentials are synthetic and
were kept outside the repository.

**Correction to the runbook — and to this document's own first draft.** `QrdaUploadsController` declares
`respond_to :xml, :json` and ships no HTML template, so a request that negotiates neither fails. The
first draft of this section, and the runbook edit made alongside it, said "the bare path returns HTTP
500" and "the explicit format suffix is required". **Both overgeneralized from a single measurement.**
Codex's review of this PR pointed at the inconsistency; measuring all four combinations showed the defect
was in the prose, not in the runbook's commands, which already sent `Accept: application/json`:

| Request | `Accept: */*` (curl default) | `Accept: application/json` | `.json` suffix |
|---|---|---|---|
| `GET /qrda_validation` | **500** `ActionView::MissingTemplate` | 200 | 200 |
| `POST /qrda_validation/2026/qrdaI/hl7` | **422** | 201 | 201 |

So it is **content negotiation, not the path**. Either the header or the suffix works; neither is
required if the other is present. The 500 is worth recording anyway because it reads like a broken
stand-up rather than a wrong Accept type, which is how a bare `curl` will present it.

Cypress v7.5.1 offers validators for 2023–2027. Per ADR-050 the correct ruler for the EC measures we
route is the **HL7 base IG**, not the CMS Hospital IG, so `hl7` is the primary target; every QRDA-I was
also submitted to the `cms` validator to quantify the difference.

## 5. Results

Every one of the 22 submissions returned **HTTP 201**. No submission was rejected or errored.

| Document | Ruler | Total | CDA schema (XSD) | Cat III Schematron | CMS Hospital Schematron |
|---|---|---|---|---|---|
| cms122-compliant-qrda1 | hl7 | 8 | 8 | 0 | 0 |
| cms122-compliant-qrda1 | cms | 12 | 8 | 0 | 4 |
| cms122-due_soon-qrda1 | hl7 | 8 | 8 | 0 | 0 |
| cms122-due_soon-qrda1 | cms | 12 | 8 | 0 | 4 |
| cms122-overdue-qrda1 | hl7 | 8 | 8 | 0 | 0 |
| cms122-overdue-qrda1 | cms | 12 | 8 | 0 | 4 |
| cms122-missing_data-qrda1 | hl7 | 8 | 8 | 0 | 0 |
| cms122-missing_data-qrda1 | cms | 12 | 8 | 0 | 4 |
| cms122-excluded-qrda1 | hl7 | 10 | 10 | 0 | 0 |
| cms122-excluded-qrda1 | cms | 14 | 10 | 0 | 4 |
| cms125-compliant-qrda1 | hl7 | 8 | 8 | 0 | 0 |
| cms125-compliant-qrda1 | cms | 12 | 8 | 0 | 4 |
| cms125-due_soon-qrda1 | hl7 | 6 | 6 | 0 | 0 |
| cms125-due_soon-qrda1 | cms | 10 | 6 | 0 | 4 |
| cms125-overdue-qrda1 | hl7 | 6 | 6 | 0 | 0 |
| cms125-overdue-qrda1 | cms | 10 | 6 | 0 | 4 |
| cms125-missing_data-qrda1 | hl7 | 6 | 6 | 0 | 0 |
| cms125-missing_data-qrda1 | cms | 10 | 6 | 0 | 4 |
| cms125-excluded-qrda1 | hl7 | 8 | 8 | 0 | 0 |
| cms125-excluded-qrda1 | cms | 12 | 8 | 0 | 4 |
| cms122-qrda3 | hl7 | 24 | 1 | 23 | 0 |
| cms125-qrda3 | hl7 | 24 | 1 | 23 | 0 |
| **Totals** | | **240** | **154** | **46** | **40** |

### 5.1 The headline: ADR-050's claim holds, and was narrower than it reads

ADR-050 recorded QRDA Category I as measuring **0 base-HL7 errors**. CVU+ **confirms that exactly**:
across all 10 Category I documents, against the HL7 base ruler, the base-HL7 **Schematron** produced
zero findings.

**That zero is not vacuous, and it was worth proving rather than assuming** — a validator that never ran
reports zero exactly like one that ran clean, which is the whole complaint this section goes on to make
about our own tooling. `Validators::QrdaUploadValidator` composes `[CDA.instance, qrda_validator]`, and
its `qrda_1_validator` returns `Cat1R53.instance` for `organization == 'hl7'` when `bundle_year > 2021` —
but only past a `return unless supported_bundle_versions.include? bundle_year.to_s` guard, which would
otherwise leave the Schematron slot `nil`. The CMS ruler reached
`CMSQRDA1HQRSchematronValidator` through **that same guard at the same `bundle_year` (2025)** and produced
40 findings, so the guard demonstrably passed. Therefore `Cat1R53` was constructed and executed on all 10
documents and returned nothing.

But CVU+ runs a layer our own tooling never did. `backend-ts/scripts/qrda-schematron-check.py` is, by its
own first line, a measurement "against the published **Schematron**". It does not validate against the
CDA **XSD schema**. CVU+ runs `CqmValidators::CDA` first — and every Category I document fails it 6 to 10
times.

So "0 base-HL7 errors" was a true statement about Schematron that reads as a statement about
conformance. This is the vacuous-guard family again: not a check that could not fire, but a check whose
scope was narrower than the claim it was cited for. The gap was invisible because the only instrument
pointed at the document had no XSD in it.

### 5.2 QRDA Category I — CDA schema findings (verbatim, HL7 ruler)

Six distinct classes, all `CqmValidators::CDA`:

```text
16:0: ERROR: Element '{urn:hl7-org:v3}id', attribute 'root': 'urn:workwell:employee' is not a valid
  value of the union type '{urn:hl7-org:v3}uid'.
43:0: ERROR: Element '{urn:hl7-org:v3}id', attribute 'root': 'urn:workwell:device' is not a valid
  value of the union type '{urn:hl7-org:v3}uid'.
61:0: ERROR: Element '{urn:hl7-org:v3}id', attribute 'root': 'urn:workwell:custodian' is not a valid
  value of the union type '{urn:hl7-org:v3}uid'.
112:0: ERROR: Element '{urn:hl7-org:v3}versionNumber', attribute 'value': '1.0.000' is not a valid
  value of the atomic type '{urn:hl7-org:v3}int'.
113:0: ERROR: Element '{urn:hl7-org:v3}text': This element is not expected.
131:0: ERROR: Element '{urn:hl7-org:v3}id', attribute 'root': 'urn:workwell:fhir' is not a valid
  value of the union type '{urn:hl7-org:v3}uid'.
```

Three underlying defects:

1. **`@root` carries a URN.** CDA `II.root` is typed `uid` — an ISO OID or a UUID. `urn:workwell:employee`,
   `urn:workwell:device`, `urn:workwell:custodian` and `urn:workwell:fhir` are none of those. The
   `urn:workwell:fhir` class accounts for 26 of the 76 HL7-ruler findings because it is emitted once per
   referenced clinical resource, so its count varies by document — which is the whole reason the
   `excluded` fixtures score 10 and the sparser cms125 fixtures score 6.
2. **`versionNumber value="1.0.000"`.** CDA `versionNumber` is `INT`. `1.0.000` is the eCQM *version
   string*, correct as identity and wrong as a type. Emitted at
   `qrda1-export.ts` inside `externalDocument`.
3. **`<text>cms122</text>` inside `<externalDocument>`.** Not permitted at that position.

These are defects in WorkWell's export, not in the corpus and not in official execution. Nothing here
touches the evaluated outcome — the population results were correct in every document.

### 5.3 QRDA Category I — the CMS ruler costs exactly +4, as predicted

Every Category I document scores exactly **4 more** against `cms` than against `hl7`, all four from
`Validators::CMSQRDA1HQRSchematronValidator` and all four the CMS Hospital Quality Reporting templateIds
ADR-050 decided not to claim:

```text
This document SHALL contain exactly one QRDA Category I Report - CMS templateId
  (@root='2.16.840.1.113883.10.20.24.1.3') with appropriate @extension (version) of the form 'yyyy-mm-dd'.
SHALL contain exactly one [1..1] templateId (CONF:CMS_0036) such that it SHALL contain exactly one [1..1]
  @root="2.16.840.1.113883.10.20.24.2.1.1" (CONF:CMS_0037) ... @extension="2022-02-01" (CONF:CMS_0038).
SHALL contain exactly one [1..1] templateId (CONF:CMS_0040) ... @root="2.16.840.1.113883.10.20.17.2.1.1"
SHALL contain exactly one [1..1] templateId (CONF:CMS_0044) ... @root="2.16.840.1.113883.10.20.17.3.8.1"
```

This is an **independent external confirmation of ADR-050's partition.** The ADR predicted "+4
CMS-hospital-only, expected" from a Schematron script we wrote ourselves; CVU+, which has no knowledge of
that partition, reproduces the number exactly on all ten documents. The delta is deliberate: ADR-050
stopped claiming `…24.1.3` precisely because it is the CMS Hospital document template.

### 5.4 QRDA Category III — the stub is measured for the first time

Both Category III documents score **24** (1 XSD + 23 Cat III Schematron). ADR-009 called QRDA III "a
structurally-representative stub"; this is the first external measurement of how far that is from
conformant. Distinct classes:

```text
CqmValidators::CDA — Element '{urn:hl7-org:v3}component': This element is not expected.
  Expected is one of ( setId, versionNumber, copyTime, recordTarget ).
Cat3R1 — SHALL contain exactly one [1..1] recordTarget (CONF:4484-17212).
Cat3R1 — SHALL contain exactly one [1..1] custodian (CONF:4484-17213).
Cat3R1 — SHALL contain at least one [1..*] author (CONF:4484-18156) such that it SHALL contain exactly
  one [1..1] time (CONF:4484-18158). SHALL contain exactly one [1..1] assignedAuthor (CONF:4484-18157).
Cat3R1 — SHALL contain exactly one [1..1] methodCode (CONF:77-19509).                        [8x]
Cat3R1 — This code SHALL contain exactly one [1..1] @code="MSRAGG" rate aggregation (CONF:77-19508). [8x]
Cat3R1 — SHALL contain exactly one [1..1] value with @xsi:type="INT" (CONF:77-17567).        [8x]
Cat3R1 — This code SHALL contain exactly one [1..1] @code="ASSERTION" Assertion (CONF:77-17578).
Cat3R1 — SHALL contain exactly one [1..1] statusCode (CONF:77-17579).
Cat3R1 — SHALL contain exactly one [1..1] reference (CONF:77-18204).
Cat3R1 — SHALL contain exactly one [1..1] entryRelationship (CONF:77-17581) such that it SHALL contain
  exactly one [1..1] @typeCode="SUBJ" ... @inversionInd="true" ... Aggregate Count
  (identifier: urn:oid:2.16.840.1.113883.10.20.27.3.3) (CONF:77-17584).
Cat3R1 — templateId (CONF:4484-17208) @root="2.16.840.1.113883.10.20.27.1.1" @extension="2020-12-01"
Cat3R1 — templateId (CONF:4484-17284) @root="2.16.840.1.113883.10.20.27.2.1" @extension="2020-12-01"
Cat3R1 — templateId (CONF:4484-17908) @root="2.16.840.1.113883.10.20.27.3.1" @extension="2020-12-01"
Cat3R1 — templateId (CONF:3259-17912) @root="2.16.840.1.113883.10.20.27.3.5" @extension="2016-09-01"
```

Two things are worth separating:

- **Version drift.** Our documents carry `extension="2017-06-01"` on the Cat III templateIds; the 2026
  (R2.1) validator requires `2020-12-01`. That is a pin, not a design gap.
- **Genuinely absent structure.** No `recordTarget`, no `custodian`, no `author/time`, no `methodCode`,
  no `MSRAGG` aggregation code, no `ASSERTION`, no `statusCode`, no `reference`, no Aggregate Count
  entryRelationship, and measure counts not typed `INT`. The XSD ordering error is the same finding seen
  from the schema side: `component` appears where `recordTarget` was expected, because `recordTarget` is
  not there at all.

The `[8x]` classes recur four times per document because they bind each of the four population
components.

## 6. What this licenses, and what it does not

**Licensed.** Cypress CVU+ 7.5.1 accepted all 22 WorkWell documents as processable QRDA submissions
(HTTP 201, no parse rejections). ADR-050's base-HL7 Schematron result is externally confirmed at 0, and
its CMS/base partition is externally confirmed at exactly +4 on all 10 Category I documents.

**Not licensed.**

- **This is not conformance.** 154 CDA schema errors and 46 Cat III Schematron errors stand. No document
  passed clean against any ruler.
- **This is not the Calculation Check path.** It is the externally-supplied-document validation route
  only. Nothing here compares expected population results, and no CVU+ result in this run says anything
  about whether our *calculations* are right. Locked decision #2's bar — "import → evaluate → export →
  Cypress CVU+ green" — is **not met**; this run establishes the export leg's actual distance from green.
- **This says nothing about real patient data.** The corpus is the ADR-038 synthetic five-target set.
- `mitrehealthdocker/cqm-execution-service:latest` remains unpinned.
- Per issue #379, no claim in `README.md` or `docs/STANDARDS_CONFORMANCE.md` was changed on the strength
  of this run.

## 7. Reproducing

```powershell
# 1. Fixtures — from the PRIMARY working tree, not a worktree (gitignored sidecars).
corepack pnpm --dir backend-ts exec tsx ../scripts/cvu/generate-qrda-fixtures.ts

# 2. Cypress — per scripts/cvu/README.md. If the round-1 stack exists it restarts with Docker.
docker compose -f scripts/cvu/round1.compose.yml up -d
curl.exe --silent -o NUL -w '%{http_code}' http://127.0.0.1:3000/users/sign_in    # expect 200

# 3. User — POST /users with user[email], user[password], user[password_confirmation],
#    user[terms_and_conditions] and the form's authenticity_token. Keep credentials out of the repo.

# 4. Validators — ask for JSON explicitly, by suffix or Accept header. A bare curl (Accept: */*) 500s.
curl.exe --silent -b <jar> http://127.0.0.1:3000/qrda_validation.json

# 5. Submit.
curl.exe --silent -b <jar> -F "file=@cvu-workdir/documents/<doc>.xml" `
  http://127.0.0.1:3000/qrda_validation/2026/qrdaI/hl7.json
```

Raw per-document responses were written to `cvu-workdir/cvu-responses/` (gitignored scratch).

## 8. What this makes actionable

Ordered by cost-to-fix against value, for a separate decision — not started here:

1. **`@root` URNs → OIDs or UUIDs.** Four emit sites across two files: `urn:workwell:employee`,
   `urn:workwell:device` and `urn:workwell:custodian` in `qrda1-export.ts` (lines 170, 204, 216), and
   `urn:workwell:fhir` in `qdm-entries.ts:139` — the per-resource one, hence its count of 26. Removes 56
   of the 76 HL7-ruler Category I findings. **This is not a one-line change:** `qrda1-import.ts:100`
   reads `urn:workwell:fhir` back as "our own root", so ADR-051's round trip moves with it, and an OID
   would have to be one WorkWell can legitimately assert.
2. **`versionNumber`** — `qrda-common.ts:101` emits the eCQM version *string* into a CDA `INT`. Correct as
   identity, wrong as a type; it needs an integer with the version string carried where it belongs. That
   site is shared by both Category I and Category III. Removes 10.
3. **Drop `<text>` from `externalDocument`** (`qrda1-export.ts:323`). Removes 10. Together these three
   would take Category I to **0 findings against the HL7 base ruler**, XSD and Schematron alike — 76
   findings accounted for exactly.
4. **QRDA Category III** is a larger piece of work and its own decision: re-pin the templateIds to
   `2020-12-01`/`2016-09-01` and add the absent structure. ADR-009's "structurally-representative stub"
   is now quantified at 23 Schematron findings.
5. **Add XSD to `qrda-schematron-check.py`, or rename it.** Its output was cited for a conformance claim
   whose scope it never covered.
