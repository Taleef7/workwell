# Cypress Calculation Check — scoping spike (#385)

Date: 2026-08-02. Timeboxed spike to answer one question: **can Cypress run a Calculation Check against
WorkWell for CMS122/CMS125, and what does it need?**

**Answer: yes, architecturally — every piece WorkWell needs already exists. It is blocked on ONE thing,
and that thing is a credential on this machine, not a technical unknown.**

## 1. The finding

Cypress's Calculation Check is the **C2 task**. Reading the task models in the running v7.5.1 container:

| Task | You upload | Validated by | ONC criterion |
|---|---|---|---|
| **C1** | QRDA **Cat I** | `CalculatingSmokingGunValidator`, `QrdaCat1Validator` | §170.315(c)(1) record & export |
| **C2** | QRDA **Cat III** | `QrdaCat3Validator` + **`ExpectedResultsValidator`** | §170.315(c)(2) **import & calculate** |
| **C3 Cat3** | QRDA **Cat III** | `QrdaCat3Validator` + `CMSQRDA3SchematronValidator` | §170.315(c)(3) report |

**`ExpectedResultsValidator` is the thing we have never had**: it compares the numbers we submit against
`product_test.expected_results` — Cypress's own precalculated answers for its own generated patients.

## 2. The loop C2 defines, and what WorkWell already has

1. Cypress generates test patients for a measure → downloadable as **QRDA Category I**.
   `product_tests_controller.rb`: *"always respond with a `.qrda.zip` file of qrda category I documents"*.
2. The system under test **imports** those patients — **WorkWell has this** (`POST /api/runs/:id/evaluate`
   with `{measureId, qrda1}`, ADR-051).
3. It **calculates** — **WorkWell has this**, and for CMS122/CMS125 it runs CMS's published QI-Core
   artifacts (ADR-045/046), not authored logic.
4. It **exports QRDA Category III** — **WorkWell has this**, and as of 2026-08-02 it validates at
   **0 findings** against the HL7 base ruler (#384).
5. Upload that Cat III to the C2 task → `ExpectedResultsValidator` compares.

**Every step exists.** This is why the spike was worth doing before committing to a milestone: the answer
is not "build the loop", it is "obtain one file".

## 3. The blocker, measured

Cypress cannot create a Product without a **measure bundle** — a `.zip` carrying measures, generated
patients, and precalculated expected results, imported through `Cypress::CqlBundleImporter`.

**This instance has none.** Measured directly against its MongoDB:

```text
products                                0
product_tests                           0
health_data_standards_svs_value_sets    0
fs.files                                0
individual_results                      0
users                                   1
```

Bundles come from `https://cypressdemo.healthit.gov/measure_bundles/bundle-<year>.zip`
(`Settings.downloadable_bundles_path`). Available years, from `version_config`: **2022–2026**.

**It is NLM-gated.** `BundleDownloadsController#download_bundle` sends HTTP basic auth as
`user: 'NA', password: api_key` and fails with **"Could not verify NLM User Account."** Probed
unauthenticated:

```text
bundle-2025.zip -> HTTP 401
```

This is the **same licensing boundary** ADR-041 hit for terminology: upstream caps value-set expansions
at 1000 because full ones need an NLM licence. Same gate, different artifact.

## 4. What that means practically

**We hold a credential of the right kind.** `WORKWELL_VSAC_API_KEY_VENDOR` is a UMLS/UTS key, which is
what VSAC and this endpoint both authenticate against. What we do **not** have is that key **on the
machine running Cypress** — it exists only as a GitHub secret.

**And unlike the CMS130/CMS165 vendoring problem, a `workflow_dispatch` job cannot solve this one.** That
pattern worked (#365) because the vendor outputs are two small committable files, with a test asserting
the licensed `terminology.json` never leaves the runner. A Cypress bundle is **licensed NLM content in
its entirety** — routing it through a GitHub Actions artifact *is* redistribution, which is exactly what
`vendor-workflow-safety.test.ts` exists to prevent. It must be downloaded **directly on the machine that
runs Cypress**, by the owner, with the owner's NLM key.

## 5. Not verified

- **Whether CMS122 and CMS125 are in the bundle.** Cypress covers 56 EP/EC eCQMs and both are standard
  Eligible Clinician measures, so it is very likely — but it is an inference, not a measurement, and it
  cannot be measured without the bundle.
- **Whether our Cat III passes `ExpectedResultsValidator`.** Validating clean against the Schematron
  (#384) says the document is well-formed and conformant; it says nothing about whether the numbers in it
  match Cypress's expected results. **That is the entire point of C2 and remains untested.**
- **Whether the QRDA-I import handles Cypress's patients.** Ours reads the five QDM datatypes CMS122/125
  consume and NAMES what it cannot translate (ADR-051); the CMS RY2026 sample carried 47 untranslated
  templates. Cypress's generated patients may carry more.

## 6. What this does NOT change

The MADiE gate (410/410) already gives us external, known-answer validation of **calculation** — CMS's
logic, CMS's patients, CMS's expected vectors, through the executor production uses. C2 is not "the first
external check of our calculations"; an earlier draft of #385 said that and it was wrong.

What C2 adds is **coverage of the chain around the executor** — ingest, outcome derivation, aggregation —
which MADiE bypasses by handing the executor a finished bundle.

## 7. Recommendation

**One owner step unblocks the whole milestone:** obtain `bundle-<year>.zip` for the year matching the
measurement period we want to test, onto the machine running Cypress. Two ways, both needing the
UMLS/NLM API key:

- **In-app** — sign in and use **Download Bundle** (`GET /bundle_downloads`), which prompts for the API
  key and proxies `https://cypressdemo.healthit.gov/measure_bundles/bundle-<year>.zip`.
- **Direct** — `curl -u NA:<UMLS_API_KEY> https://cypressdemo.healthit.gov/measure_bundles/bundle-2026.zip`,
  matching the basic-auth shape `BundleDownloadsController` uses.

Then import it through the **admin Bundles page** (`resources :bundles` under the admin namespace, which
enqueues `BundleUploadJob` → `Cypress::CqlBundleImporter`). **There is no import rake task** — a first
draft of this document invented `rake bundle:import`, which does not exist; the only bundle rake tasks
are `precalculate_bundle` and the `bundle:eval:*` diagnostics, and `precalculate_bundle` *destroys* the
bundle when it finishes, so it is not an import path.

Expect the import to be slow and large: the bundle carries every measure, its generated patients, and
precalculated results for all of them.

After that the spike's remaining unknowns become measurable in one sitting, because steps 1–4 of §2 are
already built. **Do not commit to C2 as a milestone before the bundle exists** — every estimate past this
point is guesswork until we can see whether CMS122/CMS125 are in it.

---

# Part 2 — the blocker is CLEARED, and the C2 harness stands up (same day, with the owner's key)

The owner supplied the UMLS/NLM API key, which changes §3–§5 from "blocked" to measured. **Two of my own
estimates in Part 1 were wrong and are corrected here rather than quietly edited above.**

## 8. Everything Part 1 could not verify

| Part 1 said | Measured |
|---|---|
| "hundreds of MB to a few GB" | **23–33 MB.** `bundle-2025.zip` is 28,266,751 bytes. Off by two orders of magnitude. |
| CMS122/125 in the bundle is "an inference, not a measurement" | **Measured: PRESENT.** And so are all six other gated measures — CMS2, CMS68, CMS130, CMS138, CMS165, CMS951 — out of 80. |
| Bundle is NLM-gated | **Confirmed.** With the key, all five years (2022–2026) return HTTP 200. |

`bundle-2025.zip` self-describes as **"2026 Performance Period Eligible Clinician eCQMs"** — the same
performance year as our vendored artifacts, and the year whose CVU+ validators we used in #380/#384.
Imported as **v2025.0.1: 70 measures, 714 patients, 7891 precalculated results, active.**

Cypress carries these as **CMS122v14** and **CMS125v14** — the QDM lineage — where our artifacts are
FHIR/QI-Core **v1.0.000**. Same measures, two representations. That makes the comparison genuinely
independent: Cypress computed its expected answers from QDM logic, we would compute ours from CMS's
FHIR artifacts.

## 9. The harness stands up

A Vendor + Product with `c2_test: true` and MeasureTests for both measures produces a **`C2Task`** each,
generates patients (CMS122: 64, CMS125: 150), evaluates them, and writes `expected_results`. The patient
archives extract as QRDA Category I — the format our importer already reads.

**So §2's claim holds: nothing needs building.** The remaining work is running our engine over these
documents and comparing.

### Three setup traps, all of which fail SILENTLY

1. **Pre-setting `measure_ids` on the Product creates ZERO tests.** `add_measure_tests` builds a
   MeasureTest per `(new_ids - old_ids)`, so seeding the ids first makes that difference empty — and the
   Product still saves, reporting `tests=0` with no error. But the Product *also* will not validate
   without `measure_ids` ("Measure ids must select at least one"), so the way through is to set them and
   build the `MeasureTest` records directly, as `add_measure_tests` does.
2. **`/app/public/data` is root-owned while the app runs as uid 1001.** Setup fails at
   `archive_patients` with `Permission denied @ dir_s_mkdir`, *after* generating and evaluating patients
   — so the test shows `state=errored` while the delayed_job log says `COMPLETED, 0 failed`. Fix:
   `mkdir -p /app/public/data/upload && chown -R app:app` as root.
3. **Re-running `ProductTestSetupJob` CONTAMINATES `expected_results`.** `reset_product_test_patients`
   deletes Patients but **not** `CQM::IndividualResult`, and `ExpectedResultsCalculator` aggregates
   every result carrying the test's `correlation_id`. Measured after one re-run: CMS122 had **128
   individual results across 64 distinct patient ids**, and its expected IPP read **128** — exactly
   double. **Had that been used as the oracle, our engine would have looked ~50% wrong and the hunt
   would have been for a bug that does not exist.** Teardown must delete the IndividualResults, not just
   the Product.

## 10. Where this stops, and why

**The comparison itself is NOT done, and I am not reporting one.**

Across three setup runs the expected counts came out differently each time (CMS122 IPP 128, then 93),
and the relationship between patient count, `IndividualResult` count and the expected populations is not
yet something I understand well enough to treat as an oracle — CMS122 shows 64 patients, 93 individual
results over 64 distinct patient ids, and IPP 93, for a patient-based measure where none of those
numbers is obviously the others. Some of that is the duplication C2 applies (`duplicate_patients` is
forced true for C2, and the archive carries more documents than there are patients); some of it is
trap 3 above.

**A comparison against a number I cannot yet derive twice would be worse than no comparison** — it would
either manufacture a defect in our engine or, worse, agree by luck and be cited later as evidence.

### The next session's first task, stated precisely

Establish the oracle before running anything through WorkWell:

1. From a **clean** rebuild (results deleted, setup run exactly once), record patients, IndividualResult
   count, archive document count, and expected populations.
2. Repeat it and confirm every number is **identical**. Until it reproduces, it is not an oracle.
3. Only then: import the archive's QRDA-I documents, evaluate through the official executor, aggregate,
   and compare — reporting differences without explaining them away.

Everything needed for step 3 is already built and already validated (#380/#381/#384). The gap is
entirely in trusting the expected side.

## 11. CORRECTION — "nothing needs building" is WRONG (review of #386, two P1s)

Both Part 1 §2 and Part 2 §9 concluded *"nothing needs building — the remaining work is running our
engine over these documents and comparing."* **That is false, and review found two concrete technical
prerequisites I had classified as untested consequences of the single-file blocker.** Both verified
against the tree rather than taken on faith.

### 11.1 No HTTP route can finalize an imported run

`POST /api/runs` creates a run `QUEUED`; each `POST /api/runs/:id/evaluate` moves it to `RUNNING`; and
**no route calls `finalizeRun`.** Verified: `grep -rn finalizeRun backend-ts/src/routes/` returns only
`*.test.ts` matches, and the real callers are internal — `run-pipeline.ts`, `case-rerun.ts`,
`backfill-scale.ts`, `batch-evaluate-scale.ts`. `GET /api/runs/:id/qrda` guards on `notReportable` and
returns **409** for a run that is still `RUNNING`.

So the §2 loop **cannot reach step 4 over the API**. Producing the Cat III that C2 requires needs either
a new route (or an explicit finalize action on the existing one) or direct store access from a script.
That is a code change, small but real, and it is on the critical path.

### 11.2 The measurement periods are not aligned

`officialMeasurementPeriod` (`wiring/official-executor-adapter.ts`) deliberately evaluates the
registry's **rolling** window — `evaluationDate − periodMonths … evaluationDate`. **ADR-039 records this
exact divergence** from the calendar year `2026-01-01 … 2026-12-31`, and resolved it by aligning the
shadow diff ONTO the rolling window — the right call then, because the goal was comparing our own two
engines. It is the wrong window for Cypress, whose expected results are computed over the test's own
`effective_date` (`product_test.rb#effective_date` ← `product.effective_date`).

A patient whose qualifying event sits near a period boundary can therefore land in a different
population **even with a correct engine and a correct import**. Aligning the period is a prerequisite,
not a finding — and had this run gone ahead unaligned, the boundary patients would have shown up as
population mismatches and been indistinguishable from real defects.

### 11.3 What the spike's conclusion actually is, restated honestly

**Unchanged and still valuable:** the bundle is obtainable and obtained; CMS122/CMS125 (and six more) are
present; the C2 harness stands up and produces patients, archives and expected results; Cypress hands out
QRDA Cat I, which our importer reads; and the export validates clean (#384). **The milestone is viable.**

**Corrected:** it is *not* "obtain one file". It is obtain one file **plus** (a) a way to finalize an
imported run, (b) measurement-period alignment with the Cypress test, and (c) an oracle that reproduces
(§10). Three prerequisites, all small, none of them zero.

That is still a good answer to the spike's question — **"viable, with three named prerequisites" is
exactly what a scoping spike is for.** It is just not the answer I first wrote.

---

# Part 3 — the oracle reproduces, and the comparison has been run (2026-08-03)

Part 2 stopped at §10 because the expected results could not be derived twice. They can now, and the
comparison C2 grades has been performed offline against the archive. **The headline: our two official
measures agree with Cypress on WHO is in the measure and disagree on WHO IS EXCLUDED — and the cause is
QRDA import coverage, not measure logic.** Both causes are confirmed by construction, not inferred.

## 12. The oracle, derived rather than recorded

Two clean rebuilds (`scripts/cvu/c2/rebuild.rb`, then `snapshot.rb`), each running
`ProductTestSetupJob` exactly once. **Every graded number is identical across both passes:**

| | CMS122v14 | CMS125v14 |
|---|---|---|
| patients | 64 | 150 |
| `CQM::IndividualResult` | 64 | 300 |
| distinct patients in results | 64 | 150 |
| expected `PopulationSet_1` | IPP 64, DENOM 64, NUMER 31, DENEX 32 | IPP 150, DENOM 150, NUMER 2, DENEX 47 |
| expected strata | — | S1: IPP 28 · S2: IPP 122 |
| supplemental-data digest | identical | identical (all three sets) |
| measurement period | 2024-01-01 … 2024-12-31T23:59:59Z | same |

§10's irreproducibility was trap 3 and nothing else: teardown that deletes the Product but not its
`IndividualResult`s. With those deleted explicitly, the counts repeat exactly.

**Every number is now derivable, which is what makes it an oracle rather than an observation:**

- `IndividualResult` = patients × (1 unstratified row + 1 row for the patient's OWN stratum). CMS122 is
  unstratified, so 64×1; CMS125 declares three population sets but writes 150×2 = 300, because a patient
  belongs to exactly one stratum — and 28 + 122 = 150 confirms that. (Not "patients × population sets",
  which would predict 450.)
- archive documents = patients + **1** (`ClinicalRandomizer` splits one patient's clinical data across
  two documents) + **k** duplicates, where `k = rand(1..3)` seeded from a per-test `rand_seed`.
- distinct PEOPLE = patients. Always.

**So the archive document count legitimately VARIES between rebuilds and the expected results do not** —
66 → 68 for CMS122 and 152 → 153 for CMS125 across the two passes. That is the answer to Part 2's "66 vs
67" puzzle: not instability, the duplicate test doing its job.

**The comparison in §15 was run against BOTH archives and every graded number is identical** — 64 people
from 66 documents and from 68, 150 from 152 and from 153, same IPP/DENOM/NUMER/DENEX both times. That
invariance under the randomised duplication is the direct answer to "is a MATCH an artefact of which
documents happened to be duplicated": for these numbers, no.

**One thing that is NOT stable across rebuilds, found by trying it: the MBI.** Joining pass A's documents
to pass B's per-patient rows matched **4 of 64** for CMS122 — exactly the four patients who have no MBI
and are therefore keyed on name+birth — and **0 of 150** for CMS125. Cypress regenerates the identifier
on every setup run. The aggregate expected results are pass-invariant; per-patient rows must come from the
same rebuild as the archive. The harness reports the unmatched count, which is how this was caught rather
than quietly reported as a 0%-agreement result.

## 13. A FOURTH prerequisite, found by measuring the archive: identity resolution

Documents are not people, deliberately. Both extras get a **new Cypress MRN** (`1.3.6.1.4.1.115`), and
the augmented duplicate additionally gets a randomized first name, last name **or** birthdate — never all
three. Measured on the CMS122 archive:

```text
49_TWO_Diabetes Adult.xml   mrn=…8dba16  MBI=8UA6K41TH72  "TWO Diabetes Adult"  dob=19781224203000
50_TWO_Diabetes Axult.xml   mrn=…8dc82f  MBI=8UA6K41TH72  "TWO Diabetes Axult"  dob=19781224203000
```

The identifier that survives both transforms is the **Medicare Beneficiary Identifier**
(`2.16.840.1.113883.4.927`). Keyed on it, 66 documents resolve to 64 people and 152 to 150 — exactly the
patient counts the expected results were computed over. **Four CMS122 patients (the `*_Virtual` ones)
carry no MBI at all**, so name+birth is the fallback; that is sound here precisely because Cypress never
duplicates those four, and it is not a general patient-matching algorithm.

A receiver that treats each document as a subject reports 66 or 68 where Cypress expects 64, and fails C2
on arithmetic before any logic is involved. **The product path does exactly that today:**
`POST /api/runs/:id/evaluate` keys the subject off the first `<id>` extension — the per-document MRN —
so nothing in WorkWell resolves these to one person. The resolution lives only in the harness.

## 14. Prerequisite 11.2, measured rather than argued

The bundle's own period is **CY2024** (`measure_period_start` 2024-01-01, `effective_date`
2024-12-31T23:59:59Z), despite `bundle-2025.zip` self-describing as the *2026 Performance Period* — worth
stating because assuming 2026 would have moved every patient.

`officialMeasurementPeriod('cms125', '2024-12-31')` yields `2023-12-31 … 2024-12-31T23:59:59.999Z`: the
same end, one extra day at the start. Re-running both measures on both windows over the same subjects:
**0 of 64 and 0 of 150 subjects change population membership.** The risk is real in principle and zero in
this corpus. The harness therefore pins the period explicitly rather than relying on that.

## 15. The comparison

`pnpm --dir backend-ts exec tsx ../scripts/cvu/c2-calculation-check.ts` over the pass-B archives, official
artifacts, CY2024:

| population | CMS122 expected | CMS122 reported | CMS125 expected | CMS125 reported |
|---|---|---|---|---|
| IPP | 64 | **64 MATCH** | 150 | **150 MATCH** |
| DENOM | 64 | **64 MATCH** | 150 | **150 MATCH** |
| NUMER | 31 | 54 | 2 | **2 MATCH** |
| DENEX | 32 | 9 | 47 | 19 |

**This compares `PopulationSet_1` only, and CMS125 has two more.** Its expected results also carry
`PopulationSet_1_Stratification_1` (IPP 28, DENEX 2) and `_Stratification_2` (IPP 122, DENEX 45), and a
real C2 submission is graded on every set — a measure can agree on the unstratified totals and disagree
inside a stratum. fqm computes stratifier results, but `packages/official-executor` surfaces only
`detailedResults[0]`, so this harness cannot read them; extending it is a production change and outside
this spike. The report now prints the uncompared sets and their expected counts above the table, so it
cannot be read as the complete comparison (Codex, #387).

Per subject, against Cypress's own per-patient `IndividualResult`s (`scripts/cvu/c2/per-patient.rb`):

- **CMS122: 41 of 64 subjects agree on every population.** All 23 differences are `DENEX: cypress=1
  workwell=0` **and** `NUMER: cypress=0 workwell=1` — one direction, no exceptions.
- **CMS125: 122 of 150 agree.** All 28 differences are `DENEX: cypress=1 workwell=0`.

**Two properties of these artifacts decide how that table may be READ, and both were verified in the
vendored bundles rather than assumed.** (1) `Denominator` is an `ExpressionRef` to `Initial Population`
in **both** measures, so the DENOM row is the IPP row restated — **one agreement, not two**, and any
phrasing that reads as two independent corroborations is wrong. (2) `fqm-execution` sets NUMER false
whenever DENEX is true for a proportion measure with a single initial population
(`DetailedResultsBuilder.handleStandardPopulationValues`, verified in the installed build), so a
numerator count cannot be read apart from the exclusions. A first draft of this document cited a harness
check that "no subject is in both DENEX and NUMER" as evidence the columns were comparable; **that check
is structurally incapable of returning anything else for these measures** and has been removed rather
than reported. The conclusion it was cited for still holds, and is carried by the per-subject table
instead: 23 subjects each show `DENEX −1` **and** `NUMER +1`, which is the missed exclusions falling
through — for an INVERSE measure (numerator = poor control, and "no result" counts) that is the direction
that reads as non-compliance.

Cypress's patient names state the criterion each exercises, and the differing set reads as a list of the
exclusions we miss: `TWO N Advanced Illness …`, `TWO N Long Care …`, `TWO Palliative …`,
`THREE N Independent Risk Factors …`.

## 16. The cause: QRDA import coverage, twice — both confirmed by construction

### 16.1 Five datatypes are translated; the exclusion logic reads more

What the importer produced across each archive:

| CMS122 | produced | CMS125 | produced |
|---|---|---|---|
| Encounter | 126 | Encounter | 368 |
| Condition | 95 | Condition | 63 |
| Observation | 4 | Procedure | 6 (of 10 entries) |
| | | Observation | 2 |

Dropped datatypes, by entry count (CMS122 / CMS125) — **Intervention, Performed** (12 / 17),
**Assessment, Performed** (9 / 9), **Intervention, Order** (9 / 2), **Symptom** (6 / 5),
**Device, Order** (2 / 2), **Medication, Active** (1 / 1), **Patient Characteristic Expired** (0 / 14),
plus Patient Characteristic Payer (68 / 153, supplemental data only). Those are the inputs to hospice,
palliative care, long-term nursing home, advanced illness and frailty — i.e. to `Denominator Exclusions`.

**The MECHANISM is confirmed, not inferred** — and it is a reproducible command, not a one-off script:
`--inject scripts/cvu/c2/inject-assessment.json`. `TWO N Long Care GP Adult` carries one Assessment,
Performed (LOINC 71802-3 "Housing status", value SNOMED 160734000 "Lives in a nursing home"). Adding that
single entry back as a QI-Core `Observation`:

```text
as imported   {"initial-population":true,"denominator":true,"denominator-exclusion":false,"numerator":true}
+ injected    {"initial-population":true,"denominator":true,"denominator-exclusion":true,"numerator":false}
```

which is Cypress's expected answer for that patient exactly.

### 16.2 `concept()` reads the primary `<code>` only, from six code systems only

`SYSTEM_FOR_OID` maps SNOMED, LOINC, CPT, ICD-10-CM, ICD-9-CM and HCPCS. A `<code>` in any other system
makes `concept()` return `undefined` and the WHOLE resource is dropped — and a `<translation>` inside it
is never consulted, even when it is in a system we do map.

Measured: **4 of CMS125's 10 Procedure, Performed entries are coded in ICD-10-PCS**
(`2.16.840.1.113883.6.4`, unmapped), which is why 6 Procedures were produced from 10 entries. Two of the
four carry the SNOMED code CMS125's own exclusion value set contains:

```xml
<code code="0HTT0ZZ" codeSystem="2.16.840.1.113883.6.4" codeSystemName="ICD10PCS">
  <translation code="429400009" codeSystem="2.16.840.1.113883.6.96" codeSystemName="SNOMEDCT"/>
</code>
```

Adding those two back as SNOMED Procedures (`--inject scripts/cvu/c2/inject-mastectomy.json`):

```text
as imported   {"initial-population":true,"denominator":true,"denominator-exclusion":false,"numerator":false}
+ injected    {"initial-population":true,"denominator":true,"denominator-exclusion":true,"numerator":false}
```

### 16.3 Mechanism vs coverage — what the two injections do and do not establish

Each injection is **n = 1 subject**. They establish the MECHANISM: this datatype, dropped, changes this
population, and supplying it produces Cypress's exact expected answer. They do **not** establish that
these two causes account for all 23 + 28 differing subjects. That step is an inference from the §16.1
inventory (the dropped datatypes are precisely the exclusion inputs) plus Cypress's own patient names,
which state the criterion each patient exercises — `TWO N Advanced Illness …`, `TWO N Long Care …`,
`TWO Palliative …`. Strong, and not the same thing as measured.

### 16.4 What this does NOT say

It says nothing bad about the official artifacts or the executor. Given the data, the artifact computes
Cypress's answer both times — measured above. **The gap is between the document and the engine**, and it
is a mapping gap. That is a materially better position than a logic divergence would have been, and it is
also narrower than "our calculations are validated": the **initial population** is corroborated by an
independent QDM implementation over 214 patients (DENOM restates it, per §15), and the exclusion paths
are not yet exercised end to end.

One more thing the harness does that flatters the input, and should be stated where the claim is made:
`preparedForQiCore` stamps `clinicalStatus: active` and a problem `category` on every imported Condition
(ADR-037), because the importer emits neither. Over our own synthetic corpus that is normalisation of a
known gap; over a **third party's** document it asserts something the document did not say. It is not
implicated in either divergence above — both are missing resources, not mis-stated ones — but "given the
data, the artifact computes Cypress's answer" is true of the data *as prepared*.

## 17. Three smaller findings, recorded rather than smoothed over

1. **`untranslatedTemplates` names the wrong template.** It reports the LAST `templateId` found in the
   entry, which is routinely a nested ATTRIBUTE template — Author dateTime (`…24.3.155`, 31 times) or
   Rank (`…24.3.166`) — rather than the datatype that was dropped. So the diagnostic an operator is meant
   to read to know "which datatype did we lose" names something that is not a datatype at all. The
   inventory in §16.1 had to be computed independently for this reason.
2. **`Patient.birthDate` receives a dateTime.** `isoFromHl7` returns the full timestamp for a 14-digit
   `birthTime`, so the importer writes `"1978-12-24T20:30:00Z"` into a field FHIR types as `date`. It
   changed no population here — IPP matched 64/64 and 150/150, so the age predicates evaluated fine — but
   it is invalid FHIR that our own exporter would never produce.
3. **One document is refused, correctly.** `58_ZTHREE N_Eye.xml` (pass B) is the half of a clinically
   split patient that received no clinical data at all — only a payer entry — so the importer refuses it
   under ADR-051 rather than producing a Patient-only bundle. The merge recovers the person from the
   other half. The refusal is right; it is recorded because "1 document failed to import" reads alarming
   until you know which document.

## 17b. Two defects in the HARNESS, found by review of this branch

Both are fixed; both are recorded because the harness's output is quoted as evidence, and "the measuring
instrument was wrong in a way that produced a plausible number" is the failure mode this whole document
is about.

1. **The merge picked one document's demographics by filename sort order, silently.** `readdirSync().sort()`
   is lexicographic, not Cypress's index order, so `17_F_Heart Adult.xml` sorts before
   `9_FIVE SIX_Heart Adult.xml` — and in pass B the *augmented* copy won 4 of 7 merges. Review demonstrated
   the consequence by mutating a birthdate in the document that does NOT win: the harness printed
   `IPP | 64 | 64 | MATCH` while discarding a birthdate it had been handed. **That is a false MATCH**, and
   both artifacts gate the initial population on `AgeInYearsAt(...)`, so it is load-bearing. It never fired
   in either measured pass because Cypress randomised NAMES both times — a `rand_seed` property, not an
   invariant. The merge now reports every demographic disagreement (measured: 3 people in CMS122, 2 in
   CMS125, all on `name`, none on `birthDate`), and the printed label now comes from the same document as
   the evaluated Patient — previously it came from the last document, so a reader following the label
   opened the wrong file.
2. **The per-patient export selected a population set on a field that does not exist.**
   `r['stratification'].nil?` is nil on *every* row, so for CMS125 the export took whichever of a patient's
   two rows Mongo returned first — the unstratified one or their own stratum. Both carry `IPP=1`, so a
   mixed selection can still sum to the right aggregate and read as correct. The selector is now
   `population_set_key == 'PopulationSet_1'`, asserted to match exactly one row. **Re-exported and compared
   byte-for-byte with the file §15 was computed from: identical** — the defect was latent, not active, and
   §15 stands as measured.

Also fixed, from the same review: `rebuild.rb` printed `SETUP DONE` when a test ended `errored`, which is
precisely how trap 2 fails (the test errors *after* generating patients while the job log says COMPLETED);
the harness now checks the people it resolved against the oracle's own patient count and the per-patient
rows against the aggregate, so an identity artefact or a contaminated setup surfaces as itself rather than
as an apparent engine defect; and the "N subjects had no fqm result" warning moved from stderr into the
report, which is routinely redirected to a file.

## 18. Where the milestone stands now

**Answered.** The oracle reproduces. The comparison runs. IPP and DENOM are corroborated externally for
both routed measures. The two divergences are diagnosed to a cause, at a line of code, with a
constructed proof each.

**Prerequisite 11.1 is still open and untouched:** no HTTP route calls `finalizeRun`, so an imported run
cannot reach `GET /api/runs/:id/qrda` (409 while RUNNING). This spike went around it by calling the
executor directly — which is the alternative §11.1 itself named, and which measures the calculation
without proving the SUBMISSION. A real C2 upload still needs that route, plus §13's identity resolution
in the product path rather than in a script.

**So the honest statement of the milestone bar is unchanged.** Locked decision #2 is the import →
evaluate → export → CVU+ green LOOP. This is the calculate leg, measured offline against Cypress's
expected results. `ExpectedResultsValidator` has still never graded a document we produced.
