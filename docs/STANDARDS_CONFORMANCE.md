# WorkWell Standards-Conformance Matrix

What WorkWell emits across the eCQM toolchain, and the conformance level of each. (#91 / E3.3)

| Artifact | Standard | What WorkWell emits | Conformance level | Notes |
|----------|----------|---------------------|-------------------|-------|
| Measure logic | HL7 CQL 1.x | Authored `.cql` per runnable measure (`backend-ts/measures/*.cql`) | Authored + compiles | Inline-code + value-set-retrieve variants |
| Compiled logic | HL7 ELM | Build-time CQL→ELM (`@cqframework/cql`, JVM-free), committed JSON | Compiled + executed | Runtime engine executes ELM via `cql-execution` |
| Value sets | FHIR ValueSet / VSAC | `ValueSetResolver` expansion → populated `cql.CodeService` (E3.2) | Real expansion (store-backed) | VSAC-ready behind the port; synthetic codes today |
| Measure result (patient + summary) | FHIR R4 MeasureReport | `GET /api/runs/{id}/measure-report` (summary + individual + Bundle) (E3.1) | Structurally conformant | Counts reconcile 1:1 with outcomes; structural (not HL7-validator) |
| Measure definition export | MAT (Measure/Library/ValueSet) | `GET /api/measures/{id}/versions/{vid}/export/mat` (FHIR R4 XML) | MAT-compatible | Hand-built FHIR R4 bundle |
| Aggregate report | HL7 QRDA Category III | `GET /api/runs/{id}/qrda` (CDA XML) (E3.3) | **Stub** | Well-formed + structurally representative; **not** IG/Schematron-validated |

**Notes:** All emitted artifacts are produced JVM-free with no external runtime dependency. The QRDA III
stub uses the well-known QRDA III IG template OIDs and carries the aggregate population counts +
performance rate; full IG/Schematron validation and multi-measure aggregation are future work.
