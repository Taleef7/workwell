/**
 * Vendored official measure artifacts (roadmap §7.4, PR-5).
 *
 * Reads `measures/official/<catalogId>/{bundle.json,manifest.json}` — the output of
 * `scripts/vendor-official-measure.mjs`. This is the app-side half of the split the executor package
 * defines: the package executes a bundle it is handed, and knowing where bundles live on disk (and what
 * provenance they carry) is the app's business.
 *
 * The convention replaces the hardcoded `cms122v14/CMS122FHIR-v0.5.000-FHIR.json` path and its
 * `OFFICIAL_CMS122` constant. That hardcoding *was* the staleness bug: the vendored artifact sat at
 * v0.5.000 while upstream moved to v1.0.000, and nothing could notice because the version was spelled
 * into a filename and a literal. Promotion is now a file swap plus a manifest, per measure.
 */
import { readFileSync } from "node:fs";
import { isExecutableMeasureBundle, type MeasureBundle } from "@workwell/official-executor";

export interface OfficialManifest {
  catalogId: string;
  measureName: string;
  version: string;
  cmsId: string | null;
  url: string;
  status: string;
  effectivePeriod: { start?: string; end?: string } | null;
  scoring: string | null;
  populationBasis: string | null;
  /**
   * As DECLARED by the artifact — never normalized here.
   *
   * Note for PR-7: CMS122's artifact declares `increase` even though the measure is inverse (its
   * numerator is poor glycemic control, so a lower rate is better and eCQI describes it as
   * decrease-is-improvement). Recording the declared value keeps the discrepancy visible instead of
   * silently resolving it during vendoring; deciding what an exported report should claim — and
   * whether to raise it upstream — is PR-7's call.
   */
  improvementNotation: string | null;
  populations: string[];
  source: { repo: string; ref: string; path: string; rawSha256: string };
  reduction: Record<string, unknown>;
  /**
   * The contract for the gitignored `terminology.json` sidecar (PR-8a). Optional in the TYPE because an
   * artifact vendored before PR-8a has no such block, and that must read as "unpinned, refuse to route"
   * rather than as a crash — `loadOfficialTerminology` turns its absence into exactly that sentence.
   */
  terminology?: {
    file: string;
    valueSets: number;
    codes: number;
    truncated: Array<{ oid: string; have: number; declaredTotal: number }>;
    /**
     * Present only when `vendor:official --complete-terminology` actually replaced a shortfall
     * upstream shipped (PR-9). Optional in the TYPE because an artifact vendored without the flag —
     * or one vendored before it existed — has no such block, and that must read as "nothing was
     * completed" rather than as a crash.
     *
     * The `manifest` field is the VSAC release the codes came from, and it is load-bearing rather
     * than decorative: re-expanding at a different release yields different codes, a different
     * terminology digest, and therefore a different `officialLogicVersion`. Recording it is what
     * makes the completion reproducible instead of merely repeatable.
     *
     * `reason` distinguishes the two things that get completed, and they are not equally evidenced
     * (ADR-053). A `capped` set was checked against upstream's own declared total AND against
     * containment of the codes upstream shipped. An `absent-upstream` set had neither check available
     * — upstream shipped nothing to contain and declared no total — so it is held only to VSAC's own
     * `expansion.total`, and its `declaredTotal` here is `null` rather than VSAC's number, because
     * this field means "what the bundle declared" and the bundle declared nothing. Optional in the
     * TYPE because artifacts completed before ADR-053 carry no `reason`; absent reads as `capped`,
     * which is what they all were.
     */
    completion?: {
      source: string;
      manifest: string;
      valueSets: Array<{
        oid: string;
        reason?: "capped" | "absent-upstream";
        had: number;
        now: number;
        declaredTotal: number | null;
      }>;
    };
    sha256: string;
  };
  sha256: string;
}

export interface OfficialArtifact {
  manifest: OfficialManifest;
  bundle: MeasureBundle;
}


/**
 * The eMeasure identifiers QRDA III references a measure by (ADR-046, corrected after review of #357).
 *
 * `manifest.cmsId` is the **publisher** identifier — `"122FHIR"` for CMS122 — and QRDA III's
 * `externalDocument/id` is not that. The published Measure carries the two identifiers a receiver
 * actually resolves, typed by `artifact-identifier-type`:
 *
 *   - **version-specific** → `id/@extension` under root `2.16.840.1.113883.4.738` (the eMeasure
 *     Identifier OID). This names the exact published version whose logic produced the counts.
 *   - **version-independent** → `setId/@root`, the measure's identity across versions.
 *
 * Read from the vendored bundle rather than the manifest so no re-vendor (and no reproducibility-gate
 * churn) is needed: the bundle IS the published artifact, and these values are part of it.
 */
export interface OfficialMeasureIdentifiers {
  versionSpecific?: string;
  versionIndependent?: string;
}

/** Strip the `urn:uuid:` prefix MADiE writes — QRDA carries the bare GUID. */
const bareUuid = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.replace(/^urn:uuid:/i, "") : undefined;
};

export function officialMeasureIdentifiers(artifact: OfficialArtifact): OfficialMeasureIdentifiers {
  const entries = (artifact.bundle as { entry?: Array<{ resource?: Record<string, unknown> }> }).entry ?? [];
  const measure = entries.map((e) => e.resource).find((r) => r?.["resourceType"] === "Measure");
  const identifiers = (measure?.["identifier"] as Array<Record<string, unknown>> | undefined) ?? [];
  const byType = (code: string): string | undefined => {
    for (const id of identifiers) {
      const coding = ((id["type"] as { coding?: Array<{ code?: unknown }> } | undefined)?.coding ?? [])[0];
      if (coding?.code === code) return bareUuid(id["value"]);
    }
    return undefined;
  };
  const versionSpecific = byType("version-specific");
  const versionIndependent = byType("version-independent");
  return {
    ...(versionSpecific ? { versionSpecific } : {}),
    ...(versionIndependent ? { versionIndependent } : {}),
  };
}

const ARTIFACT_ROOT = new URL("../../measures/official/", import.meta.url);

/**
 * `new URL()` normalizes `..`, so an unvalidated id escapes the artifact root ("../../etc/passwd"
 * resolves outside `measures/official/`). Harmless while every id is a literal, but PR-7 makes the id
 * set operator-supplied via `WORKWELL_OFFICIAL_MEASURES` — validate now, while it is cheap.
 */
const VALID_CATALOG_ID = /^[a-z0-9]+$/;

/** Parsed artifacts are cached: the files are committed and immutable for the life of the process. */
const cache = new Map<string, OfficialArtifact | null>();

/**
 * Load a vendored artifact, or `null` when it is absent or unusable — a missing artifact is a normal
 * state (only some measures are vendored), and the fidelity route degrades to a lower tier rather than
 * failing. A bundle that IS present but has no pre-compiled ELM is treated the same way: it cannot be
 * executed without translation, which is the thing this whole path exists to avoid.
 */
export function loadOfficialArtifact(catalogId: string): OfficialArtifact | null {
  const cached = cache.get(catalogId);
  if (cached !== undefined) return cached;

  if (!VALID_CATALOG_ID.test(catalogId)) return null;

  let artifact: OfficialArtifact | null = null;
  try {
    const manifest = JSON.parse(
      readFileSync(new URL(`${catalogId}/manifest.json`, ARTIFACT_ROOT), "utf8"),
    ) as OfficialManifest;
    const bundle = JSON.parse(readFileSync(new URL(`${catalogId}/bundle.json`, ARTIFACT_ROOT), "utf8"));
    artifact = isExecutableMeasureBundle(bundle) ? { manifest, bundle } : null;
    if (!artifact) {
      console.error(
        `WORKWELL_ALERT ${JSON.stringify({ kind: "OFFICIAL_ARTIFACT_UNUSABLE", catalogId, reason: "bundle has no pre-compiled ELM" })}`,
      );
    }
  } catch (err) {
    // "Not vendored" and "the read failed" are different facts, and caching them the same way is how a
    // transient failure becomes permanent: PR-7 routes production measure execution through here, so a
    // cached null would silently fall back to the authored CQL for the life of the worker — two
    // containers could then report different results for the same measure with no signal anywhere.
    const absent = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    if (!absent) {
      console.error(
        `WORKWELL_ALERT ${JSON.stringify({
          kind: "OFFICIAL_ARTIFACT_LOAD_FAILED",
          catalogId,
          message: err instanceof Error ? err.message : String(err),
        })}`,
      );
      return null; // deliberately NOT cached — a retry may succeed.
    }
    artifact = null;
  }
  cache.set(catalogId, artifact);
  return artifact;
}

/** True when this measure has a vendored artifact that can actually be executed. */
export function officialArtifactAvailable(catalogId: string): boolean {
  return loadOfficialArtifact(catalogId) !== null;
}

/** @internal test hook */
export function __clearOfficialArtifactCache(): void {
  cache.clear();
}
