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
