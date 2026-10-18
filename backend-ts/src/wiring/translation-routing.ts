/**
 * Which WorkWell translation, if any, a deployment would use to score a year — for read models that only
 * NAME the logic (the measure page, the measures list, the vintage note). The executor decides with
 * `selectArtifactForPeriod` over loaded artifacts; this answers the same question from the manifests
 * alone, by the same rule: the measure is official-routed and named in WORKWELL_DERIVED_MEASURES, CMS's
 * artifact does not cover the year, and the translation does. The router refuses to build at all when an
 * allowlisted translation fails a construction check, so a deployment that scores anything scores what
 * this names.
 */
import { effectivePeriodCovers, loadDerivedManifest, loadOfficialManifest, type OfficialManifest } from "./official-artifacts.ts";
import { derivedMeasureIds, officialMeasureIds } from "./official-routing.ts";

/**
 * The year a routed translation would actually score, or null: the translation's own year, checked by
 * `routedTranslationFor`, so a translation CMS's artifact now covers (CMS wins), or one not allowlisted,
 * is never named as running. For read models that name the logic without a period in hand.
 */
export function routedTranslationYear(
  measureId: string,
  env: Record<string, unknown> = process.env,
  manifests: { official: (id: string) => OfficialManifest | null; derived: (id: string) => OfficialManifest | null } = {
    official: loadOfficialManifest,
    derived: loadDerivedManifest,
  },
): number | null {
  const period = manifests.derived(measureId)?.effectivePeriod;
  const year = period?.start?.slice(0, 4);
  // Exactly one calendar year, as router construction requires (D4): any other translation never runs.
  if (!year || period?.start?.slice(0, 10) !== `${year}-01-01` || period?.end?.slice(0, 10) !== `${year}-12-31`) return null;
  return routedTranslationFor(measureId, Number(year), env, manifests) ? Number(year) : null;
}

export function routedTranslationFor(
  measureId: string,
  year: number,
  env: Record<string, unknown> = process.env,
  manifests: { official: (id: string) => OfficialManifest | null; derived: (id: string) => OfficialManifest | null } = {
    official: loadOfficialManifest,
    derived: loadDerivedManifest,
  },
): OfficialManifest | null {
  if (!officialMeasureIds(env).has(measureId) || !derivedMeasureIds(env).has(measureId)) return null;
  const period = { start: `${year}-01-01`, end: `${year}-12-31` };
  const official = manifests.official(measureId);
  if (!official || effectivePeriodCovers(official, period) === true) return null;
  const translation = manifests.derived(measureId);
  return translation && effectivePeriodCovers(translation, period) === true ? translation : null;
}

/**
 * The officially routed measures that no logic covers for a calendar year: neither CMS's artifact nor a
 * routed translation declares that year, so a run would score it with another year's logic (the
 * prior-year warning). Pure over the env and the manifests, so CI can hold every deploy's lists to it.
 */
export function uncoveredRoutedMeasures(
  year: number,
  env: Record<string, unknown> = process.env,
  manifests: { official: (id: string) => OfficialManifest | null; derived: (id: string) => OfficialManifest | null } = {
    official: loadOfficialManifest,
    derived: loadDerivedManifest,
  },
): string[] {
  const period = { start: `${year}-01-01`, end: `${year}-12-31` };
  return [...officialMeasureIds(env)]
    .filter((id) => {
      const official = manifests.official(id);
      if (official && effectivePeriodCovers(official, period) === true) return false;
      return routedTranslationFor(id, year, env, manifests) === null;
    })
    .sort();
}

/**
 * The years a deployment must already cover on `today` (`YYYY-MM-DD`): its own, and from 1 October the
 * next, so the logic for a new performance year is in place a quarter before the year's first nightly.
 */
export function yearsToCover(today: string): number[] {
  const year = Number(today.slice(0, 4));
  return today.slice(5, 7) >= "10" ? [year, year + 1] : [year];
}
