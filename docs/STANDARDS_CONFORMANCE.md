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
| Evaluated resources | HL7 QI-Core (US Realm) | Synthetic FHIR bundles stamped with QI-Core `meta.profile` + required elements (E3.4) | Structural alignment | `meta.profile` declared + required elements present; **not** IG/validator-validated (ADR-009) |
| Measure fidelity | Official eCQM spec (eCQI/CMS) | Structural fidelity diff of WorkWell's authored measure vs the official spec (`GET /api/measures/:id/fidelity`) (E14) | **Structural / definitional (descriptive)** | Sourced, versioned `OfficialMeasureReference` (CMS122v14) with provenance; per-criterion COVERED/SIMPLIFIED/OMITTED + value-set coverage; **does not execute the official CQL or diff outcomes**; advisory — `Outcome Status` stays authoritative (ADR-008/ADR-018) |

## E14 — standards fidelity (authored measure vs official eCQM spec)

WorkWell's eCQM measures (`cms122`, `cms125`) are hand-authored, **simplified** CQL (local value sets,
WorkWell-specific defines, gist-level logic). E14 (#186) makes the **officially published** measure
definition the reference and produces a **documented structural fidelity diff** of WorkWell's authored
version against it:

- **Sourced reference:** `backend-ts/src/standards/references/cms122v14.ts` — a vendored,
  provenance-carrying `OfficialMeasureReference` for **CMS122v14** (v14.0.000, steward NCQA, proportion):
  the official population criteria (IPP/DENOM/DENEX/NUMER/NUMEX), the ~21 official VSAC value sets, and a
  curated, grounded coverage judgement per criterion. Every claim is transcribed from the cited official
  sources (eCQI Resource Center HTML + QPP MIPS frozen-code PDF) — no VSAC login.
- **The diff:** `computeFidelity(ref)` (`backend-ts/src/standards/measure-fidelity.ts`) is a pure assembler
  → a `FidelityReport`: each criterion classified `COVERED | SIMPLIFIED | OMITTED` with a note,
  value-set coverage (which official concepts WorkWell represents), reconciling summary counts, a
  data-driven headline, and a disclaimer that it is structural, not an outcome diff.
- **Endpoint:** `GET /api/measures/:id/fidelity` → the report for a measure with an official reference
  (cms122 today); `{ available: false }` (200) for measures without one; 404 for an unknown measure id.
  Read-only, authenticated, read-time, **no schema**.
- **Conformance level:** **structural / definitional (descriptive)**. It documents exactly where the
  authored measure diverges *in definition* from the official spec; it does **not** execute the official
  CQL. **Official-CQL execution + an evaluated-outcome diff is deferred to E14 PR-2**, behind the existing
  E3.2 (#90) `ValueSetResolver` seam (with frozen QPP code lists as a no-VSAC expansion source). The report
  is advisory — CQL `Outcome Status` remains the sole compliance authority (ADR-008/ADR-018).

**Notes:** All emitted artifacts are produced JVM-free with no external runtime dependency (see ADR-009).
The QRDA III stub uses the well-known QRDA III IG template OIDs and carries the aggregate population counts +
performance rate; **its internal observation `code` values (e.g. on the performance-rate observation) are
placeholders pending QRDA III IG alignment** — the document is structurally representative, not IG-code-exact.
Full IG/Schematron validation, IG-exact codes, and multi-measure aggregation are future work.
