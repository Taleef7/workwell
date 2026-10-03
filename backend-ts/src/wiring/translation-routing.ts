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
