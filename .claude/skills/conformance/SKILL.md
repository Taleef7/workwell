---
name: conformance
description: Check or write standards-conformance claims — eCQM, QI-Core, QRDA-I/III, DEQM, MeasureReport semantics, Cypress/CVU+, ONC certification. Use before asserting in docs, a PR, or a demo that WorkWell conforms to any standard.
---

# Standards conformance

Read **`docs/STANDARDS_CONFORMANCE.md`** — the conformance matrix, section by section. It records what
is verified, what is partial, and what is aspirational.

## Why this is gated

Claiming conformance we cannot demonstrate is a real harm. **Never upgrade a "partial" or "planned" row to
"conforms" without a passing test or a validator run to point at**, and always name **who graded what** —
no FHIR-column check produces a certificate.

**WorkWell is supplementary to WebChart and does NOT pursue ONC certification** (locked decision 1,
2026-08-04). WebChart carries certification (~33/49 measures); WorkWell carries the engine. Never justify
a claim, or a piece of work, with "certification needs it."

## Load-bearing facts

- **Run the OFFICIAL published CQL for official CMS eCQMs — never reauthor.** Self-authored CQL is the
  value only where no official definition exists (occupational/OSHA, HEDIS-insight).
- **The verification bar is the FHIR-column SET in `docs/ROADMAP_2026-08-04.md` §4** — MADiE cases,
  the offline Cypress C2 comparison, the FHIR validator + DEQM STU5 package, cross-execution against Java
  `cqf-fhir-cr`, the Inferno US Quality Core kit, connectathon peer verification, `cql-tests`.
  MADiE is authoring tooling, **not** EHR verification, and it shares our engine.
- **"Cypress CVU+ is the verification bar" is RETIRED (ADR-058).** Cypress can only grade **QDM-lineage**
  documents — `extract_results_by_ids` short-circuits on measure identity — and no FHIR-lineage grader
  exists (`cvu-fhir` abandoned Apr 2023). A **Calculation Check green is not a goal**, and relabelling to
  obtain one is forbidden (ADR-046 d3/d4). QRDA I/III is kept as an **interoperability bridge**; both
  document types measure 0 findings against the HL7 base ruler, and that result stands.
- **Independence matters when citing an oracle:** `fqm-testify` and `deqm-test-server` both wrap
  `fqm-execution`, the library we run. Java `cqf-fhir-cr` is genuinely independent.
- A MeasureReport's population counts use membership labels with per-measure semantics, and its measure
  identity (canonical, improvementNotation, membership) comes from the outcome's own evidence — never from
  the deployment's configuration. (Old `ADR-0NN` ids resolve from git history, as CLAUDE.md says.)
- HEDIS guardrail: our own spec text and cases only — **never** reproduce NCQA specs (DUA).
- QDM appears only as a translation at the QRDA boundary. **The FHIR column: QI-Core v7.0.2 (STU7) aligns
  to US Core 7, but CMS's shipping measure content is authored on QI-Core 6, and the forward direction is
  US Quality Core 0.5.0 over US Core 6.1.0.** Do not assert STU7 as "the surface the content is on."
- **CMS has published NO date** for FHIR-based eCQM reporting. The "~2030" figure is not CMS-attributable.
  QPP accepts QPP JSON and QRDA III XML only.
