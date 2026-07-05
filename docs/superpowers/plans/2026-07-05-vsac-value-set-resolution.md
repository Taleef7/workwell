# Live VSAC Value-Set Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make VSAC value-set expansion real behind the existing `ValueSetResolver` port — a live `VsacValueSetResolver`, a composite (VSAC-for-real-OIDs / local-fallback-for-URNs) resolver wired into the runtime engine, and an owner-run CLI that imports real VSAC expansions into `value_sets` — with zero compliance drift.

**Architecture:** Three `ValueSetResolver` implementations composed behind the unchanged `expand()` port: `StoreValueSetResolver` (existing, local fallback), a new `VsacValueSetResolver` (real `ValueSet/$expand` over an injectable `VsacClient` transport), and a new `CompositeValueSetResolver` (routes real OIDs → VSAC, `urn:workwell:*`/URLs → store). `resolveValueSetResolver(env, store)` selects composite-when-keyed, plain-store-otherwise (inert-unless-configured). Runtime engines are built by a memoized `engineForEnv(env)`. An owner-run CLI (`pnpm resolve-valuesets`) persists expansions into `value_sets` (existing columns, no DDL), audited.

**Tech Stack:** TypeScript (node-24, `tsx`), `cql-execution`, node `--test` + `node:assert/strict`, SQLite floor + Postgres ceiling stores, global `fetch` (no new dependency).

**Reference spec:** `docs/superpowers/specs/2026-07-05-vsac-value-set-resolution-design.md`

**Key constraint (ADR-008):** value-set expansion feeds the CQL engine; it never decides compliance. Enabling VSAC must not change any current measure's `Outcome Status` (Task 6 parity test proves it).

**Conventions to match (verified in-repo):**
- Test files are `*.test.ts` beside the source, run by `pnpm test` (`node --import tsx --test "src/**/*.test.ts"`). Use `node:test` (`test`, `describe`) + `node:assert/strict`.
- Imports use explicit `.ts` extensions (e.g. `from "./vsac-client.ts"`).
- `resolve*` selector pattern: see `resolveDataSource` in `src/engine/ingress/data-source.ts` (trim env, both-set-or-default).
- Transport seam pattern: see `WebChartClient`/`fixtureWebChartClient`/`httpWebChartClient` in `src/engine/ingress/webchart/webchart-client.ts`.
- Audit writes: `store.appendAudit({ eventType, entityType, entityId, actor, refRunId, refCaseId, refMeasureVersionId, payload })` (see `src/run/backfill-scale.ts:117`).
- CLI pattern: `src/run/cli/seed-scale.ts` (side-effect-free `main(argv): Promise<number>`) + `seed-scale-bin.ts` (2-line runnable entry) + `package.json` script.

---

## File Structure

New files:
- `backend-ts/src/engine/cql/vsac-client.ts` — `VsacClient` transport port, `fixtureVsacClient`, `httpVsacClient`.
- `backend-ts/src/engine/cql/vsac-client.test.ts`
- `backend-ts/src/engine/cql/vsac-value-set-resolver.ts` — `VsacValueSetResolver` (expand + memoize + error→throw).
- `backend-ts/src/engine/cql/vsac-value-set-resolver.test.ts`
- `backend-ts/src/engine/cql/composite-value-set-resolver.ts` — `CompositeValueSetResolver` (routing).
- `backend-ts/src/engine/cql/composite-value-set-resolver.test.ts`
- `backend-ts/src/engine/cql/resolve-value-set-resolver.ts` — `resolveValueSetResolver(env, store)`.
- `backend-ts/src/engine/cql/resolve-value-set-resolver.test.ts`
- `backend-ts/src/engine/cql/engine-factory.ts` — `engineForEnv(env)` memoized engine builder.
- `backend-ts/src/engine/cql/audiogram-vsac-parity.test.ts` — the ADR-008 cross-mode parity guard.
- `backend-ts/src/run/cli/resolve-valuesets.ts` — the import CLI (`main(argv)`).
- `backend-ts/src/run/cli/resolve-valuesets.test.ts`
- `backend-ts/src/run/cli/resolve-valuesets-bin.ts` — runnable entry.

Modified files:
- `backend-ts/src/stores/value-set-store.ts` — add `UpsertResolvedValueSetInput` + `upsertResolvedValueSet` to the port.
- `backend-ts/src/stores/sqlite/value-set-store-sqlite.ts` — implement it.
- `backend-ts/src/stores/postgres/value-set-store-postgres.ts` — implement it.
- `backend-ts/src/stores/value-set-store.contract.test.ts` (or the existing store-contract test file — confirm name) — cover the new method.
- `backend-ts/src/routes/runs.ts`, `src/routes/cases.ts`, `src/routes/measures.ts`, `src/routes/compliance-simulation.ts` — build the engine via `engineForEnv(env)` instead of the module-level `new CqlExecutionEngine()`.
- `backend-ts/package.json` — `resolve-valuesets` script.
- `backend-ts/.env.example` (and repo-root `.env.example` if present) — `WORKWELL_VSAC_API_KEY`, `WORKWELL_VSAC_BASE_URL`.
- Docs: `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/DEPLOY.md`, `docs/MEASURES.md`, `docs/DECISIONS.md`, `docs/JOURNAL.md`.

---

## Task 1: `VsacClient` transport seam

**Files:**
- Create: `backend-ts/src/engine/cql/vsac-client.ts`
- Test: `backend-ts/src/engine/cql/vsac-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend-ts/src/engine/cql/vsac-client.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureVsacClient, httpVsacClient, type VsacExpansion } from "./vsac-client.ts";

test("fixtureVsacClient returns the mapped expansion for a known oid", async () => {
  const exp: VsacExpansion = {
    oid: "2.16.840.1.113883.3.464.1003.103.12.1001",
    total: 2,
    contains: [
      { code: "44054006", system: "http://snomed.info/sct", display: "Diabetes mellitus type 2" },
      { code: "E11.9", system: "http://hl7.org/fhir/sid/icd-10-cm", display: "Type 2 diabetes" },
    ],
  };
  const client = fixtureVsacClient({ [exp.oid]: exp });
  const got = await client.expand("2.16.840.1.113883.3.464.1003.103.12.1001");
  assert.equal(got.total, 2);
  assert.equal(got.contains.length, 2);
  assert.equal(got.contains[0].code, "44054006");
});

test("fixtureVsacClient rejects for an unknown oid (simulates a 404/not-configured set)", async () => {
  const client = fixtureVsacClient({});
  await assert.rejects(() => client.expand("9.9.9"), /no fixture/i);
});

test("httpVsacClient is a client with kind 'http' (no network in this test)", () => {
  const client = httpVsacClient({ baseUrl: "https://cts.nlm.nih.gov/fhir", apiKey: "x" });
  assert.equal(client.kind, "http");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && pnpm exec node --import tsx --test src/engine/cql/vsac-client.test.ts`
Expected: FAIL — cannot find module `./vsac-client.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// backend-ts/src/engine/cql/vsac-client.ts
/**
 * VSAC transport seam (E14 / live value-set expansion). `VsacValueSetResolver` calls this port to
 * expand a VSAC value-set OID; the transport is isolated here (mirrors the WebChartClient seam) so the
 * resolver core is tested against `fixtureVsacClient` with no network. `httpVsacClient` is the live
 * transport over the NLM FHIR terminology service (global `fetch`, no new dependency).
 *
 * Endpoint/auth are per NLM UTS docs (https://documentation.uts.nlm.nih.gov): FHIR
 * `GET {base}/ValueSet/{oid}/$expand`, HTTP Basic auth username `apikey` + password = the UMLS API key.
 * CONFIRM the request/response shape + paging params against the live docs before enabling in prod.
 */

/** One member concept of an expanded value set. */
export interface VsacCode {
  code: string;
  system: string;
  display?: string;
}

/** A value-set expansion for one OID. */
export interface VsacExpansion {
  oid: string;
  /** expansion.total from the server (may exceed contains.length before paging). */
  total: number;
  contains: VsacCode[];
}

export interface VsacClientConfig {
  baseUrl: string;
  apiKey: string;
}

export interface VsacClient {
  readonly kind: string;
  /** Expand one value-set OID. Rejects on transport/HTTP error or an unknown-to-this-client OID. */
  expand(oid: string): Promise<VsacExpansion>;
}

/** In-memory client for tests + offline fixtures. Rejects on an OID with no fixture. */
export function fixtureVsacClient(fixtures: Record<string, VsacExpansion>): VsacClient {
  return {
    kind: "fixture",
    expand(oid: string): Promise<VsacExpansion> {
      const hit = fixtures[oid];
      if (!hit) return Promise.reject(new Error(`fixtureVsacClient: no fixture for oid '${oid}'`));
      return Promise.resolve(hit);
    },
  };
}

/**
 * Live VSAC transport over the NLM FHIR terminology service. Pages `expansion.contains` until complete.
 * Throws on any non-2xx (the resolver turns a throw into a hard failure — never a silent empty set).
 */
export function httpVsacClient(cfg: VsacClientConfig): VsacClient {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const auth = "Basic " + Buffer.from(`apikey:${cfg.apiKey}`).toString("base64");
  const PAGE = 1000;
  return {
    kind: "http",
    async expand(oid: string): Promise<VsacExpansion> {
      const contains: VsacCode[] = [];
      let offset = 0;
      let total = 0;
      for (;;) {
        const url = `${base}/ValueSet/${encodeURIComponent(oid)}/$expand?offset=${offset}&count=${PAGE}`;
        const res = await fetch(url, { headers: { Authorization: auth, Accept: "application/fhir+json" } });
        if (!res.ok) {
          throw new Error(`VSAC $expand failed for oid '${oid}': ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as {
          expansion?: { total?: number; contains?: Array<{ code?: string; system?: string; display?: string }> };
        };
        const page = body.expansion?.contains ?? [];
        total = body.expansion?.total ?? total;
        for (const c of page) {
          if (c.code && c.system) contains.push({ code: c.code, system: c.system, display: c.display });
        }
        offset += page.length;
        if (page.length === 0 || (total > 0 && contains.length >= total)) break;
      }
      return { oid, total: total || contains.length, contains };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend-ts && pnpm exec node --import tsx --test src/engine/cql/vsac-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/engine/cql/vsac-client.ts backend-ts/src/engine/cql/vsac-client.test.ts
git commit -m "feat(vsac): VsacClient transport seam (fixture + http $expand)"
```

---

## Task 2: `VsacValueSetResolver`

**Files:**
- Create: `backend-ts/src/engine/cql/vsac-value-set-resolver.ts`
- Test: `backend-ts/src/engine/cql/vsac-value-set-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend-ts/src/engine/cql/vsac-value-set-resolver.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureVsacClient, type VsacClient, type VsacExpansion } from "./vsac-client.ts";
import { VsacValueSetResolver } from "./vsac-value-set-resolver.ts";

const OID = "2.16.840.1.113883.3.464.1003.103.12.1001";
const exp: VsacExpansion = {
  oid: OID,
  total: 1,
  contains: [{ code: "44054006", system: "http://snomed.info/sct", display: "T2DM" }],
};

test("expand maps VSAC contains → CqlCode[] (code + system only)", async () => {
  const resolver = new VsacValueSetResolver(fixtureVsacClient({ [OID]: exp }));
  const codes = await resolver.expand(OID);
  assert.deepEqual(codes, [{ code: "44054006", system: "http://snomed.info/sct" }]);
});

test("expand memoizes per-oid — one client call for repeated expands", async () => {
  let calls = 0;
  const counting: VsacClient = {
    kind: "counting",
    expand(oid) {
      calls++;
      return Promise.resolve({ ...exp, oid });
    },
  };
  const resolver = new VsacValueSetResolver(counting);
  await resolver.expand(OID);
  await resolver.expand(OID);
  assert.equal(calls, 1);
});

test("expand THROWS on a client/transport error (never a silent empty set)", async () => {
  const failing: VsacClient = { kind: "failing", expand: () => Promise.reject(new Error("boom 500")) };
  const resolver = new VsacValueSetResolver(failing);
  await assert.rejects(() => resolver.expand(OID), /boom 500/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && pnpm exec node --import tsx --test src/engine/cql/vsac-value-set-resolver.test.ts`
Expected: FAIL — cannot find module `./vsac-value-set-resolver.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// backend-ts/src/engine/cql/vsac-value-set-resolver.ts
/**
 * Live VSAC resolver behind the ValueSetResolver port (E14). Expands a real VSAC OID → member codes via
 * the injected VsacClient, memoized per-OID for the resolver's lifetime (value sets are stable within a
 * process). A transport/HTTP error PROPAGATES (throws) — the engine must fail visibly rather than
 * mis-evaluate compliance against a silently-empty value set (ADR-008). Descriptive only — never
 * decides compliance.
 */
import type { CqlCode, ValueSetResolver } from "./value-set-resolver.ts";
import type { VsacClient } from "./vsac-client.ts";

export class VsacValueSetResolver implements ValueSetResolver {
  private readonly cache = new Map<string, Promise<CqlCode[]>>();
  constructor(private readonly client: VsacClient) {}

  expand(valueSetUrl: string): Promise<CqlCode[]> {
    let hit = this.cache.get(valueSetUrl);
    if (!hit) {
      hit = this.client
        .expand(valueSetUrl)
        .then((e) => e.contains.map((c) => ({ code: c.code, system: c.system })));
      // Do not cache a rejected expand — a transient failure should be retryable on the next call.
      hit.catch(() => this.cache.delete(valueSetUrl));
      this.cache.set(valueSetUrl, hit);
    }
    return hit;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend-ts && pnpm exec node --import tsx --test src/engine/cql/vsac-value-set-resolver.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/engine/cql/vsac-value-set-resolver.ts backend-ts/src/engine/cql/vsac-value-set-resolver.test.ts
git commit -m "feat(vsac): VsacValueSetResolver (memoized, error-propagating)"
```

---

## Task 3: `CompositeValueSetResolver`

**Files:**
- Create: `backend-ts/src/engine/cql/composite-value-set-resolver.ts`
- Test: `backend-ts/src/engine/cql/composite-value-set-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend-ts/src/engine/cql/composite-value-set-resolver.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CqlCode, ValueSetResolver } from "./value-set-resolver.ts";
import { CompositeValueSetResolver, isVsacOid } from "./composite-value-set-resolver.ts";

function stub(tag: string): ValueSetResolver {
  return { expand: (url) => Promise.resolve([{ code: tag, system: url }] as CqlCode[]) };
}

test("isVsacOid matches dotted numeric OIDs, not URNs/URLs", () => {
  assert.equal(isVsacOid("2.16.840.1.113883.3.464.1003.103.12.1001"), true);
  assert.equal(isVsacOid("urn:workwell:vs:audiogram-procedures"), false);
  assert.equal(isVsacOid("http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840"), false);
  assert.equal(isVsacOid("Audiogram Procedures"), false);
});

test("real OID routes to the vsac tier", async () => {
  const c = new CompositeValueSetResolver(stub("vsac"), stub("store"));
  const codes = await c.expand("2.16.840.1.113883.3.464.1003.103.12.1001");
  assert.equal(codes[0].code, "vsac");
});

test("urn:workwell:* routes to the store tier", async () => {
  const c = new CompositeValueSetResolver(stub("vsac"), stub("store"));
  const codes = await c.expand("urn:workwell:vs:audiogram-procedures");
  assert.equal(codes[0].code, "store");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && pnpm exec node --import tsx --test src/engine/cql/composite-value-set-resolver.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
// backend-ts/src/engine/cql/composite-value-set-resolver.ts
/**
 * Routes value-set expansion by URL shape (E14): a real VSAC OID (dotted-numeric) → the VSAC tier;
 * anything else (urn:workwell:*, canonical URLs, human names) → the local store tier. This is the
 * resolver the live engine receives when VSAC is configured, so enabling VSAC never breaks the
 * local-coded measures (audiogram's `urn:workwell:vs:audiogram-procedures` still resolves locally).
 */
import type { CqlCode, ValueSetResolver } from "./value-set-resolver.ts";

/** True for a dotted-numeric OID (e.g. 2.16.840.1.113883…) — the VSAC-resolvable shape. */
export function isVsacOid(valueSetUrl: string): boolean {
  return /^\d+(\.\d+)+$/.test(valueSetUrl.trim());
}

export class CompositeValueSetResolver implements ValueSetResolver {
  constructor(
    private readonly vsac: ValueSetResolver,
    private readonly store: ValueSetResolver,
  ) {}

  expand(valueSetUrl: string): Promise<CqlCode[]> {
    return isVsacOid(valueSetUrl) ? this.vsac.expand(valueSetUrl) : this.store.expand(valueSetUrl);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend-ts && pnpm exec node --import tsx --test src/engine/cql/composite-value-set-resolver.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/engine/cql/composite-value-set-resolver.ts backend-ts/src/engine/cql/composite-value-set-resolver.test.ts
git commit -m "feat(vsac): CompositeValueSetResolver (OID→VSAC, URN→store)"
```

---

## Task 4: `resolveValueSetResolver(env, store)` selector

**Files:**
- Create: `backend-ts/src/engine/cql/resolve-value-set-resolver.ts`
- Test: `backend-ts/src/engine/cql/resolve-value-set-resolver.test.ts`

**Note:** `StoreValueSetResolver` (existing, `value-set-resolver.ts`) takes a `ValueSetStore`. Import its type from `../../stores/value-set-store.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// backend-ts/src/engine/cql/resolve-value-set-resolver.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { StoreValueSetResolver } from "./value-set-resolver.ts";
import { CompositeValueSetResolver } from "./composite-value-set-resolver.ts";
import { resolveValueSetResolver } from "./resolve-value-set-resolver.ts";
import type { ValueSetStore } from "../../stores/value-set-store.ts";

// Minimal ValueSetStore stub — only listAll is exercised by the resolvers.
const store = { listAll: () => Promise.resolve([]) } as unknown as ValueSetStore;

test("no VSAC key → plain StoreValueSetResolver (inert; today's behavior)", () => {
  const r = resolveValueSetResolver({}, store);
  assert.ok(r instanceof StoreValueSetResolver);
});

test("blank VSAC key → still inert", () => {
  const r = resolveValueSetResolver({ WORKWELL_VSAC_API_KEY: "   " }, store);
  assert.ok(r instanceof StoreValueSetResolver);
});

test("VSAC key set → CompositeValueSetResolver", () => {
  const r = resolveValueSetResolver({ WORKWELL_VSAC_API_KEY: "abc" }, store);
  assert.ok(r instanceof CompositeValueSetResolver);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && pnpm exec node --import tsx --test src/engine/cql/resolve-value-set-resolver.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
// backend-ts/src/engine/cql/resolve-value-set-resolver.ts
/**
 * Config-driven ValueSetResolver selection (mirrors resolveDataSource/resolveForecaster): the plain
 * local StoreValueSetResolver by default (today's behavior — inert), and the CompositeValueSetResolver
 * (VSAC for real OIDs, local fallback for urn:workwell:*) only when WORKWELL_VSAC_API_KEY is set.
 * Inert-unless-configured: setting the key never changes a current measure's outcome (Task 6 parity).
 */
import type { ValueSetResolver } from "./value-set-resolver.ts";
import { StoreValueSetResolver } from "./value-set-resolver.ts";
import { VsacValueSetResolver } from "./vsac-value-set-resolver.ts";
import { CompositeValueSetResolver } from "./composite-value-set-resolver.ts";
import { httpVsacClient } from "./vsac-client.ts";
import type { ValueSetStore } from "../../stores/value-set-store.ts";

export interface VsacEnv {
  WORKWELL_VSAC_API_KEY?: string;
  WORKWELL_VSAC_BASE_URL?: string;
}

const DEFAULT_BASE = "https://cts.nlm.nih.gov/fhir";

export function resolveValueSetResolver(env: VsacEnv, store: ValueSetStore): ValueSetResolver {
  const apiKey = (env.WORKWELL_VSAC_API_KEY ?? "").trim();
  const storeResolver = new StoreValueSetResolver(store);
  if (!apiKey) return storeResolver;
  const baseUrl = (env.WORKWELL_VSAC_BASE_URL ?? "").trim() || DEFAULT_BASE;
  const vsac = new VsacValueSetResolver(httpVsacClient({ baseUrl, apiKey }));
  return new CompositeValueSetResolver(vsac, storeResolver);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend-ts && pnpm exec node --import tsx --test src/engine/cql/resolve-value-set-resolver.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/engine/cql/resolve-value-set-resolver.ts backend-ts/src/engine/cql/resolve-value-set-resolver.test.ts
git commit -m "feat(vsac): resolveValueSetResolver selector (inert-unless-configured)"
```

---

## Task 5: `upsertResolvedValueSet` store method (floor + ceiling)

**Files:**
- Modify: `backend-ts/src/stores/value-set-store.ts`
- Modify: `backend-ts/src/stores/sqlite/value-set-store-sqlite.ts`
- Modify: `backend-ts/src/stores/postgres/value-set-store-postgres.ts`
- Test: add to the existing value-set store-contract test (find it: `grep -rl "ValueSetStore" backend-ts/src/stores/**/*.test.ts backend-ts/src/**/*value-set*.test.ts`). If a shared contract test drives both floor+ceiling, add there; else add a floor test in `backend-ts/src/stores/sqlite/value-set-store-sqlite.test.ts`.

**Context to read first:** `backend-ts/src/stores/sqlite/value-set-store-sqlite.ts` `seedValueSet` (its `INSERT … ON CONFLICT` target + column list) and `getById`/`listAll` mapping. Match the exact `code_systems` serialization (`JSON.stringify` of the systems array on the floor; `text[]` on the ceiling) and the conflict target (the table's `UNIQUE(oid, version)`).

- [ ] **Step 1: Write the failing test** (floor; place in the value-set store test file)

```ts
// add to backend-ts/src/stores/sqlite/value-set-store-sqlite.test.ts (create if absent; mirror an existing sqlite store test's DB setup)
import { test } from "node:test";
import assert from "node:assert/strict";
// (reuse the file's existing `makeStore()` / DB bootstrap helper if present)

test("upsertResolvedValueSet inserts a VSAC row and re-resolves idempotently by oid", async () => {
  const store = await makeStore(); // existing helper: fresh in-memory sqlite ValueSetStore
  const oid = "2.16.840.1.113883.3.464.1003.103.12.1001";
  await store.upsertResolvedValueSet({
    oid, name: "Diabetes", version: "20240101", source: "VSAC",
    codes: [{ code: "44054006", display: "T2DM", system: "http://snomed.info/sct" }],
    resolutionStatus: "RESOLVED", resolutionError: null, expansionHash: "h1",
    lastResolvedAt: "2026-07-05T00:00:00.000Z",
  });
  let all = await store.listAll();
  const row = all.find((v) => v.oid === oid);
  assert.ok(row);
  assert.equal(row!.source, "VSAC");
  assert.equal(row!.resolutionStatus, "RESOLVED");
  assert.equal(row!.codes.length, 1);
  assert.equal(row!.codes[0].code, "44054006");

  // Re-resolve same oid+version with new codes → updates in place (no duplicate row).
  await store.upsertResolvedValueSet({
    oid, name: "Diabetes", version: "20240101", source: "VSAC",
    codes: [
      { code: "44054006", display: "T2DM", system: "http://snomed.info/sct" },
      { code: "E11.9", display: "T2DM", system: "http://hl7.org/fhir/sid/icd-10-cm" },
    ],
    resolutionStatus: "RESOLVED", resolutionError: null, expansionHash: "h2",
    lastResolvedAt: "2026-07-05T01:00:00.000Z",
  });
  all = await store.listAll();
  assert.equal(all.filter((v) => v.oid === oid).length, 1);
  assert.equal(all.find((v) => v.oid === oid)!.codes.length, 2);
});

test("upsertResolvedValueSet records an ERROR row with no codes", async () => {
  const store = await makeStore();
  const oid = "2.16.840.1.113883.3.464.1003.1003";
  await store.upsertResolvedValueSet({
    oid, name: oid, version: null, source: "VSAC", codes: [],
    resolutionStatus: "ERROR", resolutionError: "500 Server Error", expansionHash: null,
    lastResolvedAt: "2026-07-05T00:00:00.000Z",
  });
  const row = (await store.listAll()).find((v) => v.oid === oid);
  assert.equal(row!.resolutionStatus, "ERROR");
  assert.equal(row!.resolutionError, "500 Server Error");
  assert.equal(row!.codes.length, 0);
});
```

> If the test file has no `makeStore()` helper, mirror the DB bootstrap already used by the nearest existing `*-sqlite.test.ts` (create the D1 via `@mieweb/cloud-local` `createSqliteD1(":memory:")`, run the value-set schema init the store expects, then `new SqliteValueSetStore(db)`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && pnpm exec node --import tsx --test src/stores/sqlite/value-set-store-sqlite.test.ts`
Expected: FAIL — `upsertResolvedValueSet` is not a function / not on the type.

- [ ] **Step 3a: Add to the port** (`backend-ts/src/stores/value-set-store.ts`)

```ts
/** Input for an owner-run VSAC expansion import (resolve-valuesets CLI). Writes existing value_sets
 *  columns only — no DDL. Idempotent by (oid, version). */
export interface UpsertResolvedValueSetInput {
  oid: string;
  name: string;
  version: string | null;
  source: string;
  codes: CodeEntry[];
  resolutionStatus: string; // "RESOLVED" | "ERROR"
  resolutionError: string | null;
  expansionHash: string | null;
  lastResolvedAt: string; // ISO
}
```

Add to the `ValueSetStore` interface (near `setCodes`):

```ts
  /** Upsert a VSAC-sourced value set by (oid, version) with real codes + resolution metadata
   *  (resolve-valuesets CLI). Sets source/status/resolution_status/last_resolved_at/expansion_hash;
   *  status is ACTIVE. No DDL — existing columns only. */
  upsertResolvedValueSet(input: UpsertResolvedValueSetInput): Promise<void>;
```

- [ ] **Step 3b: Implement on the floor** (`backend-ts/src/stores/sqlite/value-set-store-sqlite.ts`)

Match `seedValueSet`'s conflict target + `code_systems` serialization. Derive `code_systems` as the sorted-unique list of `codes[].system`. Example (adapt column/`ON CONFLICT` to the file's existing `seedValueSet`):

```ts
  async upsertResolvedValueSet(input: UpsertResolvedValueSetInput): Promise<void> {
    const id = crypto.randomUUID();
    const codesJson = JSON.stringify(input.codes);
    const systems = JSON.stringify([...new Set(input.codes.map((c) => c.system))].sort());
    await this.db
      .prepare(
        `INSERT INTO value_sets
           (id, oid, name, version, codes_json, code_systems, source, status,
            resolution_status, resolution_error, expansion_hash, last_resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)
         ON CONFLICT(oid, version) DO UPDATE SET
           name = excluded.name, codes_json = excluded.codes_json, code_systems = excluded.code_systems,
           source = excluded.source, status = 'ACTIVE', resolution_status = excluded.resolution_status,
           resolution_error = excluded.resolution_error, expansion_hash = excluded.expansion_hash,
           last_resolved_at = excluded.last_resolved_at`,
      )
      .bind(id, input.oid, input.name, input.version, codesJson, systems, input.source,
            input.resolutionStatus, input.resolutionError, input.expansionHash, input.lastResolvedAt)
      .run();
  }
```

> Verify the `ON CONFLICT` target column list matches the actual UNIQUE constraint on the floor's `value_sets` (`seedValueSet` shows the working target — copy it). `version` may be nullable; if the floor's unique index doesn't treat NULL versions as conflicting, pass `""`/a sentinel consistent with `seedValueSet`. Follow whatever `seedValueSet` already does.
> Add `import` for `crypto` only if the file doesn't already use `crypto.randomUUID()` (node global — usually no import needed).

- [ ] **Step 3c: Implement on the ceiling** (`backend-ts/src/stores/postgres/value-set-store-postgres.ts`)

Mirror the floor, but Postgres param placeholders (`$1…`), `code_systems` as a `text[]` (pass the array, not JSON), `codes_json` as JSONB (`JSON.stringify` + `::jsonb` per the file's existing pattern), and `ON CONFLICT (oid, version)`. Copy the exact style from the file's `seedValueSet`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend-ts && pnpm exec node --import tsx --test src/stores/sqlite/value-set-store-sqlite.test.ts`
Expected: PASS. Then `pnpm typecheck` to confirm the ceiling implements the new port method.

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/stores/value-set-store.ts backend-ts/src/stores/sqlite/value-set-store-sqlite.ts backend-ts/src/stores/postgres/value-set-store-postgres.ts backend-ts/src/stores/sqlite/value-set-store-sqlite.test.ts
git commit -m "feat(vsac): upsertResolvedValueSet store method (floor + ceiling, no DDL)"
```

---

## Task 6: Audiogram cross-mode parity guard (the ADR-008 test)

> **IMPLEMENTATION CORRECTION (2026-07-05):** an existing cross-mode parity test already lives in
> `backend-ts/src/engine/cql/value-set-resolver.test.ts` (lines 70–97) and proves `inline == store-expansion
> == expected` for audiogram using real fixtures in `spike/synthetic/audiogram/*.json` and the real seeded
> value set (`code: "audiogram-procedure"`, system = `urn:workwell:vs:audiogram-procedures`). The plan's
> hand-rolled `audiogramStore()`/`buildSyntheticBundle` code below used the WRONG code (`AUDIOGRAM`) — do
> NOT use it. Instead, mirror the existing test's setup and ADD the composite (VSAC-key-on) comparison,
> asserting `inline == composite(keyed) == expected` across the 4 scenarios. This directly proves the keyed
> path matches today's inline production path. See the dispatched Task 6 prompt for the exact code.

**Files:**
- Create: `backend-ts/src/engine/cql/audiogram-vsac-parity.test.ts`

**Why:** Proves that turning VSAC on (composite resolver) does not change audiogram outcomes — audiogram's `urn:workwell:vs:audiogram-procedures` still resolves via the store tier. This is the guard for "engine never silently changes compliance."

**Context to read first:** how existing engine tests build a synthetic audiogram bundle + call `CqlExecutionEngine.evaluate`. Find one: `grep -rl "audiogram" backend-ts/src/engine/**/*.test.ts` and copy its bundle-construction (e.g. via `buildSyntheticBundle` + `deriveExamConfig`, or an existing fixture). Reuse the SAME scenario set that existing audiogram tests use so the parity assertion is meaningful across COMPLIANT/OVERDUE/etc.

- [ ] **Step 1: Write the test** (this task is test-only — no new production code; it must pass immediately, proving parity)

```ts
// backend-ts/src/engine/cql/audiogram-vsac-parity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CqlExecutionEngine } from "./cql-execution-engine.ts";
import { StoreValueSetResolver } from "./value-set-resolver.ts";
import { resolveValueSetResolver } from "./resolve-value-set-resolver.ts";
import type { ValueSetStore, ValueSetRecord } from "../../stores/value-set-store.ts";
// Reuse the repo's audiogram bundle builder + scenarios — copy the exact imports an existing
// audiogram engine test uses (buildSyntheticBundle / deriveExamConfig / MEASURE_BINDINGS), e.g.:
import { buildSyntheticBundle } from "../synthetic/fhir-bundle-builder.ts";
import { deriveExamConfig } from "../synthetic/exam-config.ts";
import { MEASURE_BINDINGS } from "../synthetic/measure-bindings.ts";

// A store that serves the local audiogram value set (so the store tier resolves it identically in both modes).
function audiogramStore(): ValueSetStore {
  const rec: ValueSetRecord = {
    id: "vs-audiogram", oid: "urn:workwell:vs:audiogram-procedures", name: "Audiogram Procedures",
    version: "1", lastResolvedAt: null, canonicalUrl: "urn:workwell:vs:audiogram-procedures",
    source: "WorkWell Demo", governanceStatus: "ACTIVE", resolutionStatus: "RESOLVED",
    resolutionError: "", expansionHash: "", codeSystems: ["urn:workwell:cs:audiogram"],
    // Use the SAME code(s) the synthetic audiogram bundle stamps + cms/measure expects. Read
    // fhir-bundle-builder.ts / the audiogram value-set seed for the exact code+system and mirror it here.
    codes: [{ code: "AUDIOGRAM", display: "Audiogram", system: "urn:workwell:cs:audiogram" }],
  };
  return { listAll: () => Promise.resolve([rec]) } as unknown as ValueSetStore;
}

const SCENARIOS = ["COMPLIANT", "OVERDUE", "DUE_SOON", "MISSING_DATA", "EXCLUDED"] as const;

test("audiogram outcomes are identical with VSAC key OFF vs ON (composite falls back to store)", async () => {
  const store = audiogramStore();
  const off = new CqlExecutionEngine({ valueSetResolver: new StoreValueSetResolver(store) });
  const on = new CqlExecutionEngine({ valueSetResolver: resolveValueSetResolver({ WORKWELL_VSAC_API_KEY: "test-key" }, store) });
  const evalDate = "2026-07-05";
  for (const target of SCENARIOS) {
    const cfg = deriveExamConfig("audiogram", target, evalDate); // match the real helper signature
    const bundle = buildSyntheticBundle(MEASURE_BINDINGS.audiogram, cfg, "emp-parity", evalDate);
    const a = await off.evaluate({ measureId: "audiogram", patientBundle: bundle, evaluationDate: evalDate });
    const b = await on.evaluate({ measureId: "audiogram", patientBundle: bundle, evaluationDate: evalDate });
    assert.equal(b.outcome, a.outcome, `scenario ${target} diverged: off=${a.outcome} on=${b.outcome}`);
  }
});
```

> The exact `buildSyntheticBundle`/`deriveExamConfig` signatures + the audiogram value-set code/system are what an existing audiogram engine test already uses — **copy them from that test verbatim** rather than guessing. If the composite's VSAC tier is (correctly) never hit here (audiogram uses a URN → store tier), the `WORKWELL_VSAC_API_KEY` value can be any non-blank string and no network occurs.

- [ ] **Step 2: Run test to verify it passes**

Run: `cd backend-ts && pnpm exec node --import tsx --test src/engine/cql/audiogram-vsac-parity.test.ts`
Expected: PASS — identical outcomes across all scenarios. If it FAILS, the composite routing or fallback is wrong — fix before proceeding (this is the safety gate).

- [ ] **Step 3: Commit**

```bash
git add backend-ts/src/engine/cql/audiogram-vsac-parity.test.ts
git commit -m "test(vsac): audiogram cross-mode parity guard (ADR-008 — VSAC on == off)"
```

---

## Task 7: Runtime wiring — `engineForEnv(env)` + swap call sites

**Files:**
- Create: `backend-ts/src/engine/cql/engine-factory.ts`
- Create: `backend-ts/src/engine/cql/engine-factory.test.ts`
- Modify: `backend-ts/src/routes/runs.ts`, `src/routes/cases.ts`, `src/routes/measures.ts`, `src/routes/compliance-simulation.ts`

**Design:** a memoized-per-env engine factory. Each route currently holds `const engine = new CqlExecutionEngine()` (module singleton, no resolver). Replace usages with `await engineForEnv(env)`, which builds a `CqlExecutionEngine` cached per env object. Do **not** touch `evaluate-bundle.ts` (the DB-less ingress library stays env/store-free by design) or `scheduler.ts`'s unused `_engine`.

> **IMPLEMENTATION CORRECTION (2026-07-05) — safer wiring:** production today runs `new CqlExecutionEngine()`
> with **no resolver** (audiogram → inline path). To change **nothing** on the unkeyed demo, `engineForEnv`
> must pass **no `valueSetResolver` when `WORKWELL_VSAC_API_KEY` is unset** (byte-identical to today), and the
> composite resolver **only when the key is set**. So the factory branches on the key rather than always
> attaching `resolveValueSetResolver`'s store-fallback. (The existing parity test already proves
> store-expansion == inline, so attaching-always would also be safe — but not-attaching is strictly the
> smaller change and keeps the default path untouched.)

- [ ] **Step 1: Write the failing test**

```ts
// backend-ts/src/engine/cql/engine-factory.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CqlExecutionEngine } from "./cql-execution-engine.ts";
import { engineForEnv } from "./engine-factory.ts";

// engineForEnv needs a store bundle with `.valueSets`. Build the same local env getStores uses.
async function localEnv() {
  // @ts-expect-error — @mieweb/cloud-local ships .mjs without types
  const { createSqliteD1 } = await import("@mieweb/cloud-local");
  const DB = await createSqliteD1(":memory:");
  return { DB };
}

test("engineForEnv returns a CqlExecutionEngine and memoizes per env", async () => {
  const env = await localEnv();
  const e1 = await engineForEnv(env);
  const e2 = await engineForEnv(env);
  assert.ok(e1 instanceof CqlExecutionEngine);
  assert.equal(e1, e2, "same env → same cached engine");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && pnpm exec node --import tsx --test src/engine/cql/engine-factory.test.ts`
Expected: FAIL — cannot find module `./engine-factory.ts`.

- [ ] **Step 3: Write the factory**

```ts
// backend-ts/src/engine/cql/engine-factory.ts
/**
 * Builds the runtime CqlExecutionEngine wired with the env-selected ValueSetResolver
 * (resolveValueSetResolver: composite VSAC+store when WORKWELL_VSAC_API_KEY is set, else plain store).
 * Memoized per env object — mirrors getStores' per-env caching — so evaluation routes share one engine
 * per env without rebuilding the resolver each request. VSAC changes nothing for current measures
 * (composite falls back to the store tier for urn:workwell:* value sets; audiogram-vsac-parity.test.ts).
 */
import { CqlExecutionEngine } from "./cql-execution-engine.ts";
import { resolveValueSetResolver, type VsacEnv } from "./resolve-value-set-resolver.ts";
import { getStores, type StoresEnv } from "../../stores/factory.ts";

type EngineEnv = StoresEnv & VsacEnv;

const cache = new WeakMap<object, Promise<CqlExecutionEngine>>();

export function engineForEnv(env: EngineEnv): Promise<CqlExecutionEngine> {
  let hit = cache.get(env as object);
  if (!hit) {
    hit = (async () => {
      const stores = await getStores(env);
      return new CqlExecutionEngine({ valueSetResolver: resolveValueSetResolver(env, stores.valueSets) });
    })();
    cache.set(env as object, hit);
  }
  return hit;
}
```

> Note: `resolveValueSetResolver` reads `process.env`-style fields off `env`; the deploy container sets `WORKWELL_VSAC_API_KEY` in the backend env, which the worker passes as part of `env`. Confirm the worker's `env` object carries arbitrary `WORKWELL_*` vars (it carries `DATABASE_URL`, auth secrets, etc. already). If the route `env` does NOT include process env vars, read the key from `process.env` inside `engineForEnv` instead: `resolveValueSetResolver({ WORKWELL_VSAC_API_KEY: process.env.WORKWELL_VSAC_API_KEY, WORKWELL_VSAC_BASE_URL: process.env.WORKWELL_VSAC_BASE_URL }, stores.valueSets)`. Pick whichever matches how the codebase reads other `WORKWELL_*` runtime flags (grep `process.env.WORKWELL_` vs `env.WORKWELL_`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend-ts && pnpm exec node --import tsx --test src/engine/cql/engine-factory.test.ts`
Expected: PASS.

- [ ] **Step 5: Swap the call sites**

In each of `src/routes/runs.ts`, `src/routes/cases.ts`, `src/routes/measures.ts`, `src/routes/compliance-simulation.ts`:
1. Remove the module-level `const engine … = new CqlExecutionEngine();`.
2. Add `import { engineForEnv } from "../engine/cql/engine-factory.ts";`.
3. At each place the old `engine` was used inside a handler that has `env`, replace with `const engine = await engineForEnv(env);` (build it once at the top of the handler, before it's passed into `deps`/`evaluate`). Keep the `EvaluateMeasureBinding` type annotation where present.

For `runs.ts` specifically: the module-level `engine` is passed into `deps` at multiple points (lines ~230, ~261, ~272) and used directly at ~339. Introduce `const engine = await engineForEnv(env);` at the start of each handler body where those live, and reference that local. Do **not** create a second module-level singleton.

- [ ] **Step 6: Typecheck + full test suite**

Run: `cd backend-ts && pnpm typecheck && pnpm test`
Expected: typecheck clean; all tests pass (≈ prior count + the new VSAC tests, 1 pg-skip). If a route test constructed the old module `engine`, update it to the handler-built engine.

- [ ] **Step 7: Commit**

```bash
git add backend-ts/src/engine/cql/engine-factory.ts backend-ts/src/engine/cql/engine-factory.test.ts backend-ts/src/routes/runs.ts backend-ts/src/routes/cases.ts backend-ts/src/routes/measures.ts backend-ts/src/routes/compliance-simulation.ts
git commit -m "feat(vsac): wire runtime engine through engineForEnv (env-selected resolver)"
```

---

## Task 8: The persist CLI — `pnpm resolve-valuesets`

**Files:**
- Create: `backend-ts/src/run/cli/resolve-valuesets.ts`
- Create: `backend-ts/src/run/cli/resolve-valuesets.test.ts`
- Create: `backend-ts/src/run/cli/resolve-valuesets-bin.ts`
- Modify: `backend-ts/package.json`

**Design:** read the target OIDs (default = every OID in the `cms122v14` reference's `valueSets`; `--oid <oid>` repeatable overrides), `$expand` each via a VsacClient, and `upsertResolvedValueSet` into the store, audited (`VALUE_SETS_RESOLVED` per OID). Failure on one OID → an ERROR row + continue. `main(argv)` is side-effect-free + testable (inject the client + stores); the `-bin` entry builds the real HTTP client + stores from `process.env`.

**Context to read first:** `src/run/cli/seed-scale.ts` (`parseArgs`, `SeedCliUsageError`, `buildEnv`, `main` shape) and `src/standards/references/cms122v14.ts` (`CMS122V14.valueSets[].oid`) + `references/index.ts` (how references are exported).

- [ ] **Step 1: Write the failing test**

```ts
// backend-ts/src/run/cli/resolve-valuesets.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runResolve, parseArgs, DEFAULT_OIDS } from "./resolve-valuesets.ts";
import { fixtureVsacClient, type VsacExpansion } from "../../engine/cql/vsac-client.ts";
import type { UpsertResolvedValueSetInput, ValueSetStore } from "../../stores/value-set-store.ts";
import type { AppendAuditInput, CaseEventStore } from "../../stores/case-event-store.ts";

function fakes() {
  const upserts: UpsertResolvedValueSetInput[] = [];
  const audits: AppendAuditInput[] = [];
  const valueSets = { upsertResolvedValueSet: (i: UpsertResolvedValueSetInput) => { upserts.push(i); return Promise.resolve(); } } as unknown as ValueSetStore;
  const events = { appendAudit: (a: AppendAuditInput) => { audits.push(a); return Promise.resolve(); } } as unknown as CaseEventStore;
  return { upserts, audits, valueSets, events };
}

test("parseArgs: --oid is repeatable; default is the CMS122 reference set", () => {
  assert.deepEqual(parseArgs(["--oid", "1.2.3", "--oid", "4.5.6"]).oids, ["1.2.3", "4.5.6"]);
  assert.ok(DEFAULT_OIDS.length > 5);
  assert.equal(parseArgs([]).oids, undefined); // undefined → caller uses DEFAULT_OIDS
});

test("runResolve upserts a RESOLVED row + audits per resolved oid", async () => {
  const { upserts, audits, valueSets, events } = fakes();
  const oid = "2.16.840.1.113883.3.464.1003.103.12.1001";
  const exp: VsacExpansion = { oid, total: 1, contains: [{ code: "44054006", system: "http://snomed.info/sct", display: "T2DM" }] };
  const client = fixtureVsacClient({ [oid]: exp });
  const res = await runResolve({ oids: [oid], client, valueSets, events, now: "2026-07-05T00:00:00.000Z" });
  assert.equal(res.resolved, 1);
  assert.equal(res.errors, 0);
  assert.equal(upserts[0].resolutionStatus, "RESOLVED");
  assert.equal(upserts[0].source, "VSAC");
  assert.equal(upserts[0].codes[0].code, "44054006");
  assert.equal(audits[0].eventType, "VALUE_SETS_RESOLVED");
});

test("runResolve writes an ERROR row and continues when an oid fails to expand", async () => {
  const { upserts, valueSets, events } = fakes();
  const ok = "2.16.840.1.113883.3.464.1003.103.12.1001";
  const bad = "2.16.840.1.113883.3.464.1003.1003";
  const client = fixtureVsacClient({ [ok]: { oid: ok, total: 0, contains: [] } }); // `bad` has no fixture → rejects
  const res = await runResolve({ oids: [bad, ok], client, valueSets, events, now: "2026-07-05T00:00:00.000Z" });
  assert.equal(res.errors, 1);
  assert.equal(res.resolved, 1);
  const errRow = upserts.find((u) => u.oid === bad)!;
  assert.equal(errRow.resolutionStatus, "ERROR");
  assert.ok(errRow.resolutionError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && pnpm exec node --import tsx --test src/run/cli/resolve-valuesets.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the CLI lib**

```ts
// backend-ts/src/run/cli/resolve-valuesets.ts
/**
 * CLI: import real VSAC value-set expansions into `value_sets` (E14). For each target OID: `$expand`
 * via VSAC → `upsertResolvedValueSet` (source="VSAC", real codes, RESOLVED), audited VALUE_SETS_RESOLVED.
 * A failed expand writes an ERROR row and continues. Owner-run ON DEMAND, NOT on deploy. Local (SQLite
 * floor) or Neon (export DATABASE_URL + WORKWELL_VSAC_API_KEY). Default target = the CMS122 reference set.
 *
 *   pnpm resolve-valuesets [--oid <oid> ...] [--measure cms122]
 *
 * ROLLBACK (reversible; schema-qualify on Postgres): DELETE FROM workwell_spike.value_sets WHERE source = 'VSAC';
 *
 * Side-effect-free + importable by tests; resolve-valuesets-bin.ts is the runnable entry.
 */
import { getStores, type StoresEnv } from "../../stores/factory.ts";
import { httpVsacClient, type VsacClient } from "../../engine/cql/vsac-client.ts";
import { CMS122V14 } from "../../standards/references/cms122v14.ts";
import type { CaseEventStore } from "../../stores/case-event-store.ts";
import type { ValueSetStore } from "../../stores/value-set-store.ts";

export const USAGE = "Usage: pnpm resolve-valuesets [--oid <oid> ...] [--measure cms122]";
export const DEFAULT_OIDS: string[] = [...new Set(CMS122V14.valueSets.map((v) => v.oid))];
const NAME_BY_OID: Record<string, string> = Object.fromEntries(CMS122V14.valueSets.map((v) => [v.oid, v.name]));

export class ResolveCliUsageError extends Error {
  override readonly name = "ResolveCliUsageError";
}

export interface ResolveArgs {
  oids?: string[];
}

export function parseArgs(args: string[]): ResolveArgs {
  const oids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--oid") {
      const v = args[++i];
      if (!v) throw new ResolveCliUsageError(`--oid needs a value\n${USAGE}`);
      oids.push(v);
    } else if (a === "--measure") {
      const m = args[++i];
      if (m !== "cms122") throw new ResolveCliUsageError(`--measure only supports 'cms122' today\n${USAGE}`);
      // cms122 → the default set; leave `oids` as-is (default applied by caller).
    } else if (a === "--help" || a === "-h") {
      throw new ResolveCliUsageError(USAGE);
    } else {
      throw new ResolveCliUsageError(`unknown argument '${a}'\n${USAGE}`);
    }
  }
  return oids.length ? { oids } : {};
}

export interface RunResolveDeps {
  oids: string[];
  client: VsacClient;
  valueSets: ValueSetStore;
  events: CaseEventStore;
  now: string;
}

export interface ResolveResult {
  resolved: number;
  errors: number;
}

/** Simple, deterministic expansion hash over sorted code|system pairs (idempotency/audit only). */
function expansionHash(codes: { code: string; system: string }[]): string {
  const joined = codes.map((c) => `${c.system}|${c.code}`).sort().join(",");
  let h = 0;
  for (const ch of joined) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `h${h.toString(16)}`;
}

export async function runResolve(deps: RunResolveDeps): Promise<ResolveResult> {
  let resolved = 0;
  let errors = 0;
  for (const oid of deps.oids) {
    try {
      const exp = await deps.client.expand(oid);
      const codes = exp.contains.map((c) => ({ code: c.code, display: c.display ?? c.code, system: c.system }));
      await deps.valueSets.upsertResolvedValueSet({
        oid, name: NAME_BY_OID[oid] ?? oid, version: null, source: "VSAC", codes,
        resolutionStatus: "RESOLVED", resolutionError: null, expansionHash: expansionHash(codes),
        lastResolvedAt: deps.now,
      });
      await deps.events.appendAudit({
        eventType: "VALUE_SETS_RESOLVED", entityType: "value_set", entityId: oid, actor: "resolve-valuesets",
        refRunId: null, refCaseId: null, refMeasureVersionId: null,
        payload: { oid, codes: codes.length, source: "VSAC", status: "RESOLVED" },
      });
      resolved++;
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      await deps.valueSets.upsertResolvedValueSet({
        oid, name: NAME_BY_OID[oid] ?? oid, version: null, source: "VSAC", codes: [],
        resolutionStatus: "ERROR", resolutionError: message, expansionHash: null, lastResolvedAt: deps.now,
      });
      await deps.events.appendAudit({
        eventType: "VALUE_SETS_RESOLVED", entityType: "value_set", entityId: oid, actor: "resolve-valuesets",
        refRunId: null, refCaseId: null, refMeasureVersionId: null,
        payload: { oid, source: "VSAC", status: "ERROR", error: message },
      });
      errors++;
    }
  }
  return { resolved, errors };
}

async function buildEnv(): Promise<StoresEnv> {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (databaseUrl) return { DATABASE_URL: databaseUrl };
  // @ts-expect-error — @mieweb/cloud-local ships .mjs without types
  const { createSqliteD1 } = await import("@mieweb/cloud-local");
  const dbPath = process.env.WORKWELL_SQLITE_PATH ?? "./.workwell-local.sqlite";
  const DB = await createSqliteD1(dbPath);
  return { DB };
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ResolveArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (e instanceof ResolveCliUsageError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
  const apiKey = (process.env.WORKWELL_VSAC_API_KEY ?? "").trim();
  if (!apiKey) {
    console.error("WORKWELL_VSAC_API_KEY is required to resolve value sets against VSAC.");
    return 2;
  }
  const baseUrl = (process.env.WORKWELL_VSAC_BASE_URL ?? "").trim() || "https://cts.nlm.nih.gov/fhir";
  const oids = parsed.oids ?? DEFAULT_OIDS;
  const env = await buildEnv();
  const stores = await getStores(env);
  const res = await runResolve({
    oids, client: httpVsacClient({ baseUrl, apiKey }), valueSets: stores.valueSets, events: stores.events,
    now: new Date().toISOString(),
  });
  console.log(`resolve-valuesets: ${res.resolved} resolved, ${res.errors} error(s), ${oids.length} target(s).`);
  return res.errors > 0 && res.resolved === 0 ? 1 : 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend-ts && pnpm exec node --import tsx --test src/run/cli/resolve-valuesets.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the runnable entry + package script**

```ts
// backend-ts/src/run/cli/resolve-valuesets-bin.ts
#!/usr/bin/env -S node --import tsx
/**
 * Runnable entry for the VSAC value-set importer (mirrors seed-scale-bin.ts). The lib
 * (resolve-valuesets.ts) stays side-effect-free + importable by tests.
 *   pnpm resolve-valuesets [--oid <oid> ...] [--measure cms122]
 * Requires WORKWELL_VSAC_API_KEY (+ optional WORKWELL_VSAC_BASE_URL); honors DATABASE_URL for Neon.
 * Rollback: DELETE FROM workwell_spike.value_sets WHERE source = 'VSAC'; (schema-qualify on Postgres).
 */
import { main } from "./resolve-valuesets.ts";

main(process.argv.slice(2)).then((code) => process.exit(code));
```

In `backend-ts/package.json` scripts (after `"seed:quality-history"`):

```json
    "resolve-valuesets": "tsx src/run/cli/resolve-valuesets-bin.ts",
```

- [ ] **Step 6: Verify + commit**

Run: `cd backend-ts && pnpm typecheck && pnpm exec node --import tsx --test src/run/cli/resolve-valuesets.test.ts`
Expected: clean typecheck; tests pass.

```bash
git add backend-ts/src/run/cli/resolve-valuesets.ts backend-ts/src/run/cli/resolve-valuesets.test.ts backend-ts/src/run/cli/resolve-valuesets-bin.ts backend-ts/package.json
git commit -m "feat(vsac): resolve-valuesets CLI — import VSAC expansions into value_sets (audited)"
```

---

## Task 9: Docs, `.env.example`, ADR, JOURNAL

**Files:**
- Modify: `backend-ts/.env.example` (+ repo-root `.env.example` if it exists — `ls .env.example`)
- Modify: `docs/DECISIONS.md` (new ADR)
- Modify: `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/MEASURES.md`, `docs/DEPLOY.md`, `docs/JOURNAL.md`

- [ ] **Step 1: `.env.example`** — add (no values):

```
# VSAC / UMLS value-set expansion (inert unless set; composite resolver falls back to local value sets)
WORKWELL_VSAC_API_KEY=
WORKWELL_VSAC_BASE_URL=https://cts.nlm.nih.gov/fhir
```

- [ ] **Step 2: ADR** — append a new numbered ADR to `docs/DECISIONS.md` (use the next number; read the last ADR number first). Content: *"Live VSAC value-set resolution behind the ValueSetResolver port — composite (VSAC-for-real-OIDs, local-fallback-for-URNs), inert-unless-configured (`WORKWELL_VSAC_API_KEY`), descriptive-only (ADR-008). Runtime wiring via `engineForEnv`; owner-run `resolve-valuesets` CLI persists expansions into `value_sets` (existing columns, no DDL). Rationale: unblocks real value-set expansion + the E14 official-CQL execution on-ramp without compliance drift. Full official-CQL outcome diff (E14 PR-3) remains out of scope pending synthetic-data enrichment."*

- [ ] **Step 3: ARCHITECTURE.md** — in the `compile`/`engine` module description, note the new resolvers: `VsacValueSetResolver` (live `$expand` via injectable `VsacClient`), `CompositeValueSetResolver` (OID→VSAC, URN→store), `resolveValueSetResolver(env, store)` (inert-unless-configured), and `engineForEnv(env)` (memoized engine w/ the env-selected resolver). Add to §6 Runtime Invariants: *"VSAC value-set expansion is descriptive — the composite resolver falls back to the local store for `urn:workwell:*` sets, so enabling `WORKWELL_VSAC_API_KEY` does not change any current measure's `Outcome Status` (audiogram cross-mode parity test); a VSAC fetch error throws rather than silently emptying a value set."*

- [ ] **Step 4: DATA_MODEL.md** — in §3.4 `value_sets`, note VSAC-sourced rows: `source='VSAC'`, real codes, `resolution_status` RESOLVED/ERROR, written by the owner-run `resolve-valuesets` CLI (existing columns, no DDL). Add the rollback: `DELETE FROM workwell_spike.value_sets WHERE source = 'VSAC';`.

- [ ] **Step 5: DEPLOY.md** — add a "Resolving VSAC value sets" subsection (mirror the seed-CLI subsections): the `WORKWELL_VSAC_API_KEY_TWH` GitHub secret + its mapping in `deploy-twh-mieweb.yml`, `WORKWELL_VSAC_BASE_URL`, the owner-run recipe `DATABASE_URL=<neon> WORKWELL_VSAC_API_KEY=<key> pnpm resolve-valuesets`, note it's inert on the demo unless the key is set and changes no current outcome, and the rollback SQL. Add `WORKWELL_VSAC_API_KEY` / `WORKWELL_VSAC_BASE_URL` to the env-vars reference table.

- [ ] **Step 6: MEASURES.md** — under Implementation Notes / the ValueSetResolver bullet, note the live VSAC adapter is now real behind the port (composite; inert-unless-configured), superseding "a live VSAC adapter is a future drop-in."

- [ ] **Step 7: JOURNAL.md** — new dated `2026-07-05` entry (newest on top) summarizing the VSAC resolver + CLI, the ADR-008 parity guard, "no schema / no new deps", and that E14 PR-3 (official-CQL execution) remains the follow-on.

- [ ] **Step 8: Full verify + commit**

Run: `cd backend-ts && pnpm typecheck && pnpm test`
Expected: typecheck clean; all tests pass (1 pg-skip). Then:

```bash
git add docs backend-ts/.env.example .env.example
git commit -m "docs(vsac): ADR + ARCHITECTURE/DATA_MODEL/DEPLOY/MEASURES/JOURNAL + .env.example"
```

---

## Final verification (before PR / code review)

- [ ] `cd backend-ts && pnpm typecheck` — clean.
- [ ] `cd backend-ts && pnpm test` — all pass (prior count + new VSAC tests; 1 pg-skip expected).
- [ ] `grep -rn "WORKWELL_VSAC" backend-ts/.env.example docs/DEPLOY.md` — documented.
- [ ] No secret committed: `git log -p | grep -i "REDACTED-KEY-PREFIX" || echo "clean"` → prints `clean`.
- [ ] Confirm audiogram parity test present + passing (the ADR-008 gate).

## Self-review notes (traceability to spec)

- Spec §5.1 resolvers → Tasks 2/3 (+ existing StoreValueSetResolver reused). §5.2 transport → Task 1. §5.3 selection → Task 4. §6 transport/auth → Task 1 `httpVsacClient` (verify endpoint against NLM docs at implementation time). §7 CLI → Task 8. §7.1 store method → Task 5. §8 safety (composite + parity + fetch-error-throws) → Tasks 3/6 (+ Task 2 error-propagation). §10 testing → Tasks 1–8 tests. §11 files → all tasks. §12 secrets → Task 9 (`.env.example`, DEPLOY, final-verify no-secret check). §13 reversibility → Task 9 (rollback SQL) + Task 4 (unset key ⇒ plain store). §9 out-of-scope (official-CQL execution) → not planned (correct).
