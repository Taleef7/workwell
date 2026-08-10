# E7 — Order / Action Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate advisory **proposed orders** from non-compliant measure findings behind an interface-ready, EH-deferred seam — the charter's "Action Evaluators → orders", with Panel=Risk selection and dedupe vs. standing orders.

**Architecture:** A new `backend-ts/src/order/` module: a pure `proposeOrders()` engine over latest-population-run outcomes, an action-evaluator order catalog, a `StandingOrderProvider` port (simulated default + inert EH stub), a `ProposedOrder` domain type with a FHIR R4 `ServiceRequest` mapping, exposed read-only via `GET /api/orders/proposals` (CASE_MANAGER/ADMIN). No schema, no frontend, no EH dependency. Simulated/inert by default, mirroring E5/E6.

**Tech Stack:** TypeScript on `@mieweb/cloud`; Node test runner (`node --import tsx --test`); reuses `program/rollup-shared.ts` outcome selection and `routes/query-dates.ts`.

**Spec:** `docs/superpowers/specs/2026-06-19-e7-order-generation-design.md`

**Conventions (same as E6):**
- Tests are `*.test.ts` colocated; run all: `cd backend-ts; pnpm test`; one file: `cd backend-ts; node --import tsx --test src/path/file.test.ts`. Typecheck: `cd backend-ts; pnpm typecheck`.
- Route handlers: `handleX(req, env): Promise<Response | null>` (return `null` to fall through), mounted in `backend-ts/src/worker.ts`. **Auth is enforced by the matrix in `backend-ts/src/auth/authorize.ts` BEFORE dispatch** — handlers don't check roles themselves (mirror `handleHierarchy`).
- Imports use explicit `.ts` extensions. Commit per task; conventional commits scoped `(order|routes|docs): #77 E7 — …`.
- Commit trailers: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JEuvJZExcGrtdkDo9AwiyM`.

---

## File Structure

- Create `backend-ts/src/order/proposed-order.ts` — `ProposedOrder`/`OrderCode`/`OrderPriority` types, `dedupeKeyFor`, `toServiceRequest`, `bundleOf`.
- Create `backend-ts/src/order/order-catalog.ts` — per-measure action-evaluator order map + `orderForMeasure`.
- Create `backend-ts/src/order/standing-order-provider.ts` — `StandingOrder`/`StandingOrderProvider`/`StandingOrderEnv`, simulated + inert-EH adapters, `resolveStandingOrderProvider`.
- Create `backend-ts/src/order/order-proposal.ts` — `AtRiskOutcome`, `proposeOrders`.
- Create `backend-ts/src/routes/orders.ts` — `handleOrders` (`GET /api/orders/proposals`).
- Modify `backend-ts/src/program/rollup-shared.ts` — export `latestRunRows` (extracted from hierarchy-rollup for reuse).
- Modify `backend-ts/src/program/hierarchy-rollup.ts` — import `latestRunRows` from rollup-shared (de-dupe the helper).
- Modify `backend-ts/src/auth/authorize.ts` — add `rx("/api/orders/**") → [CM, A]`.
- Modify `backend-ts/src/worker.ts` — mount `handleOrders`.
- Tests colocated for each new file + `routes/orders.test.ts`; add an assertion to the existing authorize matrix test.

---

## Task 1: ProposedOrder types + FHIR mapping

**Files:** Create `backend-ts/src/order/proposed-order.ts`; Test `backend-ts/src/order/proposed-order.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend-ts/src/order/proposed-order.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeKeyFor, toServiceRequest, bundleOf, type ProposedOrder } from "./proposed-order.ts";

const sample: ProposedOrder = {
  subjectId: "emp-006",
  measureId: "audiogram",
  order: { code: "92557", system: "http://www.ama-assn.org/go/cpt", display: "Comprehensive audiometry evaluation" },
  reasonOutcome: "OVERDUE",
  priority: "urgent",
  status: "PROPOSED",
  dedupeKey: dedupeKeyFor("emp-006", { code: "92557", system: "http://www.ama-assn.org/go/cpt", display: "x" }),
  authoredOn: "2026-06-19",
};

test("dedupeKeyFor is subject + system|code", () => {
  assert.equal(sample.dedupeKey, "emp-006:http://www.ama-assn.org/go/cpt|92557");
});

test("toServiceRequest emits a FHIR proposal ServiceRequest", () => {
  const sr = toServiceRequest(sample) as Record<string, unknown>;
  assert.equal(sr.resourceType, "ServiceRequest");
  assert.equal(sr.intent, "proposal");
  assert.equal(sr.status, "draft");
  assert.equal(sr.priority, "urgent");
  assert.deepEqual((sr.subject as Record<string, unknown>).reference, "Patient/emp-006");
  const coding = ((sr.code as { coding?: Array<Record<string, unknown>> }).coding ?? [])[0];
  assert.equal(coding?.code, "92557");
  assert.equal(coding?.system, "http://www.ama-assn.org/go/cpt");
  assert.equal(sr.authoredOn, "2026-06-19");
  // reason carries the measure + outcome for traceability
  const reason = ((sr.reasonCode as Array<{ text?: string }>) ?? [])[0]?.text ?? "";
  assert.ok(reason.includes("audiogram") && reason.includes("OVERDUE"));
});

test("bundleOf wraps proposals in a FHIR collection Bundle of ServiceRequest", () => {
  const b = bundleOf([sample]) as Record<string, unknown>;
  assert.equal(b.resourceType, "Bundle");
  assert.equal(b.type, "collection");
  const entries = b.entry as Array<{ resource: Record<string, unknown> }>;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].resource.resourceType, "ServiceRequest");
});
```

- [ ] **Step 2: Run test → FAIL** (`cd backend-ts && node --import tsx --test src/order/proposed-order.test.ts`) — module not found.

- [ ] **Step 3: Implement**

```ts
// backend-ts/src/order/proposed-order.ts
/**
 * Order proposal types + FHIR mapping (#77 E7). A ProposedOrder is advisory — a human reviews and
 * submits; nothing is auto-ordered. toServiceRequest emits FHIR R4 ServiceRequest (intent=proposal,
 * status=draft) so the output is EH-ready; hand-built JSON (no FHIR runtime dep), like MeasureReport/QRDA.
 */
export type OrderPriority = "urgent" | "routine";

export interface OrderCode {
  code: string;
  system: string;
  display: string;
}

export interface ProposedOrder {
  subjectId: string;
  measureId: string;
  order: OrderCode;
  reasonOutcome: string; // OVERDUE | DUE_SOON | MISSING_DATA
  priority: OrderPriority;
  status: "PROPOSED";
  dedupeKey: string;
  authoredOn: string; // YYYY-MM-DD
  /** Present (true) only on the suppressed-list view (suppressed by an existing standing order). */
  suppressedByStandingOrder?: boolean;
}

export function dedupeKeyFor(subjectId: string, order: OrderCode): string {
  return `${subjectId}:${order.system}|${order.code}`;
}

export function toServiceRequest(p: ProposedOrder): unknown {
  return {
    resourceType: "ServiceRequest",
    intent: "proposal",
    status: "draft",
    priority: p.priority,
    subject: { reference: `Patient/${p.subjectId}` },
    code: { coding: [{ system: p.order.system, code: p.order.code, display: p.order.display }] },
    reasonCode: [{ text: `${p.measureId} — ${p.reasonOutcome}` }],
    authoredOn: p.authoredOn,
  };
}

export function bundleOf(proposals: ProposedOrder[]): unknown {
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: proposals.map((p) => ({ resource: toServiceRequest(p) })),
  };
}
```

- [ ] **Step 4: Run test → PASS.**
- [ ] **Step 5: Typecheck** (`cd backend-ts && pnpm typecheck`) — clean.
- [ ] **Step 6: Commit**

```bash
git add backend-ts/src/order/proposed-order.ts backend-ts/src/order/proposed-order.test.ts
git commit -m "feat(order): #77 E7 — ProposedOrder types + FHIR ServiceRequest mapping"
```

## Task 2: Action-evaluator order catalog

**Files:** Create `backend-ts/src/order/order-catalog.ts`; Test `backend-ts/src/order/order-catalog.test.ts`

First read `backend-ts/src/measure/value-set-seed.ts` for the exact `CPT`/`CVX`/`DEMO` system-URI constants used by the terminology seed (the reused codes 92557, 86580, 141 must use the SAME system strings). Use those system URIs in the catalog. If the seed's constants aren't exported, copy their literal values and add a comment pointing at value-set-seed.ts.

- [ ] **Step 1: Write the failing test**

```ts
// backend-ts/src/order/order-catalog.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { orderForMeasure, ORDER_CATALOG } from "./order-catalog.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";

test("every runnable (registered) measure maps to an order", () => {
  for (const id of Object.keys(MEASURES)) {
    assert.ok(orderForMeasure(id), `missing order for runnable measure ${id}`);
  }
});

test("reused terminology codes match the seed (audiogram/tb/flu)", () => {
  assert.equal(orderForMeasure("audiogram")!.code, "92557");
  assert.equal(orderForMeasure("tb_surveillance")!.code, "86580");
  assert.equal(orderForMeasure("flu_vaccine")!.code, "141");
});

test("unknown measure yields null (extension-safe)", () => {
  assert.equal(orderForMeasure("does_not_exist"), null);
});

test("catalog only covers Active or known measures (no stray ids)", () => {
  const known = new Set(MEASURE_CATALOG.map((m) => m.id));
  for (const id of Object.keys(ORDER_CATALOG)) assert.ok(known.has(id), `catalog id ${id} not in MEASURE_CATALOG`);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** (use the real CPT/CVX system URIs from value-set-seed.ts; the values below are the standard URIs — confirm they match the seed and adjust if the seed differs)

```ts
// backend-ts/src/order/order-catalog.ts
/**
 * Action evaluators (#77 E7): runnable measure → the order to propose for an at-risk member.
 * Codes are representative (demo, not billing-certified) and REUSE the terminology_mappings seed
 * where present (value-set-seed.ts): audiogram→CPT 92557, tb_surveillance→CPT 86580, flu_vaccine→CVX 141.
 * A measure absent here yields no proposal (extension-safe).
 */
import type { OrderCode } from "./proposed-order.ts";

const CPT = "http://www.ama-assn.org/go/cpt";
const CVX = "http://hl7.org/fhir/sid/cvx";
const LOCAL = "urn:workwell:orders";

export const ORDER_CATALOG: Record<string, OrderCode> = {
  audiogram: { code: "92557", system: CPT, display: "Comprehensive audiometry evaluation" },
  tb_surveillance: { code: "86580", system: CPT, display: "TB intradermal skin test" },
  flu_vaccine: { code: "141", system: CVX, display: "Influenza seasonal injectable" },
  adult_immunization: { code: "115", system: CVX, display: "Tdap vaccine" },
  diabetes_hba1c: { code: "83036", system: CPT, display: "Hemoglobin A1c" },
  cms122: { code: "83036", system: CPT, display: "Hemoglobin A1c" },
  cholesterol_ldl: { code: "80061", system: CPT, display: "Lipid panel" },
  cms125: { code: "77067", system: CPT, display: "Screening mammography, bilateral" },
  hypertension: { code: "99473", system: CPT, display: "Self-measured blood pressure" },
  obesity_bmi: { code: "bmi-screening", system: LOCAL, display: "BMI screening & counseling" },
  hazwoper: { code: "hazwoper-surveillance-exam", system: LOCAL, display: "HAZWOPER medical surveillance exam" },
};

export function orderForMeasure(measureId: string): OrderCode | null {
  return ORDER_CATALOG[measureId] ?? null;
}
```

- [ ] **Step 4: Run → PASS.** If the "every runnable measure maps" test fails, a measure in `MEASURES` (measure-registry) lacks a catalog entry — add it. If reused codes mismatch the seed, fix the catalog to match value-set-seed.ts.
- [ ] **Step 5: Typecheck clean. Commit**

```bash
git add backend-ts/src/order/order-catalog.ts backend-ts/src/order/order-catalog.test.ts
git commit -m "feat(order): #77 E7 — action-evaluator order catalog (terminology reuse)"
```

## Task 3: StandingOrderProvider port

**Files:** Create `backend-ts/src/order/standing-order-provider.ts`; Test `backend-ts/src/order/standing-order-provider.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend-ts/src/order/standing-order-provider.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulatedStandingOrderProvider, ehStandingOrderProvider, resolveStandingOrderProvider } from "./standing-order-provider.ts";

test("simulated provider is deterministic per subject", () => {
  const a = simulatedStandingOrderProvider.activeOrdersFor("emp-006");
  const b = simulatedStandingOrderProvider.activeOrdersFor("emp-006");
  assert.deepEqual(a, b);
});

test("simulated provider suppresses some subjects but not all (across emp-001..emp-100)", () => {
  let withOrders = 0;
  for (let i = 1; i <= 100; i++) {
    const id = `emp-${String(i).padStart(3, "0")}`;
    if (simulatedStandingOrderProvider.activeOrdersFor(id).length > 0) withOrders++;
  }
  assert.ok(withOrders > 0 && withOrders < 100, `expected partial coverage, got ${withOrders}/100`);
});

test("resolveStandingOrderProvider returns simulated by default", () => {
  assert.equal(resolveStandingOrderProvider({}), simulatedStandingOrderProvider);
  assert.equal(resolveStandingOrderProvider({ WORKWELL_EH_FHIR_API_KEY: "k" }), simulatedStandingOrderProvider);
});

test("resolveStandingOrderProvider returns the inert EH stub only when both env vars set", () => {
  const p = resolveStandingOrderProvider({ WORKWELL_EH_FHIR_API_KEY: "k", WORKWELL_EH_FHIR_BASE_URL: "https://eh.example/fhir" });
  assert.notEqual(p, simulatedStandingOrderProvider);
  assert.deepEqual(p.activeOrdersFor("emp-006"), []); // inert: no orders, no HTTP
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```ts
// backend-ts/src/order/standing-order-provider.ts
/**
 * StandingOrderProvider port (#77 E7) — the dedupe seam: existing active orders a member already has,
 * so a proposal isn't a duplicate (the charter's "duplicate orders are bad"). Simulated default;
 * an inert EH stub is selected ONLY when both WORKWELL_EH_FHIR_* env vars are set
 * (inert-unless-configured, mirroring SendGrid/ICE). The real EH adapter (a FHIR
 * `ServiceRequest?subject=&status=active` query) is the documented drop-in behind this port.
 */
import type { OrderCode } from "./proposed-order.ts";
import { ORDER_CATALOG } from "./order-catalog.ts";

export interface StandingOrder {
  subjectId: string;
  order: OrderCode;
}

export interface StandingOrderProvider {
  activeOrdersFor(subjectId: string): StandingOrder[];
}

export interface StandingOrderEnv {
  WORKWELL_EH_FHIR_BASE_URL?: string;
  WORKWELL_EH_FHIR_API_KEY?: string;
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

// Deterministic synthetic standing orders: ~1 in 5 subjects already has a standing order for a
// stable measure picked from the catalog — enough to demonstrate dedupe suppression without
// suppressing most proposals.
const CATALOG_ENTRIES = Object.entries(ORDER_CATALOG);
export const simulatedStandingOrderProvider: StandingOrderProvider = {
  activeOrdersFor(subjectId) {
    const h = hash(subjectId);
    if (h % 5 !== 0) return [];
    const [, order] = CATALOG_ENTRIES[h % CATALOG_ENTRIES.length];
    return [{ subjectId, order }];
  },
};

export function ehStandingOrderProvider(_config: { apiKey: string; baseUrl: string }): StandingOrderProvider {
  // STUB: a real impl would GET `${baseUrl}/ServiceRequest?subject=<id>&status=active` with the key.
  return { activeOrdersFor: () => [] };
}

export function resolveStandingOrderProvider(env: StandingOrderEnv): StandingOrderProvider {
  const apiKey = (env.WORKWELL_EH_FHIR_API_KEY ?? "").trim();
  const baseUrl = (env.WORKWELL_EH_FHIR_BASE_URL ?? "").trim();
  if (apiKey && baseUrl) return ehStandingOrderProvider({ apiKey, baseUrl });
  return simulatedStandingOrderProvider;
}
```

- [ ] **Step 4: Run → PASS.** If the "partial coverage" test fails (0 or 100), adjust the `h % 5` ratio so coverage is strictly between 0 and 100 over emp-001..emp-100.
- [ ] **Step 5: Typecheck clean. Commit**

```bash
git add backend-ts/src/order/standing-order-provider.ts backend-ts/src/order/standing-order-provider.test.ts
git commit -m "feat(order): #77 E7 — StandingOrderProvider port (simulated default, inert EH stub)"
```

## Task 4: proposeOrders engine

**Files:** Create `backend-ts/src/order/order-proposal.ts`; Test `backend-ts/src/order/order-proposal.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend-ts/src/order/order-proposal.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { proposeOrders, type AtRiskOutcome } from "./order-proposal.ts";
import type { StandingOrderProvider } from "./standing-order-provider.ts";

const noStanding: StandingOrderProvider = { activeOrdersFor: () => [] };

test("Panel=Risk: only OVERDUE/DUE_SOON/MISSING_DATA propose; COMPLIANT/EXCLUDED do not", () => {
  const rows: AtRiskOutcome[] = [
    { subjectId: "e1", measureId: "audiogram", status: "OVERDUE" },
    { subjectId: "e2", measureId: "audiogram", status: "DUE_SOON" },
    { subjectId: "e3", measureId: "audiogram", status: "MISSING_DATA" },
    { subjectId: "e4", measureId: "audiogram", status: "COMPLIANT" },
    { subjectId: "e5", measureId: "audiogram", status: "EXCLUDED" },
  ];
  const { proposed } = proposeOrders(rows, noStanding);
  assert.deepEqual(proposed.map((p) => p.subjectId).sort(), ["e1", "e2", "e3"]);
});

test("risk tier → priority (OVERDUE urgent; DUE_SOON/MISSING_DATA routine)", () => {
  const rows: AtRiskOutcome[] = [
    { subjectId: "e1", measureId: "audiogram", status: "OVERDUE" },
    { subjectId: "e2", measureId: "audiogram", status: "DUE_SOON" },
    { subjectId: "e3", measureId: "audiogram", status: "MISSING_DATA" },
  ];
  const { proposed } = proposeOrders(rows, noStanding);
  const byId = Object.fromEntries(proposed.map((p) => [p.subjectId, p.priority]));
  assert.equal(byId.e1, "urgent");
  assert.equal(byId.e2, "routine");
  assert.equal(byId.e3, "routine");
});

test("in-batch dedupe: same subject+order proposed once", () => {
  const rows: AtRiskOutcome[] = [
    { subjectId: "e1", measureId: "diabetes_hba1c", status: "OVERDUE" }, // 83036
    { subjectId: "e1", measureId: "cms122", status: "OVERDUE" },         // also 83036 → same dedupeKey
  ];
  const { proposed } = proposeOrders(rows, noStanding);
  assert.equal(proposed.filter((p) => p.subjectId === "e1").length, 1);
});

test("standing-order suppression moves a proposal to suppressed[]", () => {
  const standing: StandingOrderProvider = {
    activeOrdersFor: (id) => (id === "e1" ? [{ subjectId: "e1", order: { code: "92557", system: "http://www.ama-assn.org/go/cpt", display: "x" } }] : []),
  };
  const rows: AtRiskOutcome[] = [{ subjectId: "e1", measureId: "audiogram", status: "OVERDUE" }];
  const { proposed, suppressed } = proposeOrders(rows, standing);
  assert.equal(proposed.length, 0);
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].suppressedByStandingOrder, true);
});

test("measure with no catalog entry yields no proposal", () => {
  const rows: AtRiskOutcome[] = [{ subjectId: "e1", measureId: "respirator_fit_test", status: "OVERDUE" }];
  assert.equal(proposeOrders(rows, noStanding).proposed.length, 0);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```ts
// backend-ts/src/order/order-proposal.ts
/**
 * Order proposal engine (#77 E7) — trigger-agnostic + pure. Panel=Risk: the at-risk gap
 * (Denominator − Numerator = OVERDUE|DUE_SOON|MISSING_DATA) gets a proposed order; COMPLIANT/EXCLUDED
 * don't. Risk tier → priority. Deduped in-batch and against the StandingOrderProvider (the charter's
 * "duplicate orders are bad"). Read-time today (the orders route); the SAME function is
 * run-pipeline-callable when EH auto-ordering is wired.
 */
import { dedupeKeyFor, type OrderPriority, type ProposedOrder } from "./proposed-order.ts";
import { orderForMeasure } from "./order-catalog.ts";
import type { StandingOrderProvider } from "./standing-order-provider.ts";

/** Minimal input shape (decoupled from OutcomeWithRun): the route maps outcomes → these. */
export interface AtRiskOutcome {
  subjectId: string;
  measureId: string;
  status: string;
}

const AT_RISK: Record<string, OrderPriority | undefined> = {
  OVERDUE: "urgent",
  DUE_SOON: "routine",
  MISSING_DATA: "routine",
};

export function proposeOrders(
  outcomes: AtRiskOutcome[],
  standingOrders: StandingOrderProvider,
  authoredOn: string = new Date().toISOString().slice(0, 10),
): { proposed: ProposedOrder[]; suppressed: ProposedOrder[] } {
  const proposed: ProposedOrder[] = [];
  const suppressed: ProposedOrder[] = [];
  const seen = new Set<string>(); // in-batch dedupe keys already proposed

  for (const o of outcomes) {
    const priority = AT_RISK[o.status];
    if (!priority) continue; // COMPLIANT / EXCLUDED / unknown → not at risk
    const order = orderForMeasure(o.measureId);
    if (!order) continue; // no action evaluator for this measure
    const dedupeKey = dedupeKeyFor(o.subjectId, order);
    const proposal: ProposedOrder = {
      subjectId: o.subjectId, measureId: o.measureId, order, reasonOutcome: o.status,
      priority, status: "PROPOSED", dedupeKey, authoredOn,
    };
    if (seen.has(dedupeKey)) continue; // in-batch duplicate
    const covered = standingOrders
      .activeOrdersFor(o.subjectId)
      .some((s) => s.order.code === order.code && s.order.system === order.system);
    if (covered) {
      suppressed.push({ ...proposal, suppressedByStandingOrder: true });
      seen.add(dedupeKey);
      continue;
    }
    proposed.push(proposal);
    seen.add(dedupeKey);
  }
  return { proposed, suppressed };
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Typecheck clean. Commit**

```bash
git add backend-ts/src/order/order-proposal.ts backend-ts/src/order/order-proposal.test.ts
git commit -m "feat(order): #77 E7 — proposeOrders engine (Panel=Risk, dedupe, suppression)"
```

## Task 5: Extract latestRunRows + orders endpoint + auth + mount

**Files:** Modify `backend-ts/src/program/rollup-shared.ts`, `backend-ts/src/program/hierarchy-rollup.ts`, `backend-ts/src/auth/authorize.ts`, `backend-ts/src/worker.ts`; Create `backend-ts/src/routes/orders.ts`, `backend-ts/src/routes/orders.test.ts`; modify the existing authorize matrix test.

- [ ] **Step 1: Extract `latestRunRows` into rollup-shared.ts (DRY)**

In `backend-ts/src/program/rollup-shared.ts`, add (it must be generic over the run-bearing shape):

```ts
/** The rows of the most-recent run (by runStartedAt) among the given rows; [] if none.
 *  Shared by the hierarchy rollup and the order-proposal route so "latest population run" can't drift. */
export function latestRunRows<T extends { runId: string; runStartedAt: string }>(rows: T[]): T[] {
  const byRun = new Map<string, { startedAt: string; rows: T[] }>();
  for (const r of rows) {
    const g = byRun.get(r.runId) ?? byRun.set(r.runId, { startedAt: r.runStartedAt, rows: [] }).get(r.runId)!;
    g.rows.push(r);
  }
  let best: { startedAt: string; rows: T[] } | null = null;
  for (const g of byRun.values()) if (!best || g.startedAt > best.startedAt) best = g;
  return best?.rows ?? [];
}
```

In `backend-ts/src/program/hierarchy-rollup.ts`: delete its private `latestRunRows` function and import the shared one — change the import line `import { day, isPopulationRun, round1 } from "./rollup-shared.ts";` to also import `latestRunRows`. Leave all call sites unchanged.

- [ ] **Step 2: Verify the extraction didn't break hierarchy**

Run: `cd backend-ts && node --import tsx --test src/routes/hierarchy.test.ts` (and any `hierarchy-rollup` test) — still PASS. Typecheck clean.

- [ ] **Step 3: Write the failing route test**

```ts
// backend-ts/src/routes/orders.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleOrders } from "./orders.ts";

// Minimal fake env: an outcomeStore whose listOutcomesWithRun returns a fixed population run.
const rows = [
  { runId: "r1", runStartedAt: "2026-06-10T00:00:00Z", runScopeType: "ALL_PROGRAMS", subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE" },
  { runId: "r1", runStartedAt: "2026-06-10T00:00:00Z", runScopeType: "ALL_PROGRAMS", subjectId: "emp-007", measureId: "audiogram", status: "COMPLIANT" },
];
const env = {
  // getStores(env) is what the route uses; emulate the shape the route calls. See Step 4 for the
  // exact accessor — match it. Here we assume the route calls getStores(env).outcomes.listOutcomesWithRun.
  DB: {}, DATABASE_URL: undefined,
  __testStores: { outcomes: { listOutcomesWithRun: async () => rows } },
} as never;

// NOTE: align this harness with how peer route tests (e.g. hierarchy.test.ts) inject stores.
// If hierarchy.test.ts builds a real SQLite store + seeds a run, mirror that instead of a fake.

const get = (qs = "") => handleOrders(new Request(`http://x/api/orders/proposals${qs}`, { method: "GET" }), env);

test("returns domain proposals for at-risk outcomes (default format)", async () => {
  const res = await get("");
  assert.equal(res!.status, 200);
  const body = await res!.json();
  assert.ok(Array.isArray(body.proposed));
  assert.ok(body.proposed.some((p: { subjectId: string }) => p.subjectId === "emp-006"));
  assert.ok(!body.proposed.some((p: { subjectId: string }) => p.subjectId === "emp-007")); // COMPLIANT
});

test("format=fhir returns a ServiceRequest Bundle", async () => {
  const res = await get("?format=fhir");
  const body = await res!.json();
  assert.equal(body.resourceType, "Bundle");
});

test("400 on malformed from", async () => {
  const res = await get("?from=2026-13-99");
  assert.equal(res!.status, 400);
});

test("falls through (null) on non-match", async () => {
  assert.equal(await handleOrders(new Request("http://x/api/other", { method: "GET" }), env), null);
  assert.equal(await handleOrders(new Request("http://x/api/orders/proposals", { method: "POST" }), env), null);
});
```

> **Implementer:** before writing the route, READ `backend-ts/src/routes/hierarchy.ts` and `hierarchy.test.ts` to see exactly how the route obtains stores (`getStores(env)` vs `outcomeStore(env)`) and how its test injects them. Mirror that injection in BOTH the route and this test rather than the `__testStores` placeholder above (adjust the test to the real harness).

- [ ] **Step 4: Implement the route**

```ts
// backend-ts/src/routes/orders.ts
/**
 * Order proposals route (#77 E7) — advisory "Action Evaluators → orders" over the latest population
 * run per Active measure. Read-time; no schema. Gated to CASE_MANAGER/ADMIN by the auth matrix
 * (orders are clinical). format=domain (default) → {proposed,suppressed}; format=fhir → ServiceRequest Bundle.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { isPopulationRun, latestRunRows } from "../program/rollup-shared.ts";
import { parseQueryDate, QueryDateError } from "./query-dates.ts";
import { proposeOrders, type AtRiskOutcome } from "../order/order-proposal.ts";
import { resolveStandingOrderProvider, type StandingOrderEnv } from "../order/standing-order-provider.ts";
import { bundleOf } from "../order/proposed-order.ts";

interface OrdersEnv extends StandingOrderEnv { DB: CloudDatabase; DATABASE_URL?: string; }
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handleOrders(req: Request, env: OrdersEnv): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  if (url.pathname !== "/api/orders/proposals") return null;

  const q = url.searchParams;
  let from: string | undefined, to: string | undefined;
  try {
    from = parseQueryDate(q.get("from"), "from");
    to = parseQueryDate(q.get("to"), "to");
  } catch (err) {
    if (err instanceof QueryDateError) return json({ error: "invalid_request", message: err.message }, 400);
    throw err;
  }
  const measureId = q.get("measureId")?.trim() || null;
  const subjectId = q.get("subjectId")?.trim() || null;
  const fhir = (q.get("format") ?? "domain") === "fhir";

  const active = MEASURE_CATALOG.filter((m) => m.status === "Active").map((m) => m.id);
  const scope = measureId ? (active.includes(measureId) ? [measureId] : []) : active;

  const s = await getStores(env);
  const atRisk: AtRiskOutcome[] = [];
  if (scope.length > 0) {
    const all = (await s.outcomes.listOutcomesWithRun({ from, to })).filter((r) => isPopulationRun(r.runScopeType));
    const byMeasure = new Map<string, typeof all>();
    for (const r of all) (byMeasure.get(r.measureId) ?? byMeasure.set(r.measureId, []).get(r.measureId)!).push(r);
    for (const m of scope) {
      for (const r of latestRunRows(byMeasure.get(m) ?? [])) {
        if (subjectId && r.subjectId !== subjectId) continue;
        atRisk.push({ subjectId: r.subjectId, measureId: r.measureId, status: r.status });
      }
    }
  }
  const { proposed, suppressed } = proposeOrders(atRisk, resolveStandingOrderProvider(env));
  return fhir ? json(bundleOf(proposed)) : json({ proposed, suppressed });
}
```

Adjust `getStores(env).outcomes` / `s.outcomes` to the actual store accessor name used by `hierarchy.ts` (it uses `getStores(env)` then `.outcomes`/`.cases` — confirm `s.outcomes.listOutcomesWithRun` is correct; in hierarchy it passes `s.outcomes` as `outcomeStore`).

- [ ] **Step 5: Auth matrix + mount**

In `backend-ts/src/auth/authorize.ts`, add next to the campaigns rule (the `rx("/api/campaigns/**")` line ~91):

```ts
  // Order proposals (#77 E7) — clinical decision support over case/PII data; gated like campaigns.
  { pattern: rx("/api/orders/**"), access: [CM, A] },
```

In the existing authorize matrix test (find it: `grep -rl "campaigns/\*\*\|authorize" backend-ts/src/auth/*.test.ts`), add an assertion mirroring the campaigns one: `GET /api/orders/proposals` is allowed for CASE_MANAGER + ADMIN and denied (403/!allowed) for other roles.

In `backend-ts/src/worker.ts`: add `import { handleOrders } from "./routes/orders.ts";` by the other route imports, and the dispatch right after the immunization block (inside the authenticated `/api` chain):

```ts
  // Order proposals — advisory "Action Evaluators → orders" over latest population runs (#77 E7).
  const ordersResponse = await handleOrders(req, env);
  if (ordersResponse) return ordersResponse;
```
Also confirm the worker `Env` already satisfies `StandingOrderEnv` — if not, add the two optional `WORKWELL_EH_FHIR_*` fields to the worker `Env` interface (mirroring how the ICE fields were added for E6).

- [ ] **Step 6: Run the route + auth tests → PASS; then full suite**

```bash
cd backend-ts && node --import tsx --test src/routes/orders.test.ts && pnpm typecheck && pnpm test
```
Expect 0 fail. Fix any harness mismatch (Step 3 note). 

- [ ] **Step 7: Commit**

```bash
git add backend-ts/src/program/rollup-shared.ts backend-ts/src/program/hierarchy-rollup.ts backend-ts/src/auth/authorize.ts backend-ts/src/auth/*.test.ts backend-ts/src/worker.ts backend-ts/src/routes/orders.ts backend-ts/src/routes/orders.test.ts
git commit -m "feat(routes): #77 E7 — GET /api/orders/proposals (CM/ADMIN) + shared latestRunRows"
```

## Task 6: Docs + ADR-013

**Files:** `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/DECISIONS.md`, `docs/MEASURES.md`, `docs/JOURNAL.md`, `README.md`

- [ ] **Step 1: DECISIONS.md** — prepend **ADR-013 — Order-proposal engine + StandingOrderProvider port (EH-ready, simulated by default)**, dated 2026-06-19 (confirm 013 is the next free number; ADR-012 was E6). Content per spec §6: ProposedOrder/ServiceRequest shape; Panel=Risk → at-risk + risk→priority; dedupe contract (in-batch + standing-order); simulated-default/inert-EH; advisory (human submits, never auto-submit); trigger-agnostic engine; no schema; named-but-deferred `OrderSubmitter` EH write drop-in.

- [ ] **Step 2: ARCHITECTURE.md** — §3 add an `order` module bullet (proposeOrders engine, order-catalog action evaluators, StandingOrderProvider port simulated/inert, ProposedOrder→ServiceRequest); §7 External Interfaces add `GET /api/orders/proposals?measureId=&subjectId=&from=&to=&format=domain|fhir` (CM/ADMIN, read-time, no schema); a §6 invariant line: order proposals are advisory and never auto-submitted (CQL/compliance unaffected).

- [ ] **Step 3: DATA_MODEL.md** — a subsection: no `orders` table; proposals derived read-time from `outcomes`; documented EH drop-ins (`ehStandingOrderProvider` real FHIR query + future `OrderSubmitter` write path + its persistence, owned by the maintainer).

- [ ] **Step 4: MEASURES.md** — a short note: the action-evaluator order map (per-measure proposed order codes; reuse of the terminology_mappings seed for audiogram/TB/flu).

- [ ] **Step 5: JOURNAL.md** — prepend a dated 2026-06-19 E7 entry (engine, ports, endpoint, Panel=Risk, dedupe, no-schema, ADR-013, design-only/EH-deferred; full suite green).

- [ ] **Step 6: README.md** — add `GET /api/orders/proposals` to API highlights.

- [ ] **Step 7: Commit**

```bash
git add docs/ README.md
git commit -m "docs: #77 E7 — order generation (ARCHITECTURE, DATA_MODEL, MEASURES, ADR-013, JOURNAL, README)"
```

---

## Final verification

- [ ] `cd backend-ts && pnpm typecheck && pnpm test` — all green (idempotency + audit invariants pass; the orders endpoint writes no state).
- [ ] (No frontend changes in E7 — skip the frontend build unless a doc/link check is wanted.)
- [ ] **Whole-PR code review:** run `superpowers:code-reviewer` on the entire branch diff before opening the PR (maintainer's standing rule).
- [ ] Open PR referencing #77; CI green; merge on maintainer approval (no auto-merge). Deploys on merge.
- [ ] Post-deploy: `GET /api/orders/proposals` live (with a CM/ADMIN token) returns proposals for existing OVERDUE cases; `?format=fhir` returns a ServiceRequest Bundle.

---

## Self-review (author)

- **Spec coverage:** Panel=Risk + risk→priority (Task 4 + spec §2); ProposedOrder/ServiceRequest (Task 1, §4.1); action-evaluator catalog + terminology reuse (Task 2, §4.2); StandingOrderProvider simulated/inert (Task 3, §4.3); proposeOrders dedupe/suppression + trigger-agnostic (Task 4, §4.4); endpoint domain|fhir + CM/ADMIN + latest-population-run reuse (Task 5, §4.5); no schema (no migration tasks); ADR-013 + docs (Task 6, §6/§8); OrderSubmitter named-deferred (docs Task 6 step 3, §5). All spec sections mapped. UI panel + real EH explicitly out of scope (spec §3/§9) — no tasks, by design.
- **Type consistency:** `OrderCode`/`ProposedOrder`/`OrderPriority` defined Task 1, reused Tasks 2/4/5. `dedupeKeyFor`/`toServiceRequest`/`bundleOf` Task 1 → used Tasks 4/5. `StandingOrderProvider`/`resolveStandingOrderProvider`/`StandingOrderEnv` Task 3 → used Tasks 4/5. `AtRiskOutcome` Task 4 → used Task 5. `latestRunRows` Task 5 (shared) → used route + hierarchy. `orderForMeasure` Task 2 → used Task 4.
- **Verify-points flagged inline (codebase confirmations, not placeholders):** CPT/CVX system URIs vs value-set-seed.ts (Task 2); the store-injection harness in route + test vs hierarchy.ts/.test.ts (Task 5 Steps 3–4); worker `Env` already satisfies `StandingOrderEnv` (Task 5 Step 5); the authorize matrix test file + its CM/A assertion style (Task 5 Step 5); ADR number is 013 (Task 6).
