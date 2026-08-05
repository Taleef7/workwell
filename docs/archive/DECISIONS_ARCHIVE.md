# Archived Architecture Decision Records

> **Moved out of `docs/DECISIONS.md` on 2026-08-05.** These are the records that no longer govern anything:
> those **superseded** by a later decision (7), and those that were really **findings** (7) — a diagnosis of
> a defect, written up in ADR form because that had become the habit — rather than decisions constraining
> future work.
>
> **The bar for being here is that nothing live cites the record as current behaviour.** Six records that
> failed that bar were moved back on review (#396): a record named by a test, a doc comment, an operator
> warning or a runbook is a *design record*, however diagnostic its prose reads.
>
> **Nothing here is deleted or edited.** Each body is verbatim. `docs/DECISIONS.md` keeps a dated one-line
> pointer for every one of them, so a cross-reference anywhere in the repo still resolves. Read these when
> you want to know *how* something was found or *why* an earlier approach was abandoned; do not act on them.
>
> The active record — decisions that still bind, and design records for built features — stays in
> `docs/DECISIONS.md`.

## Contents

- [ADR-056: A batch import and an import-driven finalize — the two routes the certification loop needed, and the guard that keeps finalize from being a "finish this run" button  ](#adr-056)
  _Historical finding._
- [ADR-055: What a QDM datatype becomes in FHIR is read off the artifact's own ELM retrieves — and the importer is now measured against a third party's answers  ](#adr-055)
  _Historical finding._
- [ADR-054: CMS130 and CMS165 onboard clean — the credentialed workflow's completion flag was already doing the capped-expansion work ADR-041 built it for  ](#adr-054)
  _Historical finding._
- [ADR-051: QRDA Category I import is a mapping into the unchanged engine — and it proved the export only works in real terminology  ](#adr-051)
  _Historical finding._
- [ADR-049: QRDA Category I exists, reports population membership only, and says so in the document  ](#adr-049)
  _Superseded._
- [ADR-048: The TRANSLATOR debt is paid; the CLI-surface debt is not, and the split is not a file move  ](#adr-048)
  _Historical finding._
- [ADR-039: The shadow diff is a shadow of the runtime, not a study of its own  ](#adr-039)
  _Historical finding._
- [ADR-038: The synthetic corpus is verified against the official artifact's own terminology  ](#adr-038)
  _Historical finding._
- [ADR-027: Production CMS122/CMS125 evaluate eCQI v14 faithful-subset CQL (not toy day-count rules); literal QICore remains diagnostic — 2026-07  ](#adr-027)
  _Superseded._
- [ADR-024: Official CMS122 fidelity via a faithful subset, not the literal QICore CQL — E14 PR-3 (#186)  ](#adr-024)
  _Superseded._
- [ADR-018: Standards fidelity is structural/definitional-first; official-CQL execution deferred — E14 (#186)  ](#adr-018)
  _Superseded._
- [ADR-014: CQL→SQL bridge (charter Q2) — recommendation recorded, decision DEFERRED to Doug  ](#adr-014)
  _Superseded._
- [ADR-009: Emit eCQM artifacts JVM-free; QRDA III as a structurally-representative stub  ](#adr-009)
  _Superseded._
- [ADR-001: Single Spring Boot deployable with modular package boundaries  ](#adr-001)
  _Superseded._

---


<a id="adr-056"></a>

## ADR-056: A batch import and an import-driven finalize — the two routes the certification loop needed, and the guard that keeps finalize from being a "finish this run" button

**Status:** Accepted (2026-08-03). **Extends ADR-051/ADR-055.**

**Context.** §170.315(c)(2) is "import and calculate", and the loop locked decision #2 names ends in a
QRDA Category III somebody can submit. Two steps of that were missing and #386 §11.1 named one of them:
`POST /api/runs/:id/evaluate` takes ONE document and one subject, and **no HTTP route called
`finalizeRun`**, so an imported run stayed RUNNING and `GET /api/runs/:id/qrda` refused it with a 409 —
correctly, since exporting a run that is still writing outcomes presents a partial roster as complete.

**Decision 1 — `POST /api/runs/:id/import` takes a BATCH, and resolves documents to people first.** Not a
flag on `/evaluate`: identity resolution is inherently cross-document, so a per-document import cannot do
it at any level of effort. Measured on Cypress's own archives, 68 documents describe 64 people and 153
describe 150 — a receiver that counts documents fails C2 on arithmetic before any measure logic runs.

**Decision 2a — three things about "identifier" and "deterministic" needed saying, all found by review
(#389) and all measured.** A `nullFlavor` id is **not** an identifier — two documents both saying "unknown"
are not the same person, and without that filter two people merged into one subject. The canonical Patient
is merged **field-wise**: absence is not disagreement, and taking one document's Patient whole dropped a
`us-core-sex` that only the other stated, which silently removes a person from official CMS125's initial
population (ADR-042) while reporting it as a `gender` conflict of `["", "female"]`. And the canonical pick
tiebreaks on CONTENT (document id, then patient id, then the document text) rather than input index: with
equal identifier sets — one sender, one patient, two records — the earlier tiebreak let `readdirSync` order
decide a 28-year birthdate difference across `AgeInYearsAt` bands, under a doc comment claiming order
independence. Two people who still resolve to the same subject id are disambiguated rather than conflated,
because `outcomes` has no unique key that would catch it.

**Decision 2 — grouping is DETERMINISTIC and identifier-only.** Documents merge when they share any
`<recordTarget>` identifier, transitively; a document sharing none is its own person, however alike its
demographics. That is ADR-022's rule one level down, and it was chosen on a measurement: adding a
name+birthdate pass for identifier-less documents changes **nothing** on any of the four Cypress archives,
because the patients shipped without a Medicare Beneficiary Identifier are never the ones duplicated. A
rule that buys no accuracy and can merge two different people is not worth having. Where a merged group's
documents DISAGREE on demographics the conflict is **reported, never resolved** — a `birthDate` conflict
moves a person between age bands in both routed measures, and review of the C2 harness reproduced exactly
that failure (a MATCH printed while a supplied birthdate was discarded).

**Decision 3 — import-drivenness is a property of the run's CONSTRUCTION, not an inference from its rows.**
A run may receive documents, and be finalized from outside, only if it was created with
`requestedScope.importDriven`. Finalizing a population run from outside would mark a partial roster
COMPLETED and make it exportable — the exact harm the export guard exists to prevent.

The first cut inferred it from the rows ("every outcome carries `qrda1Import`") and **review broke that end
to end** (#389): `scheduleAsyncRun` returns RUNNING immediately and finishes its fan-out in `ctx.waitUntil`,
so an ALL_PROGRAMS run spends a window RUNNING with **zero** outcomes, during which the row test is
vacuously true. One document imported into that window, `/finalize` → COMPLETED, a QRDA III exported —
from a run that then gained 2,100 more outcomes, mutating a terminal run under every read-model cache keyed
on `runId`. The flag cannot be retrofitted onto a run the pipeline owns, because the pipeline builds its
own `requestedScope` and no route edits one. **Both checks now run**: construction says the run was meant
for this, the row test says nothing else got in.

**Decision 3b — a subject the engine cannot evaluate is PERSISTED as `MISSING_DATA` + `evaluationError`,
exactly as the population pipeline does.** Collecting it in the response alone lost the subject the moment
the request ended — no row, no log, no audit — so an export counted the roster short with nothing anywhere
saying so; and it made the `PARTIAL_FAILURE` branch structurally dead, since every row `/finalize` could
see came from a SUCCESSFUL evaluate. One fix, both halves (review, #389). `/finalize` also writes a
`RUN_COMPLETED` audit event: a run state change with no ledger entry breaches the repo-wide hard rule, and
the pipeline has always audited its own.

**Decision 3 (original) — `POST /api/runs/:id/finalize` refuses any run that is not import-driven.** A population run
is advanced by the pipeline, which knows when its fan-out is done; finalizing one from outside would mark
a partial roster COMPLETED and make it exportable — the exact harm the export guard exists to prevent. The
test is stateless and fails closed: **every** outcome in the run must carry `qrda1Import` evidence, which
is true only of a run whose roster came from supplied documents. A run mixing imported and pipeline
outcomes is refused rather than guessed at, and a run larger than the import cap is refused as a
population run.

**Decision 4 — a cross-lineage measure identity is an ASSERTION the caller makes and the system records,
never a relaxation.** Cypress's CMS125v14 documents reference the QDM eMeasure UUID; our vendored artifact
is the FHIR/QI-Core one. They are the same measure and our system holds nothing that can prove it, so the
default stays refusal (evaluating a document as a measure it is not about is a mislabel that PERSISTS) and
`assertMeasureIdentifiers` lets a caller state the mapping explicitly. Every asserted identifier is
recorded in the outcome evidence, so a later reader sees a human's claim rather than a derivation.

**Consequences.** The loop runs end to end over a third party's archive and produces a Category III
carrying Cypress's exact expected counts. It is **not green**: Cypress extracted nothing from the
document, because the same lineage split appears on the way out (`Invalid HQMF ID Found`) and because we
emit no supplemental data at all. Both are now measured rather than assumed —
`docs/evidence/CVU_C2_SUBMISSION_2026-08-03.md`. The import cap (500 documents) bounds a request that
parses everything at once; Cypress's own archives are 66–153.

<a id="adr-055"></a>

## ADR-055: What a QDM datatype becomes in FHIR is read off the artifact's own ELM retrieves — and the importer is now measured against a third party's answers

**Status:** Accepted (2026-08-03). **Supersedes nothing; extends ADR-051.**

**Context.** ADR-051 shipped QRDA Category I import as "a mapping into the unchanged engine" and translated
the five QDM datatypes CMS122/CMS125 consume on their IPP → DENOM → NUMER path. #387 measured that
importer against Cypress's own generated patients — a third party's documents with a third party's
precalculated answers — and found it right about who is in the measure and wrong about who is excluded:
**IPP 64=64 and 150=150, DENOM identical, CMS125 NUMER 2=2, but DENEX 9 vs 32 and 19 vs 47**, with every
one of the 51 differing subjects failing in the same direction. Two causes, both in the importer and
neither in the measure logic: the exclusion paths (hospice, palliative care, long-term nursing home,
advanced illness, frailty) read datatypes we dropped, and `concept()` read only the primary `<code>` from
six mapped code systems, silently discarding any resource coded outside them.

**Decision 1 — the FHIR target of each QDM datatype is read off what the official artifacts' ELM
RETRIEVES, never off a QDM-to-QI-Core mapping table.** The ELM is what the executed measure will look
for; a plausible second-hand answer that retrieves nothing is indistinguishable from a patient with no
data, which is the ADR-043 hazard arriving through a new door. Measured across both artifacts:
Intervention Performed → `Procedure` (Hospice Care Ambulatory, Palliative Care Intervention),
Intervention Order → `ServiceRequest` (same value set, different type — so the pair cannot be collapsed),
Device Order → `DeviceRequest` (Frailty Device), Medication Active → `MedicationRequest` (Dementia
Medications), Symptom and Assessment Performed → `Observation` (Frailty Symptom). The libraries read
`authoredOn`, `performed`, `effective` and `value` — **and also `status` and `intent`**: every retrieve on
an exclusion path is wrapped in a `Status.is*` predicate, and the `Status` library reads `status` 22 times
and `intent` 6. A first draft of this ADR said the opposite and used it to justify the values chosen. The
values are all correct, but the reasoning was false and the margins are thin — `isMedicationActive` is an
`Equal` on `"active"`, so a plausible "just state the QDM shape" edit to `"completed"` silently kills the
dementia exclusion (review, #388). Each value is now pinned against the predicate it satisfies.

**Decision 2 — a `<translation>` is an ADDITIONAL coding, an unmappable primary code no longer discards
the resource, and every system URL is the one the ARTIFACTS use.** CDA's translation is "the same concept
in another vocabulary", which is exactly what a `CodeableConcept` with several `coding` entries means.
Measured: 4 of CMS125's 10 `Procedure, Performed` entries are coded in **ICD-10-PCS**, absent from the map
— so the whole Procedure vanished, taking a mastectomy exclusion with it, while the SNOMED code the
exclusion value set actually contains sat inside the element unread. The map is now a superset of the
export's (the export need only emit what our bundles carry; the import must read what a third party
wrote), and `concept()` returns undefined only when nothing at all resolved.

**And a near-miss URL is worse than an absent one** — which review of #388 found live in this very change.
`cql-execution` compares `system` by exact string equality, so an unmapped system drops the resource
*visibly* (`untranslatedTemplates` names it) while a wrong URL imports it and leaves it invisible to every
retrieve, with no diagnostic anywhere. HCPCS was mapped to `urn:oid:2.16.840.1.113883.6.285` against the
expansions' `http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets` — 103 codes including Annual
Wellness Visit `G0438` and Hospice Care Ambulatory `G0182` — and **the exact agreement recorded below did
not catch it**, because the initial population is `exists(...)` and those patients carry other qualifying
encounters. So every URL is read off the vendored expansions and pinned twice: as literals, and against
the expansions themselves in a sidecar-gated test that a future re-vendor would trip. Speculative mappings
are refused — an unvalidatable mapping is a landmine, an absent one is a visible gap.

**Decision 2b — a negated act is skipped, never imported as a positive fact.** `negationInd="true"` means
the act did not happen; importing it positively would manufacture a denominator exclusion out of a record
stating the opposite. Cypress's archives carry none, so this is latent and test-covered rather than
measured, and the diagnostic does not distinguish "negated" from other drops — a known limit.

**Decision 3 — three fields that decide a population and had no mapping at all.** `Encounter.hospitalization.dischargeDisposition` from `<sdtc:dischargeDispositionCode>` (an inpatient
stay ending in discharge to hospice is an exclusion in both measures — measured as the LAST remaining
cause of divergence, 9 subjects per measure); the Device Order's code from
`participant/participantRole/playingDevice/code`, because `<supply>` carries none and the only `<code>`
up the tree is the ActClass literal `SPLY`; and the Medication's drug from
`consumable/…/manufacturedMaterial/code`.

**Decision 4 — Symptom INVERTS code and value, Assessment does not.** `[Observation: "Frailty Symptom"]`
filters on `Observation.code`, and a QDM Symptom's own `<code>` says only "this entry is a symptom"
(LOINC 75325-1) while the `<value>` carries the symptom — the same inversion as Diagnosis. An Assessment
keeps both: its `<code>` is the instrument and its `<value>` the result. Getting either backwards leaves
a bundle that looks complete and retrieves nothing.

**Consequences.**

- **Measured: exact agreement with Cypress on all 214 patients** — 64/64 and 150/150 subjects agree on
  every population, IPP/DENOM/NUMER/DENEX identical, across TWO independently generated archives. That is
  the first external, known-answer validation of the chain from a third party's DOCUMENT through our
  import into the official executor.
- **The MADiE gate is untouched** (410/410): it hands the executor finished bundles and never reaches the
  importer. These are complementary oracles — MADiE grades the executor, Cypress grades everything in
  front of it.
- **Import stays asymmetric with export, deliberately.** `qdm-entries.ts` still emits five datatypes,
  because it can only export what our own evaluated bundles contain and those carry no frailty, hospice
  or palliative data. So the round trip cannot reach the new mappers; they are pinned instead by a
  fixture modelled on Cypress's own documents, mutation-checked one fix at a time.
- **`untranslatedTemplates` now names the DATATYPE**, not the last templateId in the entry — which was
  routinely a nested attribute template (Author dateTime, Rank) and blamed the wrong thing 31 times in
  one archive. And `Patient.birthDate` is truncated to a FHIR `date`; it changed no population, but it
  was invalid FHIR our own exporter would never emit.
- **What this does NOT establish.** Cypress's patients are synthetic and its expected results come from
  the QDM lineage of the same measures, so this is agreement between two implementations, not truth. It
  is still not a Cypress Calculation Check RESULT: `ExpectedResultsValidator` has never graded a document
  we produced, because no HTTP route finalizes an imported run (#387 §11.1). And only `PopulationSet_1`
  is compared — CMS125's two strata carry their own expected results, and the executor package does not
  surface fqm's stratifier results.

<a id="adr-054"></a>

## ADR-054: CMS130 and CMS165 onboard clean — the credentialed workflow's completion flag was already doing the capped-expansion work ADR-041 built it for

**Status:** Accepted (2026-07-31).

**Context.** ADR-041 built `--complete-terminology` to finish upstream-capped expansions, and ADR-053
extended it to source a value set that CMS138's bundle omitted entirely. CMS130 and CMS165 were the
first measures where that machinery already existed and only needed to be run: one credentialed
`vendor-official-measure.yml` dispatch each, with no new implementation.

**Measured before upload.**

| measure | value sets / codes | MADiE case directories | terminology |
|---|---:|---:|---|
| CMS130 | 31 / 3172 | 64 | `truncated: []`, `absent: []` |
| CMS165 | 33 / 5024 | 68 | `truncated: []`, `absent: []` |

Both arrived complete on the first dispatch, including their capped `AdvancedIllness`-class expansions.
Unlike CMS138, neither needed an absent-value-set supplement; unlike the original CMS122/CMS125 cap
discovery, there was nothing new to build.

**Decision.** Add CMS130 and CMS165 to `OFFICIAL_GATED_MEASURES` and the MADiE/deploy vendor lists, with
full `measure-bundle` provenance. Leave routing untouched. The [credentialed CI run](https://github.com/Taleef7/workwell/actions/runs/30718966633)
measured CMS130 at 64/64 and CMS165 at 68/68, with 0 unexpected mismatches and 0 errors for each, and
reproduced both manifests byte-for-byte against what shipped in this PR.


<a id="adr-051"></a>

## ADR-051: QRDA Category I import is a mapping into the unchanged engine — and it proved the export only works in real terminology

**Status:** Accepted (2026-07-31). Roadmap M-B. **Not CVU+-validated** — that bar is unmet and this ADR
does not claim it.

**Context.** ADR-050 established that a QRDA Category I carries patient DATA, not an answer, because the
receiver **recalculates**. §170.315**(c)(2)** is literally "import and calculate", and it is the half we
had not built: the roadmap's proof chain is *QRDA-I ingest → calculate → QRDA-I/III export → Cypress*.

**Decision.**

1. **Import is a MAPPING, not a second calculator.** `qrda1-import.ts` turns QDM entries back into the
   FHIR the engine already evaluates, and `POST /api/runs/:id/evaluate` accepts `{ measureId, qrda1 }`
   in place of `{ measureId, patientBundle }`. Everything downstream — engine, persistence, audit,
   idempotency — is the existing path, unchanged. A second calculator is the thing this criterion is
   supposed to detect, not something to build.
2. **The XML reader is hand-rolled** (`cda-parse.ts`, ~180 lines), matching the emitters' posture,
   because CLAUDE.md forbids new dependencies and Node ships no DOM parser. It is total on malformed
   input and decodes **only** the five predefined entities plus numeric refs — there is no entity table
   for an attacker to grow, so the billion-laughs class does not exist here. Element lookups match the
   **local name**, since CDA appears in the wild both as `<ClinicalDocument xmlns=…>` and
   `<cda:ClinicalDocument>`.
3. **A document we cannot read is a 400 with the reason — never a silent empty bundle.** An empty bundle
   evaluates out-of-population for every measure, which is indistinguishable from a genuinely ineligible
   patient: the exact hazard ADR-043 exists for.
4. **What could not be translated travels with the answer.** `untranslatedTemplates` names each QDM
   template the mapper does not know, in the evaluate response. Naming rather than counting is
   deliberate — an operator needs to know *which* datatype was dropped to judge the recalculation. The
   CMS RY2026 sample file alone carries **47** such entries against our five datatypes.

**The round trip found a defect in the EXPORT, which is what it was written to catch.** Driving the real
route — evaluate a bundle, export the document, feed the document back — produced a different answer for
`audiogram`. Cause: that measure's bundle binds **synthetic `urn:workwell:vs:*` value sets, which have no
CDA code system OID**, so every clinical resource was silently dropped and the export reported only "no
QDM patient data entries". True, and the misleading half of the truth.

So the translator now returns **why** each resource was dropped (`translateQdm`), and those reasons reach
the non-conformance list: *"not exported — Procedure: no CDA code system OID for urn:workwell:vs:audiogram
— CDA cannot carry it"*. The consequence is worth stating plainly and is not a bug to fix later:

> **A QRDA Category I is only a meaningful artifact for measures whose data is in real terminology** —
> LOINC, SNOMED, CPT, ICD. That means the official measures. WorkWell's authored measures cannot be
> exported as QRDA at all, and now say so instead of producing an empty document.

That also sharpens locked decision #4 (retiring the authored cms122/125 subsets): the authored catalogue
is not QRDA-representable, so it cannot participate in the certification rehearsal either way.

**Review found five more, three P1, and one exposed a test whose NAME lied.**

- **A present-but-empty Patient Data section was accepted.** The refusal checked for the section's
  *existence*, so our own no-bundle export — the document that declares itself non-conformant
  (CONF:67-14567) — imported to a Patient-only bundle and would have persisted a plausible
  out-of-population outcome. Worse, the test covering it was called `import REFUSES our own no-bundle
  export` and asserted that the hollow bundle **came back**. Now it refuses, with a message that
  distinguishes "there was nothing" from "we could translate none of it" — different operator responses.
- **The requested measure was not checked against the document.** A CMS125 document posted with
  `measureId: "cms122"` was calculated *and persisted* as cms122. The route now refuses unless the
  requested measure is one the document references (by WorkWell id or by published eMeasure UUID), and
  only when it references any at all, so a document with no measure section stays importable.
- **The import qualification died with the request.** `untranslatedTemplates` went only into the POST
  response, so every later read — outcomes, MeasureReport, QRDA — presented a partial calculation as an
  ordinary one. Now persisted in `evidence.qrda1Import`, additively, the way `official` is.
- **Timezone offsets were discarded.** `20251231230000-0500` became `2025-12-31T23:00:00Z` instead of
  `2026-01-01T04:00:00Z` — a different day *and year*, on exactly the half-open boundary a measurement
  period turns on. Base HL7 asks for the offset (CONF:81-10130) even though the CMS Hospital IG asks for
  its absence (CMS_0121), so a conformant document may well carry one.
- **An Observation interval collapsed to an instant**, dropping `<high>` — and a lab or study whose
  relevant period *overlaps* a measurement window is exactly the case temporal CQL predicates turn on.

**A second review pass found eight more, one of which made the whole feature wrong on the routed measure.**

1. **CRITICAL — the import wrote `Patient.gender` and no `us-core-sex` extension.** Official CMS125's
   initial population reads the EXTENSION, never `gender` (ADR-042, and `devdb-official-eval.test.ts`
   already pins that stripping it empties the whole roster from the IPP). Measured: source bundle
   COMPLIANT / in-IPP, round-tripped MISSING_DATA / out-of-IPP. On demo/production —
   where `WORKWELL_OFFICIAL_MEASURES="cms122,cms125"` is set — `(c)(2)` calculated **every imported
   subject out of population**, persisted it, and returned 201 with `untranslatedTemplates: []`. The
   round trip could not see it because it never runs the official engine, and the test that was meant to
   cover it asserted `patient.gender === "female"` **while citing ADR-042** — naming the right hazard and
   measuring the element ADR-042 established is the wrong one. `qrda1-import-official.test.ts` now
   asserts population membership itself, is mutation-checked, and is wired into the `official-cases` CI
   job (the workflow warns in a comment that a sidecar test not listed there is permanently skipped
   while reading as covered — which is exactly how this class recurs).
2. **HIGH — a legal `>` inside an attribute value corrupted the tree.** XML requires only `<` and `&` to
   be escaped in attributes, so `displayName="HbA1c > 9.0%"` is conformant; the element was truncated
   mid-attribute, lost its self-closing slash, and **swallowed its siblings**, silently deleting the date
   and value from an HbA1c of 9.6. The round trip provably cannot catch this — our own `esc()` escapes
   `>`, so we never emit the input that breaks us.
3. **HIGH — unmatched close tags were quadratic: a 1 MB body took 53 seconds** on this single-threaded
   host, stalling every other request past nginx's 60 s timeout. An accidental DoS from a truncated
   document, not only a malicious one. Close-tag matching is now an O(1) name→depth lookup, with a
   `MAX_ELEMENTS` bound. The module's claim that "there is no construct that can cause unbounded work"
   was simply false, and now describes what is true.
4. **HIGH — only ONE resource was imported per `<entry>`**, and the rest vanished *while the entry was
   reported fully translated*. A Result Organizer carrying two Laboratory Tests is a standard CDA
   construct, so an HbA1c that is the second component of a chemistry panel disappeared with
   `untranslatedTemplates: []` — breaking decision 4 above on its own terms.
5. **MEDIUM — `descendants()` recursed** and blew the stack at ~5 000 nesting levels (~30 KB), and
   `importQrda1Document` calls it on the root first. Explicit stack now, pushing children in reverse so
   document order is preserved — the measure-reference reader depends on it.
6. **MEDIUM — two drop reasons were wrong.** An Observation whose category is outside both sets was
   blamed on terminology even with a plain LOINC code, and an Encounter was *always* reported as having
   "an absent code" because the reason read `code` while the builder reads `type[0] ?? code`. A wrong
   reason is worse than none: it sends someone to the wrong place.
7. **MEDIUM — the reason list was unbounded and duplicated** (measured: 302 reasons, 3 unique, 31 KB per
   subject). Deduped and counted.
8. **MEDIUM — no date validation on the date-only path**, so `00000000` became `"0000-00-00"` in
   `Patient.birthDate`, which CMS125's IPP feeds to `AgeAt(...)`.

Also from that pass: `<setId>` (the version-independent eMeasure id) was never read, so a document naming
its measure only that way would have been refused by the new measure check; and `qrda1: null` — a common
client idiom for an absent optional — was treated as "a QRDA was supplied".

**Consequences.**

- The round trip proves our two halves agree; it does **not** prove our reading of the IG is right. The
  one external check here is the CMS RY2026 sample file, which imports cleanly (1 subject, 6 resources,
  both eMeasure UUIDs, 47 datatypes correctly named as untranslated). That test **self-skips** without
  `WORKWELL_QRDA1_SAMPLE`, and says so in its skip message rather than reading as covered — the sample
  ships in the same manually-downloaded CMS zip as the Schematron.
- **Cypress CVU+ still has not run.** It needs Docker and remains the M-B bar. Nothing here may be
  described as certified.
- Not translated, by scope rather than oversight: medications, assessments, adverse events, and every
  other QDM datatype outside CMS122/CMS125. They are named on import, so a receiver's gap is visible.

---

<a id="adr-049"></a>

## ADR-049: QRDA Category I exists, reports population membership only, and says so in the document

> **SUPERSEDED in its central claim by ADR-050 (2026-07-30, same day).** Decisions 1–2 below — that a
> QRDA I reports per-subject population membership, evidence-first, including the populations the subject
> is not in — are **wrong**: Category I has no place for population membership at all, and its Patient
> Data section SHALL carry the QDM entries a receiver recalculates from. Decision 3's conformance
> assessment was also measured against the CMS **Hospital** Schematron, which is not the bar for the
> Eligible Clinician measures we route. What survives: the sha-checked measure identity, the refusal to
> export a mid-run run, and the principle that the document states its own limits in prose (`nullFlavor`
> on a `<section>` is measurably inert). Read ADR-050 for the current design.

**Status:** Accepted (2026-07-30). Roadmap M-B, first step. **Not CVU+-validated** — that bar is unmet
and this ADR does not claim it.

**Context.** The roadmap's audit recorded "**QRDA-I does not exist anywhere**; QRDA-III is a stub". QRDA I
is the patient-level artifact — one CDA document per subject — and it is the half of the certification
rehearsal that carries what a receiving engine would recalculate from. Nothing produced one.

**Decision.**

1. **One document per subject, membership read EVIDENCE-first.** Population membership comes from
   `membershipFor`, so an official-routed outcome's populations are `evidence.official.populationResults`
   — the regulatory truth — and never the 5-bucket workflow status, which cannot express DENEXCEP and
   **inverts** for cms122. A status-derived QRDA I would report a poor-control patient as out of the
   numerator, which is the same defect ADR-031 fixed for MeasureReport.
2. **Every population is emitted, including the ones the subject is not in.** A receiver must be able to
   distinguish "not in the numerator" from "the numerator was not reported"; omitting false members
   collapses those into one document.
3. **The measure is referenced by its published eMeasure UUIDs when the outcome was scored officially** —
   version-specific under the eMeasure Identifier root, version-independent as `setId`, per ADR-046. A
   receiver resolves the measure's numerator orientation from that identity, so naming WorkWell's urn over
   CMS's populations would misdescribe the document. Authored outcomes keep the urn.
4. **The Patient Data section is EMPTY and says so in its own `<text>` — but `nullFlavor` was NOT the
   mechanism.** *(Corrected after review, #360, by running the official CMS 2026 QRDA Cat I Schematron.)*
   The first version put `nullFlavor="NI"` on the section believing that encoded "no information".
   **Measured: it buys exactly nothing.** Against the official CMS sample, stripping a section's children
   produces the same 5 errors with or without the attribute — QRDA section rule contexts carry no
   `[not(@nullFlavor)]` guard:

   | official sample variant | errors |
   |---|---:|
   | untouched | 0 |
   | `nullFlavor="NI"` added, children intact | 0 |
   | children stripped, no nullFlavor | 5 |
   | children stripped, **with** `nullFlavor="NI"` | **5 — identical** |

   The attribute is removed. What communicates the gap is the prose in `<text>`, which now says plainly
   that the document cannot be used to recalculate the measure and is not conformant. The intent of the
   original decision stands; the mechanism was wrong and is not worth preserving as folklore.

5. **This is NOT a conformant QRDA Category I document, and the gap is now measured rather than
   hedged.** *(Sharpened after review, #360.)* Running the official CMS 2026 Schematron — first
   reproducing CMS's own published expectation on their sample exactly, so the runner is trustworthy —
   establishes what is actually missing:
   - the **QRDA Category I Report** template root `…24.1.1` was absent entirely, and `…24.1.2`/`…24.1.3`
     carried wrong extensions. Fixed here to the RY2026 set (`2017-08-01`, `2021-08-01`, `2025-03-01`);
   - required header elements are still absent: `author`, `custodian` (whose id root
     `2.16.840.1.113883.4.336` carries the CCN), `legalAuthenticator`, and the CMS EHR Certification ID
     **device** `participant`;
   - `<addr>` is a hard-error `1..*` **with no nullFlavor escape**, so a document for a patient with no
     address *cannot* validate. That is a data-ingest prerequisite, not a formatting detail;
   - `administrativeGenderCode nullFlavor="NI"` is Schematron-clean but IG-wrong — the sanctioned values
     are `OTH`/`UNK`/`ASKU`. A sharper instance of this file's own theme: **Schematron-clean is not
     conformant.**

   The claim therefore stays at "well-formed, structurally recognisable", the level QRDA III has carried
   since ADR-009 — and now with a list of what would have to change, instead of a hedge.

6. **CDA primitives are shared, not duplicated** (`qrda-common.ts`). The two documents describe the same
   run and the certification loop compares them against each other, so a timestamp format or escaping
   rule drifting between them would surface as a validation difference nobody introduced deliberately.

7. **The measure reference is ONE shared implementation, sha-checked** *(added after review, #360)*.
   Both QRDA documents now call `qrdaMeasureReference`, which claims the published identity **only when
   the vendored artifact's `sha256` matches the `artifactSha256` the outcome was scored under** — the
   rule ADR-046 decision 3 already applied to MeasureReport's canonical and which this path had not
   carried over. A re-vendor between run and export would otherwise stamp an old outcome with the new
   published UUID. A missing artifact degrades to a version-qualified local id instead of crashing; the
   first version passed `{}` in place of a `null` artifact and read `.bundle` off it, turning the
   endpoint into a 500.
8. **A quality report may only be exported from a FINISHED run** *(added after review, #360; the same
   gap existed on the pre-existing Category III route)*. A configured-live or wide-scope run returns
   `RUNNING` while `finishManualRun` persists outcomes in the background, so exporting mid-run produced
   documents covering only the subjects written so far — every organizer marked `completed`, nothing in
   the envelope saying subjects were missing. `PARTIAL_FAILURE` **is** reportable (those runs finished,
   and failed subjects persist MISSING_DATA with an `evaluationError`); `RUNNING` and `FAILED` are not,
   and get a 409 naming the status.

**Consequences.**

- `GET /api/runs/:id/qrda1` returns a JSON envelope of per-subject documents, bounded by
  `MAX_INDIVIDUAL_REPORT_SUBJECTS` for the reason the individual MeasureReport bundle is: this path
  materializes per-subject rows, and a 120k `seed:scale` run would otherwise build 120k CDA documents in
  the worker. It **refuses** rather than truncating.
- **Well-formedness is tested, not assumed.** The document is hand-built XML, so balance is a property to
  check: a dependency-free tag-balance/escaping checker runs on every generated document (CLAUDE.md
  forbids adding an XML parser without approval). Mutation-checked — unbalancing a tag or dropping an
  escape fails three tests.
- **An open question that may reshape M-B, flagged rather than acted on.** Review reports that CMS
  QRDA **Category I is Hospital Quality Reporting only**, and that Eligible Clinicians / MIPS submit
  Category III — corroborated structurally by Cypress shipping `EH_CAT_I.sch` and `EP_CAT_III.sch` but no
  `EP_CAT_I.sch`. CMS122 and CMS125 are EC/MIPS measures. If that holds for the *submission* path it does
  not automatically hold for the *ONC certification* path (§170.315(c) requires QRDA I export, which is
  what the roadmap's chain is actually about) — so the two must be separated before anything is
  concluded. **Verify before acting**; it is a milestone-shaping fact, not a PR-shaping one, and nothing
  in this PR depends on the answer beyond the framing sentence above.
- **What is still missing for M-B**, stated so the milestone is not read as closed: the QDM patient-data
  entries (decision 4), QRDA **I import** entirely, and the CVU+ loop that would let any of this be
  called validated.

<a id="adr-048"></a>

## ADR-048: The TRANSLATOR debt is paid; the CLI-surface debt is not, and the split is not a file move

**Status:** Accepted (2026-07-30). Roadmap §7.4 PR-2 / M-C item C1 — the first of the two extraction
debts that roadmap names.

**Context.** The engine-boundary test has carried an allowlist entry since PR-1 saying, in its own words,
that `@cqframework/cql` "is a real runtime dep of this tree TODAY. PR-2 moves `cql-translator.ts` to the
app, which is what restores the two-dependency package story." That was the one thing standing between
`src/engine/` and the dependency manifest a publishable package would declare.

**Decision.**

1. **`cql-translator.ts` moves to `src/measure/`, with its `resources/` directory.** It is the ELM
   Explorer's live-compile path, reached from `routes/measures.ts` and `measure-authoring.ts` — an
   authoring feature, not an evaluation one. Four importers; `scripts/compile-measures.mjs` re-pointed at
   the moved resources.
2. **The allowlist entry is deleted and the self-test inverted.** It asserted the translator dep "must be
   permitted in cql-translator.ts"; it now asserts the dep must **not** be permitted anywhere in the
   engine tree. The eval core's declared dependencies are `cql-execution` and `cql-exec-fhir`, with
   `node:` built-ins confined to `*-cli.ts` entrypoints — which is a package manifest, not an aspiration.
3. **The physical extraction is NOT a wholesale move of `src/engine/`, and the measurement says why.**
   Counting what the rest of the app actually imports from the engine tree:

   | import | count | belongs to |
   |---|---:|---|
   | `synthetic/employee-catalog.ts` | 50 | the app — WorkWell's demo directory |
   | `cql/measure-registry.ts` | 32 | the engine |
   | `synthetic/measure-bindings.ts` | 25 | the app |
   | `ingress/webchart/live-directory.ts` | 20 | the app |
   | `synthetic/exam-config.ts` | 19 | the app |
   | `synthetic/fhir-bundle-builder.ts` | 17 | the app |
   | `cql/cql-execution-engine.ts` | 16 | the engine |

   **The largest single export of a wholesale `@workwell/measure-engine` would be a directory of 150
   fake employees.** Nobody installs a measure engine to get demo data. The roadmap already scopes the
   package to "`measure-engine` = cql-execution+cql-exec-fhir only", so `synthetic/` (5 files) and
   `ingress/` (15 files) are app concerns that happen to live under `engine/`.

4. **The split is tractable, with ONE named exception.** *(Corrected after review, #359 — the first
   version of this claimed `cql/` imports nothing from `synthetic/` or `ingress/`, which is false and was
   the claim the whole conclusion rested on.)* The eval core proper — `evaluate-measure.ts`,
   `measure-executor.ts` and `cql/` **minus the two `generate-sql` CLI files** — reaches nothing
   app-side. The exception is real and transitive:

   `cql/codegen/generate-sql-cli.ts` → `ingress/webchart/terminology.ts` → `synthetic/measure-bindings.ts`

   so a `git mv` of `cql/` wholesale would drag the demo employee catalog into the package.
   `ROADMAP_2026-07-24.md` §7.4 had already recorded exactly this edge and scoped its clean-core claim to
   a 9-file closure; ADR-048's first draft widened a true narrow claim into a false broad one. The remedy
   is the same call the roadmap already made for `resolveDataSource`: `generate-sql-cli.ts` is app
   composition and stays behind.

5. **Two engine TESTS now import the app, and that is this PR's own doing — so they moved.** The boundary
   test deliberately exempts test files ("the rule protects what would ship"), which is exactly the blind
   spot that let it happen: relocating `cql-translator.ts` turned two sibling imports in
   `cql/codegen/*.test.ts` into `../../../measure/` imports, so the engine's YAML→CQL→ELM→evaluate parity
   gate depended on an app module. Step 2 would then have had to either strand those tests or give the
   package a devDependency pointing back at the app. Both now live in `src/measure/` beside the
   translator they exercise — they are integration tests between engine codegen and the app's compiler,
   and the side that owns the compiler is the honest home.

**Consequences.**

- **The two-dependency package story is true today**, and enforced rather than promised.
- **Step 2 is a boundary redesign with a published API at stake**, not a mechanical move — which is why it
  is not bundled here. It has to decide what `@workwell/measure-engine` exports, and that decision is
  hard to reverse once published. The measurement above is the input to it.
- **No behaviour changes.** The translator is the same module reached by the same callers.
- `src/engine/` holds **42 production files**: `cql/` 14, `ingress/` 15, `synthetic/` 5, `immunization/` 4,
  plus `evaluate-measure.ts`, `measure-executor.ts` and two `cli/` entrypoints. (An earlier draft said
  "14 + 24" and omitted four files, two of which are the most eval-core in the tree.) The boundary test
  still guards the whole tree.
- **The `node:` allowlist entry SURVIVES, and calling it a manifest rather than a debt was wrong.**
  `ROADMAP_2026-07-24.md` §7.4 names two debts and says PR-2 must drop both. This PR drops one. The
  roadmap is right that the second is not a `git mv`: `generate-sql-cli.ts` exports `WCDB_SQL_MEASURES`
  to two test modules and `devdb-cli.ts` exports `DEVDB_WHITELIST`/`DEVDB_EXCLUDED` to five, including
  **production** `live-cli.ts`. They are not pure entrypoints, so extracting them is a real refactor.
- **A new build-time edge, recorded rather than smoothed over.** `src/measure/resources/` now supplies the
  model-info and `FHIRHelpers` that `compile-measures.mjs` uses to generate the ENGINE's committed ELM. It
  is harmless today because the ELM is committed and the package would ship prebuilt — but if
  `packages/measure-engine` should be regenerable standalone, `resources/` belongs beside `scripts/`
  rather than under `src/measure/`. Step 2's call.





<a id="adr-039"></a>

## ADR-039: The shadow diff is a shadow of the runtime, not a study of its own

**Status:** Accepted (2026-07-27). Roadmap §7.4, PR-8d. Nothing routes officially yet.

**Context.** `standards/literal-diff.ts` exists to answer one question before PR-9 flips a measure: what
will the flip do? It can only answer that if it evaluates what the runtime would evaluate. Auditing it
against `wiring/official-executor-adapter.ts` — the thing it is supposed to forecast — found three
divergences and one latent inversion:

| | the diff did | the runtime does |
|---|---|---|
| measurement period | the CALENDAR YEAR (`2026-01-01 … 2026-12-31`) | the registry's rolling window (`asOf − periodMonths … asOf`) |
| the bundle | harness-ENRICHED — VSAC codings appended plus deliberate age-out / missing-visit / hospice / GMI injection | the plain synthetic bundle |
| preparation | `prepareForQiCore` **in place**, then WorkWell evaluated on the mutated bundle | `preparedForQiCore` on a **copy**, WorkWell sees the original |

For an as-of of 2026-07-27 the two periods share barely half their days, so any difference they produced
would have been read as a *logic* divergence. And the enrichment manufactured divergence on purpose —
correct when the corpus could not reach the official populations at all, actively misleading once PR-8c
fixed that (ADR-038): a shadow period that invents divergence forecasts divergence that will not happen.

Separately, `officialOutcome` hardcoded `numerator ? OVERDUE : COMPLIANT`. That is **cms122's inverse
reading** — its numerator is poor glycemic control. cms125's numerator is a completed mammogram, so the
same code would have reported every screened woman OVERDUE and every unscreened one COMPLIANT. Latent
only because the route gated the literal tier on `diffId === "cms122"`, which is also why the roadmap's
"shadow period cms122/125" was not actually possible: cms125 silently answered with the estimate.

**Decision.**

1. **Same period, same bundle, same preparation.** `officialMeasurementPeriod(measureId, evaluationDate)`
   is exported from the adapter and called by both. The enrichment is gone from the literal path. The
   diff prepares a copy and hands the authored engine the original, exactly as the runtime does.
2. **Numerator semantics come from `officialMeasureSemantics`**, the same fail-closed table the runtime
   consults — and a measure with no recorded semantics is now *unavailable* for the literal tier rather
   than silently mapped under another measure's reading.
3. **Any vendored measure, not cms122.** `literalDiffAvailable(measureId)` takes an argument; the route
   offers the literal tier to any measure with an artifact, semantics and terminology.
4. **The SUBSET tier stays cms122-only, guarded at both its exits.** It executes a hand-authored
   official-subset CQL that exists for cms122 alone. Only ONE exit was actually reachable for another
   measure — the literal-failure `catch`; the `mode === "subset"` branch is unreachable by construction,
   since `chooseDiffMode` returns "subset" only when the literal tier is unavailable, which the outer
   guard already excludes. Review corrected an earlier claim here that both were reachable. Both are
   guarded anyway: the reasoning spans two functions and an `if`, and the failure it prevents — cms122's
   criteria reported under cms125's name — is the exact wrongness this ladder exists to expose.
5. **`chooseDiffMode` no longer gates the literal tier on cms122's VSAC import.** Since ADR-036 the
   literal path reads the artifact's own sidecar and never touches `value_sets`, so the probe could not
   inform it — yet it declined a working literal diff on any stack that never ran `pnpm
   resolve-valuesets`, and (once the tier opened up) declined cms125 whenever cms122's hand-kept OIDs
   were missing. The probe remains what it was written to be: the SUBSET tier's gate.
6. **The fidelity LAB keeps its enrichment.** `execution-diff.ts` compares authored cms122 against a
   hand-authored subset; manufactured divergence is the point there. The distinction is what each is
   FOR — one forecasts a production change, the other studies a modelling gap.

**What review caught, because generalizing a cache is not free.**

- **The memo was keyed on `runId` alone**, which was safe only while the tier was cms122-only. An
  `ALL_PROGRAMS` run writes every measure's outcomes under ONE run id, so asking for cms122's diff and
  then cms125's returned the *identical object* — cms122's measureId, ecqmId, subjects and provenance,
  under cms125's URL. The same wrongness closed at the route, re-opened one layer down; the new
  cms125-test's `__clearLiteralDiffCache()` between calls was working around it rather than exposing it.
  Now keyed `measureId|runId`, in both diff tiers, with a regression test that does not clear.
- **`officialOutcome` was a second copy of the runtime's mapping, and they disagreed** on the branch
  that matters most: out of the initial population the diff said `OUT_OF_POPULATION` where the runtime
  and both authored measures say `MISSING_DATA`. A subject the two engines fully AGREE about was
  therefore counted as a divergence against the `initial-population` gate. Measured latent on today's
  corpus (0 out-of-population subjects across all 100 employees, both measures) and not latent for the
  six measures still to onboard, nor for live WebChart data. It now calls `outcomeFromPopulations` — the
  fourth and last thing this ADR aligns.

**Consequences.**

- **The ADR-008 guard got stronger.** With the diff feeding the authored engine the plain bundle, it can
  assert what it could not before: WorkWell's side of the diff equals a direct evaluation of the same
  subject. The previous best was self-consistency across two passes — true of any deterministic
  function, including a wrong one.
- **The cms122 diff's numbers will change**, and should: it now reports the divergence the flip will
  actually produce over the real corpus rather than over an enriched one. After ADR-038 that is close to
  none, which is the honest answer and the one PR-9 needs.
- **cms125 can enter the shadow period at all**, which the roadmap assumed it already could.
- Full suite **1517 pass / 0 fail / 14 skipped**; **1506 / 0 / 25** with the terminology sidecars removed;
  MADiE gate 55/55 + 66/66 with the vendored artifact and the evidence report byte-unchanged.

<a id="adr-038"></a>

## ADR-038: The synthetic corpus is verified against the official artifact's own terminology

**Status:** Accepted (2026-07-27). Roadmap §7.4, PR-8c. Nothing routes officially yet.

**Context.** ADR-037 closed with a finding: preparation alone left the official CMS122 scoring the
synthetic roster IPP=25 / DENOM=25 / **NUMER=0**, and since cms122's numerator is *poor glycemic
control*, the roster rendered as 100% compliant. That finding was recorded with an attribution —
"our bundles carry `urn:workwell:*` codes where the official numerator retrieves real LOINC" — which
auditing showed was **wrong, and comfortable**. The corpus already dual-stamped real codes; it had done
so since the 2026-07 production-faithful promotion. The measured causes were different, more specific,
and worse:

| # | Defect | Effect |
|---|---|---|
| 1 | **12 of 24 codes were not members of the value set they were registered under.** SNOMED 103735009 is in "Palliative Care Intervention" but not "Palliative Care Diagnosis"; 385763009 is in "Hospice Care Ambulatory" but not "Hospice Encounter"; CPT 77067 is not a member of the Mammography value set the official CMS125 numerator retrieves — all 92 of its members are LOINC. | official CMS122 scored the EXCLUDED cohort **COMPLIANT** — the DENEX never fired |
| 2 | **CMS125's initial population reads the `us-core-sex` extension, not `Patient.gender`.** | official CMS125 put the **entire roster** out-of-population |
| 3 | **CMS125's numerator retrieves `[Observation: "Mammography"]`.** The corpus emitted a Procedure, and all 92 members of that value set are LOINC. | no subject could ever reach the numerator |
| 4 | **Conditions carried no `onsetDateTime`.** `QICoreCommon.prevalenceInterval` is not merely conservative without one, it is inconsistent: CMS122's `prevalenceInterval Overlaps MP` returns true (unbounded overlaps everything) while CMS125's `Start(prevalenceInterval) SameOrBefore End(MP)` returns null. | mastectomy DENEX never fired |

Defect 1 is the one worth naming, because no measure test could have caught it.
`bundled-ecqm-expansions.ts` supplies **both** the code stamped on the synthetic resource **and** the
offline expansion the authored CQL resolves. A wrong code is therefore wrong in both places at once: the
authored retrieve still matches, every outcome is exactly as seeded, and the suite is green. The table
was internally consistent and externally wrong — a shape that only an external authority can detect, and
the artifact's own terminology (ADR-036) is that authority.

Measured over the five synthetic targets per measure, official artifact vs the outcome the corpus was
authored to produce:

| | before | after |
|---|---|---|
| cms122 | 4 of 5 | **5 of 5** |
| cms125 | 0 of 5 | **5 of 5** |

**Decision.**

1. **Every code the corpus stamps is a verified member of the official artifact's expansion of the value
   set it is registered under — enforced, not intended.** `CANONICAL_CODE_VALUE_SETS` names the value set
   each code answers to, the offline expansion is *derived* from that table rather than maintained beside
   it, and `wiring/corpus-membership.test.ts` checks every entry against the vendored terminology. A value
   set neither artifact references is reported as a failure rather than skipped, because "checked and
   fine" is the false reading this whole ADR exists to prevent.
2. **One constant per value set.** Three codes were each serving two sets while being a member of one.
   The names are now ugly on purpose (`hospiceEncounter` vs `hospiceCareAmbulatory`,
   `statusPostLeftMastectomy` vs `unilateralMastectomyLeft`): they name a value set, not a concept, and a
   test forbids sharing.
3. **Dual representation, never replacement.** The corpus emits the mammogram as a CPT `Procedure` *and*
   a LOINC `Observation`, and the patient carries `gender` *and* `us-core-sex`. Both halves are real —
   an EHR that performed a screening mammogram has an order record and a result, and a US-Core patient
   carries administrative gender and recorded sex as different elements answering different questions.
   Replacing either would have moved authored outcomes, which ADR-008 forbids for a change whose whole
   point is that the two engines become comparable.
4. **The corpus may author an onset; the preparation layer may not.** This qualifies ADR-037's
   "normalization, never fabrication" rather than contradicting it. The distinction is *whose fact it
   is*: `qicore-preparation.ts` receives data it did not create and must not invent a clinical date for
   it, while the corpus invents the entire patient by construction — a fictional employee with diabetes
   was diagnosed on some fictional day, and declining to say when is not neutrality, it is an
   ill-formed record that happens to read as absent. Synthetic Conditions now carry an onset 730 days
   before the evaluation date, which also retires a documented workaround: `cms122.cql` carries the
   comment "presence-based (synthetic Conditions often lack onset periods)".

   **`stampEnrollment` is the counter-example, and it took review to find it.** The first cut gave the
   same onset to the enrollment Condition that gets stamped onto REAL WebChart bundles — which fails
   this very test: its input is a roster asserting program membership, and that roster carries no date,
   so WorkWell does not know when an employee joined the hearing conservation program. It also cost
   something concrete: `canonical-hash.ts` hashes the bundle AFTER stamping, so a date-derived field
   there changes a live subject's `data_hash` every calendar day and permanently defeats the across-day
   incremental reuse (ADR-035) whose stated payoff is exactly the WebChart tenant. Removed. Nothing
   needed it — official artifacts retrieve VSAC-coded diagnoses, never a `urn:workwell:*`
   program-membership Condition. The byte-identity drift guard now excepts that one named field and
   asserts the difference in both directions, so it is deliberate rather than accidental.

**Consequences.**

- **Authored outcomes are byte-identical.** The corpus additions are invisible to the authored measures
  (an `Observation` is not a `Procedure`; no authored CQL reads `onset` or the sex extension), and the
  code corrections moved the stamped code and the offline expansion together. Full suite 1512 pass / 0
  fail / 14 skipped; 1501 / 0 / 25 with the terminology sidecars removed; MADiE gate 55/55 + 66/66 with
  the vendored artifact and the evidence report byte-unchanged.
- **For the STATIC synthetic corpus, the PR-9 flip is now a config change rather than a roster
  rewrite**, and there is a test that says so. `official-corpus-outcomes.test.ts` asserts the official
  artifact scores each target as authored, that the authored path agrees, and that the corpus is not
  degenerate.
- **Two other data paths are NOT covered, and both are PR-9 blockers alongside the capped
  `AdvancedIllness` expansion.** (a) The **scale generator** (`run/scale-generator.ts`,
  `webChartRealisticGenerator` — the default for `seed:scale --mode evaluate`, which produced the live
  `mhn` tenant) re-codes clinical events to one real code per measure; review caught it overwriting the
  new LOINC mammogram `Observation` with the CPT, putting the whole scale population back out of
  CMS125's numerator. Fixed here by skipping resources that carry no `urn:workwell:*` coding, but the
  outcomes guard still only exercises `buildSyntheticBundle`. (b) **Real WebChart data** gets neither
  CMS125 fix: `normalizeWebChartBundle` synthesizes no `us-core-sex` extension, and the crosswalk maps
  mammography onto a `Procedure` with no LOINC — so official CMS125 over live teatea data would still
  read out-of-population. That is an M-D question, answerable only against live data.
  > **Updated by ADR-042 (2026-07-30).** Half of (b) is closed and half is not, and the halves behave
  > differently. `us-core-sex` is now emitted for data flowing through the **shim / dev-DB export** path,
  > where official CMS125 agrees with authored on all 56 subjects — but NOT for a live third-party WebChart
  > FHIR server such as teatea, which still reads out-of-population. The mammography half is fully open, and
  > measurement showed it is worse than an out-of-population read: with one crosswalk-shaped mammogram,
  > official reports a screened woman **OVERDUE**. See ADR-042 consequences 3 and 5.
- **This work moves earlier than the roadmap scheduled it.** §7.4 put per-measure corpus extension at
  PR-10..12. Running the shadow period first would have compared against data that cannot exercise the
  numerator, and then run it again.
- **Both guards are wired into the `official-cases` CI job**, not just written. They self-skip without
  the fetched terminology sidecar, and the job that runs `pnpm test` has no sidecar — so as first
  written they were permanently skipped in CI while reading as covered, which review caught. Any future
  test that loads a sidecar must be added to that step.
- **The six remaining measures inherit the guard, not the fix.** Each still needs its own corpus data;
  what they no longer need is to rediscover that a plausible code can belong to the wrong set.

<a id="adr-027"></a>

## ADR-027: Production CMS122/CMS125 evaluate eCQI v14 faithful-subset CQL (not toy day-count rules); literal QICore remains diagnostic — 2026-07

**Status:** Accepted (2026-07-10).

**Context:** Production `cms122`/`cms125` were simplified TWH-ops CQL (local `urn:workwell:*` codes, single-day measurement period, no age/visit/GMI/Oct-1 mammogram window). That blocked the demo claim “we run real eCQMs from eCQI.” Official multi-library QICore packages remain hard to run as the *production* engine (ADR-026 keeps fqm diagnostic-only). CMS publishes **v15 for 2027**; population criteria are essentially unchanged from **v14/2026**, and the product’s demo year is 2026.

**Decision:**
1. **Production path** for `cms122` and `cms125` is a **faithful official-subset** CQL (FHIR R4, VSAC OIDs, 12-month MP) aligned to eCQI **CMS122v14 / CMS125v14** QDM population criteria. Residual DENEX (66+ LTC, frailty/advanced illness) is Phase 2.
2. **Offline VSAC expansions** are committed (`bundled-ecqm-expansions.ts`) so evaluation works without a live VSAC key; store/VSAC wins when non-empty.
3. **Synthetic dual-coding** stamps real VSAC/LOINC/CPT members alongside `urn:workwell:*` so both paths resolve.
4. **Stay on v14/2026** until an explicit 2027 product cutover; do not re-base on v15 solely because it is published.
5. **Literal fqm path (ADR-026)** remains diagnostic for CMS122 only; production never imports `fqm-execution` on the run path.

**Consequences:** Demo can honestly claim eCQI-aligned production evaluation for the two Active CMS measures. Synthetic outcome distributions change (e.g. missing lab in IPP → OVERDUE for CMS122). Reversible by reverting the CQL/registry/builder commits.

<a id="adr-024"></a>

## ADR-024: Official CMS122 fidelity via a faithful subset, not the literal QICore CQL — E14 PR-3 (#186)

**Status:** Accepted (2026-07-05).

**Context:** E14 PR-2 turned `GET /api/measures/cms122/fidelity/diff` into a **criteria-impact estimate** (structural-first, ADR-018): it could verify only the age gate (synthetic patients have deterministic birth years) and reported every other official criterion (qualifying visit, hospice, palliative, LTC, frailty) as *"unverifiable."* PR-3's goal was a **real, subject-by-subject execution outcome diff** — execute the official CMS122 against each subject and diff the resulting outcome against WorkWell's authored measure. The obvious path was to compile and run the **literal official CMS122v14 QICore CQL**. A compile-feasibility spike (2026-07-05) proved that is **not tractable** under the repo's pinned JVM-free translator `@cqframework/cql` 4.0.0-beta.1: (1) the real measure is authored `using QICore version '6.0.0'` and chains 8 libraries (FHIRHelpers, QICoreCommon, SupplementalDataElements, Status, AdvancedIllnessandFrailty, Hospice, PalliativeCare, CumulativeMedicationDuration); (2) the beta translator's **modelinfo loader cannot resolve cross-model type references** — any `FHIR.*`/`USCore.*` `baseType`/`elementType` in the QICore/US Core modelinfo makes the whole model fail to load (an isolated one-attribute repro reproduced it; real QICore has 1,300+ such refs → cascade to 804 errors / 0 retrieves), while a hand-crafted minimal QICore modelinfo *did* load and type-check (so the wiring is correct — the blocker is the real cross-model modelinfo); and (3) a second blocker behind it: the runtime `cql-execution-engine.ts` links only `FHIRHelpers`, not an 8-library include graph, over a plain-FHIR (not QICore-profile) data source. Neither escape route (wait for a stable multi-model translator; or mechanically flatten QICore+USCore+FHIR into one namespace) is bounded effort. The bar (as with ADR-023): add the execution diff with **zero risk** of drifting a current measure's `Outcome Status`.

**Decision:** Ship a **faithful official-SUBSET** CMS122, not the literal artifact.
- **Official-subset CQL** — `measures/cms122_official.cql`, authored `using FHIR '4.0.1'` in the repo's proven **value-set-retrieve** style (mirrors the audiogram VS variant), compiled to committed ELM `DiabetesHbA1cPoorControlOfficialCQL-1.0.0`. It adds the gates WorkWell's authored measure omits/simplifies (age 18–75, qualifying visit, diabetes diagnosis, hospice/palliative exclusion, HbA1c-missing-counts-numerator), driven by the **VSAC OID value sets** now importable via ADR-023 — resolved from the imported `value_sets` (`source='VSAC'`) rows by `StoreValueSetResolver`, so **no runtime VSAC key is needed** (the key was only for the one-time `pnpm resolve-valuesets` import).
- **Real subject-by-subject execution diff** — `computeExecutionDiff` (`backend-ts/src/standards/execution-diff.ts`): for each subject in the latest cms122 population run, build the synthetic bundle → additively enrich → evaluate **both** WorkWell's `cms122` and the official-subset measure fresh → diff, attributing each divergence to the first differing official gate. Memoized per run-id (terminal runs are immutable). `GET /api/measures/cms122/fidelity/diff` runs it whenever the imported VSAC rows are present (`chooseDiffMode` probes the diabetes OID expansion), else degrades to the unchanged PR-2 estimate.
- **Descriptive-only, structurally guaranteed (ADR-008).** The diff writes nothing and never sets an `Outcome Status`. The enrichment (`enrichForOfficialCms122`) is **harness-local** — real VSAC-member codings **appended** to the diff harness's own bundle copy (never replacing the `urn:workwell:*` codings, never a change to the shared `fhir-bundle-builder.ts`, never on the live run path) — so WorkWell's cms122 outcomes stay **byte-identical** (guard test). The one in-place field is `Patient.birthDate` (age-out), outcome-neutral because WorkWell's cms122 CQL ignores age.
- **`metaOverride` seam; official measure kept out of `MEASURES`.** `CqlExecutionEngine.evaluate` gained an optional `metaOverride?: MeasureMeta` so the official-subset measure (`CMS122_OFFICIAL_META`, `cms122-official.ts`) evaluates **without** being registered in the `MEASURES` registry — which is iterated by `seed:scale`, quality backfill, and segment/order code that must not see a diagnostic-only measure.

**Consequences:** The execution diff is **real** (not an estimate) for CMS122, with **no schema change and no new dependency**, and provably no `Outcome Status` drift. **Revisit the literal-QICore path** when `@cqframework/cql` ships a stable multi-model modelinfo release (all artifacts + wiring are identified in the spike record). Known gaps: the **GMI numerator alternative** is not modeled; the execution diff is **CMS122-only** (other measures return the PR-2 estimate / `{ available: false }`). Reversible by reverting the PR; local/dev without imported VSAC rows transparently serves the PR-2 estimate.

<a id="adr-018"></a>

## ADR-018: Standards fidelity is structural/definitional-first; official-CQL execution deferred — E14 (#186)

Date: 2026-06-26
Status: Accepted

**Decision.** E14 (standards fidelity) makes the **officially published** eCQM definition the reference and
ships a **documented structural fidelity diff** of WorkWell's authored (simplified) measure against it —
**not** an execution of the official CQL. PR-1 delivers a sourced, versioned `OfficialMeasureReference`
(CMS122v14 first), a pure `computeFidelity(ref)` assembler → a `FidelityReport` (per-criterion
COVERED/SIMPLIFIED/OMITTED + value-set coverage + reconciling counts + a disclaimer), and a read-only
`GET /api/measures/:id/fidelity`. A new `backend-ts/src/standards/` module — pure data + pure functions, no
DB, no `node:fs`, no engine call.

**Why structural-first.** The issue (#186) says *"scope the build conservatively."* Executing the official
CMS122v14 CQL for an evaluated-outcome diff is research-grade: QDM→FHIR translation, expansion of ~20 VSAC
value sets, the shared exclusion libraries (Hospice / AdvancedIllnessAndFrailty / PalliativeCare /
SupplementalDataElements / QICoreCommon), and QI-Core patient bundles carrying encounter/hospice/frailty/
palliative resources. PR-1 instead documents exactly where the authored measure **diverges in definition**
from the official spec — honest, sourced (every claim cites the official eCQI/QPP provenance URLs), and
already useful, since WorkWell evaluates its own measure today. **Official-CQL execution + outcome diff is
PR-2**, deferred behind the existing E3.2 (#90) `ValueSetResolver` seam (frozen QPP code lists as a no-VSAC
expansion source).

**Coverage is curated, not fully auto-derived (honest).** Value-set coverage is derived (does WorkWell
reference a value set for each official concept?); criterion coverage uses a small **curated, sourced**
coverage map in the reference, because semantic equivalence ("WorkWell's one generic `Has Exclusion` ≈ which
official exclusions?") cannot be reliably auto-derived from CQL text. The report's `disclaimer` states this;
PR-2's execution diff is the objective complement.

**Jurisdiction.** Country/jurisdiction is modeled as **measure metadata** — `jurisdiction?: string` on the
registry `MeasureMeta` (default `"US"`), surfaced on the measure-detail read model. The per-country rule
sets, a `RegulatorySource` registry, non-US references, and a "latest regulatory updates by country" watcher
are **design-first/aspirational** (`docs/standards/country-aware-regulatory-sourcing.md`), not built in PR-1.

**Consequences.** The fidelity report is **descriptive only** — it never sets or overrides an outcome; CQL
`Outcome Status` remains the sole compliance authority (ADR-008). **No schema, no new dependencies.** The
engine is unmodified. PR-2 adds the official-CQL execution path behind the `ValueSetResolver` seam; non-US
regulatory sourcing and the version watcher are later work.

<a id="adr-014"></a>

## ADR-014: CQL→SQL bridge (charter Q2) — recommendation recorded, decision DEFERRED to Doug

- **Date:** 2026-06-19
- **Status:** **Superseded by ADR-025** (2026-07-08). Was *Deferred* (recommendation only); E9 (#78) shipped
  the decision + the `MeasureExecutor` seam on our own (default A / decision C / inert-stub B) rather than
  continuing to wait on Doug's Q2. The recommendation below stands as the analysis behind ADR-025.
- **Context:** The charter's "CQL → SQL" is the biggest architectural fork (Q2): run measures *inside*
  WebChart's MariaDB report engine (transpile), keep the CQF/FHIR engine as the report engine
  (adapter), or hybrid.
- **Recommendation (not yet a committed decision):** **Hybrid, FHIR-native-first (Option C).**
  Near-term integration is a real WebChart `PatientDataProvider` adapter (reuses the E1 seam + the
  JVM-free CQF engine; full CQL fidelity, lowest risk). Treat "CQL→SQL" as a bounded, opt-in second
  executor via **SQL-on-FHIR v2 `ViewDefinition`s** only for reports that must run in MariaDB,
  cross-checked against the FHIR-native oracle. **Reject** a wholesale CQL→MariaDB transpiler — the
  only concrete CQL→SQL transpiler (VA) is Databricks-only/partial and the field targets Spark/Hive,
  not transactional MariaDB.
- **Decision owner:** Doug (gated on the five Q2 questions in the memo).
- **Full analysis:** `docs/CQL_TO_SQL_BRIDGE_DECISION_MEMO.md`. When Doug answers Q2, the chosen path
  becomes a normal epic and this ADR is superseded by the decision record.

<a id="adr-009"></a>

## ADR-009: Emit eCQM artifacts JVM-free; QRDA III as a structurally-representative stub

- **Date:** 2026-06-18
- **Status:** Accepted
- **Context:** E3 (eCQM artifact completeness, #73) adds FHIR `MeasureReport` (#89), real value-set expansion (#90), and a QRDA Category III aggregate export (#91). The reference validators for these standards (the HL7 FHIR validator, the QRDA III IG Schematron) are Java tools, and the stack is deliberately JVM-free with a no-new-dependency rule (ADR-008). We must decide how "conformant" each emitted artifact is and how conformance is asserted.
- **Decision:** Emit all eCQM artifacts JVM-free, hand-built (no FHIR/CDA runtime, no XML/Schematron validator dependency), and assert conformance **structurally** (required elements/codes/cardinality + balanced-by-construction XML), not via the official validators. The **QRDA III export is an explicit stub**: well-formed and structurally representative (well-known QRDA III IG template OIDs, aggregate population counts + performance rate reconciled with `outcomes` via the shared `countPopulations`), but **not** IG/Schematron-validated, and its internal observation `code` values are placeholders pending IG alignment. FHIR `MeasureReport` is structurally conformant (R4 elements + `measure-population` codes), not HL7-validator-checked.
- **Consequences:**
  - Conformance levels are documented honestly in `docs/STANDARDS_CONFORMANCE.md` (the matrix marks QRDA III "Stub").
  - Full QRDA III IG/Schematron validation, IG-exact codes, and multi-measure aggregation are tracked as future work; a real validator would reintroduce a JVM or a new dependency (a separate, approved decision).
  - Counts reconcile across artifacts by construction (one `countPopulations` source), so MeasureReport and QRDA III agree for the same run.

<a id="adr-001"></a>

## ADR-001: Single Spring Boot deployable with modular package boundaries

- **Date:** 2026-04-29
- **Status:** Accepted
- **Context:** The internship timeline is 13 weeks with one primary developer path, and MVP success depends on shipping an end-to-end vertical slice early (author -> execute -> operate) with reliable local bring-up, fast CI, and minimal operational overhead.
- **Decision:** Use one Spring Boot deployable for backend runtime, organized by domain packages (`com.workwell.measure`, `com.workwell.compile`, `com.workwell.run`, `com.workwell.caseflow`, `com.workwell.audit`, `com.workwell.valueset`, `com.workwell.mcp`) rather than separate microservices during MVP.
- **Consequences:**
  - Faster Week 0-Week 3 delivery: one build, one process boundary, one deployment unit.
  - Simpler local development and debugging: fewer moving parts while CQL + FHIR integration is still being proven.
  - Clear seam for post-MVP split: package boundaries remain explicit so services can be carved out later if load or ownership requires it.
  - Keeps risk focus on measure correctness, run determinism, and case idempotency rather than distributed-systems overhead.
