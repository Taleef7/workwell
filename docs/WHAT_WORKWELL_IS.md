# What WorkWell Is

A one-page guide for quality leaders, nursing informatics teams, and clinical executives.

## What WorkWell is

WorkWell is a supplementary compliance and clinical quality measure engine operating alongside WebChart. It takes clinical records from electronic health records, evaluates patients against clinical quality measures, and provides structured evidence explaining every outcome.

In this architecture, WebChart remains the primary electronic health record (EHR) and carries Office of the National Coordinator (ONC) health IT certification. WorkWell sits beside WebChart as a dedicated engine, handling population surveillance, clinical quality reporting, and Total Worker Health compliance without modifying WebChart's certified footprint.

## What it is NOT

- **Not a competing EHR or certified engine:** WorkWell does not replace WebChart or manage appointments, billing, or general charting. WebChart already carries ONC certification; WorkWell deliberately does not pursue certification.
- **Not a CQF-Ruler deployment:** WorkWell does not deploy CQF-Ruler (the reference clinical-reasoning server) or depend on its plan-definition machinery. It runs a lean, purpose-built evaluation core.
- **Not point-of-care alerting yet:** WorkWell includes a Clinical Decision Support (CDS) Hooks service, but it is structurally conformant to CDS Hooks 2.0.1, self-graded, not verified by an external suite, and the CDS Hooks JWT client-auth profile is not implemented. Additionally, no documented or configured client integration exists today; whether WebChart can act as a CDS Hooks client is an open question with MIE. Alerting today happens only on WorkWell's own screens.
- **AI never decides compliance:** Artificial intelligence never determines whether a patient meets a quality measure. AI tools are strictly limited to assistive drafts and summaries for human review. The clinical measure engine remains the sole authority on compliance verdicts.

## What differentiates it

- **Runs CMS's own published logic:** Many quality systems rewrite official electronic clinical quality measures (eCQMs) into proprietary rules, risking logic discrepancies. WorkWell can execute the Centers for Medicare & Medicaid Services (CMS) published measure files directly. Today that is true for two measures, CMS122 and CMS125, and only on the TWH deployment; the Maui sandbox currently runs WorkWell's authored versions of those two measures. The other vendored CMS measures have been checked against the measure authors' own test cases but are not yet runnable.
- **Evidence retained per patient per measure:** For authored measures, WorkWell retains every named rule's result per patient per measure; for official-routed measures, it retains population membership (initial population, denominator, exclusions, numerator) per patient, because WorkWell strips the position markers from CMS's published files to make them deployable, and the calculator needs those markers to report a trustworthy per-rule trace.
- **Occupational and OSHA content nobody publishes:** The national catalogs contain no occupational-health patient-level measures. WorkWell authors dedicated measures for workplace health regulations—such as OSHA standard threshold shifts for occupational hearing conservation—where national digital measure specifications do not exist.
- **Published modular packages:** The core evaluation engine is decoupled from the clinical catalog and published as public npm packages with cryptographically verified provenance.

## What runs where today

WorkWell operates across two primary environments:

- **The Total Worker Health (TWH) demo instance:** Demonstrates occupational compliance alongside official CMS measures (CMS122 for diabetes glycemic control and CMS125 for breast cancer screening) over a synthetic workforce.
- **The Maui pilot sandbox:** A dedicated sandbox deployment for the pilot group (a primary-care group preparing for a Medicare Shared Savings Program ACO in performance year 2027). The Maui sandbox features patient-driven terminology, clickable status counts that open the matching patient list, and a synthetic primary-care roster.

Both instances run entirely on synthetic clinical data. A separate staging stack has exercised the live-EHR path against a WebChart trial system, which is how the integration is verified without putting real patients in the demo or the sandbox. There is no Protected Health Information (PHI) anywhere in the repository or sandbox environments. The pilot's production use with real patient data (PHI) is a separate, future phase requiring formal HIPAA and tenant-isolation controls.

## How it fits a quality team's day

- **The provider-panel work list:** Quality coordinators typically manage patient panels assigned to specific primary care clinicians rather than reviewing disconnected measure spreadsheets. A planned milestone (MM-2, after the measure set) builds work lists organized by provider panel so coordinators can address all open care gaps across a clinician's assigned panel in one place.
- **Cards that resolve:** Today, care-gap cards link to the patient's compliance view in WorkWell. Approved draft-order suggestions already exist for three occupational measures with approved mappings; a planned milestone (MM-3) adds pilot-specific order pick lists, local terminology mappings, and the exception path (blocked on order-mapping and clinical guidance).
- **An essential clinical rule:** An order never closes a care gap. Placing an order is a proposal; the gap closes only when the completed result returns to the medical record and the engine re-evaluates the patient.

## Honesty guardrails

- **Measure authorship:** WorkWell authors its own measure specifications from public statutes and clinical guidelines. Its HEDIS-style wellness measures are authored from public clinical guidance and cite HEDIS by name only.
- **Grounded standards claims:** Conformance claims are strictly limited to what is verified in [Standards Conformance](STANDARDS_CONFORMANCE.md). WorkWell validates clean aggregate QRDA documents and clean patient-level documents for official measures over its synthetic corpus against HL7 base standards (authored-measure patient-level QRDA is nonconformant by design), but does not claim full ONC certification or official agency endorsements. OSHA does not certify software, and WorkWell's OSHA measures represent careful regulatory interpretation, not government validation.
- **Proposed rules remain proposed:** Any future CMS transition timelines toward digital FHIR-based reporting (such as proposals in the CY2027 Physician Fee Schedule proposed rule, CMS-1848-P) are referenced strictly as proposed rules, not final mandates.

## Where to read more

- [The WorkWell Guide](guide/README.md) — Chapter-by-chapter walkthrough of the architecture, clinical logic, and data flow.
- [From the clinic EHR to a quality result](guide/normalization-for-quality-teams.md) — Visual walkthrough showing how clinical records move from WebChart through normalization to quality results.
- [Standards Conformance](STANDARDS_CONFORMANCE.md) — Detailed matrix of verified standards, external testing harnesses, and deliberate boundaries.
