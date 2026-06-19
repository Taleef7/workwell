# Architecture Decision Records

## ADR-013: E7 order-proposal engine — `ProposedOrder`/`StandingOrderProvider` port (EH-ready, simulated by default)

- **Date:** 2026-06-19
- **Status:** Accepted
- **Epic:** #77 (E7 order generation)
- **Context:** The TWH charter's "Action Evaluators → orders" layer calls for generating proposed
  orders from non-compliant measure findings — audiogram overdue → propose audiogram; TB screening
  overdue → propose TB screen. Three design questions had to be resolved up front.

  **1. Advisory vs. auto-submit.** Orders in clinical systems (EHR, EH) are actionable: submitting
  one can schedule an appointment, trigger a workflow, or notify a provider. Auto-submitting from a
  compliance system without a human review step violates the spirit of the AI_GUARDRAILS rule and the
  project's human-in-the-loop contract. Proposed orders must be advisory — generated for a human
  reviewer who decides to submit or discard.

  **2. Standing-order deduplication.** Duplicate orders are a patient-safety concern (and flagged in
  the charter). The engine must detect when a qualifying standing order already exists for a subject
  and suppress a new proposal for that subject rather than adding a redundant one.

  **3. EH integration.** The real standing-order query and the real order-submission write are EH
  FHIR API calls. Those require credentials and a live EH instance (Doug Q6), and are inert stubs
  today. The `OutreachChannel`/`ImmunizationForecast` port pattern applies: simulated by default,
  inert-unless-configured.

- **Decision:**
  - **`ProposedOrder` domain type** (`backend-ts/src/order/proposed-order.ts`): `{subjectId,
    measureId, order, reasonOutcome, priority, status, dedupeKey, authoredOn,
    suppressedByStandingOrder?}` (`order` is `{code, system, display}`). `toServiceRequest()`
    emits a FHIR R4 `ServiceRequest` (`intent:"proposal"`, `status:"draft"`) hand-built as JSON (no
    FHIR runtime dependency — same pattern as `MeasureReport`/QRDA). `bundleOf()` wraps a set into a
    collection `Bundle`.
  - **`order-catalog.ts` — action-evaluator map:** runnable measure → `OrderCode` (system + code +
    display). Reuses the `terminology_mappings` seed standard codes where present (audiogram → CPT
    92557; tb_surveillance → CPT 86580; flu_vaccine → CVX 141; hazwoper → `hazwoper-exam` in
    `urn:workwell:vs:hazwoper-exams`). LOCAL codes (`urn:workwell:orders`) for measures without a
    seed mapping (e.g., BMI screening). No new DB dependency.
  - **Panel=Risk selection:** `proposeOrders(outcomes, provider)` in `order-proposal.ts` classifies
    the Denominator − Numerator subset: OVERDUE/DUE_SOON/MISSING_DATA outcomes propose; COMPLIANT and
    EXCLUDED do not. Risk maps to `priority`: OVERDUE → `urgent`; DUE_SOON or MISSING_DATA →
    `routine`. The engine is pure and trigger-agnostic — read-time today, callable from the run
    pipeline later without changes.
  - **Dedupe contract:** in-batch per-subject deduplication (one proposal per subject per measure);
    standing-order suppression (subjects with a qualifying standing order are excluded from
    `proposed`, returned separately in `suppressed`). Prevents the "duplicate orders" safety concern
    from the charter.
  - **`StandingOrderProvider` port** (`backend-ts/src/order/standing-order-provider.ts`):
    `simulatedStandingOrderProvider` (default — deterministic ~1/5 of subjects have a standing order,
    no HTTP) + inert `ehStandingOrderProvider` stub (selected only when both
    `WORKWELL_EH_FHIR_BASE_URL` + `WORKWELL_EH_FHIR_API_KEY` are set; performs no real HTTP; returns
    empty). `resolveStandingOrderProvider(env)` selects between them. **Inert-unless-configured**,
    mirroring ADR-011 (SendGrid/DataChaser) and ADR-012 (ICE).
  - **Proposals are advisory — never auto-submitted.** A human reviews and submits. This is the
    order-generation analog of "AI never decides compliance": the engine proposes, the operator acts.
    The real EH write path (`OrderSubmitter`) is **named but deferred** (documented drop-in) — when
    Doug Q6 is answered and EH credentials are available, it drops in without touching the proposal
    engine.
  - **`GET /api/orders/proposals?measureId=&subjectId=&from=&to=&format=domain|fhir`** — gated
    CASE_MANAGER/ADMIN (`authorize.ts` `rx("/api/orders/**") → [CM, A]`). Selects the latest
    population run per Active measure (reuses `rollup-shared.ts` `isPopulationRun` + `latestRunRows`).
    `format=domain` → `{proposed, suppressed}` JSON; `format=fhir` → FHIR R4 ServiceRequest
    `Bundle` (proposed only). Read-time; **no schema change**.
  - **No schema change.** Proposals are derived read-time from `outcomes`; nothing is persisted. The
    production drop-in is an `OrderSubmitter` EH FHIR write + a `submitted_orders` audit table
    (owner-gated, not built today).

- **Consequences:**
  - Adding the real EH standing-order query and the real `OrderSubmitter` write are port adapter swaps
    behind `resolveStandingOrderProvider` and a future `OrderSubmitter` port, env-gated; the demo
    stays simulated by default with zero config (CLAUDE.md hard rule preserved).
  - No schema migration today. No compliance-logic change — proposals never set or override
    `Outcome Status`. CQL `Outcome Status` remains the sole source of truth.
  - Proposals are advisory: human submits, system proposes. This invariant is documented in
    `docs/ARCHITECTURE.md` §6 and enforced by the endpoint returning read-only data with no write
    side-effects.
  - Ships on `feat/issue-77-order-generation`; deploys on merge to `main`.

## ADR-012: E6 immunization & forecasting — `ImmunizationForecast` port (ICE-ready, simulated by default) + AIS-E Td/Tdap measure

- **Date:** 2026-06-19
- **Status:** Accepted
- **Epic:** #76 (E6 immunization & forecasting)
- **Context:** E6 adds immunization forecasting alongside a new runnable measure for adult immunization
  status. Three design questions had to be resolved up front.

  **1. Port shape and ICE integration.** Immunization forecasting in clinical quality uses the
  Immunization Calculation Engine (ICE), a CDC-supported CDS service. The demo stack must stay
  simulated by default (CLAUDE.md hard rule), and the exact ICE integration surface (CDS Hooks
  vs. the REST API vs. a WebChart-ICE bridge) is an open question deferred to Doug (#76 Q5). The
  `OutreachChannel` port pattern from ADR-011 applies directly: simulated adapter by default, inert
  stub when real env vars are set.

  **2. Measure vs. forecast split.** The synthetic data model is single-event per subject per
  measure — one enrollment/waiver/event Condition. A true multi-series composite immunization measure
  (Td/Tdap + Influenza + Hepatitis B) would require reworking the shared synthetic infra used by all
  10+ existing measures. Forcing a composite on the existing infra would be a wide blast radius with
  no correctness benefit.

  **3. Measure choice.** NCQA HEDIS AIS-E (Adult Immunization Status) is the natural fit for a TWH
  employer wellness platform. CMS117 (Pneumococcal Vaccination, pediatric) is a mismatch for an
  adult workforce. CMS127 (Pneumococcal Vaccination for adults 65+) was explicitly considered and
  rejected: it covers a narrow age cohort, measures ever-received not time-to-next, and forecasting
  is ill-suited to a near-permanent binary outcome. AIS-E Td/Tdap single-series (10-year window) is
  the correct real NCQA measure, implementable within the existing single-event model.

- **Decision:**
  - **`ImmunizationForecast` port** (`backend-ts/src/engine/immunization/immunization-forecast.ts`):
    `ImmunizationForecast` interface + `simulatedForecaster` default (ACIP-style "next dose due" over
    the port's OWN deterministic per-subject synthetic immunization history — `syntheticImmunizationHistory`,
    epoch-anchored — covering 3 series: Td/Tdap 10y, Influenza annual, Hepatitis B 3-dose series) +
    an inert `iceForecaster` stub (selected only when both `WORKWELL_IMMZ_ICE_API_KEY` +
    `WORKWELL_IMMZ_ICE_BASE_URL` are set; returns a "ICE not wired (Doug Q5)" reason; **no real HTTP**).
    `resolveForecaster(env)` selects between them. Mirroring ADR-011's SendGrid/DataChaser posture:
    **simulated by default, inert-unless-configured**.
  - **Forecasting is advisory only** — an analog to the AI_GUARDRAILS rule. `ImmunizationForecast`
    output is labelled advisory on every surface; `CQL Outcome Status` remains the sole compliance
    authority. The forecaster never sets or overrides a case status.
  - **`adult_immunization` measure** — AIS-E Td/Tdap single-series: CQL `backend-ts/measures/adult_immunization.cql`
    + YAML, seeded Active in the HEDIS wellness category. 10-year window (3650 days); Td/Tdap
    contraindication → EXCLUDED; refusal (documented `tdap-refusal` Condition) stays open (a `Refused`
    define flags it but does not exclude — refusals need case-manager intervention). Outcomes: COMPLIANT
    ≤3590 days, DUE_SOON 3591–3650, OVERDUE >3650, MISSING_DATA no record. Catalog total: **61 measures,
    11 runnable**.
  - **Measure vs. forecast split** is the correct model: the measure covers the NCQA single-series
    Td/Tdap obligation (answering "is this worker current?"); the forecaster covers all 3 series
    advisory-only (answering "when is the next dose due?"). A composite multi-series measure and
    age-gated indicators (zoster 50+, pneumococcal 65+) are documented follow-ups.
  - **Case-detail enrichment:** `GET /api/cases/:id` attaches an advisory `immunizationForecast` (the
    3-series forecast) for `adult_immunization` cases only; rendered as an advisory panel on `/cases/[id]`.
  - **Endpoint:** `GET /api/immunization/forecast?subjectId=&asOf=` → `ImmunizationForecast` JSON;
    `asOf` defaults to today, validated YYYY-MM-DD (400 on malformed); authenticated under `/api/**`.
    Read-time; **no schema change**.
  - **Doug Q5 deferred** behind `iceForecaster` stub. When Doug's answer arrives, the production ICE
    adapter drops in behind `resolveForecaster` with zero impact on the measure or case logic.

- **Consequences:**
  - Adding a real ICE adapter is a port adapter swap behind `resolveForecaster`, env-gated; the demo
    stays simulated by default with zero config (CLAUDE.md hard rule preserved). ICE is inert until
    configured — no live HTTP, no overclaim.
  - No schema migration today. The production drop-in is an `immunization_forecasts` cache table fed
    by a real ICE adapter (analogous to the §3.17 E5 `PgCampaignStore` drop-in). `adult_immunization`
    adds no new columns.
  - Forecasting is advisory; the `ImmunizationForecast` port never influences `Outcome Status`. This
    is the immunization analog of "AI never decides compliance."
  - Ships on `feat/issue-76-immunization-forecasting`; deploys on merge to `main`.

## ADR-011: E5 outreach at scale — multi-channel `OutreachChannel` port + staged (audit-backed → Pg) campaign persistence

- **Date:** 2026-06-19
- **Status:** Accepted
- **Epic:** #75 (E5 outreach at scale)
- **Context:** E5 generalizes per-case outreach into (a) multiple delivery channels and (b) bulk
  campaigns over many cases. Two design questions follow: how to add SMS/PHONE and a real outreach
  vendor (DataChaser) without violating the CLAUDE.md "simulated by default on the demo stack" hard
  rule, and how to persist a campaign given that schema is owner-gated (both the SQLite floor
  `schema.ts` **and** the Pg ceiling `schema-pg.ts`) and the actual sends are still simulated. Contrast
  with E4 (ADR-010), where the hierarchy was a **derived** read-time view — so adding no schema was
  the *correct* model there. A campaign is different: it is **created state** (an operator launches it
  with specific filters/channel and gets back a result), not derivable from existing rows.
- **Decision:**
  - **Multi-channel `OutreachChannel` port** (`backend-ts/src/case/outreach-channel.ts`):
    `ChannelType` EMAIL/SMS/PHONE, each with a **simulated** adapter (EMAIL delegates to the existing
    simulated email service; SMS/PHONE body-only), plus an inert **DataChaser stub** (`dataChaserChannel`
    — returns QUEUED with a self-describing stub note, **no real HTTP**). `resolveChannel(type, env)`
    returns the simulated adapter **by default** and the DataChaser stub **only** when both
    `WORKWELL_OUTREACH_DATACHASER_API_KEY` + `WORKWELL_OUTREACH_DATACHASER_BASE_URL` are set
    (inert-unless-configured, mirroring the SendGrid posture). `dispatchOutreach` (`case-outreach.ts`)
    is the shared send core for both single-case send and campaigns; the per-case action and
    `POST /api/cases/:id/actions/outreach?channel=` honor a channel (default EMAIL; PHONE → `tel:`,
    SMS → `sms:`, EMAIL → `@workwell-demo.dev` synthetic addresses).
  - **Staged campaign persistence behind a `CampaignStore` port — audit-backed NOW, Pg tables LATER.**
    A campaign persists as a single `OUTREACH_CAMPAIGN_COMPLETED` audit event (payload =
    `{campaign, recipients}`); the demo adapter (`audit-campaign-store.ts`) reads by scanning
    `listAuditEvents` and filtering by event type (O(ledger-size), demo-scale). **No new DDL** on either
    floor or ceiling. The documented production drop-in is a `PgCampaignStore` over `outreach_campaigns`
    + `outreach_delivery_log` (+ an owner migration). **Why staged rather than just writing the tables:**
    because the campaign *is* created state it cannot be derived (so ADR-010's no-schema rationale does
    not transfer), **but** the sends are simulated, DataChaser is a stub, and the schema is owner-gated
    on both stores — so writing real tables now would add DDL the simulated layer can't actually
    exercise. A port stages the decision: the demo runs audit-backed today; the Pg store drops in when
    real sends + owner-approved schema land together.
  - **`POST /api/campaigns` gated to CASE_MANAGER/ADMIN** (`authorize.ts` rule
    `rx("/api/campaigns/**") → [CM, A]`), matching per-case outreach — this also closed an authz gap
    found in review (campaigns must not be more permissive than the single-case action they batch).
- **Consequences:**
  - Adding a real channel/vendor is a port adapter swap behind `resolveChannel`, env-gated; the demo
    stays simulated by default with zero config (CLAUDE.md hard rule preserved). DataChaser is an inert
    stub until configured — no live HTTP, no overclaim.
  - Campaign reads are O(ledger-size) on the audit adapter — acceptable at demo scale, and the reason
    the Pg drop-in exists for production.
  - No schema migration today; no AI/compliance-logic change — campaigns send outreach, they never
    decide compliance. CQL `Outcome Status` remains the sole source of truth.
  - Ships on `feat/issue-75-outreach-at-scale`; deploys on merge to `main` (not yet live).

## ADR-010: E4 multi-level hierarchy — provider = attributed clinician, modeled in the synthetic directory (no DB schema)

- **Date:** 2026-06-18
- **Status:** Accepted
- **Epic:** #74 (E4 multi-level dashboards); sub-issues #93 (E4.1 hierarchy model) + #94 (E4.2 rollups + UI)
- **Context:** E4 needs a multi-level compliance view above the per-measure programs overview —
  enterprise → location → provider → patient. The roadmap flagged E4.1 (#93, "org/provider hierarchy
  data model") as a likely **schema change = stop-and-ask**. The key finding on inspection: `backend-ts`
  has **no `employees` DB table** — the workforce is the synthetic directory
  (`engine/synthetic/employee-catalog.ts`), and `outcomes`/`cases` persist only `subjectId`. So the
  hierarchy can be added entirely as read-time structure over the existing synthetic data with **no
  migration**, which satisfies the #93 stop-and-ask gate without writing any SQL.
- **Decision:**
  - **Provider = the attributed occupational-health clinician** (eCQM/MIPS-authentic: quality measures
    roll up by attributed provider), strictly **nested under location** (`site`). Each `EmployeeProfile`
    gains a `providerId`; new exports `ENTERPRISE` (root), `PROVIDERS` (8 synthetic clinicians, 2 per
    location across Plant A / Plant B / HQ / Clinic), `providerById`, `providersForLocation`. The
    enterprise→location→provider→patient levels live **only in the synthetic directory** — **no DB
    schema change, no `employees` table, no migration**.
  - The rollup is a **read-time read model** (`backend-ts/src/program/hierarchy-rollup.ts`,
    `buildHierarchyRollup`) over the same outcome rows the programs overview uses (latest population run
    per Active measure; CASE/EMPLOYEE reruns excluded). Exposed via `GET /api/hierarchy/rollup`. Shared
    helpers extracted to `rollup-shared.ts`; the date-param parser to `routes/query-dates.ts`.
  - **UI:** a semantic nested expandable drill-down table at `/programs/hierarchy` (NITRO grid deferred
    until `@mieweb/datavis` is published — ADR-007).
- **Consequences:**
  - **Reconciliation invariant is the testable backbone:** because providers are strictly nested under
    locations (and locations under the enterprise), parent count totals = Σ children at **every** level.
    This is the property the rollup tests assert.
  - A future real `EmployeeDirectory`/org-hierarchy adapter (ADR-005 ports) can supply the same
    enterprise→location→provider→patient shape behind the read model without touching the rollup or the
    API. If a relational org-hierarchy table is ever introduced, that **would** be a schema change and a
    fresh stop-and-ask.
  - No AI/compliance-logic change; CQL `Outcome Status` remains the sole source of truth.

## ADR-009: Emit eCQM artifacts JVM-free; QRDA III as a structurally-representative stub

- **Date:** 2026-06-18
- **Status:** Accepted
- **Context:** E3 (eCQM artifact completeness, #73) adds FHIR `MeasureReport` (#89), real value-set expansion (#90), and a QRDA Category III aggregate export (#91). The reference validators for these standards (the HL7 FHIR validator, the QRDA III IG Schematron) are Java tools, and the stack is deliberately JVM-free with a no-new-dependency rule (ADR-008). We must decide how "conformant" each emitted artifact is and how conformance is asserted.
- **Decision:** Emit all eCQM artifacts JVM-free, hand-built (no FHIR/CDA runtime, no XML/Schematron validator dependency), and assert conformance **structurally** (required elements/codes/cardinality + balanced-by-construction XML), not via the official validators. The **QRDA III export is an explicit stub**: well-formed and structurally representative (well-known QRDA III IG template OIDs, aggregate population counts + performance rate reconciled with `outcomes` via the shared `countPopulations`), but **not** IG/Schematron-validated, and its internal observation `code` values are placeholders pending IG alignment. FHIR `MeasureReport` is structurally conformant (R4 elements + `measure-population` codes), not HL7-validator-checked.
- **Consequences:**
  - Conformance levels are documented honestly in `docs/STANDARDS_CONFORMANCE.md` (the matrix marks QRDA III "Stub").
  - Full QRDA III IG/Schematron validation, IG-exact codes, and multi-measure aggregation are tracked as future work; a real validator would reintroduce a JVM or a new dependency (a separate, approved decision).
  - Counts reconcile across artifacts by construction (one `countPopulations` source), so MeasureReport and QRDA III agree for the same run.

## ADR-008: De-Java the backend — re-platform onto TypeScript / `@mieweb/cloud` (strangler-fig)

- **Date:** 2026-06-12
- **Status:** Accepted — **DONE (2026-06-17).** `twh.os.mieweb.org` is served by the TS backend (`twh-api-ts`) on Neon (Pg ceiling, `workwell_spike` schema). The blue-green flip went live (#109 PR #159), and **#109 PR4 retired the JVM**: `backend/` deleted, Java build/deploy jobs + the shadow workflow removed, `backend-ts` is the CI-gated sole backend, and a self-heal reconciler covers reboot/crash recovery. The zero-Java end state is reached.
- **Stakeholder:** Doug Horner (`horner`) — issue [#96](https://github.com/Taleef7/workwell/issues/96)
- **Plan:** `docs/superpowers/plans/2026-06-12-issue-96-dejava-replatform.md`
- **Context:** Doug's #96 changes the repo direction: the backend must **not require Java/Spring Boot,
  a JVM, Spring DI, Spring Data, or Spring MVC** to run, test, or deploy. `@mieweb/cloud` (a v0.0.0
  Cloudflare-shaped portability layer) becomes the pluggable backend; application code calls explicit
  repository contracts (e.g. `runStore.createRun(input)`, `runStore.claimNextQueuedRun(workerId)`) and
  each runtime adapter (Cloudflare native / local Node / SQLite / D1 / Postgres / S3-MinIO / Valkey)
  implements them. Principle: **"SQLite/D1 define the portable floor; Postgres provides the
  performance ceiling."** A lightweight query builder (Drizzle or Kysely) handles schema/migrations/
  CRUD, **not** the portability layer. This supersedes the ADR-001 "single Spring Boot deployable"
  decision for the backend runtime (ADR-001 remains the historical record of why the monolith was
  right for the MVP timeline). The frontend (ADR-004/007) is unaffected.
- **Decision:**
  - **Strangler-fig re-platform**, not a big-bang rewrite. Port the backend to TypeScript
    module-by-module **behind the unchanged frontend API contract** (`frontend/lib/api/client.ts` URL
    + request/response shapes are the seam); nothing is deleted until its TS replacement passes parity.
  - **CQL engine = Path C (confirmed by Taleef 2026-06-12).** Keep CQL and eCQM standards-compliance;
    run the Java `cql-to-elm` translator **offline at authoring/build time only** (committing ELM JSON +
    FHIRHelpers + ModelInfo + expanded value sets) and **execute ELM in Node** via
    `cql-execution`/`fqm-execution`. Java thus leaves the **runtime/deploy-required** path entirely,
    surviving only as a build tool. Rejected: Path B (FHIRPath, zero Java but abandons CQL/MAT — gives up
    the differentiator). Fallback if Path C fails parity: keep the Java engine as an isolated evaluation
    microservice (Java stays required to deploy — last resort).
  - **Live CQL authoring is preserved (no functionality compromise).** The Studio CQL compile gate
    stays; CQL→ELM translation runs in Node (see the 2026-06-12 update) — never requiring a JVM.

- **Update 2026-06-12 — Phase-1 spike GO + zero-Java end state (Taleef, per Doug's #96):**
  The Phase-1 vertical-slice spike (#103) cleared the gate on evidence:
  - The TS worker runs on the `@mieweb/cloud` local Node host; `RunStore` works over `CloudDatabase`
    (SQLite floor) with an atomic queue-claim; live `POST /api/runs` · `GET /api/runs/:id` · `claim`.
  - **CQL Path C golden parity across all 10 runnable measures × 4 scenarios — 40/40 exact** (452
    define comparisons) vs the Java engine, incl. the eCQMs (CMS122 value-based, CMS125 820-day),
    season-based flu (`Measurement Period`), and count-based hazwoper/tb. The feared ValueSet-expansion
    risk is **absent** — all 10 measures use inline code filters (no `in "ValueSet"`), so no terminology
    service is needed.
  - **Zero Java is achievable with no functional compromise, so we take it (Doug's stated end state).**
    `@cqframework/cql` (v4.0.0-beta.1, Apache-2.0) — the cqframework reference translator compiled to
    **pure Node via Kotlin Multiplatform, no JVM** — translates all 10 measures' CQL→ELM (errors=0), and
    that Node-translated ELM evaluates **40/40 exact** against the Java golden. So CQL→ELM, the last Java
    touchpoint, **also runs in Node**: Java/Spring Boot leaves the project **entirely** — runtime, build,
    and authoring. The earlier "JVM evaluator sidecar / build-time Java" fallbacks are demoted to
    contingency only (used solely if `@cqframework/cql` regresses before cutover).
  - **Guardrails:** the `@cqframework/cql` beta version is **pinned**; the full-catalog golden-parity
    harness (`backend-ts/spike/compare-all.mjs`) is the **regression gate** on every bump/measure change;
    the Java `ElmCompilerCli` is retained transitionally as a cross-check, removed with the rest of Java
    when the TS engine binding lands (#106). Three standard version-stable resources (System + FHIR-R4
    model-info XML, FHIRHelpers CQL) are committed config, not a Java dependency.
  - Evidence + reproduce: `backend-ts/spike/README.md` (PR #112).
  - **Reusable-module mandate (Vision Doc, Doug 2026-06-08):** each layer ships as a reusable MIE
    package (frontend on `@mieweb/ui`, backend on `@mieweb/cloud`), and the headless
    `evaluate(patient, measure.yaml)` evaluator (ADR-006) survives as a first-class reusable TS artifact.
  - **Engine as an explicit swappable compute binding (not the app framework).** The worker calls an
    `EvaluateMeasure` binding like an AI/vector provider; the portability layer is JVM-free regardless.
    Path C (Node-ELM execution) is the **preferred** binding implementation; a **JVM evaluator sidecar**
    is the fallback implementation (decided by the Phase-1 parity spike). A target with no CQL binding
    **raises `UnsupportedBindingError`, never guesses a status** — same invariant as "AI never decides
    compliance." Full storage decomposition into `RunStore`/`CaseStore`/`OutcomeStore`/`MeasureStore`/
    `AuditStore` contracts, the answers to Doug's 9 questions, and the repo-grounded Spring footprint are
    detailed in the companion memo `docs/MIEWEB_CLOUD_REFACTOR_MEMO.md`. The eventual zero-JVM endgame
    (no sidecar) ties to roadmap epic **E9/#78 (CQL→SQL / transpile)**, tracked separately.
  - **Not a FHIR server.** Postgres stays the system of record; FHIR R4 bundles remain transient,
    synthesized in-memory only to feed the engine. We adopt TS FHIR *typing* (`@types/fhir`), not a TS
    FHIR server. `node-on-fhir/honeycomb` (Meteor + MongoDB + AGPL-3.0, no CQL) is **not adopted**;
    Medplum (monolithic platform) is overkill.
  - **Deploy target:** Node container on MIE Create-a-Container (not Cloudflare Workers yet) — same
    `deploy-twh-mieweb.yml` v1 Container Manager flow with the JVM image swapped for a Node image.
  - **`@mieweb/cloud` added as a git submodule** and co-developed: `@mieweb/cloud-postgres` does not
    exist yet and is built as part of Phase 2.
  - **Parity is the gate.** A Phase-1 vertical-slice spike must show one measure's TS output equals the
    Java engine's `Outcome Status` + key `expressionResults` for the shared employee fixtures before the
    expensive phases proceed (GO/NO-GO).
- **Consequences:**
  - Tracked as epic sub-issues under #96 (Phases 0–5) on the "WorkWell #96 — De-Java Re-platform" board.
  - The `evidence_json` contract (ADR-002), the `audit_event`-on-every-state-change invariant, case
    idempotency, and "AI never decides compliance" all carry forward unchanged into the TS backend.
  - **JSONB-floor tension:** the schema's Postgres JSON ops must either be reworked to the SQLite/D1
    floor or surfaced as honest `UnsupportedBindingError` on constrained adapters — resolved per-target.
  - Schema migrations remain **Taleef-owned**; no agent writes `V0xx`/new migrations without explicit
    instruction. The 21 existing migrations define the data model the Drizzle/Kysely schema mirrors.
  - End state: Java/Spring/Gradle removed from the backend; `CLAUDE.md`/`README.md` stack lines change
    from "Java 21 + Spring Boot" to the TS/`@mieweb/cloud` stack when Phase 5 lands (a future ADR amends
    the "immutable stack" line at that point).

## ADR-007: Vendor `@mieweb/datavis` (NITRO grid) source to unblock the data grid

- **Date:** 2026-06-11
- **Status:** Accepted
- **Stakeholder:** Doug (direction 2026-06-08: "use nitro for all tables"); supersedes the "deferred" stance in ADR-004.
- **Context:** ADR-004 deferred the DataVis NITRO grid as "not npm-consumable." On closer inspection that was incomplete: the published `@mieweb/ui@0.6.1` **does** ship the NITRO bundle (`dist/datavis.js` + the `./datavis` export), but that bundle imports from a **bare `datavis` specifier** (raw `datavis/src/...` `.ts`/`.tsx`) plus `datavis-ace`. `datavis-ace@=4.0.0-PRE.2` **is** on public npm; the `datavis` UI source is **not** published, but the `github.com/mieweb/datavis` repo is **public**, and `@mieweb/ui`'s own build marks `/^datavis\//` external — expecting the consumer to provide `datavis`, exactly as the upstream monorepo does via a `file:` link. So NITRO is consumable today by mirroring that.
- **Decision:**
  - **Vendor the `datavis` source** into `frontend/vendor/datavis` (pinned to upstream commit `52c27cc`, matching `@mieweb/ui@0.6.1`) and alias it `"datavis": "file:./vendor/datavis"`. Runtime deps added: `datavis-ace@=4.0.0-PRE.2`, `@dnd-kit/*`, `i18next`, `react-i18next`. Provenance + upgrade recipe in `frontend/vendor/datavis/VENDORING.md`.
  - **Wiring:** `transpilePackages: ["datavis", "@mieweb/ui"]` (Next must transpile both so the extensionless deep imports resolve); Tailwind `@source "../vendor/datavis/src"` + the `.wcdv-*` custom classes. Both Dockerfiles `COPY vendor` before `pnpm install`.
  - **Integration seam:** `features/datavis/NitroGrid*.tsx` — client-only (`next/dynamic`, `ssr:false`, because the engine touches `window` at module load), local in-memory data via the upstream `createMockView` pattern (no `http` fetch; the authed API client still owns data loading). Pages import the wrapper, never `@mieweb/ui/datavis` directly. Rich cells preserved via NITRO's `formatCell` (returns `ReactNode`).
  - **Applied to the strong-fit operational/audit tables:** `/measures`, `/runs` (Outcomes), `/admin` ×3 (data mappings, terminology mappings, delivery log). Small in-card tables (`/programs/[measureId]`, studio panels, `/employees/[externalId]`) intentionally stay semantic — NITRO chrome too heavy.
- **Consequences:**
  - Vendored MIE-internal source now lives in the tree (public, used under its license). Brittle on `@mieweb/ui` upgrades — the deep import paths are the contract to re-verify; VENDORING.md documents the re-vendor step. The clean long-term fix (MIE publishes a built `@mieweb/datavis` to npm so `vendor/` can be deleted) remains tracked in `questions_for_doug.md`.
  - Vendored source is excluded from our eslint (`vendor/**`).
  - Landed on `feat/datavis-nitro-unblock`. The remaining `@mieweb/ui` form-control component-swap is split out as issue #99.
  - No backend/schema/API/compliance change.

## ADR-006: Declarative YAML measure definitions + headless evaluator CLI

- **Date:** 2026-06-10
- **Status:** Accepted
- **Epic:** #72 (sub-issues #85–#88); spec `docs/superpowers/specs/2026-06-10-e2-yaml-measures-design.md`
- **Context:** After E1 (ADR-005), measure bindings still lived in a hardcoded Java switch
  (`SyntheticMeasureDefinitionProvider`), and there was no way to evaluate an arbitrary patient
  outside the web app. Doug's most concrete ask is a "programming layer, no UI: given this patient
  and this YAML file, are they compliant?".
- **Decision:**
  - **YAML is the single source of measure bindings.** One `measures/<id>.yaml` per runnable measure
    (sibling to its `.cql`), schema v1: metadata (`id`, `name` = exact catalog name, `version`,
    `title`, `policyRef`, `tags`) + `cql:` file ref + `bindings:` (enrollment/waiver/event code +
    value set, `event.type: procedure|immunization|observation` replacing the two raw booleans,
    `complianceWindowDays` defaulting to 365). `YamlMeasureDefinitionProvider` loads
    `classpath*:measures/*.yaml` at construction (Spring-core resource resolver as plain library
    code — no ApplicationContext; the no-Spring guard still constructs it with `new`) and is the
    default bean. The hardcoded switch is **deleted**; no `yaml|java` fallback flag (dual sources
    were the #82 smell). Golden parity (100 employees × 10 measures) gates the swap.
  - **Population logic and bucket thresholds stay in the CQL** (`Outcome Status` define) — CQL is
    the single source of logic; YAML is the binding/metadata envelope. Aspirational eCQM packaging
    fields were deliberately not added (extension path documented in the spec for E3).
  - **Headless surface:** public `CqlEvaluationService.evaluateBundle(...)` evaluates an arbitrary
    FHIR `Bundle` and returns `BundleOutcome` (normalized bucket + define-level expression results);
    the synthetic path delegates to the same core. `HeadlessEvaluatorCli` (plain `main`, no Spring,
    no DB) + the Gradle `evaluateMeasure` task expose it:
    `./gradlew.bat evaluateMeasure --args="patient.json measures/audiogram.yaml"` (Java-era form; post-#109
    this is realized JVM-free in `backend-ts` as `pnpm evaluate --patient <bundle.json> --measure <id>`, #72/E2).
    A REST endpoint was deferred (trivial later atop `evaluateBundle`).
  - **No new dependencies:** SnakeYAML (Boot), HAPI JSON parser, Jackson — all already shipped.
- **Consequences:**
  - Authoring a new runnable measure = a `.cql` + a `.yaml` file; no Java changes for bindings.
  - Headless evidence is `expressionResults` + outcome only — the synthetic `why_flagged` block
    derives from `ExamConfig`, which doesn't exist for real bundles (intentional, documented).
  - E3 (#73) plugs MeasureReport/value-set expansion into the same seam; a future real
    `PatientDataProvider` feeds `evaluateBundle` directly.

## ADR-005: Measure engine ports/adapters (same module, synthetic default adapter)

- **Date:** 2026-06-10
- **Status:** Accepted
- **Epic:** #71 (sub-issues #79–#84); spec `docs/superpowers/specs/2026-06-10-e1-measure-engine-ports-design.md`
- **Context:** `CqlEvaluationService` hard-wired its inputs to the synthetic demo: `new SyntheticFhirBundleBuilder()`, the static `SyntheticEmployeeCatalog`, and the per-measure binding switch `measureSeedSpecFor()`. This blocked plugging in real EHR/FHIR data and a declarative measure format (E2) without editing the core. The roadmap (`docs/PLAN.md`) calls for inverting these onto ports so synthetic data today and real data later share one seam.
- **Decision:**
  - Introduce four input ports — `PatientDataProvider`, `EmployeeDirectory`, `MeasureDefinitionProvider`, `EvaluationConfigProvider` — in `com.workwell.engine.port`, with `MeasureDefinition` in `engine.model`. `CqlEvaluationService` is constructed from these ports.
  - The synthetic demo becomes the **default adapter set** in `engine.synthetic` (`@Component` beans). The live TWH demo runs on them unchanged; a future real-data adapter is added as an alternative bean selected by profile/config (the `EngineConfig` seam), with the synthetic beans remaining default (`docs/PLAN.md` principle 5).
  - **Same Gradle module**, not a separate `:engine` project — keeps CI sharding, Docker build, and the OneDrive binary-results workaround untouched. The "Spring-free core" guarantee is enforced by `EngineNoSpringContextTest`, which constructs and runs the engine with plain `new` and no `ApplicationContext`. Future extraction to a dedicated module stays mechanical because the package boundary has no Spring imports.
  - **`OutreachChannel` deferred to E5** (no consumer yet — YAGNI). Four ports now.
  - **Outcome parity is the gate:** a golden-file characterization test captures the deterministic (employee → outcome-status) mapping for all 100 employees × 10 measures and asserts it is unchanged by the refactor.
- **On the "#82 single source of truth":** the value-set/code **bindings** that were duplicated lived only in `CqlEvaluationService.measureSeedSpecFor()`; they are now solely in `SyntheticMeasureDefinitionProvider`. `MeasureService.ensure*Seed()` holds catalog/UI metadata (`spec_json`) and CQL filenames — a separate concern, not the binding data — so no further dedup was warranted there. A speculative name→file catalog was intentionally **not** added (YAGNI; E2's YAML carries the CQL reference).
- **Consequences:**
  - `CqlEvaluationService` public methods (`evaluate`, `evaluateSubject`) are unchanged, so callers (`AllProgramsRunService`, `CaseFlowService`, `MeasureImpactPreviewService`, `SeedHistoricalRunsService`) are unaffected.
  - E2 adds a YAML-backed `MeasureDefinitionProvider`; later epics add real `PatientDataProvider`/`EmployeeDirectory` adapters behind the same ports.
  - No schema migration; no AI/compliance-logic change. AI still never decides compliance; CQL `Outcome Status` remains the sole source of truth.

## ADR-004: Adopt `@mieweb/ui` as the frontend component library (dark mode + Enterprise Health brand)

- **Date:** 2026-06-09
- **Status:** Accepted
- **Stakeholder:** Doug (direction 2026-06-08: "Mieweb UI" + "use nitro for all tables")
- **Context:** The frontend was built on hand-rolled primitives (CVA + clsx + tailwind-merge) styled with hardcoded `slate-*` Tailwind classes, light-only. Doug's direction is for WorkWell to consume MIE's own component library so the work is reusable across MIE's internal projects and products. `@mieweb/ui` (v0.6.1, public npm, ui.mieweb.org) provides themeable React components (Tailwind 4, dark mode, brand theming incl. Enterprise Health) plus a DataVis NITRO data-grid entry.
- **Decision:**
  - Adopt `@mieweb/ui` as the frontend component library. Primary surfaces use its components (`Button`, `Select`, `Input`, `Badge`, `Modal`, `Toast`, `Skeleton`, `Sidebar`, `AppHeader`).
  - **Brand:** Enterprise Health is the default brand; a runtime brand switcher lives in the header (`useBrand` injects `/brands/{brand}.css`).
  - **Theming:** full semantic-token migration + dark mode (`useTheme` sets `.dark` + `data-theme`; persisted). Status-color helpers in `lib/status.ts` carry `dark:` variants app-wide.
  - **Tables:** DataVis NITRO was deferred here, then **unblocked via vendoring** — see **ADR-007**. The strong-fit operational/audit tables now use the real NITRO grid; small in-card tables stay themed semantic tables.
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
