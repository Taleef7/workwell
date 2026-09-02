/**
 * Runs route (#103/#106/#107) — the run pipeline + read models in TS: worker →
 * RunStore + OutcomeStore → CloudDatabase (SQLite floor), with subject evaluation
 * through the JVM-free CQL engine. The GET endpoints serve the unchanged frontend
 * `/api/runs` contract (RunListItem / RunSummary / RunLogEntry) — Phase-4 strangler
 * port (#107), runs module, read-model slice.
 *
 *   GET  /api/runs                  newest-first run list            → 200 RunListItem[]
 *   GET  /api/runs/:id              run detail/summary               → 200 RunSummary | 404
 *   GET  /api/runs/:id/measure-report  FHIR R4 MeasureReport → 200 | 404 (unknown run) | 422 (multi-measure)
 *   GET  /api/runs/:id/qrda1          QRDA Category I per-subject documents (JSON envelope) → 200 | 404 | 422
 *   GET  /api/runs/:id/qrda           QRDA Category III aggregate stub (XML) → 200 | 404 | 422
 *                                   ?type=summary (default) → summary report; individual|bundle → the
 *                                   collection Bundle (summary + per-subject individuals; the two are synonyms)
 *   GET  /api/runs/:id/logs         run log timeline                 → 200 RunLogEntry[]
 *   GET  /api/runs/:id/outcomes     persisted outcomes for a run     → 200 OutcomeRecord[]
 *   POST /api/runs                  create a QUEUED run              → 201 RunRecord
 *   POST /api/runs/claim            claim next queued (?workerId)    → 200 RunRecord | 204
 *   POST /api/runs/:id/evaluate     evaluate a subject + persist     → 201 OutcomeRecord
 *                                   body {measureId, patientBundle | qrda1, evaluationDate?}
 *                                   `qrda1` = a QRDA Category I CDA document — §170.315(c)(2) import+calculate
 *   POST /api/runs/:id/import       import a BATCH of QRDA I docs    → 201 {subjects, outcomes, merged, …}
 *                                   body {measureId, qrda1: string[], evaluationDate?}
 *                                   resolves documents→people first: identity is cross-document, so a
 *                                   per-document import over-reports the population (ADR-055)
 *   POST /api/runs/:id/finalize     finish an IMPORT-DRIVEN run      → 200 RunRecord | 409
 *                                   refuses any run whose outcomes did not all come from imported
 *                                   documents — a population run is finalized by its own pipeline
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import type { CreateRunInput, RunStore } from "../stores/run-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import type { HydratedSegment } from "../stores/segment-store.ts";
import { ensureSegmentSeed } from "../segment/segment-seed.ts";
import { routedEngineForEnv } from "../wiring/executor-router.ts";
import { toRunListItemFromCounts, toRunSummaryFromCounts, toRunLogEntries, toRunOutcomeRows, matchesRunFilters, type RunFilters } from "../run/read-models.ts";
import { recoverStuckRuns } from "../run/recover-stuck-runs.ts";
import { resolveAlertChannels } from "../run/alert-channel.ts";
import {
  executeManualRun,
  executeRerun,
  planManualRun,
  finishOrFail,
  rerunRequest,
  runningResponse,
  ASYNC_SCOPES,
  UnsupportedScopeError,
  InvalidRunRequestError,
  type ManualRunRequest,
  type ManualRunResponse,
  type RunPipelineDeps,
} from "../run/run-pipeline.ts";
import { isIncrementalEnabled } from "../run/incremental/incremental-eval.ts";
import { isVsacConfigured } from "@work-well/measure-engine";
import { rerunToVerify, UnsupportedCaseRerunError } from "../case/case-rerun.ts";
import type { PopulationCounts } from "../fhir/measure-report.ts";
import {
  officialMembership,
  buildMeasureReportBundle,
  buildSummaryMeasureReportFromCounts,
  officialReportIdentity,
  type OfficialReportIdentity,
  countPopulations,
  populationCountsFromStatus,
} from "../fhir/measure-report.ts";
import { isOfficialRouted } from "../wiring/official-routing.ts";
import { buildQrda3DocumentFromCounts } from "../fhir/qrda3-export.ts";
import { buildQrda1Documents, indexBundlesBySubject } from "../fhir/qrda1-export.ts";
import { importQrda1Document, type Qrda1Import } from "../fhir/qrda1-import.ts";
import { resolveQrda1Documents } from "../fhir/qrda1-identity.ts";
import { loadOfficialArtifact, officialMeasureIdentifiers } from "../wiring/official-artifacts.ts";
import { isWebChartConfigured, resolveDataSource, type DataSourceEnv } from "../engine/ingress/data-source.ts";
import { directoryForRows } from "../engine/ingress/webchart/live-directory.ts";
import { DEPLOYMENT_PROFILE, DIRECTORY, profileSubjectMatcher } from "../config/deployment-profile.ts";
import { subjectIdOf } from "../engine/ingress/enrollment/roster.ts";

interface RunsEnv extends DataSourceEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
  /** Optional failed-run webhook (#264). Inert unless set — see resolveAlertChannels. */
  WORKWELL_ALERT_WEBHOOK_URL?: string;
  WORKWELL_WEBCHART_ENROLLMENT_JSON?: string;
  /** #263 incremental evaluation opt-in. Inert unless "true". */
  WORKWELL_INCREMENTAL_EVAL?: string;
  /** #263 — folds value-set membership into logic_version when VSAC expansion is active. */
  WORKWELL_VSAC_API_KEY?: string;
  WORKWELL_VSAC_BASE_URL?: string;
}

// A run in one of these statuses has finished — its outcomes are final. Read models treat a terminal
// run as immutable and key on its (unchanged) runId: the roster cell cache (#233), the scale-run memo,
// `latestRunRows`, and the quality snapshots. So the `/evaluate` write path must refuse to append into
// a terminal run (a `markRunning` no-op would otherwise leave it terminal while gaining rows, silently
// changing a finished run under those caches). The async worker only ever evaluates QUEUED/RUNNING runs.
const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "PARTIAL_FAILURE", "FAILED", "CANCELLED"]);

// Reserved trigger labels are load-bearing IDENTITY, not free-form text: `seed:*` drives SEED
// classification + scale-run decoding (`aggregateScaleRun` splits `mhn|Lxx|Pxx|n` subject ids) +
// the seed CLIs' idempotency, and `scheduler` drives SCHEDULED classification + the 24h debounce.
// They must only ever be set by internal callers (the seed CLIs, the scheduler) that invoke the
// pipeline directly — never by an HTTP body. An external caller posting `{"triggeredBy":"seed:scale"}`
// would corrupt quality snapshots (live emp-* ids fed through the `|` decoder) and postpone the real
// nightly run, so a caller-supplied reserved label is coerced back to a plain operator label (Fable M1).
const RESERVED_TRIGGER_PREFIXES = ["seed:", "scheduler"];
function externalTriggeredBy(raw: unknown): string {
  // Untrusted request input: the body is only type-cast, so a malformed `{"triggeredBy":123}` would
  // reach here as a non-string and throw `raw.trim is not a function` before the route could return a
  // controlled response (Codex P2). Accept only strings; default everything else to a plain label.
  if (typeof raw !== "string") return "manual";
  const t = raw.trim();
  if (!t) return "manual";
  const lower = t.toLowerCase();
  if (RESERVED_TRIGGER_PREFIXES.some((p) => lower.startsWith(p))) return "manual";
  return t;
}

// The store factory selects the SQLite floor or the Postgres ceiling (when DATABASE_URL is set) and
// runs schema init once per env. CANONICAL schema/migrations stay Taleef-owned (CLAUDE.md).
//
// Boot recovery: an ALL_PROGRAMS/SITE run is advanced by an in-process `ctx.waitUntil` task that does
// NOT survive a container restart, so a run interrupted by a restart is stuck RUNNING forever. The
// first runs access in a process fires a best-effort sweep that fails such stuck runs. It is
// fire-and-forget (never blocks or fails the request) and time-thresholded (never touches a live run).
const sweptForOrphans = new WeakSet<object>();
async function store(env: RunsEnv): Promise<RunStore> {
  const stores = await getStores(env);
  if (!sweptForOrphans.has(env)) {
    sweptForOrphans.add(env);
    void recoverStuckRuns({
      runs: stores.runs,
      events: stores.events,
      alertChannels: resolveAlertChannels(env),
    })
      .then((ids) => {
        if (ids.length > 0)
          console.warn(`[workwell] recovered ${ids.length} stuck run(s) (RUNNING/QUEUED → FAILED, audited) on boot`);
      })
      .catch((err) => console.error("[workwell] stuck-run recovery failed:", err));
  }
  return stores.runs;
}
async function outcomes(env: RunsEnv): Promise<OutcomeStore> {
  return (await getStores(env)).outcomes;
}
async function cases(env: RunsEnv): Promise<CaseStore> {
  return (await getStores(env)).cases;
}
/** Enabled segments only — the run pipeline gates case creation by applicability (#183 E11.3);
 *  zero enabled segments ⇒ all (subject, measure) pairs are applicable (reversibility). */
async function enabledSegments(env: RunsEnv): Promise<HydratedSegment[]> {
  await ensureSegmentSeed(env);
  const all = await (await getStores(env)).segments.listSegments();
  return all.filter((s) => s.enabled);
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Cap on subjects for a per-subject (individual/bundle) MeasureReport — a 120k seed:scale run would
 *  otherwise build a 120k-entry document (Fable H4). The summary report is the aggregate above this. */
const MAX_INDIVIDUAL_REPORT_SUBJECTS = 5000;

/**
 * A `subjectId → FHIR bundle` lookup for the QRDA Category I export, or `undefined` when this stack
 * cannot supply one.
 *
 * QRDA I is a patient-DATA document (ADR-050), so its QDM entries have to come from the bundles the
 * subjects were evaluated against. Three deliberate properties:
 *
 *  - **Only where the bundles are real.** A WebChart-configured stack can re-read them; the synthetic
 *    default cannot. The synthetic bundle is NOT reconstructed from the persisted outcome:
 *    `deriveExamConfig`'s own contract says the target is a distribution BUCKET that can converge to a
 *    different status (CMS122 DUE_SOON → MISSING_DATA), so status → bundle is not injective and the
 *    reconstruction would be fiction wearing provenance.
 *  - **Never fatal.** A transport failure degrades to non-conformant documents that SAY they are
 *    non-conformant, rather than turning an export into a 500. The run's outcomes are unaffected — but
 *    the cause is LOGGED and named in the returned reason, because `webChartPrivateKeyFromEnv` throws by
 *    design ("a silent fall-through would look like a working deploy while the live integration was
 *    simply off") and a bare `catch {}` here would swallow exactly that (review, #361).
 *  - **Data as of NOW, not as of the run.** These bundles are re-read at export time, so a subject whose
 *    record changed since the run exports the current record. Stated in STANDARDS_CONFORMANCE.md; making
 *    it as-evaluated means persisting bundles, which is a schema change and the owner's call.
 *
 * **Known cost, recorded rather than hidden:** export-time bundle re-reads are now scoped to the run's
 * subject ids when the configured source/client supports by-id loading, so a 3-subject EMPLOYEE-scope
 * export reads those three patients plus their sub-resource searches rather than crawling the tenant.
 * `MAX_INDIVIDUAL_REPORT_SUBJECTS` refuses runs above 5000 before this lookup, but a run near that cap
 * still performs up to that many sequential by-id-plus-resource-search round trips. That is a STRICT
 * IMPROVEMENT over the prior whole-tenant crawl, which had no such bound and could be far larger than
 * 5000, but it is not a complete fix for very large in-cap scopes; closing that needs either a smaller
 * export-specific concurrency/streaming design or true bulk `$export`, both out of scope here. A source
 * or older client that cannot scope falls back correctly to the full read; that path remains correct, just
 * not fast.
 */
async function qrda1BundleLookup(
  env: RunsEnv,
  subjectIds: readonly string[],
): Promise<((subjectId: string) => unknown | undefined) | undefined> {
  if (!isWebChartConfigured(env)) return undefined;
  try {
    const patientIds = subjectIds.map((id) => (id.startsWith("wc|") ? id.slice(3) : id));
    const source = resolveDataSource(env);
    const bundles = source.loadBundlesFor ? await source.loadBundlesFor(patientIds) : await source.loadBundles();
    // Keying lives in `indexBundlesBySubject` so the contract between what the pipeline PERSISTS and what
    // this looks up is pinned by a test rather than by a comment (review + Codex, #361).
    return indexBundlesBySubject(bundles, (b) => subjectIdOf(b as Parameters<typeof subjectIdOf>[0]));
  } catch (error) {
    // "not configured", "private key malformed", "token endpoint down" and "transport 403" all end here
    // and are otherwise indistinguishable from "this subject genuinely has no data".
    console.error("[workwell] qrda1: WebChart bundle load failed, exporting without patient data:", error);
    return undefined;
  }
}

/**
 * Every identifier a QRDA document could legitimately use to name this measure: WorkWell's own id and,
 * when the measure is vendored, its published version-specific and version-independent eMeasure UUIDs.
 */
function measureIdentityFor(measureId: string): Set<string> {
  const identity = new Set<string>([measureId]);
  const artifact = loadOfficialArtifact(measureId);
  if (artifact) {
    const { versionSpecific, versionIndependent } = officialMeasureIdentifiers(artifact);
    if (versionSpecific) identity.add(versionSpecific);
    if (versionIndependent) identity.add(versionIndependent);
  }
  return identity;
}

/**
 * Aggregate population counts for a completed single-measure run.
 *
 * Authored measures use the bounded `GROUP BY status` histogram (Fable H4) — a 120k `seed:scale` run
 * must never materialize its 1.68M rows. An OFFICIAL-routed measure cannot: its populations live in
 * per-subject `evidence_json.official.populationResults`, which a status histogram cannot see, and
 * deriving them from the workflow status would invert the numerator for a lower-is-better measure.
 * So official runs read rows, bounded by the same subject cap the individual/bundle reports use;
 * over the cap we refuse rather than emit a status-derived (wrong) regulatory artifact.
 */
/**
 * Did THIS run's outcomes come from the official executor? One row settles it: `evidence.official` is
 * written only by that executor, and a run evaluates one measure with one engine. Bounded on purpose —
 * this sits in front of a path that must stay O(1) for a 120k `seed:scale` run.
 */
async function runProducedOfficialEvidence(
  os: Awaited<ReturnType<typeof outcomes>>,
  runId: string,
): Promise<boolean> {
  const [first] = await os.listOutcomes(runId, { limit: 1 });
  return officialMembership(first?.evidence) !== null;
}

async function aggregateCountsForRun(
  os: Awaited<ReturnType<typeof outcomes>>,
  runId: string,
  measureId: string,
  env: RunsEnv,
): Promise<{ counts: PopulationCounts; official: OfficialReportIdentity | null } | { error: Response }> {
  // Provenance comes from the RUN, not from the current deployment flag (Codex P1). A run's outcomes
  // were produced by whichever engine was configured *then*; consulting `WORKWELL_OFFICIAL_MEASURES`
  // now means that turning the flag off — the documented rollback — silently reinterprets every
  // historical official run through the status histogram, reversing cms122's numerator (its official
  // numerator is poor control, and the workflow status inverts it). An export of a past run must not
  // change meaning because of a config change made after it.
  //
  // The env flag is still consulted first, as a cheap way to skip a read for the overwhelmingly common
  // case; when it is off, one bounded row settles it. `evidence.official` is written only by the
  // official executor, and a run evaluates one measure with one engine, so a single row is decisive.
  const routedNow = isOfficialRouted(measureId, env as unknown as Record<string, unknown>);
  const official = routedNow || (await runProducedOfficialEvidence(os, runId));
  if (!official) {
    return { counts: populationCountsFromStatus(await os.countOutcomesByStatus(runId), measureId), official: null };
  }
  const total = (await os.countOutcomesByStatus(runId)).reduce((sum, c) => sum + c.count, 0);
  if (total > MAX_INDIVIDUAL_REPORT_SUBJECTS) {
    return {
      error: json(
        {
          error: "run_too_large",
          message:
            `Official-routed measure "${measureId}" reports populations from per-subject evidence, ` +
            `which is limited to ${MAX_INDIVIDUAL_REPORT_SUBJECTS} subjects; this run has ${total}.`,
        },
        422,
      ),
    };
  }
  const rows = await os.listOutcomes(runId);
  // The artifact identity travels with the counts so BOTH exporters describe the same measure. Read off
  // the first row that carries it — a run evaluates one measure with one engine, so any row is decisive,
  // and a run where only some rows errored still names the artifact the rest were scored by (ADR-046).
  const identity = rows.map((r) => officialReportIdentity(r.evidence)).find((i) => i !== null) ?? null;
  return { counts: countPopulations(rows, measureId), official: identity };
}


/**
 * A run whose outcomes are FINAL, and therefore safe to export as a regulatory artifact.
 *
 * A configured-live or wide-scope run returns `RUNNING` while `finishManualRun` is still persisting
 * outcomes in the background (`scheduleAsyncRun`). Exporting then yields a document set covering only
 * the subjects written so far — with every organizer marked `completed` and nothing in the envelope
 * saying subjects are missing — i.e. a partial roster presented as a complete report. It also weakens
 * the subject bound, since the count read and the row read can straddle further writes (Codex, #360).
 *
 * `PARTIAL_FAILURE` IS reportable: those runs finished, and their failed subjects persist MISSING_DATA
 * with an `evaluationError`, which is a real outcome rather than an absent one. `FAILED` is not.
 */
const REPORTABLE_RUN_STATUSES = new Set(["COMPLETED", "PARTIAL_FAILURE"]);

const notReportable = (status: string): Response | null =>
  REPORTABLE_RUN_STATUSES.has(status)
    ? null
    : json(
        {
          error: "run_not_reportable",
          message:
            `A quality report may only be exported from a finished run; this one is ${status}. ` +
            `Exporting a run that is still writing outcomes would present a partial roster as complete.`,
          status,
        },
        409,
      );

/** The run-detail outcomes grid returns a whole run up to this size (a live ALL_PROGRAMS run is ~2,100
 *  rows); a larger run (a 120k seed:scale run) is capped to the first page so the worker never
 *  materializes 120k hydrated rows (Fable H4 / Codex P2). Above this, page with an explicit ?limit. */
const OUTCOMES_GRID_FULL_CAP = 5000;

/**
 * Documents accepted in one `/import` call, and the size above which `/finalize` stops recognising a run
 * as import-driven. Every document is parsed and held at once to resolve identity across the batch, so
 * this bounds the request rather than expressing a belief about submission sizes: Cypress's own C2
 * archives are 66–153 documents. A larger submission belongs in several runs.
 */
const QRDA1_IMPORT_MAX_DOCUMENTS = 500;

/**
 * A run may only receive imported documents — and be finalized from outside — if it was CREATED for
 * that, by a caller that set `requestedScope.importDriven`.
 *
 * The first cut inferred this from the rows instead ("every outcome carries `qrda1Import`"), and review
 * broke it end to end (#389): `scheduleAsyncRun` returns RUNNING immediately and finishes its fan-out in
 * `ctx.waitUntil`, so there is a window in which an ALL_PROGRAMS run is RUNNING with ZERO outcomes.
 * Importing one document into that window made every row import-driven, `/finalize` marked it COMPLETED,
 * and a QRDA III was exported from a run that went on to gain 2,100 more outcomes — a partial roster
 * presented as a complete quality report, and a terminal run mutated under every read-model cache keyed
 * on `runId`.
 *
 * The flag cannot be retrofitted onto a run the pipeline owns: `executeManualRun` and the scheduler build
 * their own `requestedScope`, and there is no route that edits one. So it is a property of construction,
 * which is what the row-level test could never be. Both checks now run — this one says the run was MEANT
 * for this, the row test says nothing else got in.
 */
const isImportDrivenRun = (run: { requestedScope: Record<string, unknown> }): boolean =>
  run.requestedScope?.importDriven === true;

/**
 * Run an async-scope (ALL_PROGRAMS/SITE or configured-live MEASURE) manual run or rerun: create the run + return RUNNING
 * immediately, finish the fan-out in the background via waitUntil. The background promise gets a
 * rejection handler so a failure AFTER the response (recordOutcome/upsert/finalize) finalizes the
 * run FAILED instead of leaving it stuck RUNNING (which the page would poll forever). Returns the
 * RUNNING response, or null when this request should fall through to the synchronous path.
 */
async function scheduleAsyncRun(
  deps: RunPipelineDeps,
  body: ManualRunRequest,
  waitUntil: WaitUntil | undefined,
): Promise<ManualRunResponse | null> {
  const configuredMeasure = body.scopeType === "MEASURE" && isWebChartConfigured(deps.webChartEnv ?? {});
  if (!waitUntil || (!ASYNC_SCOPES.has(body.scopeType) && !configuredMeasure)) return null;
  const planned = await planManualRun(deps, body);
  waitUntil(finishOrFail(deps, planned)); // finishOrFail finalizes FAILED on a post-response error
  return runningResponse(planned);
}

/** Parse a query int, falling back to `def`, clamped to [min, max] (bounds payloads). */
const clampInt = (raw: string | null, def: number, min: number, max: number): number => {
  const n = raw == null ? def : Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

/** Build a ManualRunResponse from a completed rerun-to-verify (the runs page's contract). */
function caseRerunResponse(detail: {
  lastRunId: string;
  measureName: string;
  employeeName: string;
  currentOutcomeStatus: string;
}): ManualRunResponse {
  const compliant = detail.currentOutcomeStatus === "COMPLIANT" ? 1 : 0;
  return {
    runId: detail.lastRunId,
    scopeType: "CASE",
    scopeLabel: `Case: ${detail.measureName} / ${detail.employeeName}`,
    status: "COMPLETED",
    activeMeasuresExecuted: 1,
    totalEvaluated: 1,
    compliant,
    nonCompliant: 1 - compliant,
    message: `Rerun-to-verify completed with status ${detail.currentOutcomeStatus}.`,
    measuresExecuted: [detail.measureName],
  };
}

/** Returns a Response if this module owns the route, else null (let the worker continue). */
/** Schedules background work that must outlive the response (ctx.waitUntil); awaits inline if absent. */
export type WaitUntil = (p: Promise<unknown>) => void;

export async function handleRuns(
  req: Request,
  env: RunsEnv,
  actor = "system",
  waitUntil?: WaitUntil,
  generatedAt = new Date().toISOString(),
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  // ---- read models (#107 strangler — runs module) -------------------------
  // List: newest-first run summaries for the worklist/history grid, honoring the
  // page's status/scopeType/triggerType/site/from/to filters (the Java contract).
  if (pathname === "/api/runs" && req.method === "GET") {
    const q = url.searchParams;
    const limit = clampInt(q.get("limit"), 100, 1, 1000);
    const filters: RunFilters = {
      status: q.get("status") ?? undefined,
      scopeType: q.get("scopeType") ?? undefined,
      triggerType: q.get("triggerType") ?? undefined,
      site: q.get("site") ?? undefined,
      from: q.get("from") ?? undefined,
      to: q.get("to") ?? undefined,
    };
    const runStore = await store(env);
    const outcomeStore = await outcomes(env);
    // Filter first, then cap, so `limit` bounds the *matching* rows (matches the Java
    // endpoint) rather than pre-truncating before filters apply.
    const matching = (await runStore.listRuns(1000)).filter((r) => matchesRunFilters(r, filters)).slice(0, limit);
    // Bounded GROUP BY per run (not listOutcomes) so the list never materializes the 120k-row
    // seed:scale outcomes — the previous per-run full-row load pushed ?limit=20 past the 60s gateway
    // timeout once scale was seeded on Neon (post-audit perf fix).
    const items = await Promise.all(matching.map(async (r) => toRunListItemFromCounts(r, await outcomeStore.countOutcomesByStatus(r.id))));
    return json(items);
  }

  // Run log timeline (clamp + forward the page's ?limit=200 to bound the payload).
  const logsId = pathname.match(/^\/api\/runs\/([^/]+)\/logs$/)?.[1];
  if (logsId && req.method === "GET") {
    const logLimit = clampInt(url.searchParams.get("limit"), 200, 1, 1000);
    return json(toRunLogEntries(await (await store(env)).listLogs(logsId, logLimit)));
  }

  // ---- write pipeline (#107 runs module) ----------------------------------
  // Manual scoped run: evaluate + persist + summarize. Static MEASURE/EMPLOYEE run synchronously
  // (≤ a few seconds); ALL_PROGRAMS/SITE and configured-live MEASURE create the run, return RUNNING
  // immediately, and finish the fan-out/remote load in the background (the page polls to terminal).
  if (pathname === "/api/runs/manual" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as ManualRunRequest;
    body.triggeredBy = externalTriggeredBy(body.triggeredBy); // Fable M1: no forged seed:*/scheduler labels
    const engine = await routedEngineForEnv(env);
    const deps = {
      runStore: await store(env),
      outcomeStore: await outcomes(env),
      caseStore: await cases(env),
      engine,
      segments: await enabledSegments(env),
      qualitySnapshots: (await getStores(env)).qualitySnapshots,
      events: (await getStores(env)).events,
      actor, // audit attribution from the auth middleware, not the body's triggeredBy (Codex P1)
      alertChannels: resolveAlertChannels(env), // #264 failed-run alerts (console + optional webhook)
      webChartEnv: env,
      evalState: (await getStores(env)).evalState, // #263 incremental cache (inert unless the flag is set)
      incremental: isIncrementalEnabled(env),
      expansionActive: isVsacConfigured(env), // #263 — folds value-set membership into logic_version
      valueSets: (await getStores(env)).valueSets,
    };
    try {
      const running = await scheduleAsyncRun(deps, body, waitUntil);
      if (running) return json(running, 201);
      // No waitUntil (e.g. tests) → fall back to synchronous completion for every scope.
      return json(await executeManualRun(deps, body), 201);
    } catch (err) {
      if (err instanceof UnsupportedScopeError) return json({ error: "unsupported_scope", message: err.message }, err.status);
      if (err instanceof InvalidRunRequestError) return json({ error: "invalid_request", message: err.message }, 400);
      return json({ error: "run_failed", message: String((err as Error)?.message ?? err) }, 500);
    }
  }

  // Rerun an existing run's scope as a new run.
  const rerunId = pathname.match(/^\/api\/runs\/([^/]+)\/rerun$/)?.[1];
  if (rerunId && req.method === "POST") {
    const runStore = await store(env);
    const engine = await routedEngineForEnv(env);
    // A CASE run reruns through rerun-to-verify (the case scope), reading the caseId
    // persisted in requested_scope — matches Java's rerunSameScope CASE branch. Other
    // scopes go through executeRerun.
    const prior = await runStore.getRun(rerunId);
    if (!prior) return json({ error: "not_found", id: rerunId }, 404);
    if (prior.scopeType === "CASE") {
      const caseId = prior.requestedScope.caseId as string | undefined;
      if (!caseId) return json({ error: "invalid_request", message: "CASE run has no caseId to rerun" }, 400);
      try {
        const detail = await rerunToVerify(
          { cases: await cases(env), events: (await getStores(env)).events, outcomes: await outcomes(env), runStore, engine },
          caseId,
          actor,
        );
        if (!detail) return json({ error: "not_found", id: caseId }, 404);
        return json(caseRerunResponse(detail), 201);
      } catch (err) {
        if (err instanceof UnsupportedCaseRerunError) return json({ error: err.code, message: err.message }, 409);
        throw err;
      }
    }
    const deps = {
      runStore,
      outcomeStore: await outcomes(env),
      caseStore: await cases(env),
      engine,
      segments: await enabledSegments(env),
      qualitySnapshots: (await getStores(env)).qualitySnapshots,
      events: (await getStores(env)).events,
      actor, // audit attribution from the auth middleware (Codex P1)
      alertChannels: resolveAlertChannels(env), // #264 failed-run alerts
      webChartEnv: env,
      evalState: (await getStores(env)).evalState, // #263 incremental cache (inert unless the flag is set)
      incremental: isIncrementalEnabled(env),
      expansionActive: isVsacConfigured(env), // #263 — folds value-set membership into logic_version
      valueSets: (await getStores(env)).valueSets,
    };
    try {
      // Wide-scope reruns (ALL_PROGRAMS/SITE) carry the same ~1000-eval fan-out as a fresh run,
      // so they must use the async waitUntil path too — not a synchronous executeRerun.
      const running = await scheduleAsyncRun(deps, rerunRequest(prior), waitUntil);
      if (running) return json(running, 201);
      return json(await executeRerun(deps, rerunId), 201);
    } catch (err) {
      if (err instanceof InvalidRunRequestError) return json({ error: "not_found", message: err.message }, 404);
      if (err instanceof UnsupportedScopeError) return json({ error: "unsupported_scope", message: err.message }, err.status);
      return json({ error: "run_failed", message: String((err as Error)?.message ?? err) }, 500);
    }
  }

  if (pathname === "/api/runs" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Partial<CreateRunInput>;
    const now = new Date().toISOString();
    const run = await (await store(env)).createRun({
      scopeType: body.scopeType ?? "ALL_PROGRAMS",
      scopeId: body.scopeId,
      triggeredBy: externalTriggeredBy(body.triggeredBy), // Fable M1: no forged seed:*/scheduler labels

      requestedScope: body.requestedScope ?? {},
      measurementPeriodStart: body.measurementPeriodStart ?? now,
      measurementPeriodEnd: body.measurementPeriodEnd ?? now,
    });
    return json(run, 201);
  }

  if (pathname === "/api/runs/claim" && req.method === "POST") {
    const workerId = url.searchParams.get("workerId") ?? "worker-1";
    const claimed = await (await store(env)).claimNextQueuedRun(workerId);
    return claimed ? json(claimed) : new Response(null, { status: 204 });
  }

  // Evaluate a subject through the JVM-free CQL engine and persist the outcome.
  const evalId = pathname.match(/^\/api\/runs\/([^/]+)\/evaluate$/)?.[1];
  if (evalId && req.method === "POST") {
    const runStore = await store(env);
    const run = await runStore.getRun(evalId);
    if (!run) return json({ error: "not_found", id: evalId }, 404);
    // Refuse to append into a finished run — keeps a terminal run's outcomes immutable so the read-model
    // caches that key on runId (roster #233, scale memo, quality snapshots) can't serve stale rows.
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return json({ error: "run_not_open", id: evalId, status: run.status, hint: "cannot evaluate into a terminal run" }, 409);
    }
    const body = (await req.json().catch(() => null)) as
      | { measureId?: string; patientBundle?: unknown; qrda1?: string; evaluationDate?: string }
      | null;
    if (!body?.measureId || (!body.patientBundle && body.qrda1 == null)) {
      return json(
        { error: "invalid_request", hint: "body requires { measureId, patientBundle | qrda1 }; qrda1 wins if both are given" },
        400,
      );
    }
    // §170.315(c)(2) "import and calculate": a QRDA Category I document is translated to FHIR and then
    // evaluated by the SAME unchanged engine — importing is a mapping, not a second calculator (ADR-051).
    // A document we cannot read is a 400 with the reason, never a silent empty bundle: an empty bundle
    // evaluates out-of-population for every measure, indistinguishable from a genuinely ineligible
    // patient (the ADR-043 hazard).
    let imported: Qrda1Import | undefined;
    // `!= null` rather than `!== undefined`: JSON `null` for an absent optional field is a common client
    // idiom, and treating it as "a QRDA was supplied" turned a previously-working request into a 400.
    if (body.qrda1 != null) {
      if (typeof body.qrda1 !== "string") {
        return json({ error: "invalid_request", hint: "qrda1 must be the CDA document as a string" }, 400);
      }
      try {
        imported = importQrda1Document(body.qrda1);
      } catch (err) {
        return json({ error: "qrda1_import_failed", message: String((err as Error)?.message ?? err) }, 400);
      }
      // The document says WHICH measure it is about. Evaluating it as a different one is a silent
      // mislabel: a CMS125 document posted as `cms122` would be calculated and PERSISTED as cms122
      // (Codex, #362). Refuse unless the requested measure is one the document references — and only
      // when it references any at all, so a document with no measure section is still importable.
      const identity = measureIdentityFor(body.measureId);
      const referenced = [...imported.measureIdentifiers, ...(imported.localMeasureId ? [imported.localMeasureId] : [])];
      if (referenced.length > 0 && !referenced.some((r) => identity.has(r))) {
        return json(
          {
            error: "qrda1_measure_mismatch",
            message: `the document references ${referenced.join(", ")}, which is not measure '${body.measureId}'`,
            requested: body.measureId,
            documentReferences: referenced,
          },
          400,
        );
      }
    }
    const patientBundle = imported?.bundle ?? body.patientBundle;
    // The outcome's evaluation_period must equal the date the engine actually evaluates with,
    // so repeat-non-complier history (grouped by period) doesn't collapse into a blank period.
    // Engine default when omitted is today (cql-execution-engine) — prefer the run's persisted
    // period, then today, mirroring that default.
    const evaluationPeriod =
      body.evaluationDate ?? (run.requestedScope.evaluationDate as string | undefined) ?? new Date().toISOString().slice(0, 10);
    // Build the engine BEFORE claiming the run. `routedEngineForEnv` validates official-measure
    // configuration and can throw; doing that after markRunning would leave an orphaned RUNNING run for
    // `recoverStuckRuns` to sweep, for a failure that has nothing to do with the run.
    const engine = await routedEngineForEnv(env);
    // A run being processed must leave the QUEUED claim path so it isn't re-handed
    // to a worker (QUEUED → RUNNING; idempotent for already-running runs).
    await runStore.markRunning(evalId);
    try {
      const result = await engine.evaluate({
        measureId: body.measureId,
        patientBundle,
        // The RESOLVED date, not the body's. With the body silent and the run carrying an
        // `evaluationDate`, the row was labelled with the run's date while the engine evaluated TODAY —
        // a regulatory record stating a period it was not computed over (Codex, #389). `evaluationPeriod`
        // already falls back to today, so this changes nothing when both are absent.
        evaluationDate: evaluationPeriod,
      });
      // What the import could NOT translate is PERSISTED with the outcome, not just returned. A QRDA I
      // carrying QDM datatypes this mapper does not know is calculable but not necessarily correctly —
      // the CMS RY2026 sample alone contains 47 such entries. Returning that only in the POST response
      // meant every later read (outcomes, MeasureReport, QRDA) presented a partial calculation as an
      // ordinary one, and the qualification died with the request (Codex, #362). Additive under the
      // `evidence_json` contract, the same way `official` is.
      const evidence =
        imported && typeof result.evidence === "object" && result.evidence !== null
          ? {
              ...(result.evidence as Record<string, unknown>),
              qrda1Import: {
                untranslatedTemplates: imported.untranslatedTemplates,
                measureReferences: imported.measureIdentifiers,
              },
            }
          : result.evidence;
      const record = await (await outcomes(env)).recordOutcome({
        runId: evalId,
        subjectId: result.subjectId,
        measureId: body.measureId,
        evaluationPeriod,
        status: result.outcome,
        evidence,
      });
      return json(
        imported ? { ...record, qrda1: { untranslatedTemplates: imported.untranslatedTemplates } } : record,
        201,
      );
    } catch (err) {
      return json({ error: "evaluation_error", message: String((err as Error)?.message ?? err) }, 500);
    }
  }

  // §170.315(c)(2) at SUBMISSION scale: a batch of QRDA Category I documents, resolved to the people
  // they describe, evaluated through the unchanged engine. The single-document `/evaluate` above cannot
  // do this, and not for want of a flag: resolving identity is inherently cross-document, and a receiver
  // that treats every document as a subject over-reports the population before any measure logic runs
  // (measured on Cypress's own archives: 68 documents, 64 people — ADR-055 / the C2 evidence §13).
  const importId = pathname.match(/^\/api\/runs\/([^/]+)\/import$/)?.[1];
  if (importId && req.method === "POST") {
    const runStore = await store(env);
    const run = await runStore.getRun(importId);
    if (!run) return json({ error: "not_found", id: importId }, 404);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return json({ error: "run_not_open", id: importId, status: run.status, hint: "cannot import into a terminal run" }, 409);
    }
    if (!isImportDrivenRun(run)) {
      return json(
        {
          error: "run_not_import_driven",
          message:
            "documents may only be imported into a run created for it — POST /api/runs with " +
            "requestedScope.importDriven = true. A run the pipeline owns is still writing its own " +
            "outcomes, and mixing an import into it would let a partial roster be finalized and exported.",
        },
        409,
      );
    }
    const body = (await req.json().catch(() => null)) as
      | { measureId?: string; qrda1?: unknown; evaluationDate?: string; assertMeasureIdentifiers?: unknown }
      | null;
    if (!body?.measureId || !Array.isArray(body.qrda1) || body.qrda1.length === 0) {
      return json(
        { error: "invalid_request", hint: "body requires { measureId, qrda1: string[] } with at least one document" },
        400,
      );
    }
    if (body.qrda1.length > QRDA1_IMPORT_MAX_DOCUMENTS) {
      // Bounded because every document is parsed and held in memory at once to resolve identity across
      // them; a submission larger than this belongs in several runs rather than in one request.
      return json(
        {
          error: "too_many_documents",
          message: `at most ${QRDA1_IMPORT_MAX_DOCUMENTS} documents per request; received ${body.qrda1.length}`,
        },
        413,
      );
    }
    if (!body.qrda1.every((document) => typeof document === "string")) {
      return json({ error: "invalid_request", hint: "each qrda1 entry must be the CDA document as a string" }, 400);
    }

    const resolution = resolveQrda1Documents(body.qrda1 as string[]);
    // Every document unreadable is not a partial success — it is the empty-bundle hazard by another
    // route, and reporting 0 subjects with a 201 would read as "this population is empty".
    if (resolution.subjects.length === 0) {
      return json(
        {
          error: "qrda1_import_failed",
          message: "no document in the submission could be imported",
          failures: resolution.failures,
        },
        400,
      );
    }
    // The documents say which measure they are about; evaluating them as another is a silent mislabel
    // that PERSISTS (Codex, #362). Checked across the whole submission, once.
    //
    // `assertMeasureIdentifiers` is the escape hatch, and it is deliberately an ASSERTION rather than a
    // relaxation. A QRDA about the same measure in a different LINEAGE carries an identity we hold
    // nothing to match: Cypress's CMS125v14 documents reference the QDM eMeasure UUID
    // `DBD9ECCD-…`, while our vendored artifact is the FHIR/QI-Core v1.0.000 one. They are the same
    // measure and our system cannot prove it — so a caller who knows states it explicitly, every asserted
    // identifier is listed, and the assertion is PERSISTED in the outcome evidence so a later reader sees
    // that a human claimed the mapping rather than the system deriving it. Refusing stays the default.
    const asserted = Array.isArray(body.assertMeasureIdentifiers)
      ? body.assertMeasureIdentifiers.filter((value): value is string => typeof value === "string")
      : [];
    // PER SUBJECT, not over the union. Checking the union means one matching document licenses the whole
    // batch: 149 CMS125 documents plus one CMS122 would pass, and that document's clinical data would be
    // merged, evaluated and PERSISTED as cms125 — the silent mislabel #362 refused, reintroduced by the
    // aggregation. `/evaluate` cannot make this mistake because it sees one document at a time
    // (review, #389).
    const identity = measureIdentityFor(body.measureId);
    const mismatched = resolution.subjects
      .map((subject) => ({
        subject,
        unexplained: subject.measureIdentifiers.filter((r) => !identity.has(r) && !asserted.includes(r)),
      }))
      .filter(
        ({ subject, unexplained }) =>
          subject.measureIdentifiers.length > 0 &&
          !subject.measureIdentifiers.some((r) => identity.has(r)) &&
          unexplained.length > 0,
      );
    if (mismatched.length > 0) {
      const unexplained = [...new Set(mismatched.flatMap((m) => m.unexplained))];
      return json(
        {
          error: "qrda1_measure_mismatch",
          message:
            `${mismatched.length} of ${resolution.subjects.length} subject(s) reference ` +
            `${unexplained.join(", ")}, which is not measure '${body.measureId}'. If these documents are ` +
            `that measure in another lineage (a QDM eMeasure UUID for a measure we hold as FHIR, say), ` +
            `assert it explicitly with assertMeasureIdentifiers — the claim is recorded with every outcome.`,
          requested: body.measureId,
          documentReferences: unexplained,
          documentIndexes: [...new Set(mismatched.flatMap((m) => m.subject.documentIndexes))],
        },
        400,
      );
    }

    const evaluationPeriod =
      body.evaluationDate ?? (run.requestedScope.evaluationDate as string | undefined) ?? new Date().toISOString().slice(0, 10);
    const outcomeStore = await outcomes(env);
    // ONE import per run, and that is the idempotency contract (CLAUDE.md's Definition of Done makes it
    // mandatory). `outcomes` has no unique key on `(run_id, subject_id, measure, period)`, so a client
    // retrying after a timeout would insert a second row for every subject and DOUBLE the population the
    // QRDA III reports, with `/finalize` accepting every row as imported (Codex, #389). Refusing is
    // better than upserting here: a retry is indistinguishable from a deliberate second archive, and
    // silently merging two archives into one report is the worse of the two mistakes. It also makes the
    // run the unit of accumulation, so the finalize-time cap cannot be exceeded by repetition.
    const already = (await outcomeStore.countOutcomesByStatus(importId)).reduce((sum, c) => sum + c.count, 0);
    if (already > 0) {
      return json(
        {
          error: "run_already_imported",
          message:
            `this run already holds ${already} outcome(s). A run takes ONE submission — create another ` +
            `run for another archive. (Retrying an import would insert a second row per subject and ` +
            `double the population the report states; the outcomes table has no key that would stop it.)`,
        },
        409,
      );
    }
    const engine = await routedEngineForEnv(env);
    await runStore.markRunning(importId);
    const persisted: unknown[] = [];
    const evaluationFailures: Array<{ subjectId: string; message: string }> = [];
    for (const subject of resolution.subjects) {
      const provenance = {
        untranslatedTemplates: subject.untranslatedTemplates,
        measureReferences: subject.measureIdentifiers,
        documentCount: subject.documentIndexes.length,
        ...(asserted.length > 0 ? { assertedMeasureIdentifiers: asserted } : {}),
        ...(subject.demographicConflicts.length > 0 ? { demographicConflicts: subject.demographicConflicts } : {}),
      };
      try {
        const result = await engine.evaluate({
          measureId: body.measureId,
          patientBundle: subject.bundle,
          // The resolved date — see `/evaluate` above; the divergence was copied here with it.
          evaluationDate: evaluationPeriod,
        });
        const evidence =
          typeof result.evidence === "object" && result.evidence !== null
            ? {
                ...(result.evidence as Record<string, unknown>),
                qrda1Import: {
                  // The provenance a reader needs to interpret the row: how many documents this
                  // person's outcome was computed from, whether those documents disagreed about who they
                  // are, and — because it is a human's claim rather than a derivation — any cross-lineage
                  // measure identity the caller asserted.
                  ...provenance,
                },
              }
            : result.evidence;
        persisted.push(
          await outcomeStore.recordOutcome({
            runId: importId,
            subjectId: result.subjectId,
            measureId: body.measureId,
            evaluationPeriod,
            status: result.outcome,
            evidence,
          }),
        );
      } catch (err) {
        // PERSIST the failure, exactly as `run-pipeline.ts` does. Collecting it in the response only —
        // which the first cut did — loses the subject the moment the request ends: no row, no log, no
        // audit, and the exported report counts a roster short with nothing anywhere saying so. Review
        // (#389) also showed it made the `PARTIAL_FAILURE` branch below structurally dead, since every
        // row `/finalize` could see came from a SUCCESSFUL evaluate. One fix, both halves.
        const message = String((err as Error)?.message ?? err);
        evaluationFailures.push({ subjectId: subject.subjectId, message });
        persisted.push(
          await outcomeStore.recordOutcome({
            runId: importId,
            subjectId: subject.subjectId,
            measureId: body.measureId,
            evaluationPeriod,
            status: "MISSING_DATA",
            evidence: { evaluationError: "engine failure", message, qrda1Import: provenance },
          }),
        );
      }
    }

    // Every resolved subject is now persisted — successes and failures alike — so a mismatch means a row
    // was silently lost, which would under-report the population in a document that reads as complete.
    if (persisted.length !== resolution.subjects.length) {
      return json(
        {
          error: "import_incomplete",
          message: `resolved ${resolution.subjects.length} subject(s) but persisted ${persisted.length}`,
        },
        500,
      );
    }
    return json(
      {
        documents: body.qrda1.length,
        subjects: resolution.subjects.length,
        outcomes: persisted,
        // Reported at the top level as well as per-outcome, because "68 documents became 64 people" is
        // the number a submitter checks first, and a conflict is a reason to look at a document again.
        merged: resolution.subjects
          .filter((s) => s.documentIndexes.length > 1)
          .map((s) => ({ subjectId: s.subjectId, documentIndexes: s.documentIndexes })),
        demographicConflicts: resolution.subjects
          .filter((s) => s.demographicConflicts.length > 0)
          .map((s) => ({ subjectId: s.subjectId, conflicts: s.demographicConflicts })),
        importFailures: resolution.failures,
        evaluationFailures,
      },
      201,
    );
  }

  // Finish a run whose outcomes were supplied from OUTSIDE — the missing step between importing
  // documents and exporting a quality report from them (`GET /api/runs/:id/qrda*` refuses a run that is
  // still RUNNING, correctly: exporting a run that is still writing outcomes presents a partial roster
  // as complete).
  //
  // Deliberately NOT a general "finish this run" button. A population run is advanced by the pipeline,
  // which knows when its fan-out is done; finalizing one from outside would mark a partial roster
  // COMPLETED and make it exportable — the exact harm the export guard exists to prevent. So this
  // refuses unless EVERY outcome in the run carries `qrda1Import` evidence, which is true only of a run
  // whose roster came from documents the caller supplied. That is checkable without new state, and it
  // fails closed: a run mixing imported and pipeline outcomes is refused rather than guessed at.
  const finalizeId = pathname.match(/^\/api\/runs\/([^/]+)\/finalize$/)?.[1];
  if (finalizeId && req.method === "POST") {
    const runStore = await store(env);
    const run = await runStore.getRun(finalizeId);
    if (!run) return json({ error: "not_found", id: finalizeId }, 404);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return json({ error: "run_already_finished", id: finalizeId, status: run.status }, 409);
    }
    // Constructional first, rows second. See `isImportDrivenRun`: the row test alone was defeated by the
    // window in which a population run is RUNNING with no outcomes yet (review, #389).
    if (!isImportDrivenRun(run)) {
      return json(
        {
          error: "run_not_import_driven",
          message:
            "only a run created for imported documents (requestedScope.importDriven) can be finalized " +
            "from outside. A population run is finalized by the pipeline that knows when its fan-out is " +
            "done; finishing one from here would mark a partial roster COMPLETED and make it exportable.",
        },
        409,
      );
    }
    const rows = await (await outcomes(env)).listOutcomes(finalizeId, { limit: QRDA1_IMPORT_MAX_DOCUMENTS + 1 });
    if (rows.length === 0) {
      return json(
        {
          error: "run_has_no_outcomes",
          message: "a run with no outcomes has nothing to report; import documents before finalizing",
        },
        409,
      );
    }
    if (rows.length > QRDA1_IMPORT_MAX_DOCUMENTS) {
      return json(
        {
          error: "run_too_large_to_finalize",
          message:
            `this route verifies every outcome came from an imported document, and this run has more ` +
            `than ${QRDA1_IMPORT_MAX_DOCUMENTS}. A run that large is a population run, which the run ` +
            `pipeline finalizes itself.`,
        },
        409,
      );
    }
    const notImported = rows.filter((row) => !(row.evidence as Record<string, unknown> | undefined)?.qrda1Import);
    if (notImported.length > 0) {
      return json(
        {
          error: "run_not_import_driven",
          message:
            `${notImported.length} of ${rows.length} outcomes in this run were not produced by a QRDA ` +
            `import. Only a run whose roster came entirely from supplied documents can be finalized from ` +
            `outside — a population run is finalized by the pipeline that knows when its fan-out is done.`,
        },
        409,
      );
    }
    // Mirrors `case-rerun.ts`: a run whose subjects include an evaluation error finished, but not
    // cleanly, and PARTIAL_FAILURE is still reportable (those subjects persist MISSING_DATA with the
    // error, which is a real outcome rather than an absent one).
    const status = rows.some((row) => (row.evidence as Record<string, unknown> | undefined)?.evaluationError)
      ? "PARTIAL_FAILURE"
      : "COMPLETED";
    const finalized = await runStore.finalizeRun(finalizeId, status);
    await runStore.appendLog(finalizeId, "INFO", `Finalized ${status} from ${rows.length} imported outcome(s).`);
    // Every state change writes an audit event (CLAUDE.md hard rule). The store has no events binding, so
    // it is written here, exactly as `run-pipeline.ts` does for a population run — otherwise the run audit
    // packet is empty for precisely the runs whose provenance a certification story depends on
    // (review, #389). Best-effort at the boundary, like the pipeline's: the run IS finalized, and losing
    // the ledger write must not turn a finished run into a 500.
    try {
      await (await getStores(env)).events?.appendAudit({
        eventType: "RUN_COMPLETED",
        entityType: "run",
        entityId: finalizeId,
        actor: actor ?? "system",
        refRunId: finalizeId,
        refCaseId: null,
        refMeasureVersionId: null,
        payload: { status, totalEvaluated: rows.length, source: "qrda1-import" },
      });
    } catch (err) {
      await runStore.appendLog(finalizeId, "WARN", `audit write failed: ${String((err as Error)?.message ?? err)}`);
    }
    return json(finalized);
  }

  // Per-employee outcome rows for the run detail grid (RunOutcomeRow). Bounded for the 120k seed:scale
  // runs (Fable H4) WITHOUT truncating a normal run (Codex P2): the legacy default returns the whole run
  // — a live ALL_PROGRAMS run is only ~2,100 rows, and the /runs page renders the array directly without
  // paging — and only a pathologically large (scale) run is capped to the first page so the single-replica
  // worker never materializes 120k hydrated rows. An explicit ?limit/?offset always pages. X-Total-Count
  // carries the true count (a bounded GROUP BY) so a paging client can detect a capped scale run.
  const outcomesId = pathname.match(/^\/api\/runs\/([^/]+)\/outcomes$/)?.[1];
  if (outcomesId && req.method === "GET") {
    const os = await outcomes(env);
    if (DEPLOYMENT_PROFILE.id !== "default") {
      const allRows = await os.listOutcomes(outcomesId);
      const directory = directoryForRows(allRows, isWebChartConfigured(env), env, DIRECTORY);
      const profileMatch = profileSubjectMatcher(directory.employeeById);
      const visibleRows = allRows.filter((row) => profileMatch(row.subjectId));
      const hasExplicitPaging = url.searchParams.has("limit") || url.searchParams.has("offset");
      let rows = visibleRows;
      if (hasExplicitPaging) {
        const limit = clampInt(url.searchParams.get("limit"), 500, 1, 2000);
        const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
        rows = visibleRows.slice(offset, offset + limit);
      } else if (visibleRows.length > OUTCOMES_GRID_FULL_CAP) {
        rows = visibleRows.slice(0, OUTCOMES_GRID_FULL_CAP);
      }
      return new Response(JSON.stringify(toRunOutcomeRows(rows, directory.employeeById)), {
        status: 200,
        headers: { "content-type": "application/json", "X-Total-Count": String(visibleRows.length) },
      });
    }
    const total = (await os.countOutcomesByStatus(outcomesId)).reduce((sum, c) => sum + c.count, 0);
    const hasExplicitPaging = url.searchParams.has("limit") || url.searchParams.has("offset");
    let rows;
    if (hasExplicitPaging) {
      const limit = clampInt(url.searchParams.get("limit"), 500, 1, 2000);
      const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
      rows = await os.listOutcomes(outcomesId, { limit, offset });
    } else if (total > OUTCOMES_GRID_FULL_CAP) {
      rows = await os.listOutcomes(outcomesId, { limit: OUTCOMES_GRID_FULL_CAP }); // oversized (scale) run
    } else {
      rows = await os.listOutcomes(outcomesId); // whole run — no truncation for normal runs
    }
    return new Response(JSON.stringify(toRunOutcomeRows(rows)), {
      status: 200,
      headers: { "content-type": "application/json", "X-Total-Count": String(total) },
    });
  }

  // QRDA Category I — PATIENT-level, one CDA document per subject, returned as a JSON envelope of
  // documents (M-B). Category III below is the aggregate counterpart for the same run.
  //
  // Bounded by MAX_INDIVIDUAL_REPORT_SUBJECTS for the same reason the individual MeasureReport bundle is:
  // this path materializes per-subject rows, and a 120k seed:scale run would otherwise build 120k CDA
  // documents in the worker. The refusal names the limit rather than truncating — a partial QRDA set that
  // looked complete is exactly the shape this codebase keeps refusing.
  const qrda1Id = pathname.match(/^\/api\/runs\/([^/]+)\/qrda1$/)?.[1];
  if (qrda1Id && req.method === "GET") {
    const run = await (await store(env)).getRun(qrda1Id);
    if (!run) return json({ error: "not_found", id: qrda1Id }, 404);
    const unfinished = notReportable(run.status);
    if (unfinished) return unfinished;
    const os = await outcomes(env);
    const measureIds = await os.distinctMeasuresForRun(qrda1Id, 2);
    if (measureIds.length !== 1) {
      return json(
        { error: "unsupported_run_scope", message: "QRDA I requires a completed single-measure run", measures: measureIds.length },
        422,
      );
    }
    const measureId = measureIds[0]!;
    const total = (await os.countOutcomesByStatus(qrda1Id)).reduce((sum, c) => sum + c.count, 0);
    if (total > MAX_INDIVIDUAL_REPORT_SUBJECTS) {
      return json(
        {
          error: "run_too_large",
          message:
            `QRDA I emits one document per subject, which is limited to ` +
            `${MAX_INDIVIDUAL_REPORT_SUBJECTS} subjects; this run has ${total}.`,
        },
        422,
      );
    }
    const rows = await os.listOutcomes(qrda1Id);
    const documents = buildQrda1Documents(run, measureId, rows, await qrda1BundleLookup(env, rows.map((r) => r.subjectId)));
    const nonConformant = documents.filter((d) => !d.conformant).length;
    return json({
      runId: qrda1Id,
      measureId,
      count: documents.length,
      // Surfaced, not hidden: a document with no QDM patient data cannot be recalculated from and is not
      // a conformant QRDA I (CONF:67-14567). The caller learns that from the response, not by validating.
      // `withCaveats` is a SEPARATE axis — a structurally conformant document whose recalculation may
      // still differ from the run's (roster-derived evidence is deliberately not exported).
      nonConformant,
      withCaveats: documents.filter((d) => d.caveats.length > 0).length,
      documents,
    });
  }

  // QRDA Category III aggregate export (stub) for a completed single-measure run (#91 / E3.3). Built
  // from the bounded status histogram, not the per-subject rows (Fable H4) — safe at 120k scale.
  const qrdaId = pathname.match(/^\/api\/runs\/([^/]+)\/qrda$/)?.[1];
  if (qrdaId && req.method === "GET") {
    const run = await (await store(env)).getRun(qrdaId);
    if (!run) return json({ error: "not_found", id: qrdaId }, 404);
    // Pre-existing gap, found while fixing the same one on QRDA I: Category III read the status
    // histogram of a possibly-RUNNING run and reported its counts as final.
    const unfinishedIii = notReportable(run.status);
    if (unfinishedIii) return unfinishedIii;
    const os = await outcomes(env);
    const measureIds = await os.distinctMeasuresForRun(qrdaId, 2);
    if (measureIds.length !== 1) {
      return json(
        { error: "unsupported_run_scope", message: "QRDA III requires a completed single-measure run", measures: measureIds.length },
        422,
      );
    }
    const fmt = url.searchParams.get("format") ?? "xml";
    if (fmt !== "xml") return json({ error: "invalid_format", message: "QRDA III is XML only" }, 400);
    const measureId = measureIds[0]!;
    const aggregate = await aggregateCountsForRun(os, qrdaId, measureId, env);
    if ("error" in aggregate) return aggregate.error;
    return new Response(buildQrda3DocumentFromCounts(run, measureId, aggregate.counts, aggregate.official), {
      status: 200,
      headers: {
        "content-type": "application/xml",
        "content-disposition": `attachment; filename="qrda3-${qrdaId}.xml"`,
      },
    });
  }

  // FHIR MeasureReport for a completed single-measure run (#89 / E3.1).
  const mrId = pathname.match(/^\/api\/runs\/([^/]+)\/measure-report$/)?.[1];
  if (mrId && req.method === "GET") {
    const run = await (await store(env)).getRun(mrId);
    if (!run) return json({ error: "not_found", id: mrId }, 404);
    const os = await outcomes(env);
    const measureIds = await os.distinctMeasuresForRun(mrId, 2);
    if (measureIds.length !== 1) {
      return json(
        { error: "unsupported_run_scope", message: "MeasureReport requires a completed single-measure run", measures: measureIds.length },
        422,
      );
    }
    const measureId = measureIds[0]!;
    const type = url.searchParams.get("type") ?? "summary";
    const fhir = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          "content-type": "application/fhir+json",
          "content-disposition": `attachment; filename="measure-report-${mrId}-${type}.json"`,
        },
      });
    // summary = aggregate counts only → bounded status histogram, never the per-subject rows (Fable H4).
    if (type === "summary") {
      const aggregate = await aggregateCountsForRun(os, mrId, measureId, env);
      if ("error" in aggregate) return aggregate.error;
      return fhir(buildSummaryMeasureReportFromCounts(run, measureId, aggregate.counts, generatedAt, aggregate.official));
    }
    // individual/bundle emits one MeasureReport per subject; a 120k seed:scale run would build a
    // 120k-entry document. Cap it (Fable H4) — the summary is the aggregate for oversized runs.
    if (type === "individual" || type === "bundle") {
      const total = (await os.countOutcomesByStatus(mrId)).reduce((sum, c) => sum + c.count, 0);
      if (total > MAX_INDIVIDUAL_REPORT_SUBJECTS) {
        return json(
          {
            error: "run_too_large",
            message: `A per-subject ${type} MeasureReport is limited to ${MAX_INDIVIDUAL_REPORT_SUBJECTS} subjects; this run has ${total}. Use ?type=summary for the aggregate.`,
            subjects: total,
            limit: MAX_INDIVIDUAL_REPORT_SUBJECTS,
          },
          422,
        );
      }
      const rows = await os.listOutcomes(mrId, { limit: MAX_INDIVIDUAL_REPORT_SUBJECTS });
      return fhir(buildMeasureReportBundle(run, measureId, rows, generatedAt));
    }
    return json({ error: "invalid_type", message: "type must be summary|individual|bundle" }, 400);
  }

  // Run detail/summary — the RunSummary contract (superset of RunListItem).
  const id = pathname.match(/^\/api\/runs\/([^/]+)$/)?.[1];
  if (id && id !== "claim" && req.method === "GET") {
    const run = await (await store(env)).getRun(id);
    if (!run) return json({ error: "not_found", id }, 404);
    const totalCases = await (await cases(env)).countByLastRun(id);
    // Counts-based summary (bounded GROUP BY) so opening a 120k-row seed:scale run's detail header is
    // also fast; the per-employee outcomes grid (/outcomes) still loads rows on demand.
    return json(toRunSummaryFromCounts(run, await (await outcomes(env)).countOutcomesByStatus(id), totalCases));
  }

  return null;
}
