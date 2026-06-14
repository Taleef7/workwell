/**
 * AI assist unit tests (#108) — the surface logic with a stubbed ChatFn + audit recorder,
 * exercising the OpenAI-success paths (the route tests cover the no-key fallback paths).
 *   node --import tsx --test src/ai/ai-assist.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppendAuditInput } from "../stores/case-event-store.ts";
import { createChat } from "./openai-chat.ts";
import {
  draftSpec,
  draftCql,
  generateTestFixtures,
  explainCase,
  runInsight,
  AiBadRequestError,
  type AiDeps,
} from "./ai-assist.ts";

function recorder(): { deps: (chat: AiDeps["chat"]) => AiDeps; events: AppendAuditInput[] } {
  const events: AppendAuditInput[] = [];
  return {
    events,
    deps: (chat) => ({ chat, model: "test-model", events: { appendAudit: async (e) => void events.push(e) } }),
  };
}

test("draftSpec parses model JSON → success + openai provider + audit", async () => {
  const r = recorder();
  const chat = async () => '{"description":"d","complianceWindow":"Annual"}';
  const res = await draftSpec(r.deps(chat), { policyText: "annual audiogram policy", measureName: "Audiogram", measureId: "m1" }, "author@x");
  assert.equal(res.success, true);
  assert.equal(res.provider, "openai");
  assert.equal(res.fallbackUsed, false);
  assert.equal((res.suggestion as { description: string }).description, "d");
  assert.equal(r.events[0]!.eventType, "AI_DRAFT_SPEC_GENERATED");
  assert.equal(r.events[0]!.entityType, "ai");
  // payload wrapped { timestamp, payload } per AI_GUARDRAILS §4
  const payload = r.events[0]!.payload as { timestamp: string; payload: Record<string, unknown> };
  assert.ok(payload.timestamp);
  assert.equal(payload.payload.measureId, "m1");
});

test("draftSpec falls back when model returns non-JSON", async () => {
  const r = recorder();
  const res = await draftSpec(r.deps(async () => "not json at all"), { policyText: "x" }, "a@x");
  assert.equal(res.success, false);
  assert.equal(res.provider, "fallback-rules");
  assert.equal(res.measureName, "New Measure");
});

test("draftSpec throws AiBadRequestError on blank policy text", async () => {
  const r = recorder();
  await assert.rejects(() => draftSpec(r.deps(async () => "{}"), { policyText: "   " }, "a@x"), AiBadRequestError);
});

test("draftCql strips code fences from model output", async () => {
  const r = recorder();
  const chat = async () => "```cql\nlibrary FooCQL version '1.0.0'\n```";
  const res = await draftCql(r.deps(chat), { measureId: "m1", measureName: "Foo", specJson: "{}" }, "a@x");
  assert.equal(res.success, true);
  assert.equal(res.cql, "library FooCQL version '1.0.0'");
  assert.equal(res.fallbackUsed, false);
});

test("draftCql falls back to template on model failure", async () => {
  const r = recorder();
  const res = await draftCql(r.deps(async () => { throw new Error("boom"); }), { measureId: "m1", measureName: "Annual Audiogram", specJson: "{}" }, "a@x");
  assert.equal(res.fallbackUsed, true);
  assert.equal(res.provider, "fallback-template");
  assert.match(res.cql, /library AnnualAudiogramCQL version '1\.0\.0'/);
  assert.match(res.cql, /"Outcome Status"/);
});

test("generateTestFixtures parses + orders model fixtures, all 5 outcomes", async () => {
  const r = recorder();
  const model = JSON.stringify([
    { name: "ov", inputData: { examDate: "2024-01-01" }, expectedOutcome: "OVERDUE" },
    { name: "co", inputData: {}, expectedOutcome: "COMPLIANT" },
    { name: "ex", inputData: {}, expectedOutcome: "EXCLUDED" },
    { name: "ds", inputData: {}, expectedOutcome: "DUE_SOON" },
    { name: "md", inputData: {}, expectedOutcome: "MISSING_DATA" },
  ]);
  const fixtures = await generateTestFixtures(r.deps(async () => model), { measureId: "m1", measureName: "Foo", cqlText: "library" }, "a@x");
  assert.deepEqual(fixtures.map((f) => f.expectedOutcome), ["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"]);
});

test("generateTestFixtures falls back when coverage is incomplete", async () => {
  const r = recorder();
  const model = JSON.stringify([{ name: "co", inputData: {}, expectedOutcome: "COMPLIANT" }]);
  const fixtures = await generateTestFixtures(r.deps(async () => model), { measureId: "m1", measureName: "Foo", cqlText: "" }, "a@x");
  assert.equal(fixtures.length, 5);
  assert.deepEqual([...new Set(fixtures.map((f) => f.expectedOutcome))].sort(), ["COMPLIANT", "DUE_SOON", "EXCLUDED", "MISSING_DATA", "OVERDUE"]);
  assert.equal((r.events[0]!.payload as { payload: { fallbackUsed: boolean } }).payload.fallbackUsed, true);
});

test("explainCase uses model text on success + ai audit refs the case", async () => {
  const r = recorder();
  const chat = async () => "Employee was flagged because the audiogram is overdue.";
  const res = await explainCase(
    r.deps(chat),
    { caseId: "c1", measureName: "Audiogram", measureVersion: "v1.0", currentOutcomeStatus: "OVERDUE", lastRunId: "run1", employeeName: "Omar", evidenceJson: {} },
    "cm@x",
  );
  assert.equal(res.provider, "openai");
  assert.equal(res.fallbackUsed, false);
  assert.match(res.explanation, /overdue/);
  assert.ok(res.disclaimer.includes("advisory"));
  assert.equal(r.events[0]!.refCaseId, "c1");
  assert.equal(r.events[0]!.refRunId, "run1");
});

test("explainCase deterministic fallback names employee + status", async () => {
  const r = recorder();
  const evidence = {
    why_flagged: { last_exam_date: "2025-04-19", days_overdue: 55, compliance_window_days: 365, waiver_status: "none" },
    expressionResults: [{ define: "Days Since Last Audiogram", result: 420 }],
  };
  const res = await explainCase(
    r.deps(async () => { throw new Error("no key"); }),
    { caseId: "c1", measureName: "Audiogram", measureVersion: "v1.0", currentOutcomeStatus: "OVERDUE", lastRunId: "run1", employeeName: "Omar Siddiq", evidenceJson: evidence },
    "cm@x",
  );
  assert.equal(res.provider, "fallback-rules");
  assert.match(res.explanation, /Omar Siddiq was flagged as OVERDUE/);
  assert.match(res.explanation, /2025-04-19/);
});

test("runInsight parses bullets (dash + numbered) capped at 5", async () => {
  const r = recorder();
  const chat = async () => "- one\n2) two\nthree\n- four\n- five\n- six";
  const res = await runInsight(
    r.deps(chat),
    { runId: "run1", measureName: "Audiogram", measureVersion: "v1.0", status: "COMPLETED", totalEvaluated: 10, compliantCount: 7, nonCompliantCount: 3, passRate: 70, outcomeCounts: [{ status: "COMPLIANT", count: 7 }] },
    "cm@x",
  );
  assert.equal(res.fallback, false);
  assert.deepEqual(res.insights, ["one", "two", "three", "four", "five"]);
});

test("runInsight returns empty fallback on model failure", async () => {
  const r = recorder();
  const res = await runInsight(
    r.deps(async () => { throw new Error("down"); }),
    { runId: "run1", measureName: "Audiogram", measureVersion: "v1.0", status: "COMPLETED", totalEvaluated: 0, compliantCount: 0, nonCompliantCount: 0, passRate: 0, outcomeCounts: [] },
    "cm@x",
  );
  assert.equal(res.fallback, true);
  assert.deepEqual(res.insights, []);
});

// ---- openai-chat client ------------------------------------------------------

test("createChat throws when no API key is configured", async () => {
  const chat = createChat({ model: "m", fallbackModel: "f" });
  await assert.rejects(() => chat("sys", "usr"), /not configured/);
});

test("createChat falls back to the fallback model on primary failure", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { model: string };
    calls.push(body.model);
    if (body.model === "primary") return { ok: false, status: 500, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) } as Response;
  }) as unknown as typeof fetch;
  const chat = createChat({ apiKey: "k", model: "primary", fallbackModel: "fallback", fetchImpl: fakeFetch });
  assert.equal(await chat("s", "u"), "ok");
  assert.deepEqual(calls, ["primary", "fallback"]);
});

test("createChat returns primary content on success", async () => {
  const fakeFetch = (async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "hi" } }] }) }) as Response) as unknown as typeof fetch;
  const chat = createChat({ apiKey: "k", model: "primary", fallbackModel: "fallback", fetchImpl: fakeFetch });
  assert.equal(await chat("s", "u"), "hi");
});
