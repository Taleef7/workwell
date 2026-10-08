# What WorkWell Is

A one-page guide for quality leaders, nursing informatics teams, and clinical executives.

## What WorkWell is

WorkWell assists WebChart; it does not replace it. WebChart is the electronic health record (EHR). It carries Office of the National Coordinator (ONC) health IT certification, and it calculates and submits the practice's reported quality results. WorkWell reads the same kind of clinical records, evaluates each patient against clinical quality measures, and shows who has an open care gap, why, and what would close it. It keeps structured evidence for every outcome. Where WebChart reports the rates, as for the Maui pilot group, WorkWell's rates are an estimate, and the Maui sandbox's screens say so.

WorkWell is one product with several instances, each set up for its setting: a sandbox for a primary-care group (Maui, where the subjects are patients) and an occupational-health instance for Total Worker Health (TWH, where the subjects are employees).

## What it is NOT

- **Not a second system of record:** WorkWell does not calculate or submit the reported rates, and it does not manage appointments, billing, or general charting. WebChart does those. WorkWell does not pursue ONC certification.
- **Not a CQF-Ruler deployment:** WorkWell does not deploy CQF-Ruler (the reference clinical-reasoning server) or depend on its plan-definition machinery. It runs a lean, purpose-built evaluation core.
- **Not inside WebChart's encounter view yet:** WorkWell serves a Clinical Decision Support (CDS) Hooks service that returns care-gap cards. It follows the CDS Hooks 2.0.1 shapes, is self-graded rather than verified by an external suite, and uses WorkWell's own sign-in token instead of the CDS Hooks signed-JWT profile. Nothing in WebChart calls the service today, so no clinician sees the cards inside WebChart yet. Whether and how a WebChart client could call them is a question with MIE. Today, care gaps appear on WorkWell's own screens.
- **AI never decides compliance:** Artificial intelligence never determines whether a patient meets a quality measure. AI tools are strictly limited to assistive drafts and summaries for human review. The clinical measure engine remains the sole authority on compliance verdicts.

## What differentiates it

- **Runs CMS's own measure logic:** Many quality systems rewrite official electronic clinical quality measures (eCQMs) into their own rules, and the rewrite can drift from the original. WorkWell runs the Centers for Medicare & Medicaid Services (CMS) measure files directly: CMS's FHIR draft measures (version 1.0.000, posted for public comment in January–February 2026), each derived from a CMS measure such as CMS125v14. The Maui sandbox runs six that way (CMS122, CMS125, CMS2, CMS130, CMS165 and CMS137), and TWH runs two (CMS122 and CMS125). Nine vendored CMS measures pass the measure authors' own test cases, 455 of 455.
- **Says which year's logic scored a result:** CMS has not published FHIR versions of the 2027 measures, so WorkWell translates the 2027 changes itself, one measure at a time, labelled as WorkWell's translation and never as CMS's measure. CMS137's is in place on Maui. A measure without one scores a 2027 period with its 2026 draft, and the measure page says which logic scored a result.
- **Evidence retained per patient per measure:** For authored measures, WorkWell retains every named rule's result per patient per measure; for official-routed measures, it retains population membership (initial population, denominator, exclusions, numerator) per patient, because WorkWell strips the position markers from CMS's measure files to make them deployable, and the calculator needs those markers to report a trustworthy per-rule trace.
- **Occupational and OSHA content nobody publishes:** The national catalogs contain no occupational-health patient-level measures. WorkWell authors dedicated measures for workplace health regulations—such as OSHA standard threshold shifts for occupational hearing conservation—where national digital measure specifications do not exist.
- **Published modular packages:** The core evaluation engine is decoupled from the clinical catalog and published as public npm packages with cryptographically verified provenance.

## What runs where today

- **The Maui pilot sandbox:** A sandbox for the pilot group, a primary-care group preparing for a Medicare Shared Savings Program ACO in performance year 2027 (which begins 2027-01-01). It runs the six ACO measures over a generated 20,000-patient roster, with patient-driven terminology, a work list organized by provider panel, and clickable status counts that open the matching patient list.
- **The Total Worker Health (TWH) instance:** The occupational instance. It runs WorkWell's occupational and wellness measures alongside CMS122 (diabetes glycemic control) and CMS125 (breast cancer screening) over a synthetic workforce, as a public read-only sandbox.

Both instances run entirely on synthetic clinical data. A separate staging stack has exercised the live-EHR path against a WebChart trial system, which is how the integration is verified without putting real patients in the demo or the sandbox. There is no Protected Health Information (PHI) anywhere in the repository or sandbox environments. The pilot's production use with real patient data (PHI) is a separate, future phase requiring formal HIPAA and tenant-isolation controls.

## How it fits a quality team's day

- **The provider-panel work list:** Quality coordinators manage patient panels assigned to specific primary care clinicians rather than disconnected measure spreadsheets. The work list is organized by provider panel, so a coordinator sees every open care gap across a clinician's panel in one place and assigns the follow-up.
- **Cards that resolve:** Today, care-gap cards link to the patient's compliance view in WorkWell. Draft-order suggestions exist for three occupational measures with approved terminology mappings. The pilot's order pick lists, its local terminology mappings, and the exception path wait on MIE's order mapping and clinical guidance.
- **An essential clinical rule:** An order never closes a care gap. Placing an order is a proposal; the gap closes only when the completed result returns to the medical record and the engine re-evaluates the patient.

## Honesty guardrails

- **Measure authorship:** Where an instance runs a CMS measure, it runs CMS's own measure logic, not a rewrite. Not every vendored CMS measure runs yet: CMS68, CMS138 and CMS951 pass their official test cases but run on no instance. Where no national digital specification exists, as for the occupational measures, WorkWell authors its own measure specifications from public statutes and clinical guidelines. Its HEDIS-style wellness measures are authored from public clinical guidance and cite HEDIS by name only.
- **Grounded standards claims:** Conformance claims are strictly limited to what is verified in [Standards Conformance](STANDARDS_CONFORMANCE.md). WorkWell validates clean aggregate QRDA documents and clean patient-level documents for official measures over its synthetic corpus against HL7 base standards (authored-measure patient-level QRDA is nonconformant by design), but does not claim ONC certification or official agency endorsements. OSHA does not certify software, and WorkWell's OSHA measures represent careful regulatory interpretation, not government validation.
- **FHIR reporting timelines:** The CY2027 Physician Fee Schedule proposed rule (CMS-1848-P) sought comment on FHIR-based reporting (voluntary for performance years 2028–29, mandatory from 2030 for applicable APP Plus measures). That is a request for comment, not a proposal or a final rule.

## Where to read more

- [The WorkWell Guide](guide/README.md) — Chapter-by-chapter walkthrough of the architecture, clinical logic, and data flow.
- [From the clinic EHR to a quality result](guide/normalization-for-quality-teams.md) — Visual walkthrough showing how clinical records move from WebChart through normalization to quality results.
- [Standards Conformance](STANDARDS_CONFORMANCE.md) — Detailed matrix of verified standards, external testing harnesses, and deliberate boundaries.
