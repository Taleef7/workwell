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
  programOverview,
  programSites,
  programTopDrivers,
  programTrend,
  type ProgramDeps,
} from "./program-read-models.ts";

/**
 * The filter set the dashboard opens with — no site, no tenant, no date window. Deliberately the
 * ONLY key warmed: a scoped view (`?site=`, `?tenant=`, a date window) is one person's question, and
 * warming the cross product would cost more than the cold read it saves. An operator who pressed
 * Recalculate while scoped still pays a cold read for their own scope.
 */
const UNFILTERED = { site: null, tenant: null } as const;

export async function warmReadModels(deps: ProgramDeps): Promise<void> {
  let summaries;
  try {
    await programSites(deps);
    summaries = await programOverview(deps, { ...UNFILTERED });
  } catch (err) {
    console.warn(`[workwell] read-model warm failed: ${String((err as Error)?.message ?? err)}`);
    return;
  }
  for (const summary of summaries) {
    // Per measure, so one measure's failure leaves the other twelve warm rather than aborting the
    // pass at whichever happened to sort first.
    try {
      // Monthly is what the dashboard asks for; the per-run trend the measure detail page uses is
      // left cold, because warming it would double this pass for a page one person opens at a time.
      await programTrend(deps, summary.measureId, { ...UNFILTERED }, { monthly: true });
      await programTopDrivers(deps, summary.measureId, { ...UNFILTERED });
    } catch (err) {
      console.warn(`[workwell] read-model warm failed for ${summary.measureId}: ${String((err as Error)?.message ?? err)}`);
    }
  }
}
