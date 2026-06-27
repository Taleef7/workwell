# E13 PR-1 — Multi-tenant (multi-system) rollup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tenant/system dimension above the existing enterprise→location→provider→patient rollup so compliance from multiple WebChart systems aggregates into one reconciling dashboard, read-time from the synthetic directory, no schema change.

**Architecture:** A second synthetic tenant ("Indus Hospital Network", ~50 employees) is added to `employee-catalog.ts`; `EMPLOYEES` spans both tenants so the run pipeline evaluates everyone. The hierarchy rollup gains an "All Systems" aggregate root → tenant → enterprise → location → provider → patient, tenant-qualified so nothing merges across systems. Roster + programs + a new `GET /api/tenants` gain an optional `?tenant=` filter (default = all). Spec: `docs/superpowers/specs/2026-06-26-e13-multitenant-rollup-design.md`.

**Tech Stack:** TypeScript (`backend-ts`, node:test + tsx), Next.js 16 App Router frontend, SQLite floor for tests.

---

## File structure

- `backend-ts/src/engine/synthetic/employee-catalog.ts` — **modify**: Tenant model, Tenant 2 data, `tenantId` on Provider/Employee, helpers.
- `backend-ts/src/program/hierarchy-rollup.ts` — **modify**: "all"+"tenant" levels, tenant-qualified maps, `?tenant=` filter.
- `backend-ts/src/program/hierarchy-rollup.test.ts` — **modify**: new root level + cross-tenant reconciliation.
- `backend-ts/src/routes/hierarchy.ts` — **modify**: pass `?tenant=`.
- `backend-ts/src/routes/tenants.ts` — **create**: `GET /api/tenants`.
- `backend-ts/src/routes/tenants.test.ts` — **create**.
- `backend-ts/src/worker.ts` — **modify**: register `handleTenants`.
- `backend-ts/src/compliance/roster-read-model.ts` — **modify**: `tenant` filter + `tenantId`/`tenantName` on rows.
- `backend-ts/src/compliance/roster-read-model.test.ts` — **modify**.
- `backend-ts/src/routes/compliance.ts` — **modify**: pass `?tenant=`.
- `backend-ts/src/program/program-read-models.ts` — **modify**: `tenant` filter (tenantMatcher).
- `backend-ts/src/program/program-read-models.test.ts` — **modify** (or add a focused test).
- `backend-ts/src/routes/programs.ts` — **modify**: pass `?tenant=`.
- `frontend/lib/api/*` + `frontend/app/(dashboard)/{programs,compliance,programs/hierarchy}/` — **modify**: tenant select + column.
- Docs — **modify**: ARCHITECTURE, DATA_MODEL, DECISIONS (ADR), JOURNAL, CLAUDE.md.

---

## Task 1: Multi-tenant synthetic directory

**Files:**
- Modify: `backend-ts/src/engine/synthetic/employee-catalog.ts`
- Test: `backend-ts/src/engine/synthetic/employee-catalog.test.ts` (create if absent)

- [ ] **Step 1: Write failing tests**

Create/append `backend-ts/src/engine/synthetic/employee-catalog.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPLOYEES, PROVIDERS, TENANTS, employeeById, tenantById,
  enterpriseForTenant, employeesForTenant, providerById,
} from "./employee-catalog.ts";

test("two tenants exist with stable ids/names", () => {
  assert.deepEqual(TENANTS.map((t) => t.id).sort(), ["ihn", "twh"]);
  assert.equal(tenantById("twh")?.name, "Total Worker Health");
  assert.equal(tenantById("ihn")?.name, "Indus Hospital Network");
  assert.equal(tenantById("nope"), null);
});

test("every employee and provider resolves to a known tenant", () => {
  const ids = new Set(TENANTS.map((t) => t.id));
  for (const e of EMPLOYEES) assert.ok(ids.has(e.tenantId), `${e.externalId} tenant`);
  for (const p of PROVIDERS) assert.ok(ids.has(p.tenantId), `${p.id} tenant`);
});

test("tenant 1 keeps the original 100 employees unchanged on twh", () => {
  const twh = employeesForTenant("twh");
  assert.equal(twh.length, 100);
  assert.equal(twh[0]!.externalId, "emp-001");
  assert.ok(twh.every((e) => e.tenantId === "twh"));
  // identities preserved
  assert.equal(employeeById("emp-006")?.site, "Plant A");
  assert.equal(employeeById("emp-006")?.providerId, "prov-002");
});

test("tenant 2 (ihn) adds ~50 employees with distinct ids/providers, partitioning EMPLOYEES", () => {
  const ihn = employeesForTenant("ihn");
  assert.ok(ihn.length >= 40 && ihn.length <= 60, `ihn size ${ihn.length}`);
  assert.ok(ihn.every((e) => e.externalId.startsWith("ihn-emp-")));
  assert.ok(ihn.every((e) => e.tenantId === "ihn"));
  // partition: twh ∪ ihn == EMPLOYEES, disjoint
  assert.equal(employeesForTenant("twh").length + ihn.length, EMPLOYEES.length);
  // ihn providers resolve and carry tenant ihn
  const p = providerById(ihn[0]!.providerId)!;
  assert.equal(p.tenantId, "ihn");
});

test("enterpriseForTenant maps each tenant to its enterprise", () => {
  assert.equal(enterpriseForTenant("twh")?.id, "twh");
  assert.equal(enterpriseForTenant("ihn")?.name, "Indus Hospital Network");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend-ts && pnpm exec tsx --test src/engine/synthetic/employee-catalog.test.ts`
Expected: FAIL (TENANTS/tenantById/etc. undefined).

- [ ] **Step 3: Implement the multi-tenant directory**

Edit `employee-catalog.ts`:

1. Add the `Tenant` type, `TENANTS`, and per-tenant enterprise constants near the top:

```ts
export interface Tenant { id: string; name: string; }
export interface Enterprise { id: string; name: string; tenantId: string; }

export const TENANTS: readonly Tenant[] = [
  { id: "twh", name: "Total Worker Health" },
  { id: "ihn", name: "Indus Hospital Network" },
];

// One enterprise per tenant in PR-1 (the level is retained for future multi-org tenants).
const ENTERPRISES: readonly Enterprise[] = [
  { id: "twh", name: "Total Worker Health", tenantId: "twh" },
  { id: "ihn", name: "Indus Hospital Network", tenantId: "ihn" },
];
```

2. Keep the existing `ENTERPRISE` export (= Tenant 1's enterprise) for back-compat:

```ts
/** Tenant 1's enterprise root (back-compat; = ENTERPRISES[0]). */
export const ENTERPRISE = { id: "twh", name: "Total Worker Health" } as const;
```

3. Add `tenantId` to `EmployeeProfile` and `Provider`:

```ts
export interface EmployeeProfile {
  externalId: string; name: string; role: string; site: string;
  providerId: string; tenantId: string;
}
export interface Provider { id: string; name: string; location: string; tenantId: string; }
```

4. Stamp `tenantId: "twh"` on every existing `PROVIDERS` entry (prov-001…prov-008).

5. Add Tenant 2 providers (append to `PROVIDERS`) — 6 providers across 3 locations, all `tenantId: "ihn"`:

```ts
  { id: "prov-101", name: "Dr. Saima Anwar",   location: "North Campus",      tenantId: "ihn" },
  { id: "prov-102", name: "NP Rizwan Tariq",   location: "North Campus",      tenantId: "ihn" },
  { id: "prov-103", name: "Dr. Maria Yusuf",   location: "South Campus",      tenantId: "ihn" },
  { id: "prov-104", name: "NP Hamid Raza",     location: "South Campus",      tenantId: "ihn" },
  { id: "prov-105", name: "Dr. Nida Kamal",    location: "Outpatient Clinic", tenantId: "ihn" },
  { id: "prov-106", name: "NP Asad Mahmood",   location: "Outpatient Clinic", tenantId: "ihn" },
```

6. Refactor the base-employee → profile assembly so each base row carries a `tenantId`. Change `EmployeeBase` to include tenant, default the existing 100 to `twh`, and add ~50 `ihn` rows. Concretely:

```ts
type EmployeeBase = Omit<EmployeeProfile, "providerId">; // now includes tenantId

// existing 100 rows: add `tenantId: "twh"` to each. (Mechanical — every emp-0NN row.)
// Tenant 2: 50 rows across the 3 ihn locations, ids ihn-emp-001..050, tenantId "ihn".
const IHN_BASE: readonly EmployeeBase[] = [
  { externalId: "ihn-emp-001", name: "Ayesha Noor",    role: "Nurse",            site: "North Campus",      tenantId: "ihn" },
  // …50 rows total, distributed ~17/17/16 across North Campus / South Campus / Outpatient Clinic,
  //   roles drawn from {Nurse, Physician, Lab Tech, Front Desk, Pharmacist, Radiology Tech}.
];
const EMPLOYEE_BASE: readonly EmployeeBase[] = [ ...TWH_BASE, ...IHN_BASE ];
```

   (Rename the existing array to `TWH_BASE`; generate the 50 ihn rows with deterministic synthetic
   names — no randomness in module scope.)

7. Make provider attribution tenant-aware. `assignProviders` already groups by `site` and round-robins that site's providers; because ihn locations are distinct names with their own providers, the existing per-site grouping already keeps attribution within-tenant. Keep `providersForLocation` as-is; it now returns ihn providers for ihn locations. Verify `PROVIDERS_BY_LOCATION` is built from the full (both-tenant) `PROVIDERS`.

8. Add the helpers at the end:

```ts
const TENANT_BY_ID = new Map(TENANTS.map((t) => [t.id, t]));
const ENTERPRISE_BY_TENANT = new Map(ENTERPRISES.map((e) => [e.tenantId, e]));

/** Lookup a tenant by id; null when unknown. */
export function tenantById(id: string): Tenant | null { return TENANT_BY_ID.get(id) ?? null; }
/** The enterprise for a tenant; null when unknown. */
export function enterpriseForTenant(tenantId: string): Enterprise | null { return ENTERPRISE_BY_TENANT.get(tenantId) ?? null; }
/** Employees belonging to a tenant (directory order). */
export function employeesForTenant(tenantId: string): EmployeeProfile[] {
  return EMPLOYEES.filter((e) => e.tenantId === tenantId);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd backend-ts && pnpm exec tsx --test src/engine/synthetic/employee-catalog.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full backend typecheck (surface downstream type breaks early)**

Run: `cd backend-ts && pnpm typecheck`
Expected: PASS. (If `Provider`/`EmployeeProfile` literals elsewhere now miss `tenantId`, fix those call sites — they should all be inside `employee-catalog.ts`.)

- [ ] **Step 6: Commit**

```bash
git add backend-ts/src/engine/synthetic/employee-catalog.ts backend-ts/src/engine/synthetic/employee-catalog.test.ts
git commit -m "feat(e13): multi-tenant synthetic directory (twh + ihn), tenant helpers"
```

---

## Task 2: Tenant + All-Systems levels in the hierarchy rollup

**Files:**
- Modify: `backend-ts/src/program/hierarchy-rollup.ts`
- Test: `backend-ts/src/program/hierarchy-rollup.test.ts`

- [ ] **Step 1: Write failing tests** — append cross-tenant cases and update root-level expectations.

Add to `hierarchy-rollup.test.ts` (keep `assertReconciles`, which is level-agnostic):

```ts
import { TENANTS } from "../engine/synthetic/employee-catalog.ts";

test("default root is the All-Systems aggregate over tenants, reconciling at every level", async () => {
  const root = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, { measureId: "audiogram" });
  assert.equal(root.level, "all");
  assert.equal(root.id, "all");
  // only twh subjects were seeded → one tenant child
  assert.ok(root.children.every((c) => c.level === "tenant"));
  const twh = root.children.find((c) => c.id === "twh")!;
  assert.equal(twh.level, "tenant");
  assert.equal(twh.children[0]!.level, "enterprise");
  assertReconciles(root);
});

test("?tenant=twh returns the twh tenant subtree as root, totals = its slice", async () => {
  const all = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, { measureId: "audiogram" });
  const sub = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, { measureId: "audiogram", tenant: "twh" });
  assert.equal(sub.level, "tenant");
  assert.equal(sub.id, "twh");
  const twhInAll = all.children.find((c) => c.id === "twh")!;
  assert.equal(sub.totals.evaluated, twhInAll.totals.evaluated);
  assert.equal(sub.totals.compliant, twhInAll.totals.compliant);
  assertReconciles(sub);
});

test("?tenant=unknown → empty All-Systems-shaped tenant root with zeros", async () => {
  const sub = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, { measureId: "audiogram", tenant: "ihn" });
  // ihn has no seeded outcomes in this fixture
  assert.equal(sub.totals.evaluated, 0);
  assert.equal(sub.children.length, 0);
});
```

Update the three existing tests that assert `root.level === "enterprise"` / drill `root.children` as locations. Replace the navigation to go through `all → tenant(twh) → enterprise(twh) → location`:

```ts
// helper added near the top of the test file
function twhEnterprise(root: HierarchyNode): HierarchyNode {
  const twh = root.children.find((c) => c.id === "twh")!;
  return twh.children.find((c) => c.level === "enterprise")!;
}
```

- In "rollup reconciles…": change `assert.equal(root.level, "enterprise")` → `"all"`; the `root.totals.*` assertions stay (All-Systems totals == twh totals here).
- In "levels are enterprise→…": derive `const plantA = twhEnterprise(root).children.find((c) => c.id === "Plant A")!;`.
- In "empty scope (unknown measure)": change `root.level` → `"all"`, keep zeros + `children.length === 0`.
- In the multi-child + open-case blocks: derive `plantA` via `twhEnterprise(root)`.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend-ts && pnpm exec tsx --test src/program/hierarchy-rollup.test.ts`
Expected: FAIL (root.level "all" not yet produced; `tenant` filter ignored).

- [ ] **Step 3: Implement the tenant/all levels**

Edit `hierarchy-rollup.ts`:

1. Extend the level union + filters:

```ts
export type HierarchyLevel = "all" | "tenant" | "enterprise" | "location" | "provider" | "patient";

export interface HierarchyFilters {
  measureId?: string | null;
  from?: string | null;
  to?: string | null;
  tenant?: string | null;
}
```

2. Import tenant helpers:

```ts
import { ENTERPRISE, employeeById, providerById, tenantById, enterpriseForTenant } from "../engine/synthetic/employee-catalog.ts";
```

3. Build the tree bottom-up with **tenant-qualified** keys. Replace the assembly (the block from `const providerTotals = …` to the final `return`) so accumulation maps key by tenant, then wrap location children under per-tenant enterprise nodes, tenants under the all-root. Resolve a subject's tenant via `employeeById(subjectId)!.tenantId`. Concretely:

```ts
  const tenantFilter = filters.tenant?.trim() || null;

  // location/provider totals keyed by tenant-qualified id so same-named anything never merges.
  const provTotals = new Map<string, MutableTotals>();      // key: `${tenantId}|${providerId}`
  const locTotals = new Map<string, MutableTotals>();       // key: `${tenantId}|${location}`
  const entTotals = new Map<string, MutableTotals>();       // key: tenantId
  const patientsByProvKey = new Map<string, HierarchyNode[]>();
  const tenantsSeen = new Set<string>();

  for (const [subjectId, t] of byPatient) {
    if (t.evaluated === 0 && t.openCases === 0) continue;
    const emp = employeeById(subjectId)!;
    if (tenantFilter && emp.tenantId !== tenantFilter) continue;
    const prov = providerById(emp.providerId);
    const location = prov?.location ?? "Unknown";
    const provKey = `${emp.tenantId}|${emp.providerId}`;
    const locKey = `${emp.tenantId}|${location}`;
    tenantsSeen.add(emp.tenantId);
    const node: HierarchyNode = { level: "patient", id: subjectId, name: emp.name, parentId: emp.providerId, totals: seal(t), children: [] };
    (patientsByProvKey.get(provKey) ?? patientsByProvKey.set(provKey, []).get(provKey)!).push(node);
    accumulate(provTotals.get(provKey) ?? provTotals.set(provKey, zero()).get(provKey)!, t);
    accumulate(locTotals.get(locKey) ?? locTotals.set(locKey, zero()).get(locKey)!, t);
    accumulate(entTotals.get(emp.tenantId) ?? entTotals.set(emp.tenantId, zero()).get(emp.tenantId)!, t);
  }

  // provider nodes grouped under tenant-qualified location keys
  const provsByLocKey = new Map<string, HierarchyNode[]>();
  for (const [provKey, patients] of patientsByProvKey) {
    const [tenantId, providerId] = provKey.split("|");
    const prov = providerById(providerId!);
    const location = prov?.location ?? "Unknown";
    const locKey = `${tenantId}|${location}`;
    const provNode: HierarchyNode = {
      level: "provider", id: providerId!, name: prov?.name ?? providerId!, parentId: location,
      totals: seal(provTotals.get(provKey)!), children: patients.sort((a, b) => a.id.localeCompare(b.id)),
    };
    (provsByLocKey.get(locKey) ?? provsByLocKey.set(locKey, []).get(locKey)!).push(provNode);
  }

  // location nodes grouped under tenant (enterprise) — build per-tenant enterprise subtrees
  const locsByTenant = new Map<string, HierarchyNode[]>();
  for (const [locKey, provs] of provsByLocKey) {
    const [tenantId, location] = locKey.split("|");
    const locNode: HierarchyNode = {
      level: "location", id: location!, name: location!, parentId: tenantId!,
      totals: seal(locTotals.get(locKey)!), children: provs.sort((a, b) => a.id.localeCompare(b.id)),
    };
    (locsByTenant.get(tenantId!) ?? locsByTenant.set(tenantId!, []).get(tenantId!)!).push(locNode);
  }

  // enterprise node (1 per tenant) → tenant node
  const tenantNodes: HierarchyNode[] = [...tenantsSeen].sort().map((tenantId): HierarchyNode => {
    const ent = enterpriseForTenant(tenantId);
    const locations = (locsByTenant.get(tenantId) ?? []).sort((a, b) => a.id.localeCompare(b.id));
    const tenantTotals = seal(entTotals.get(tenantId)!);
    const enterpriseNode: HierarchyNode = {
      level: "enterprise", id: ent?.id ?? tenantId, name: ent?.name ?? tenantId, parentId: tenantId,
      totals: tenantTotals, children: locations,
    };
    return {
      level: "tenant", id: tenantId, name: tenantById(tenantId)?.name ?? tenantId, parentId: "all",
      totals: tenantTotals, children: [enterpriseNode],
    };
  });

  // tenant-filtered → return that single tenant subtree as root (empty zero-node if absent)
  if (tenantFilter) {
    return tenantNodes.find((t) => t.id === tenantFilter)
      ?? { level: "tenant", id: tenantFilter, name: tenantById(tenantFilter)?.name ?? tenantFilter, parentId: "all", totals: seal(zero()), children: [] };
  }

  const allTotals = zero();
  for (const t of entTotals.values()) accumulate(allTotals, t);
  return {
    level: "all", id: "all", name: "All Systems", parentId: null,
    totals: seal(allTotals), children: tenantNodes,
  };
```

   Remove the now-unused single-`ENTERPRISE`-root return and the old `providerTotals`/`locationTotals`/
   `patientsByProvider`/`ent` block it replaces. (`ENTERPRISE` import may become unused — drop it if so.)

- [ ] **Step 4: Run tests to verify pass**

Run: `cd backend-ts && pnpm exec tsx --test src/program/hierarchy-rollup.test.ts`
Expected: PASS (all updated + new tests).

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/program/hierarchy-rollup.ts backend-ts/src/program/hierarchy-rollup.test.ts
git commit -m "feat(e13): All-Systems→tenant→enterprise rollup levels + ?tenant filter"
```

---

## Task 3: Hierarchy route passes `?tenant=`

**Files:**
- Modify: `backend-ts/src/routes/hierarchy.ts`
- Test: `backend-ts/src/routes/hierarchy.test.ts`

- [ ] **Step 1: Add a failing test** to `hierarchy.test.ts`:

```ts
test("?tenant=twh returns a tenant-level root", async () => {
  const res = await get("?tenant=twh");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.level, "tenant");
  assert.equal(body.id, "twh");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend-ts && pnpm exec tsx --test src/routes/hierarchy.test.ts`
Expected: FAIL (body.level is "all", tenant ignored).

- [ ] **Step 3: Implement** — pass the param in `hierarchy.ts`:

```ts
  const tree = await buildHierarchyRollup(
    { outcomeStore: s.outcomes, caseStore: s.cases },
    { measureId: q.get("measureId"), from, to, tenant: q.get("tenant") },
  );
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend-ts && pnpm exec tsx --test src/routes/hierarchy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/routes/hierarchy.ts backend-ts/src/routes/hierarchy.test.ts
git commit -m "feat(e13): /api/hierarchy/rollup honors ?tenant filter"
```

---

## Task 4: `GET /api/tenants`

**Files:**
- Create: `backend-ts/src/routes/tenants.ts`
- Create: `backend-ts/src/routes/tenants.test.ts`
- Modify: `backend-ts/src/worker.ts`

- [ ] **Step 1: Write failing test** — `tenants.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleTenants } from "./tenants.ts";

test("GET /api/tenants lists both tenants", async () => {
  const res = (await handleTenants(new Request("http://x/api/tenants", { method: "GET" })))!;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.map((t: { id: string }) => t.id).sort(), ["ihn", "twh"]);
});

test("non-matching path → null (not handled)", async () => {
  assert.equal(await handleTenants(new Request("http://x/api/other", { method: "GET" })), null);
});

test("POST → null", async () => {
  assert.equal(await handleTenants(new Request("http://x/api/tenants", { method: "POST" })), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend-ts && pnpm exec tsx --test src/routes/tenants.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `tenants.ts`:

```ts
/**
 * Tenants route (#185 E13 PR-1) — lists the WebChart systems for the UI tenant selector.
 * Authenticated read-only under the /api/** matrix (catch-all GET → AUTHENTICATED).
 *
 *   GET /api/tenants → { id, name }[]
 */
import { TENANTS } from "../engine/synthetic/employee-catalog.ts";

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

export async function handleTenants(req: Request): Promise<Response | null> {
  if (req.method !== "GET") return null;
  if (new URL(req.url).pathname !== "/api/tenants") return null;
  return json(TENANTS.map((t) => ({ id: t.id, name: t.name })));
}
```

- [ ] **Step 4: Register in `worker.ts`** — add the import near the other route imports and dispatch it next to programs/hierarchy:

```ts
import { handleTenants } from "./routes/tenants.ts";
```
```ts
  // Tenants — WebChart system list for the multi-tenant selector (#185 E13 PR-1).
  const tenantsResponse = await handleTenants(req);
  if (tenantsResponse) return tenantsResponse;
```

- [ ] **Step 5: Run to verify pass + typecheck**

Run: `cd backend-ts && pnpm exec tsx --test src/routes/tenants.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend-ts/src/routes/tenants.ts backend-ts/src/routes/tenants.test.ts backend-ts/src/worker.ts
git commit -m "feat(e13): GET /api/tenants for the multi-tenant selector"
```

---

## Task 5: Roster `?tenant=` filter + tenant on rows

**Files:**
- Modify: `backend-ts/src/compliance/roster-read-model.ts`
- Modify: `backend-ts/src/routes/compliance.ts`
- Test: `backend-ts/src/compliance/roster-read-model.test.ts`

- [ ] **Step 1: Write failing test** — append to `roster-read-model.test.ts` (follow the file's existing store-seeding pattern; seed one twh + one ihn outcome for a panel measure, then):

```ts
test("tenant filter scopes rows; rows carry tenantId/tenantName", async () => {
  const all = await buildRoster({ outcomeStore }, { panel: "osha", pageSize: 200 });
  assert.ok(all.rows.some((r) => r.subject.tenantId === "twh"));
  assert.ok(all.rows.some((r) => r.subject.tenantId === "ihn"));
  const twh = await buildRoster({ outcomeStore }, { panel: "osha", tenant: "twh", pageSize: 200 });
  assert.ok(twh.rows.every((r) => r.subject.tenantId === "twh"));
  assert.ok(twh.total < all.total);
  assert.equal(twh.rows[0]!.subject.tenantName, "Total Worker Health");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend-ts && pnpm exec tsx --test src/compliance/roster-read-model.test.ts`
Expected: FAIL (`tenant` filter + `subject.tenantId` absent).

- [ ] **Step 3: Implement**

In `roster-read-model.ts`:
- Add to `RosterFilters`: `tenant?: string | null;`
- Extend the row subject type: `subject: { externalId: string; name: string; role: string; site: string; tenantId: string; tenantName: string }`.
- Import `tenantById` from the catalog.
- When building each row, include tenant fields:

```ts
    return { subject: { externalId: emp.externalId, name: emp.name, role: emp.role, site: emp.site, tenantId: emp.tenantId, tenantName: tenantById(emp.tenantId)?.name ?? emp.tenantId }, cells };
```
- Add the tenant filter alongside the existing site/role filters:

```ts
  if (filters.tenant) rows = rows.filter((r) => r.subject.tenantId === filters.tenant);
```

In `compliance.ts`, pass it through:

```ts
      tenant: q.get("tenant"),
```

- [ ] **Step 4: Run to verify pass + the full compliance route test**

Run: `cd backend-ts && pnpm exec tsx --test src/compliance/roster-read-model.test.ts src/routes/compliance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/compliance/roster-read-model.ts backend-ts/src/routes/compliance.ts backend-ts/src/compliance/roster-read-model.test.ts
git commit -m "feat(e13): roster ?tenant filter + tenant on each row"
```

---

## Task 6: Programs `?tenant=` filter

**Files:**
- Modify: `backend-ts/src/program/program-read-models.ts`
- Modify: `backend-ts/src/routes/programs.ts`
- Test: `backend-ts/src/program/program-read-models.test.ts`

- [ ] **Step 1: Write failing test** — append (seed a twh + ihn outcome for one Active measure, then):

```ts
test("programOverview ?tenant scopes the population to that tenant", async () => {
  const all = await programOverview(deps, {});
  const twh = await programOverview(deps, { tenant: "twh" });
  const m = (s: ProgramSummary[], id: string) => s.find((x) => x.measureId === id)!;
  // twh-scoped evaluated count ≤ all-tenant for the seeded measure
  assert.ok(m(twh, "audiogram").totalEvaluated <= m(all, "audiogram").totalEvaluated);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend-ts && pnpm exec tsx --test src/program/program-read-models.test.ts`
Expected: FAIL (`tenant` ignored — counts equal).

- [ ] **Step 3: Implement** — in `program-read-models.ts`:
- Add to `ProgramFilters`: `tenant?: string | null;`
- Add a tenant matcher mirroring `siteMatcher`:

```ts
const tenantMatcher = (filters: ProgramFilters) => {
  const tenant = filters.tenant?.trim() || null;
  return (subjectId: string) => !tenant || (employeeById(subjectId)?.tenantId ?? null) === tenant;
};
```
- In `programOverview`, build `const tenantMatch = tenantMatcher(filters);` and AND it into the row filter and the open-case filter:

```ts
    (r) => siteMatch(r.subjectId) && tenantMatch(r.subjectId) && isPopulationRun(r.runScopeType) && isCompletedRun(r.runStatus),
```
```ts
      (c) => c.measureId === m.id && c.status === "OPEN" && siteMatch(c.employeeId) && tenantMatch(c.employeeId) && inPeriod(c.createdAt),
```
   (Apply the same `tenantMatch` to `runsWithOutcomes`/`programTrend` row filters where `siteMatch` is used, so the trend honors tenant too.)

In `programs.ts`, add `tenant: q.get("tenant")` to the parsed `filters` object (and to its type).

- [ ] **Step 4: Run to verify pass**

Run: `cd backend-ts && pnpm exec tsx --test src/program/program-read-models.test.ts src/routes/programs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/program/program-read-models.ts backend-ts/src/routes/programs.ts backend-ts/src/program/program-read-models.test.ts
git commit -m "feat(e13): programs overview/trend ?tenant filter"
```

---

## Task 7: Full backend gate

- [ ] **Step 1: Typecheck + full suite**

Run: `cd backend-ts && pnpm typecheck && pnpm test`
Expected: PASS (all ~700+ tests; pg-ceiling contract self-skips without local Postgres). Fix any directory-size assertions elsewhere that hardcoded 100 employees (search: `grep -rn "100" src/**/*.test.ts` for population-count assumptions; e.g. employee-search/distribution counts may need updating to the new total).

- [ ] **Step 2: Commit any fixups**

```bash
git add -A && git commit -m "test(e13): update population-count expectations for the second tenant"
```

---

## Task 8: Frontend — tenant selector + column

**Files:**
- Modify: `frontend/lib/api/client.ts` (or `hooks.ts`) — add a `fetchTenants()` call + types; thread an optional `tenant` arg into the rollup/roster/programs fetchers.
- Modify: `frontend/app/(dashboard)/programs/hierarchy/page.tsx` — render the new top levels (the table recurses on `children`; confirm it is depth-agnostic — if it special-cases level names, extend its label map with `all`/`tenant`) + add a tenant `<select>` ("All systems" default) that re-fetches with `&tenant=`.
- Modify: `frontend/app/(dashboard)/compliance/page.tsx` — add a tenant `<select>` to the filter row (mirror the existing site/segment selects) + a tenant column on the grid (`row.subject.tenantName`).
- Modify: `frontend/app/(dashboard)/programs/page.tsx` — add the tenant `<select>` scoping the overview fetch.

- [ ] **Step 1: Read the three pages + the api client** to learn the existing filter-select and fetch patterns.

Run: open `frontend/app/(dashboard)/compliance/page.tsx`, `frontend/app/(dashboard)/programs/page.tsx`, `frontend/app/(dashboard)/programs/hierarchy/page.tsx`, `frontend/lib/api/client.ts`.

- [ ] **Step 2: Add the tenants fetch + types** to the api layer (follow the existing fetcher signature). Add a `Tenant = { id: string; name: string }` type and a `tenants()` fetcher hitting `GET /api/tenants`. Thread an optional `tenant?: string` query param into the existing `hierarchyRollup`, `complianceRoster`, and `programsOverview` fetchers (append `&tenant=` only when set).

- [ ] **Step 3: Wire the selects** — on each page, add a controlled `tenant` state (default `""` = all), populate the `<select>` from `tenants()`, and include `tenant` in the fetch deps so changing it re-queries. On `/compliance` also render `row.subject.tenantName` as a new column header + cell.

- [ ] **Step 4: Verify hierarchy table depth** — confirm `programs/hierarchy/page.tsx` renders arbitrary depth (recursive row component). If it maps `level` to an indent/label, add `all` and `tenant` to that map.

- [ ] **Step 5: Lint + build**

Run: `cd frontend && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/lib/api frontend/app/\(dashboard\)/programs frontend/app/\(dashboard\)/compliance
git commit -m "feat(e13): tenant selector on programs/compliance/hierarchy + tenant column"
```

---

## Task 9: Docs, ADR, journal

**Files:** `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/DECISIONS.md`, `docs/JOURNAL.md`, `CLAUDE.md`.

- [ ] **Step 1: ARCHITECTURE.md** — §3 `program` module: note the rollup's new All-Systems→tenant→enterprise levels + tenant-qualified accumulation; §4 routes: tenant select on `/programs`, `/compliance`, `/programs/hierarchy`; §7 API: the `?tenant=` filters on rollup/roster/programs + the new `GET /api/tenants`; §6 invariants: cross-tenant reconciliation (All = Σ tenants).

- [ ] **Step 2: DATA_MODEL.md** — §3.6 directory note: tenant is resolved read-time from the directory (`tenantId` on `EmployeeProfile`/`Provider`), **no table**; a second synthetic tenant (`ihn`) adds ~50 employees; `outcomes`/`cases` unchanged.

- [ ] **Step 3: DECISIONS.md** — new ADR (next number): "Multi-tenant rollup modeled in the read-time synthetic directory (no schema)". Record: tenant above enterprise (5-level), All-Systems aggregate root, multi-tenant-everywhere via optional `?tenant=`, reversibility (revert the additive Tenant-2 data), CQL stays sole compliance authority (ADR-008).

- [ ] **Step 4: JOURNAL.md** — dated `2026-06-26` entry summarizing E13 PR-1.

- [ ] **Step 5: CLAUDE.md** — Current Focus: E13 PR-1 shipped (multi-tenant rollup); PR-2 (scale harness) + PR-3 (cron recompute) next; catalog counts unchanged; directory now ~150 employees across 2 tenants.

- [ ] **Step 6: Commit**

```bash
git add docs CLAUDE.md
git commit -m "docs(e13): ARCHITECTURE/DATA_MODEL/DECISIONS(ADR)/JOURNAL + CLAUDE focus for PR-1"
```

---

## Task 10: Final verification + PR

- [ ] **Step 1:** `cd backend-ts && pnpm typecheck && pnpm test` → green.
- [ ] **Step 2:** `cd frontend && npm run lint && npm run build` → green.
- [ ] **Step 3:** Code review the whole branch diff (superpowers:requesting-code-review / code-reviewer agent over the full PR diff). Address findings.
- [ ] **Step 4:** Push branch, open PR to `main` with a body summarizing PR-1 scope, the no-schema/no-deps guarantees, reversibility, and the deferred PR-2/PR-3. Do not auto-merge (maintainer reviews).

---

## Self-review notes
- **Spec coverage:** tenant model (T1), rollup levels + reconciliation + `?tenant` (T2/T3), `GET /api/tenants` (T4), multi-tenant-everywhere roster/programs (T5/T6), frontend selectors + column (T8), docs/ADR (T9), no-schema/no-deps + reversibility (throughout). All spec sections map to a task.
- **Type consistency:** `tenantId` added to `EmployeeProfile`/`Provider` (T1) and consumed everywhere; `HierarchyFilters.tenant`, `RosterFilters.tenant`, `ProgramFilters.tenant` named identically; rollup `HierarchyLevel` union extended once (T2) and used by the route/test.
- **Population-count risk:** adding Tenant 2 changes total directory size — T7 explicitly hunts hardcoded `100`/population assertions across the suite.
