/**
 * AI route test (#108) — the 5 surfaces over the real stores with NO OPENAI_API_KEY,
 * so every model call falls back deterministically (the demo posture). Asserts the
 * fallback contracts, 404/400 gates, the explanation cache, and AI audit persistence.
 *   node --import tsx --test src/routes/ai.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { handleAi } from "./ai.ts";

const dbPath = join(tmpdir(), `workwell-ai-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
let caseId: string;
let runId: string;

const post = (path: string, body?: unknown, actor = "cm@workwell.dev") =>
  handleAi(new Request(`http://x${path}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }), env as never, actor);

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db }; // no OPENAI_API_KEY → fallback paths
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  runId = run.id;
  const store = new SqliteCaseStore(db);
  const c = await store.upsertFromOutcome({ runId, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
  caseId = c!.id;
  await new SqliteOutcomeStore(db).recordOutcome({
    runId,
    subjectId: "emp-006",
    measureId: "audiogram",
    status: "OVERDUE",
    evidence: {
      expressionResults: [
        { define: "Has Active Waiver", result: false },
        { define: "Most Recent Audiogram Date", result: "2025-04-19T00:00:00.000Z" },
        { define: "Days Since Last Audiogram", result: 420 },
        { define: "Outcome Status", result: "OVERDUE" },
      ],
    },
  });
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("POST /api/ai/draft-spec falls back without an API key (success=false, fallback-rules) + audit", async () => {
  const res = await post("/api/ai/draft-spec", { policyText: "Annual audiogram per OSHA 1910.95", measureName: "Audiogram" }, "author@workwell.dev");
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as { success: boolean; provider: string; fallbackUsed: boolean; fallback: string };
  assert.equal(body.success, false);
  assert.equal(body.provider, "fallback-rules");
  assert.equal(body.fallbackUsed, true);
  assert.match(body.fallback, /AI temporarily unavailable/);
  const audits = await new SqliteCaseEventStore(env.DB as never).listAuditEvents();
  assert.ok(audits.some((a) => a.eventType === "AI_DRAFT_SPEC_GENERATED"));
});

test("POST /api/ai/draft-spec → 400 on blank policy text", async () => {
  const res = await post("/api/ai/draft-spec", { policyText: "  " }, "author@workwell.dev");
  assert.equal(res?.status, 400);
});

test("POST /api/measures/:id/ai/draft-spec alias works", async () => {
  const res = await post("/api/measures/audiogram/ai/draft-spec", { policyText: "policy" }, "author@workwell.dev");
  assert.equal(res?.status, 200);
});

test("POST /api/measures/:id/ai/draft-cql → fallback template for a known measure", async () => {
  const res = await post("/api/measures/audiogram/ai/draft-cql", { oshaText: "29 CFR 1910.95" }, "author@workwell.dev");
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as { success: boolean; provider: string; cql: string };
  assert.equal(body.provider, "fallback-template");
  assert.match(body.cql, /version '1\.0\.0'/);
  assert.match(body.cql, /"Outcome Status"/);
});

test("POST /api/measures/:id/ai/draft-cql → 404 for unknown measure", async () => {
  const res = await post("/api/measures/does-not-exist/ai/draft-cql", {}, "author@workwell.dev");
  assert.equal(res?.status, 404);
});

test("POST /api/measures/:id/ai/generate-test-fixtures → 5 fallback fixtures covering all outcomes", async () => {
  const res = await post("/api/measures/audiogram/ai/generate-test-fixtures", undefined, "author@workwell.dev");
  assert.equal(res?.status, 200);
  const fixtures = (await res!.json()) as Array<{ expectedOutcome: string }>;
  assert.equal(fixtures.length, 5);
  assert.deepEqual([...new Set(fixtures.map((f) => f.expectedOutcome))].sort(), ["COMPLIANT", "DUE_SOON", "EXCLUDED", "MISSING_DATA", "OVERDUE"]);
});

test("POST /api/measures/:id/ai/generate-test-fixtures → 404 for unknown measure", async () => {
  const res = await post("/api/measures/nope/ai/generate-test-fixtures", undefined, "author@workwell.dev");
  assert.equal(res?.status, 404);
});

test("POST /api/cases/:id/explain → deterministic explanation + ai audit referencing the case", async () => {
  const res = await post(`/api/cases/${caseId}/explain`);
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as { caseId: string; provider: string; explanation: string; disclaimer: string };
  assert.equal(body.caseId, caseId);
  assert.equal(body.provider, "fallback-rules");
  assert.match(body.explanation, /flagged as OVERDUE/);
  assert.match(body.explanation, /2025-04-19/);
  assert.ok(body.disclaimer.includes("advisory"));
  const audits = await new SqliteCaseEventStore(env.DB as never).listAuditEvents();
  const explain = audits.filter((a) => a.eventType === "AI_CASE_EXPLANATION_GENERATED");
  assert.ok(explain.some((a) => a.refCaseId === caseId && a.refRunId === runId));
});

test("POST /api/cases/:id/ai/explain alias is cached (no new audit on the second call)", async () => {
  const before = (await new SqliteCaseEventStore(env.DB as never).listAuditEvents()).filter((a) => a.eventType === "AI_CASE_EXPLANATION_GENERATED").length;
  const a = await post(`/api/cases/${caseId}/ai/explain`);
  const b = await post(`/api/cases/${caseId}/ai/explain`);
  assert.equal(a?.status, 200);
  assert.equal(b?.status, 200);
  const after = (await new SqliteCaseEventStore(env.DB as never).listAuditEvents()).filter((a) => a.eventType === "AI_CASE_EXPLANATION_GENERATED").length;
  // First alias call may write one audit (cache populated by the bare /explain above shares the key),
  // but the back-to-back pair must not BOTH write — the cache short-circuits at least one.
  assert.ok(after - before <= 1, `expected at most one new explanation audit, got ${after - before}`);
});

test("POST /api/cases/:id/explain → 404 for unknown case", async () => {
  const res = await post(`/api/cases/${crypto.randomUUID()}/explain`);
  assert.equal(res?.status, 404);
});

test("POST /api/runs/:id/ai/insight → empty fallback + audit", async () => {
  const res = await post(`/api/runs/${runId}/ai/insight`);
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as { fallback: boolean; insights: string[] };
  assert.equal(body.fallback, true);
  assert.deepEqual(body.insights, []);
  const audits = await new SqliteCaseEventStore(env.DB as never).listAuditEvents();
  assert.ok(audits.some((a) => a.eventType === "AI_RUN_INSIGHT_GENERATED" && a.refRunId === runId));
});

test("POST /api/runs/:id/ai/insight → 404 for unknown run", async () => {
  const res = await post(`/api/runs/${crypto.randomUUID()}/ai/insight`);
  assert.equal(res?.status, 404);
});

test("non-AI POST returns null (not owned by this handler)", async () => {
  const res = await post("/api/cases/x/assign");
  assert.equal(res, null);
});
