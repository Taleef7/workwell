/**
 * Warm the dashboard's read models after a population run finishes.
 *
 * Every one of those read models is memoized under the winning runs' key, and a nightly recompute
 * invalidates all of them at once — so the first person to open `/programs` after the nightly pays
 * for the whole cold read while they watch a skeleton: the overview's winner resolution and row
 * scan, plus a trend and a driver pass per measure. The run already took 88 minutes; spending a few
 * more seconds at the end of it, with nobody waiting, buys a warm dashboard for every request after.
 *
 * Best-effort by construction: it computes nothing that is not already computed on demand, and a
 * failure here must never affect a run that has completed and been reported, so every error is
 * swallowed with a WARN — the same posture as the retention pass that runs beside it.
 */
import {
  activeRunnableIds,
  programOverview,
  programRiskOutlook,
  programSites,
  programTopDrivers,
  programTrend,
  type ProgramDeps,
} from "./program-read-models.ts";
import { recordWarm, type WarmRecord } from "../admin/runtime-health.ts";
import { runCandidates } from "../run/read-models.ts";
import { runOutcomeCountsFor } from "../run/run-counts.ts";

/**
 * The filter set the dashboard opens with — no site, no tenant, no date window. Deliberately the
 * ONLY key warmed: a scoped view (`?site=`, `?tenant=`, a date window) is one person's question, and
 * warming the cross product would cost more than the cold read it saves. An operator who pressed
 * Recalculate while scoped still pays a cold read for their own scope.
 */
const UNFILTERED = { site: null, tenant: null } as const;

/**
 * Consecutive panel failures after which the pass stops (#615 review). Attempting every panel after an
 * overview failure is right for a database that is up but slow — the pilot's case, where the panels
 * succeed — and wrong for one that is down: each attempt then waits out the pool's 10 s acquire budget,
 * 18 panels on Maui and 42 on the default profile, one at a time, and the boot warm retries the whole
 * pass. Three failures in a row is a database that is not answering; the rest are reported unwarmed.
 */
export const MAX_CONSECUTIVE_PANEL_FAILURES = 3;

/**
 * Run History's first page (the page's `RUN_PAGE_SIZE`), whose outcome counts are warmed too. Its
 * finished runs' counts are kept until compaction (run-counts.ts), so after a nightly only the new run
 * is read; after a deploy it is all twenty, which cost the first visitor 48.8 s on the pilot.
 */
export const RUN_LIST_WARM = 20;

/**
 * What the pass achieved, so a CALLER can tell success from failure (review of #610).
 *
 * This function swallows every error by design — a failure must never affect a run that has completed
 * and been reported. The consequence was that it also swallowed them from its own callers: the boot
 * warm wrapped it in a two-attempt retry keyed on "a serverless Postgres refusing the first
 * connection of a cold container", and that is precisely the failure this `catch` absorbs, so the
 * retry could never fire and the success line was logged on failure. `DEPLOY.md` points an operator at
 * that line as the post-deploy check.
 */
export interface WarmResult {
  /**
   * The overview pass completed. False does NOT mean nothing else ran: since #615 the per-measure
   * panels are attempted either way.
   */
  ok: boolean;
  /** Why not, when `ok` is false. */
  error?: string;
  /** Measures with at least one panel (trend, drivers, outlook) that failed to warm. */
  failedMeasures: string[];
}

/**
 * Warm, and record the pass on the runtime view (`/health`'s `lastWarm`, `/api/admin/runtime`'s
 * `warms`) whatever the caller does with the result (#615). The scheduler awaited this and dropped
 * the answer, so "did last night's warm run?" had no answer anywhere an operator could read.
 */
export async function warmReadModels(deps: ProgramDeps, trigger: WarmRecord["trigger"] = "run"): Promise<WarmResult> {
  const started = Date.now();
  const result = await warmPass(deps);
  const finished = Date.now();
  recordWarm({
    trigger,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    ok: result.ok,
    failedMeasures: result.failedMeasures,
    ...(result.error ? { error: result.error } : {}),
  });
  return result;
}

async function warmPass(deps: ProgramDeps): Promise<WarmResult> {
  let error: string | undefined;
  let measureIds: string[];
  try {
    await programSites(deps);
    measureIds = (await programOverview(deps, { ...UNFILTERED })).map((s) => s.measureId);
  } catch (err) {
    // The overview failing used to end the pass here, so nothing per-measure was warmed either. On the
    // pilot's cold database the overview ran past the 30 s role timeout (#615), and every measure page
    // then paid its own cold read. The panels below do not need the overview's answer, only the list
    // of measures it shows, so they are attempted regardless.
    error = String((err as Error)?.message ?? err);
    console.warn(`[workwell] read-model warm failed: ${error}`);
    measureIds = activeRunnableIds();
  }
  const failedMeasures: string[] = [];
  let consecutiveFailures = 0;
  for (const [index, measureId] of measureIds.entries()) {
    if (consecutiveFailures >= MAX_CONSECUTIVE_PANEL_FAILURES) {
      console.warn(`[workwell] read-model warm stopped after ${consecutiveFailures} consecutive failures; ${measureIds.length - index} measure(s) not warmed`);
      failedMeasures.push(...measureIds.slice(index));
      break;
    }
    // Per measure AND per panel, so one failure leaves every other panel warm rather than aborting at
    // whichever happened to come first.
    const panels: Array<[string, () => Promise<unknown>]> = [
      // Monthly is what the dashboard asks for; the per-run trend the measure detail page uses is
      // left cold, because warming it would double this pass for a page one person opens at a time.
      ["trend", () => programTrend(deps, measureId, { ...UNFILTERED }, { monthly: true })],
      ["drivers", () => programTopDrivers(deps, measureId, { ...UNFILTERED })],
      // The measure page's third panel, warmed since 2026-09-15 because it now costs what the other
      // two do: the winner's lean row read, plus ONE peeked row to learn whether the run's evidence
      // carries a recency define. On the pilot every routed measure is official, so that peek is the
      // whole evidence cost; on TWH the authored measures' rosters are small. `90` is the horizon the
      // page opens with — and it is not in the memo key, so an entry warmed here serves every other
      // horizon too.
      ["outlook", () => programRiskOutlook(deps, measureId, 90)],
    ];
    let failed = false;
    for (const [panel, warm] of panels) {
      if (consecutiveFailures >= MAX_CONSECUTIVE_PANEL_FAILURES) break;
      try {
        await warm();
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures += 1;
        failed = true;
        console.warn(`[workwell] read-model warm failed for ${measureId} ${panel}: ${String((err as Error)?.message ?? err)}`);
      }
    }
    if (failed) failedMeasures.push(measureId);
  }
  // Last, after the dashboard it serves less often, and not at all once the database has stopped
  // answering. A failure is a WARN only: the list reads its own counts on demand either way.
  if (consecutiveFailures < MAX_CONSECUTIVE_PANEL_FAILURES) {
    try {
      const firstPage = (await runCandidates(deps.runStore, {})).slice(0, RUN_LIST_WARM);
      await runOutcomeCountsFor(deps.outcomeStore, firstPage);
    } catch (err) {
      console.warn(`[workwell] read-model warm failed for the run list: ${String((err as Error)?.message ?? err)}`);
    }
  }
  return error ? { ok: false, error, failedMeasures } : { ok: true, failedMeasures };
}
