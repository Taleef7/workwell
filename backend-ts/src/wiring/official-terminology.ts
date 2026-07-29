/**
 * The OFFICIAL terminology for a vendored measure artifact (roadmap §7.3, §7.4 PR-8a).
 *
 * ## Why this exists — the gap it closes
 *
 * PR-6a stripped ValueSets out of `bundle.json` because their expansions carry thousands of AMA CPT and
 * SNOMED CT codes and this repo is public. PR-7a then filled the hole by expanding from our imported
 * VSAC `value_sets` rows at runtime. Individually reasonable; together they split terminology into two
 * authorities:
 *
 * - the MADiE gate (`official-cases.ts`) validated the artifact against the **bundle's own** expansions,
 * - the runtime expanded from **VSAC store rows**, which no gate had ever executed.
 *
 * So 121/121 green proved nothing about the path production would take, which is the one thing that gate
 * exists to do. The approved plan had already ruled this out: *"bundle-shipped expansions PRIMARY,
 * VSAC-patched at VENDOR time, no runtime fallback. Runtime never mixes two terminology authorities."*
 *
 * ## The resolution: fetched at build, pinned by hash
 *
 * `scripts/vendor-official-measure.mjs` writes the artifact's own expansions — same upstream commit as
 * the ELM — to a **gitignored** `terminology.json` beside the bundle, and records that file's SHA-256 in
 * the **committed** manifest. Nothing licensed is redistributed, and the bytes are still pinned: a
 * regenerated sidecar either hashes identically or is refused here. It is the same fetch-not-vendor
 * pattern `.official-content/` already uses for the test deck.
 *
 * The consequence worth stating plainly: a fresh clone has no sidecar, so official routing refuses until
 * `pnpm vendor:official` has run. That is the correct failure — the alternative is evaluating a measure
 * with terminology nobody validated.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
// Through the adapter, not from the package directly. Same reasoning as `oidFromValueSetUrl`: every
// direct importer is another door to fqm-execution that the boundary test has to keep deliberately
// open, and this module needs one type.
import { oidFromValueSetUrl, type ExpandedCode } from "./official-executor-adapter.ts";
import type { OfficialArtifact } from "./official-artifacts.ts";

const TERMINOLOGY_ROOT = new URL("../../measures/official/", import.meta.url);
const VALID_CATALOG_ID = /^[a-z0-9]+$/;

/** One value set as the artifact's own bundle expanded it, at the pinned commit. */
export interface OfficialValueSet {
  oid: string;
  url: string;
  version?: string;
  /** `expansion.total` as upstream declared it — greater than `codes.length` means VSAC capped it. */
  declaredTotal: number;
  codes: ExpandedCode[];
}

export interface OfficialTerminologyFile {
  catalogId: string;
  source: { repo: string; ref: string; measure: string };
  valueSets: OfficialValueSet[];
}

export type LoadedTerminology =
  | { ok: true; codesByOid: Map<string, ExpandedCode[]> }
  | { ok: false; problem: string };

const cache = new Map<string, LoadedTerminology>();

/**
 * Load and verify one measure's terminology sidecar.
 *
 * Every failure returns a sentence rather than throwing, because the caller that matters is
 * `officialRoutingProblems` — it reports all misconfigurations at once at boot, and an exception from
 * the middle of that loop would hide the rest of them.
 */
export function loadOfficialTerminology(artifact: OfficialArtifact): LoadedTerminology {
  const catalogId = artifact.manifest.catalogId;
  const cached = cache.get(catalogId);
  if (cached) return cached;

  const result = readTerminology(artifact);
  // Only successes are cached. A failure is usually "the build step has not run yet", and caching that
  // would keep refusing after it does — the same reasoning `loadOfficialArtifact` applies to read errors.
  if (result.ok) cache.set(catalogId, result);
  return result;
}

function readTerminology(artifact: OfficialArtifact): LoadedTerminology {
  const catalogId = artifact.manifest.catalogId;
  const pin = artifact.manifest.terminology;
  if (!pin?.sha256) {
    return {
      ok: false,
      problem:
        `${catalogId}: the vendored manifest records no terminology pin, so no sidecar can be ` +
        `verified against it. Re-vendor with 'pnpm vendor:official' to regenerate both.`,
    };
  }
  // A catalogId reaching a filesystem path — same escape the artifact loader guards, same reason.
  if (!VALID_CATALOG_ID.test(catalogId)) {
    return { ok: false, problem: `${catalogId}: not a valid catalog id` };
  }

  let raw: string;
  try {
    raw = readFileSync(new URL(`${catalogId}/${pin.file}`, TERMINOLOGY_ROOT), "utf8");
  } catch (err) {
    const absent = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    return {
      ok: false,
      problem: absent
        ? `${catalogId}: official terminology is not present (measures/official/${catalogId}/${pin.file}). ` +
          `It is fetched at build, never committed — run 'pnpm vendor:official' for this measure. ` +
          `Note this is NOT what 'pnpm resolve-valuesets' produces: official execution uses the ` +
          `artifact's own expansions, not our VSAC import.`
        : `${catalogId}: official terminology could not be read — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return verifyTerminology(catalogId, pin.sha256, raw);
}

/**
 * Verify a sidecar's bytes against the manifest pin and index them by OID.
 *
 * Separated from the filesystem read so the interesting half — hashing, parsing, shape — is testable
 * without a fixture directory inside `measures/official/`, which is exactly the kind of test litter that
 * outlives the test that made it.
 */
export function verifyTerminology(catalogId: string, expectedSha: string, raw: string): LoadedTerminology {
  const actual = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  if (actual !== expectedSha) {
    return {
      ok: false,
      problem:
        `${catalogId}: official terminology does not match the pin in its manifest ` +
        `(expected ${expectedSha}, found ${actual}). The sidecar and the ELM must come from the same ` +
        `upstream commit — regenerate both with 'pnpm vendor:official'.`,
    };
  }

  let parsed: OfficialTerminologyFile;
  try {
    parsed = JSON.parse(raw) as OfficialTerminologyFile;
  } catch (err) {
    return { ok: false, problem: `${catalogId}: official terminology is not valid JSON — ${String(err)}` };
  }
  if (!Array.isArray(parsed.valueSets)) {
    return { ok: false, problem: `${catalogId}: official terminology has no valueSets array` };
  }

  const codesByOid = new Map<string, ExpandedCode[]>();
  for (const valueSet of parsed.valueSets) {
    if (!Array.isArray(valueSet?.codes)) continue;
    const codes = valueSet.codes.map((code) => ({ system: code.system, code: code.code }));
    // Keyed by re-deriving the OID from the canonical with the PACKAGE's rule — the same
    // `oidFromValueSetUrl` that `buildValueSetCache` will look up by — rather than trusting the `oid`
    // the vendor script wrote with its own copy of that rule. Two normalizations that merely agree on
    // VSAC canonicals is a bug waiting for the first canonical of another shape, and here the two
    // sides are keys and lookups: a divergence means every lookup misses. It fails closed (the
    // expansion refusal fires), but "fails closed" is a worse answer than "cannot diverge".
    if (typeof valueSet.url === "string") codesByOid.set(oidFromValueSetUrl(valueSet.url), codes);
    else if (typeof valueSet.oid === "string") codesByOid.set(valueSet.oid, codes);
  }
  return { ok: true, codesByOid };
}

/**
 * An expander over the artifacts' own terminology, keyed by catalog id.
 *
 * Keyed by MEASURE and not by a single flat OID map on purpose. CMS122 and CMS125 share 23 of their
 * canonicals today, so a flat map would work — right up until two artifacts are pinned at different
 * upstream commits and disagree about one expansion, at which point whichever loaded first would
 * silently win for both. The sidecar belongs to the artifact; so does the lookup.
 *
 * Returns `[]` for an unexpandable OID rather than throwing: `expandArtifactTerminology` treats both
 * identically (its refusal fires either way), and a sentence-per-problem beats an exception when the
 * router is trying to report every misconfiguration at once.
 */
export function officialTerminologyExpander(
  artifactFor: (catalogId: string) => OfficialArtifact | null,
): (oid: string, catalogId: string) => Promise<ExpandedCode[]> {
  return async (oid, catalogId) => {
    const artifact = artifactFor(catalogId);
    if (!artifact) return [];
    const loaded = loadOfficialTerminology(artifact);
    return loaded.ok ? (loaded.codesByOid.get(oid) ?? []) : [];
  };
}

/**
 * Capped expansions the manifest recorded, restricted to the ones this measure's ELM actually
 * retrieves. `officialRoutingProblems` REFUSES on a non-empty result.
 *
 * This is the failure one notch weaker than the empty-set case, and the more dangerous for it. Upstream
 * ships every expansion truncated at 1000 codes as a matter of licensing policy, not because VSAC is
 * limited; `expandArtifactTerminology` refuses only on *empty*, so a 50%
 * expanded set sails through preflight. `AdvancedIllness` was exactly that (1000 of 1997) until ADR-041
 * completed it at vendor time, and it feeds
 * the 66+/advanced-illness denominator exclusion in BOTH vendored measures — so routing with it capped
 * would leave excluded subjects in the denominator and score them, producing a wrong regulatory rate
 * with no signal anywhere. Recording it was never enough; the guard has to be able to say no.
 *
 * Filtered by what the ELM references so a capped set the measure never retrieves cannot block it.
 */
export function cappedExpansions(
  artifact: OfficialArtifact,
  referencedOids: string[],
): Array<{ oid: string; have: number; declaredTotal: number }> {
  const referenced = new Set(referencedOids);
  return (artifact.manifest.terminology?.truncated ?? []).filter((cap) => referenced.has(cap.oid));
}

/** @internal test hook */
export function __clearOfficialTerminologyCache(): void {
  cache.clear();
}
