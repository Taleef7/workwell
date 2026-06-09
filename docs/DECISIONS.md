# Architecture Decision Records

## ADR-004: Adopt `@mieweb/ui` as the frontend component library (dark mode + Enterprise Health brand)

- **Date:** 2026-06-09
- **Status:** Accepted
- **Stakeholder:** Doug (direction 2026-06-08: "Mieweb UI" + "use nitro for all tables")
- **Context:** The frontend was built on hand-rolled primitives (CVA + clsx + tailwind-merge) styled with hardcoded `slate-*` Tailwind classes, light-only. Doug's direction is for WorkWell to consume MIE's own component library so the work is reusable across MIE's internal projects and products. `@mieweb/ui` (v0.6.1, public npm, ui.mieweb.org) provides themeable React components (Tailwind 4, dark mode, brand theming incl. Enterprise Health) plus a DataVis NITRO data-grid entry.
- **Decision:**
  - Adopt `@mieweb/ui` as the frontend component library. Primary surfaces use its components (`Button`, `Select`, `Input`, `Badge`, `Modal`, `Toast`, `Skeleton`, `Sidebar`, `AppHeader`).
  - **Brand:** Enterprise Health is the default brand; a runtime brand switcher lives in the header (`useBrand` injects `/brands/{brand}.css`).
  - **Theming:** full semantic-token migration + dark mode (`useTheme` sets `.dark` + `data-theme`; persisted). Status-color helpers in `lib/status.ts` carry `dark:` variants app-wide.
  - **Tables:** DataVis NITRO is the intended data-grid, but it is **deferred** — `@mieweb/datavis` is `private`/source-only and not npm-consumable (see Known Gaps in `frontend/MIEWEB-UI-MIGRATION.md`). Tables stay as themed, swap-ready semantic tables until MIE publishes `@mieweb/datavis`; fallback if needed sooner is `@mieweb/ui/ag-grid`.
  - **Kept:** Monaco (CQL editor) and recharts (rethemed) — no `@mieweb/ui` equivalent.
  - **Exceptions:** `/login` and `/sandbox` remain bespoke pre-auth pages (not part of the themed dashboard surface).
- **Consequences:**
  - The frontend stack line in `CLAUDE.md`, `README.md`, and `AGENTS.md` changes from `shadcn/ui` to `@mieweb/ui` (this ADR authorizes that stack change).
  - New runtime dependency: `@mieweb/ui` (+ its `lucide-react`/CVA peers already present). `@mieweb/ui` must only be imported from `"use client"` modules — its barrel evaluates `React.createContext` at load, which breaks Server Component builds (hence the `components/client-providers.tsx` boundary).
  - Implementation landed phased on `feat/mieweb-ui-migration` → **PR #68**; report-first living doc at `frontend/MIEWEB-UI-MIGRATION.md`; design spec at `docs/superpowers/specs/2026-06-08-mieweb-ui-migration-design.md`.
  - Follow-ups: publish/consume NITRO once available; component-purity swap of native controls on the dense table pages + studio tabs; brand Jost-font fidelity.

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

## ADR-003: Single all-encompassing TWH instance (consolidation from three-instance model)

- **Date:** 2026-05-21
- **Status:** Accepted
- **Stakeholder:** Doug (confirmed direction 2026-05-21)
- **Context:** During the sprint build-out (May 2–17), three separate deployment instances were created to isolate concerns during development: `workwell` (base skeleton), `ecqm` (CMS eCQM catalog seeding), and `twh` (Total Worker Health — OSHA safety measures). Each had its own workflow, frontend image, and partially-seeded database. Doug's May 21 review surfaced that these were not separate products — they were a development stepping stone. From the JOURNAL 2026-05-21 entry:
  > "Doug clarified the product direction: TWH (Total Worker Health) is all-encompassing. OSHA occupational safety compliance and clinical quality (eCQMs, HEDIS wellness) are not separate products — they are two sides of the same coin and belong in one platform. The three-instance deployment model (workwell, ecqm, twh) was a development stepping stone, not the product architecture. One TWH instance covers everything."
  >
  > "NIOSH's TWH framework is the conceptual foundation: worker health is shaped by both workplace hazards (OSHA safety programs) and general health promotion (chronic disease, preventive care). WorkWell is the platform that manages both in one system with a shared measure catalog, shared case workflow, shared audit trail, and shared CQL evaluation engine."
- **Decision:** Consolidate to a single TWH deployment. Delete the `deploy-os-mieweb.yml` (workwell instance) and `deploy-ecqm-mieweb.yml` (eCQM instance) workflows. The sole active workflow is `deploy-twh-mieweb.yml`, which builds the backend (`ghcr.io/taleef7/workwell-api`) and TWH-branded frontend (`ghcr.io/taleef7/workwell-twh-frontend`) and sets `WORKWELL_INSTANCE=twh` to seed all three measure categories on startup: OSHA safety (4 active CQL + 3 catalog-only), HEDIS wellness (4 active CQL), and CMS eCQM catalog (49 Draft entries). The old `workwell` and `workwell-api` MIE containers were deleted from the manager UI. Fly.io `workwell-measure-studio-api` was destroyed (stale secondary stack from the Fly era). The production URLs are `https://twh.os.mieweb.org` (frontend) and `https://twh-api.os.mieweb.org` (backend).
- **Consequences:**
  - `ecqm.os.mieweb.org` and `workwell.os.mieweb.org` are intentionally offline. The workwell hostname currently returns a 404; a 301 redirect to `twh.os.mieweb.org` is the documented follow-up (see infra/redirect/).
  - The eCQM seeding path (`ensureCmsEcqmCatalogSeed()`), the `workwell-ecqm-frontend` image build config, and the `*_ECQM` GitHub secrets are retained as a restore-later capability in case a separate eCQM-only instance is needed in future.
  - Every push to `main` deploys the single TWH environment, giving a clear signal that `main` is always production.
  - The platform can expand its catalog (more OSHA measures, more HEDIS measures, more CMS eCQMs) without any infrastructure change — it is all one seeded database with one shared catalog, case workflow, and audit trail.
  - Cost: reduced — one container pair instead of three.

## ADR-002: evidence_json shape and define-level traceability

- **Date:** 2026-05-01
- **Status:** Accepted
- **Context:** For "Explain Why Flagged", we need to decide whether to keep raw `evaluatedResource` evidence only, add explicit `rule_path[]`, or derive rule path automatically from CQL define results. D1 rechecked this against the repository CQF reference in `docs/CQF_FHIR_CR_REFERENCE.md`, which is the durable source of truth for `cqf-fhir-cr` behavior used by this ADR.
- **Decision:** Adopt the processor two-step composite flow as the canonical run pipeline:
  1. `R4MeasureProcessor.evaluateMeasureWithCqlEngine(...)` to compute `CompositeEvaluationResultsPerMeasure` (including define-level `expressionResults`).
  2. `R4MeasureProcessor.evaluateMeasure(..., compositeResults)` to materialize the standard `MeasureReport` from the same computed results.
- **Evidence from probe:**
  - `R4MeasureService.evaluate(...)` returns `MeasureReport` only; no define-result map is present on `MeasureReport`.
  - `R4MeasureProcessor.evaluateMeasureWithCqlEngine(...)` returns `CompositeEvaluationResultsPerMeasure` containing per-subject `EvaluationResult`.
  - `EvaluationResult.expressionResults` contains define-name/value pairs (probe output included `Denominator`, `Initial Population`, `Numerator` with boolean values).
  - Dual-evaluation cost probe (2026-05-01): `serviceEvaluateMs=5` vs composite flow `combinedMs=2` (`engineEvalMs=2`, `reportBuildFromCompositeMs=0`), so the composite path is a cheaper primary path, not a workaround.
- **Consequences:**
  - `evidence_json` shape is now structured as `{ expressionResults: {...}, evaluatedResource: [...] }`.
  - `rule_path[]` is derived at render time from CQL define names + `expressionResults`; it is not persisted as a stored field.
  - "Why Flagged" UI is structured-first: render `expressionResults` deterministically as the base case; AI natural-language wrapping is optional polish.
  - Outstanding Week 5 confirmation: run this same composite flow against the JPA-backed repository path. Expected yes, not yet tested in this exact combination.
