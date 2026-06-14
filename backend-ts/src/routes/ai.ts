/**
 * AI route (#108 Phase 4b) — TS port of AiController over AiAssistService.
 *
 *   POST /api/ai/draft-spec                              draft spec from policy text → 200 | 400
 *   POST /api/measures/:id/ai/draft-spec                 (alias)                      → 200 | 400
 *   POST /api/measures/:id/ai/draft-cql                  draft CQL for a measure      → 200 | 404
 *   POST /api/measures/:id/ai/generate-test-fixtures     5 fixtures (all outcomes)    → 200 | 404
 *   POST /api/cases/:id/explain                          explain why flagged          → 200 | 404
 *   POST /api/cases/:id/ai/explain                       (alias)                      → 200 | 404
 *   POST /api/runs/:id/ai/insight                        run summary bullets          → 200 | 404
 *
 * AI never decides compliance (AI_GUARDRAILS.md): each surface returns advisory text/drafts
 * and degrades to deterministic fallback on any model failure. Every call writes an AI
 * audit_event. The OpenAI client is plain fetch (no JVM, no new dependency); when
 * OPENAI_API_KEY is unset every call falls back — matching the demo posture.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { RUN_STORE_FLOOR_DDL, migrateFloorSchema } from "../stores/sqlite/schema.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { ensureMeasureStore } from "./measures.ts";
import { toCaseDetail } from "../case/case-detail-read-model.ts";
import { toRunSummary } from "../run/read-models.ts";
import { createChat, type ChatFn } from "../ai/openai-chat.ts";
import {
  draftSpec,
  draftCql,
  generateTestFixtures,
  explainCase,
  runInsight,
  AiBadRequestError,
  type AiDeps,
  type CaseExplanationResponse,
} from "../ai/ai-assist.ts";

interface AiEnv {
  DB: CloudDatabase;
  OPENAI_API_KEY?: string;
  WORKWELL_AI_OPENAI_MODEL?: string;
  WORKWELL_AI_OPENAI_FALLBACK_MODEL?: string;
}

const DEFAULT_MODEL = "gpt-5.4-nano";
const DEFAULT_FALLBACK_MODEL = "gpt-4o-mini";

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const ready = new WeakSet<object>();
async function ensure(env: AiEnv): Promise<void> {
  if (!ready.has(env.DB)) {
    await env.DB.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
    await migrateFloorSchema(env.DB);
    ready.add(env.DB);
  }
}

function model(env: AiEnv): string {
  return env.WORKWELL_AI_OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}
function chatFor(env: AiEnv): ChatFn {
  return createChat({
    apiKey: env.OPENAI_API_KEY,
    model: model(env),
    fallbackModel: env.WORKWELL_AI_OPENAI_FALLBACK_MODEL?.trim() || DEFAULT_FALLBACK_MODEL,
  });
}
async function aiDeps(env: AiEnv): Promise<AiDeps> {
  await ensure(env);
  return { chat: chatFor(env), model: model(env), events: new SqliteCaseEventStore(env.DB) };
}

/**
 * Case-explanation cache, keyed by `${caseId}:${measureVersion}` and invalidated when the
 * case `updatedAt` changes — the Java ConcurrentHashMap behavior (module-scoped, per process).
 */
const explanationCache = new Map<string, { updatedAt: string; response: CaseExplanationResponse }>();

export async function handleAi(req: Request, env: AiEnv, actor = "system"): Promise<Response | null> {
  if (req.method !== "POST") return null;
  const { pathname } = new URL(req.url);

  // ---- Draft Spec (bare + measure-scoped alias) ------------------------------
  const draftSpecMatch =
    pathname === "/api/ai/draft-spec"
      ? { measureId: null as string | null }
      : (() => {
          const m = pathname.match(/^\/api\/measures\/([^/]+)\/ai\/draft-spec$/);
          return m ? { measureId: m[1]! } : null;
        })();
  if (draftSpecMatch) {
    const body = (await req.json().catch(() => ({}))) as { measureName?: string; policyText?: string };
    try {
      const res = await draftSpec(
        await aiDeps(env),
        { policyText: body.policyText ?? "", measureName: body.measureName, measureId: draftSpecMatch.measureId },
        actor,
      );
      return json(res);
    } catch (err) {
      if (err instanceof AiBadRequestError) return json({ error: "bad_request", message: err.message }, 400);
      throw err;
    }
  }

  // ---- Draft CQL -------------------------------------------------------------
  const draftCqlId = pathname.match(/^\/api\/measures\/([^/]+)\/ai\/draft-cql$/)?.[1];
  if (draftCqlId) {
    const record = await (await ensureMeasureStore(env)).getLatest(draftCqlId);
    if (!record) return json({ error: "not_found", message: `Measure not found: ${draftCqlId}` }, 404);
    const body = (await req.json().catch(() => ({}))) as { oshaText?: string };
    const res = await draftCql(
      await aiDeps(env),
      { measureId: draftCqlId, measureName: record.name, specJson: JSON.stringify(record.spec ?? {}), oshaText: body.oshaText ?? "" },
      actor,
    );
    return json(res);
  }

  // ---- Generate Test Fixtures ------------------------------------------------
  const fixturesId = pathname.match(/^\/api\/measures\/([^/]+)\/ai\/generate-test-fixtures$/)?.[1];
  if (fixturesId) {
    const record = await (await ensureMeasureStore(env)).getLatest(fixturesId);
    if (!record) return json({ error: "not_found", message: `Measure not found: ${fixturesId}` }, 404);
    const res = await generateTestFixtures(
      await aiDeps(env),
      { measureId: fixturesId, measureName: record.name, cqlText: record.cqlText ?? "" },
      actor,
    );
    return json(res);
  }

  // ---- Explain Why Flagged (bare + ai/ alias) --------------------------------
  const explainId =
    pathname.match(/^\/api\/cases\/([^/]+)\/explain$/)?.[1] ?? pathname.match(/^\/api\/cases\/([^/]+)\/ai\/explain$/)?.[1];
  if (explainId) {
    await ensure(env);
    const c = await new SqliteCaseStore(env.DB).getCase(explainId);
    if (!c) return json({ error: "not_found", id: explainId }, 404);
    const outcomes = await new SqliteOutcomeStore(env.DB).listOutcomes(c.lastRunId);
    const outcome = outcomes.find((o) => o.subjectId === c.employeeId && o.measureId === c.measureId) ?? null;
    const detail = toCaseDetail(c, outcome);

    const cacheKey = `${detail.caseId}:${detail.measureVersion}`;
    const cached = explanationCache.get(cacheKey);
    if (cached && cached.updatedAt === detail.updatedAt) return json(cached.response);

    const res = await explainCase(
      await aiDeps(env),
      {
        caseId: detail.caseId,
        measureName: detail.measureName,
        measureVersion: detail.measureVersion,
        currentOutcomeStatus: detail.currentOutcomeStatus,
        lastRunId: detail.lastRunId,
        employeeName: detail.employeeName,
        evidenceJson: detail.evidenceJson,
      },
      actor,
    );
    explanationCache.set(cacheKey, { updatedAt: detail.updatedAt, response: res });
    return json(res);
  }

  // ---- Run Summary Insight ---------------------------------------------------
  const insightId = pathname.match(/^\/api\/runs\/([^/]+)\/ai\/insight$/)?.[1];
  if (insightId) {
    await ensure(env);
    const run = await new SqliteRunStore(env.DB).getRun(insightId);
    if (!run) return json({ error: "not_found", id: insightId }, 404);
    const outcomes = await new SqliteOutcomeStore(env.DB).listOutcomes(insightId);
    const totalCases = await new SqliteCaseStore(env.DB).countByLastRun(insightId);
    const summary = toRunSummary(run, outcomes, totalCases);
    const res = await runInsight(
      await aiDeps(env),
      {
        runId: insightId,
        measureName: summary.measureName,
        measureVersion: summary.measureVersion,
        status: summary.status,
        totalEvaluated: summary.totalEvaluated,
        compliantCount: summary.compliantCount,
        nonCompliantCount: summary.nonCompliantCount,
        passRate: summary.passRate,
        outcomeCounts: summary.outcomeCounts,
      },
      actor,
    );
    return json(res);
  }

  return null;
}
