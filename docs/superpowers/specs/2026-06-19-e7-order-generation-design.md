# E7 — Order / Action Generation — Design Spec

- Date: 2026-06-19
- Epic: #77 (E7 — Order/action generation, Smart Plan / Standing Orders, Wave 3)
- Branch: `feat/issue-77-order-generation`
- Status: Approved design, pre-implementation
- Depends on: E1 ports/adapters (#71, ADR-005); mirrors E5/E6 simulated-by-default / inert-real-provider patterns (ADR-011, ADR-012)

## 1. Goal

Generate **proposed orders** (not just outreach) from non-compliant measure findings — the charter's
"Action Evaluators → orders" — behind an interface-ready, EH-deferred seam. The output is a proposal
(advisory): a human reviews and submits. The charter's hard warning ("duplicate orders are bad") is
honored by deduplicating proposals against existing **standing orders**.

Per #77 this epic is **design-only until the Enterprise Health (EH) integration path is known**. We
therefore build the **full simulated seam** — engine, ports, FHIR mapping, dedupe, an endpoint, tests
— with **no production code that depends on EH**. Real standing-order lookup and real order
submission are inert/deferred behind named ports (same approach E6 took for ICE).

## 2. Charter mapping (Panel = Risk)

The charter's population terms map directly onto our existing outcome model:

| Charter term | Our model |
|---|---|
| Membership = Denominator | the measure's eligible population = non-`EXCLUDED` outcomes |
| Numerator = met-within-deadline | `COMPLIANT` outcomes |
| **Panel = Risk** (the gap) | Denominator − Numerator = `OVERDUE` / `DUE_SOON` / `MISSING_DATA` |

**Only the at-risk gap gets a proposed order.** `COMPLIANT` and `EXCLUDED` get none. The risk tier is
reflected in the order's FHIR `priority`:

| Outcome | Propose? | `ServiceRequest.priority` | Note |
|---|---|---|---|
| `OVERDUE` | yes | `urgent` | past deadline |
| `DUE_SOON` | yes | `routine` | **proactive pre-deadline auto-order — the "best of the best" case** |
| `MISSING_DATA` | yes | `routine` | order the screening/test to obtain the data |
| `COMPLIANT` | no | — | numerator (met) |
| `EXCLUDED` | no | — | not in denominator |

## 3. Scope & non-goals

**In scope (built, simulated, tested):**
- A trigger-agnostic proposal engine over existing outcomes (read-time now; run-pipeline-callable later).
- The action-evaluator order catalog (measure → order code).
- `StandingOrderProvider` port with a simulated default + an inert EH stub (selected only when EH env set).
- Dedupe (in-batch + standing-order suppression).
- `ProposedOrder` domain type + `toServiceRequest()` FHIR R4 mapping.
- `GET /api/orders/proposals` endpoint (`format=domain|fhir`), CASE_MANAGER/ADMIN-gated.

**Out of scope (named + documented, NOT built — YAGNI / EH-deferred):**
- A real EH `OrderSubmitter` (write path). Named as the documented drop-in; proposals stay advisory.
- A real EH standing-order FHIR query (the `ehStandingOrderProvider` stub is inert).
- A `/cases/[id]` proposal UI panel + case-detail enrichment — deferred to when E7 graduates to a full
  feature (the submit/approve workflow is EH-dependent; a dead "order this" button would mislead a demo).
- Any schema / persistence (no `orders` table). Proposals are derived read-time.
- Conditional/branching action evaluators (one order per measure for now; extension documented).

## 4. Architecture

New module **`backend-ts/src/order/`** (peer to `case/`, `program/`, `notification/` — order
generation is a downstream derivation over outcomes, like `program/hierarchy-rollup.ts`, not part of
the CQL evaluation core).

### 4.1 `order/proposed-order.ts` — types + FHIR mapping
```ts
export type OrderPriority = "urgent" | "routine";

export interface OrderCode { code: string; system: string; display: string; }

export interface ProposedOrder {
  subjectId: string;
  measureId: string;
  order: OrderCode;
  reasonOutcome: string;       // OVERDUE | DUE_SOON | MISSING_DATA
  priority: OrderPriority;
  status: "PROPOSED";
  dedupeKey: string;           // `${subjectId}:${order.system}|${order.code}`
  authoredOn: string;          // ISO date the proposal was derived
  suppressedByStandingOrder?: boolean; // present (true) only on the suppressed-list view
}

// FHIR R4 ServiceRequest with intent=proposal, status=draft (a proposal, not an active order).
export function toServiceRequest(p: ProposedOrder): unknown; // hand-built JSON, no FHIR runtime dep
```
`toServiceRequest` emits: `resourceType:"ServiceRequest"`, `intent:"proposal"`, `status:"draft"`,
`priority`, `subject:{reference:"Patient/<subjectId>"}`, `code:{coding:[order]}`,
`reasonCode:[{text:"<measure> — <outcome>"}]`, `authoredOn`. A `bundleOf(proposals)` helper wraps a
collection `Bundle` for `format=fhir`.

### 4.2 `order/order-catalog.ts` — the action evaluators
A declarative map: runnable `measureId` → `{ order: OrderCode }`. Codes are representative (demo, not
billing-certified) and **reuse the existing `terminology_mappings` seed where present** (DATA_MODEL
§3.4a): audiogram → CPT `92557`, tb_surveillance → CPT `86580`, flu_vaccine → CVX `141`. Defaults for
the rest: adult_immunization → CVX `115` (Tdap), diabetes_hba1c & cms122 → CPT `83036` (HbA1c),
cms125 → CPT `77067` (mammogram), cholesterol_ldl → CPT `80061` (lipid panel), hypertension → CPT
`99473` (BP), obesity_bmi → local `bmi-screening`, hazwoper → local `hazwoper-surveillance-exam`.
Measures absent from the catalog yield no proposal (logged, not an error) — extension-safe.

### 4.3 `order/standing-order-provider.ts` — the dedupe seam (mirrors `OutreachChannel`)
```ts
export interface StandingOrder { subjectId: string; order: OrderCode; }
export interface StandingOrderProvider { activeOrdersFor(subjectId: string): StandingOrder[]; }
export interface StandingOrderEnv { WORKWELL_EH_FHIR_BASE_URL?: string; WORKWELL_EH_FHIR_API_KEY?: string; }
```
- `simulatedStandingOrderProvider` (**default**) — deterministic synthetic standing orders: for a
  stable ~20% of subjects (by subjectId hash) emit a standing order for a subset of measures, so
  dedupe-suppression is demonstrable but most proposals still flow.
- `ehStandingOrderProvider(config)` — **inert stub**: returns `[]` (and is documented as the real
  FHIR `ServiceRequest?subject=…&status=active` query drop-in). No HTTP.
- `resolveStandingOrderProvider(env)` — returns the simulated provider by default, the inert EH stub
  **only** when both `WORKWELL_EH_FHIR_*` are set (inert-unless-configured, mirroring SendGrid/ICE).

### 4.4 `order/order-proposal.ts` — the engine
```ts
export function proposeOrders(
  outcomes: OutcomeRow[],                    // latest population-run outcomes (see §4.5)
  standingOrders: StandingOrderProvider,
): { proposed: ProposedOrder[]; suppressed: ProposedOrder[] };
```
- Filters to at-risk outcomes (§2), maps each via the catalog to a `ProposedOrder`.
- **Dedupe:** drop a proposal if its `dedupeKey` already appeared in this batch (in-batch dedupe), OR
  if `standingOrders.activeOrdersFor(subjectId)` contains the same `order.code`+`system` (standing-order
  suppression). Suppressed proposals are returned separately (with `suppressedByStandingOrder:true`)
  so the endpoint can report *why* an at-risk member got no order — useful + auditable.
- Pure and trigger-agnostic: no I/O beyond the injected provider. The run pipeline can call the same
  function when EH auto-ordering is wired (documented, not built).

### 4.5 `routes/orders.ts` — the endpoint
`GET /api/orders/proposals?measureId=&subjectId=&from=&to=&format=domain|fhir`
- Resolves the **latest population run per Active measure, excluding CASE/EMPLOYEE reruns**, by reusing
  `program/rollup-shared.ts` (`isPopulationRun` + the same selection the hierarchy rollup / programs
  overview use) — no new selection logic.
- Optional `measureId` / `subjectId` filters; optional `from`/`to` via the shared
  `routes/query-dates.ts` parser (400 on malformed).
- `format=domain` (default) → `{ proposed: ProposedOrder[], suppressed: ProposedOrder[] }`.
  `format=fhir` → a FHIR collection `Bundle` of `ServiceRequest` (proposed only).
- **Gated to CASE_MANAGER/ADMIN** (orders are clinical; matches the campaigns gate —
  `authorize.ts` rule `rx("/api/orders/**") → [CM, A]`). Mounted in `worker.ts`.

## 5. Data model

**No schema change.** Proposals are derived read-time from `outcomes`; nothing persisted. No `orders`
table. The documented production drop-ins (built only when EH integration lands):
- `ehStandingOrderProvider` → a real FHIR `ServiceRequest?subject&status=active` query for dedupe.
- An `OrderSubmitter` write port → posts an approved `ServiceRequest` to EH; persistence of submitted
  orders (an `orders` table) is part of that future work, owned by the maintainer (schema rule).

## 6. ADR

**ADR-013 — Order-proposal engine + StandingOrderProvider port (EH-ready, simulated by default).**
Records: the `ProposedOrder`/`ServiceRequest` shape; Panel=Risk → at-risk selection + risk→priority;
the dedupe contract (in-batch + standing-order suppression) answering the charter's duplicate-orders
warning; simulated-default / inert-EH-when-configured selection (mirrors ADR-011/012); proposals are
**advisory** (a human submits — never auto-submitted; the AI/compliance-guardrail analog); the engine
is trigger-agnostic (read-time now, run-pipeline-callable later); no schema; and the named-but-deferred
`OrderSubmitter` EH write drop-in.

## 7. Testing

- `proposed-order.test.ts` — `toServiceRequest` shape (intent/status/priority/subject/code/reason);
  `bundleOf` collection bundle; `dedupeKey` formation.
- `order-catalog.test.ts` — every runnable measure either maps to an order or is intentionally absent;
  the reused terminology codes match the seed.
- `standing-order-provider.test.ts` — simulated provider is deterministic and suppresses *some* but not
  all; `resolveStandingOrderProvider` returns simulated by default and the inert EH stub only when both
  env vars set; the EH stub performs no HTTP and returns `[]`.
- `order-proposal.test.ts` — Panel=Risk selection (COMPLIANT/EXCLUDED → none; the three at-risk → one
  each); risk→priority; in-batch dedupe; standing-order suppression populates `suppressed[]`.
- `routes/orders.test.ts` — endpoint happy path (domain + fhir), `measureId`/`subjectId` filters,
  `from/to` 400 validation, and the CASE_MANAGER/ADMIN auth gate (403 for other roles, fall-through on
  non-match).
- Audit invariant: the endpoint is a read; it writes no state, so no audit row is required (assert it
  doesn't fabricate one). (If a future `OrderSubmitter` writes, that path must audit — out of scope.)

## 8. Docs (same PR)

- `ARCHITECTURE.md` — new `order` module (§3), the endpoint (§7 External Interfaces), a §5 data-flow
  note (advisory; never auto-submits), and the Panel=Risk invariant (§6).
- `DATA_MODEL.md` — a subsection: no table; read-time; the two documented EH drop-ins.
- `DECISIONS.md` — ADR-013.
- `MEASURES.md` — a note on the action-evaluator order map (per-measure order codes; terminology reuse).
- `JOURNAL.md` — dated 2026-06-19 E7 entry.
- `README.md` — `GET /api/orders/proposals` in API highlights.

## 9. Out of scope (YAGNI) — recap

Real EH submit/standing-order HTTP; a `/cases/[id]` UI panel + case enrichment; an `orders` table /
any persistence; conditional action evaluators; auto-submission. All are documented as the path E7
takes when it graduates from design-only to a full feature with the EH integration path known.
