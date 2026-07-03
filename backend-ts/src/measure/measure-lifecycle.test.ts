/**
 * Measure-lifecycle gate tests (Fable M2/M3): the generic `POST /:id/status` transition must NOT
 * be a back door around (a) the ADMIN-only `/deprecate` route or (b) the compile/test approve gate.
 *   node --import tsx --test src/measure/measure-lifecycle.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { transitionStatus, MeasureError, type MeasureLifecycleDeps } from "./measure-lifecycle.ts";
import type { MeasureRecord } from "../stores/measure-store.ts";

function record(overrides: Partial<MeasureRecord>): MeasureRecord {
  return {
    measureId: "m1",
    name: "Test Measure",
    policyRef: "OSHA 1910.95",
    owner: "safety",
    tags: [],
    versionId: "v1",
    version: "1.0",
    status: "Draft",
    spec: { testFixtures: [] } as never,
    cqlText: "library X version '1.0'",
    compileStatus: "COMPILED",
    changeSummary: null,
    approvedBy: null,
    activatedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function deps(rec: MeasureRecord): MeasureLifecycleDeps {
  return {
    measures: {
      getLatest: async () => rec,
      setVersionStatus: async () => rec,
    } as never,
    events: { appendAudit: async () => {} } as never,
  };
}

test("M2: Active→Deprecated is NOT an allowed /status transition (must use ADMIN-only /deprecate)", async () => {
  await assert.rejects(
    () => transitionStatus(deps(record({ status: "Active" })), "m1", "Deprecated", "approver@workwell.dev"),
    MeasureError,
  );
});

test("M3: Draft→Approved via /status enforces the compile gate", async () => {
  await assert.rejects(
    () => transitionStatus(deps(record({ status: "Draft", compileStatus: "NOT_COMPILED" })), "m1", "Approved", "approver@workwell.dev"),
    (err: unknown) => err instanceof MeasureError && /compile/i.test((err as Error).message),
  );
});

test("M3: Draft→Approved via /status also enforces the test-fixture gate (compiled but no passing fixtures)", async () => {
  // Compiled but with no passing fixtures — the same readiness the dedicated /approve route requires.
  await assert.rejects(
    () => transitionStatus(deps(record({ status: "Draft", compileStatus: "COMPILED" })), "m1", "Approved", "approver@workwell.dev"),
    (err: unknown) => err instanceof MeasureError && /fixture/i.test((err as Error).message),
  );
});

test("Approved→Active remains an allowed /status transition (no over-blocking)", async () => {
  // The allow-list still permits the legitimate Approved→Active transition (its own gate applies).
  await assert.rejects(
    () => transitionStatus(deps(record({ status: "Approved", compileStatus: "NOT_COMPILED" })), "m1", "Active", "approver@workwell.dev"),
    (err: unknown) => err instanceof MeasureError && /activated/i.test((err as Error).message),
  );
});
