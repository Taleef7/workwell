/**
 * Single source of truth for measure identity: MIPS Quality ID and CMS ID crosswalk.
 * Occupational/OSHA measures have no MIPS ID / CMS ID and return null identity.
 */
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { loadDerivedManifest, loadOfficialManifest, type OfficialManifest } from "../wiring/official-artifacts.ts";

export interface MeasureIdentity {
  cmsId: string;
  mipsQualityId: string | null;
  improvementNotation: "increase" | "decrease";
}

/**
 * The logic a measure routed to an official artifact ACTUALLY executes, as opposed to the QDM measure
 * the catalog row is named after (locked decision §4.3: no QDM identity over FHIR-executed counts).
 * `CMS125FHIR v1.0.000`, derived from `CMS125v14`, not `CMS125v14` itself.
 */
export interface ExecutedLogic {
  /** CMS's eCQM id for the FHIR artifact, e.g. "CMS125FHIR" (the manifest's `cmsId` with its prefix). */
  ecqmId: string;
  /** The artifact's own version, e.g. "1.0.000" — never the catalog's authoring version ("v1.0"). */
  version: string;
  /** CMS's release state for the content the artifact was vendored from; "unknown" for a repo not listed below. */
  status: "draft" | "unknown";
  /** A dated phrase for `status`, or null when it is unknown. */
  statusNote: string | null;
  /** The QDM measure (with its version) the FHIR artifact was derived from, e.g. "CMS125v14". */
  derivedFrom: string | null;
}

/**
 * A WorkWell translation this deployment routes for the year it covers (decision 3, 2026-10-02). It is
 * named by its own label and canonical, never by a CMS eCQM id (LOCKED §4.3); `derivedFrom` is the CMS
 * measure it was translated from, for provenance only. CMS's artifact (`executed`) still scores every
 * other year.
 */
export interface TranslationLogic {
  /** e.g. "WorkWell translation of CMS137v15". */
  label: string;
  /** WorkWell's own version, e.g. "ww-2027.1". */
  version: string;
  /** WorkWell's canonical, e.g. "urn:workwell:measure:cms137:translation". */
  url: string;
  /** The CMS measure it was translated from, e.g. "CMS137v15". */
  derivedFrom: string;
  /** The one calendar year it scores, e.g. "2027". */
  year: string;
}

export type MeasureIdentityPayload = MeasureIdentity & { executed?: ExecutedLogic; translation?: TranslationLogic };

/**
 * What CMS released each vendored content repository as. The manifest's own `status` is the FHIR
 * `Measure.status` the authoring tool stamped ("active"), which says nothing about whether CMS has
 * finalized the content, so it is not used. The 2025 repository holds the 2026 FHIR versions CMS posted
 * as drafts for public comment; a re-vendor from any other repository reads "unknown" until it is
 * listed here deliberately.
 */
const CONTENT_RELEASES: Readonly<Record<string, { status: "draft"; note: string }>> = {
  "cqframework/dqm-content-qicore-2025": { status: "draft", note: "posted for public comment Jan–Feb 2026" },
};

/** CMS's eCQM id as every served surface spells it: the manifests and the evidence store the bare `125FHIR`. */
export function ecqmIdOf(raw: string): string {
  const id = raw.trim();
  return /^CMS/i.test(id) ? id : `CMS${id}`;
}

interface CmsArtifactLineage {
  measureId: string;
  ecqmId: string;
  version: string;
  /** The QDM measure, with its version, the FHIR artifact was derived from. */
  derivedFrom: string;
  contentRepo: string;
  /** What the artifact computes, apart from its metadata (`scripts/artifact-logic.mjs`, #848). */
  logicSha256: string;
}

/**
 * Which QDM measure each vendored CMS FHIR artifact was derived from, pinned by the artifact's own sha
 * (the committed manifest's `sha256`, which every outcome records as `official.artifactSha256`).
 *
 * Neither the bundles nor the catalog can answer this for an old row: the bundles do not carry it, and
 * the catalog's `policyRef` moves when the catalog moves to a new year, which would relabel every 2026
 * row as derived from the 2027 measure. Versions are the 2026 performance-period eCQMs on the eCQI
 * Resource Center (the catalog's own ids), which is what `dqm-content-qicore-2025` drafted.
 *
 * A re-vendor ADDS an entry and never removes one (#848): the test that every committed manifest has an
 * entry fails until this table names the new sha, and an earlier sha stays so a row it scored keeps its
 * lineage. Each entry records its `logicSha256`, which is how `scoredByCurrentLogic` tells a metadata-only
 * re-vendor (same logic, CMS's identity carries over) from a change of logic (it does not).
 */
const DQM_2025 = "cqframework/dqm-content-qicore-2025";
const CMS_ARTIFACT_LINEAGE: Readonly<Record<string, CmsArtifactLineage>> = {
  // First vendoring (2026-07/08), retired by #848's re-vendor: only two Library profile claims changed.
  "sha256:c0d99a8ebda8941a1912d6938eb2648b42e8954937d46ea3801f3e71cdcb8552": { measureId: "cms122", ecqmId: "CMS122FHIR", version: "1.0.000", derivedFrom: "CMS122v14", contentRepo: DQM_2025, logicSha256: "sha256:6e4498b1815130957eb58f4ca2d74734e488bdc4a5a474df6d42ce9d0c072efb" },
  "sha256:97f737fa5262fca1fbb4620e10ce286f612b87b7de4c3fc06fdfe38dfb666ac8": { measureId: "cms125", ecqmId: "CMS125FHIR", version: "1.0.000", derivedFrom: "CMS125v14", contentRepo: DQM_2025, logicSha256: "sha256:67a0240f5e409b699512d9241611a8cebd1fa9fa4b85bc0841c92ee8c83e54ac" },
  "sha256:aab26d665b79bc91454640923472f294c77072e36be098f927a4301081d72629": { measureId: "cms130", ecqmId: "CMS130FHIR", version: "1.0.000", derivedFrom: "CMS130v14", contentRepo: DQM_2025, logicSha256: "sha256:816e944190763d813cf9136ae2701a7a907f4bc87a87d1a9caef7406224a7eab" },
  "sha256:01e9499c10b252636ea58805a9f913685dc867eec23bd586429520cc966f0a24": { measureId: "cms137", ecqmId: "CMS137FHIR", version: "1.0.000", derivedFrom: "CMS137v14", contentRepo: DQM_2025, logicSha256: "sha256:ed270232aa281109b7bca0d855b7ab9a4cc1b137a37209d47fa5812d888ac2f4" },
  "sha256:219b52a38363ac6968d47b0d51b6b45656da6b01a9a9d2496bd05aab25280eb4": { measureId: "cms138", ecqmId: "CMS138FHIR", version: "1.0.000", derivedFrom: "CMS138v14", contentRepo: DQM_2025, logicSha256: "sha256:bb0385c3095e8481db2b6ddfb3a7342ed97ad9b0158f468aca48813f8df2fb4a" },
  "sha256:ae317d0db4136e322900ff139982621d547f411d5b0e14fa75ad8fea9a53645e": { measureId: "cms165", ecqmId: "CMS165FHIR", version: "1.0.000", derivedFrom: "CMS165v14", contentRepo: DQM_2025, logicSha256: "sha256:1528701778cecfbf3451725a41486a19e0a887239d347db26cf0c08e0f183b7f" },
  "sha256:4d69acfa4b5bc6d7010ad89279b9d61be77470cc5e37f38f2357bae176e2f1ec": { measureId: "cms2", ecqmId: "CMS2FHIR", version: "1.0.000", derivedFrom: "CMS2v15", contentRepo: DQM_2025, logicSha256: "sha256:5d5964366110a3592ddc8cc47a1aa4d97d0b1fabe807ea196104a4ded46892ce" },
  "sha256:f114b6edf657db98b6a11b625aa3b5d43e55ab736b0067dda56eeb6f312fb970": { measureId: "cms68", ecqmId: "CMS68FHIR", version: "1.0.000", derivedFrom: "CMS68v15", contentRepo: DQM_2025, logicSha256: "sha256:25beef950e0422d294f58ea3214035fc4ebc93b972481421d0a5fe090ed6dede" },
  "sha256:a005f4527d70fdd7495b9d75ab03b5ab43f1146fcdad81cbfba7d81b7caf1dae": { measureId: "cms951", ecqmId: "CMS951FHIR", version: "1.0.000", derivedFrom: "CMS951v4", contentRepo: DQM_2025, logicSha256: "sha256:9c4050b44378d20d2ba5d0624c03d527ec6b158ca6c47a22406ac72798912099" },
  // Re-vendored for #848/#851 (2026-10-19): the same logic as above, two Library claims fewer.
  "sha256:6f3f25f64a1ca13351082ffba87170bfa3ae8035b71efc56dcc542740a89c948": { measureId: "cms122", ecqmId: "CMS122FHIR", version: "1.0.000", derivedFrom: "CMS122v14", contentRepo: DQM_2025, logicSha256: "sha256:6e4498b1815130957eb58f4ca2d74734e488bdc4a5a474df6d42ce9d0c072efb" },
  "sha256:bbda505db2343b678d26988d6ef7fc49fdc802e39d6ebbc34272325f91502683": { measureId: "cms125", ecqmId: "CMS125FHIR", version: "1.0.000", derivedFrom: "CMS125v14", contentRepo: DQM_2025, logicSha256: "sha256:67a0240f5e409b699512d9241611a8cebd1fa9fa4b85bc0841c92ee8c83e54ac" },
  "sha256:62917e957b3ceebfbc1c904b435f618c3547d36f4122db1748772d9ec5ec8f04": { measureId: "cms130", ecqmId: "CMS130FHIR", version: "1.0.000", derivedFrom: "CMS130v14", contentRepo: DQM_2025, logicSha256: "sha256:816e944190763d813cf9136ae2701a7a907f4bc87a87d1a9caef7406224a7eab" },
  "sha256:abd7c6bd4403c86e19506995748f2fbfc3401bfce98f0ae9bb7481c73e04ed0e": { measureId: "cms137", ecqmId: "CMS137FHIR", version: "1.0.000", derivedFrom: "CMS137v14", contentRepo: DQM_2025, logicSha256: "sha256:ed270232aa281109b7bca0d855b7ab9a4cc1b137a37209d47fa5812d888ac2f4" },
  "sha256:99dbece35fa7d27d4a75e5dd99f052812fe4e05a54c748f61f493a2fbcafaad8": { measureId: "cms138", ecqmId: "CMS138FHIR", version: "1.0.000", derivedFrom: "CMS138v14", contentRepo: DQM_2025, logicSha256: "sha256:bb0385c3095e8481db2b6ddfb3a7342ed97ad9b0158f468aca48813f8df2fb4a" },
  "sha256:3dd610fb84b7a593ab44f51d99303bc0d33d31bb99875fee41f20e4002219e1b": { measureId: "cms165", ecqmId: "CMS165FHIR", version: "1.0.000", derivedFrom: "CMS165v14", contentRepo: DQM_2025, logicSha256: "sha256:1528701778cecfbf3451725a41486a19e0a887239d347db26cf0c08e0f183b7f" },
  "sha256:15e7985c67f72c0ee15c3ef8ddf2a4ee182b53514f65f06b9cc11c12e63daffb": { measureId: "cms2", ecqmId: "CMS2FHIR", version: "1.0.000", derivedFrom: "CMS2v15", contentRepo: DQM_2025, logicSha256: "sha256:5d5964366110a3592ddc8cc47a1aa4d97d0b1fabe807ea196104a4ded46892ce" },
  "sha256:3f2de5db0bfb3ffe5973af3619daf0a25ef11bacb752a161b291cc40d99fb743": { measureId: "cms68", ecqmId: "CMS68FHIR", version: "1.0.000", derivedFrom: "CMS68v15", contentRepo: DQM_2025, logicSha256: "sha256:25beef950e0422d294f58ea3214035fc4ebc93b972481421d0a5fe090ed6dede" },
  "sha256:c0c8c634c8bee33fa659dd5f65866312a55c72add352ff5cdc8d9eea232af69e": { measureId: "cms951", ecqmId: "CMS951FHIR", version: "1.0.000", derivedFrom: "CMS951v4", contentRepo: DQM_2025, logicSha256: "sha256:9c4050b44378d20d2ba5d0624c03d527ec6b158ca6c47a22406ac72798912099" },
};

/**
 * True when the artifact a run recorded (`artifactSha256`) computed the same logic as `manifest`, the one
 * vendored now (#848): the same bytes; or an earlier vendoring of the same measure, pinned above, whose
 * `logicSha256` equals the current manifest's. A sha nobody pinned is never assumed equal, and a manifest
 * with no `logicSha256` (a translation) matches only its own bytes. The four export gates (QRDA I/III ids
 * and criteria, the MeasureReport canonical, the vintage note) ask this instead of "are the bytes equal",
 * so a metadata-only re-vendor no longer strips CMS's identity from every older run.
 */
export function scoredByCurrentLogic(
  manifest: Pick<OfficialManifest, "catalogId" | "sha256" | "logicSha256">,
  artifactSha256: string,
): boolean {
  if (artifactSha256 === manifest.sha256) return true;
  const earlier = Object.hasOwn(CMS_ARTIFACT_LINEAGE, artifactSha256) ? CMS_ARTIFACT_LINEAGE[artifactSha256] : undefined;
  return !!earlier && !!manifest.logicSha256 && earlier.measureId === manifest.catalogId && earlier.logicSha256 === manifest.logicSha256;
}

/** For the committed-manifest drift test only. */
export const CMS_ARTIFACT_LINEAGE_FOR_TEST = CMS_ARTIFACT_LINEAGE;

/**
 * The lineage of one CMS artifact: by its sha when the record carries one, otherwise by eCQM id and
 * version (rows written before `artifactSha256` was recorded), and only when exactly one pinned artifact
 * matches. `measureId`, when given, must be the measure the artifact is filed under: an artifact for
 * another measure under this id must not borrow a lineage.
 */
function cmsArtifactLineage(
  ref: { artifactSha256?: string | null; ecqmId?: string | null; version?: string | null },
  measureId?: string,
): CmsArtifactLineage | null {
  const bySha = ref.artifactSha256 ? CMS_ARTIFACT_LINEAGE[ref.artifactSha256] : undefined;
  const found = bySha ?? (() => {
    if (ref.artifactSha256 || !ref.ecqmId || !ref.version) return undefined;
    const ecqmId = ecqmIdOf(ref.ecqmId);
    const matches = Object.values(CMS_ARTIFACT_LINEAGE).filter((l) => l.ecqmId === ecqmId && l.version === ref.version);
    // Two vendorings of one artifact (#848) are one lineage, not an ambiguity: they agree on everything
    // the lineage says. Ambiguous only when the matches name different lineages.
    const lineages = new Set(matches.map((l) => `${l.measureId}|${l.derivedFrom}|${l.contentRepo}`));
    return lineages.size === 1 ? matches[0] : undefined;
  })();
  if (!found) return null;
  return measureId === undefined || found.measureId === measureId ? found : null;
}

/** Pure over a manifest, so a test can pin the mapping without the filesystem. */
export function executedLogicFromManifest(
  measureId: string,
  manifest: Pick<OfficialManifest, "cmsId" | "version" | "source"> & { sha256?: string },
): ExecutedLogic | null {
  if (!manifest.cmsId || !manifest.version) return null;
  const ecqmId = ecqmIdOf(manifest.cmsId);
  const release = CONTENT_RELEASES[manifest.source?.repo ?? ""];
  const lineage = cmsArtifactLineage({ artifactSha256: manifest.sha256, ecqmId, version: manifest.version }, measureId);
  return {
    ecqmId,
    version: manifest.version,
    status: release?.status ?? "unknown",
    statusNote: release?.note ?? null,
    derivedFrom: lineage && lineage.ecqmId === ecqmId && lineage.version === manifest.version ? lineage.derivedFrom : null,
  };
}

/**
 * The logic that scored ONE result, read from that result's own evidence (`evidence_json.official`),
 * never from today's routing: a row's provenance does not change because a flag or the catalog moved.
 * `workwell-translation` keeps the kind value the compliance API already serves.
 */
export type ScoringLogic =
  | {
      kind: "cms-artifact";
      /** "CMS125FHIR" */
      ecqmId: string;
      /** "1.0.000" */
      version: string;
      /** "CMS125v14", from the pinned lineage; null for an artifact not in it. */
      derivedFrom: string | null;
      status: "draft" | "unknown";
      statusNote: string | null;
    }
  | {
      kind: "workwell-translation";
      /** "WorkWell translation of CMS137v15" */
      label: string;
      /** "ww-2027.1" */
      version: string;
      url: string | null;
      /** "CMS137v15" */
      derivedFrom: string | null;
    };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Null for a row with no `official` block (authored logic), an errored row, or a block missing the
 * fields that name it. A translation never yields an eCQM id (LOCKED §4.3, DATA_MODEL §5).
 */
export function scoringLogicOf(evidence: unknown): ScoringLogic | null {
  const e = evidence as { official?: unknown; evaluationError?: unknown } | null | undefined;
  if (!e || typeof e !== "object" || e.evaluationError !== undefined) return null;
  const official = e.official as Record<string, unknown> | null | undefined;
  if (!official || typeof official !== "object") return null;
  const version = str(official.version);
  if (!version) return null;
  if (official.kind === "derived") {
    const label = str(official.label);
    if (!label) return null;
    return { kind: "workwell-translation", label, version, url: str(official.url), derivedFrom: str(official.derivedFrom) };
  }
  const rawId = str(official.ecqmId);
  if (!rawId) return null;
  const ecqmId = ecqmIdOf(rawId);
  const lineage = cmsArtifactLineage({ artifactSha256: str(official.artifactSha256), ecqmId, version });
  const release = lineage ? CONTENT_RELEASES[lineage.contentRepo] : undefined;
  return {
    kind: "cms-artifact",
    ecqmId,
    version,
    derivedFrom: lineage && lineage.ecqmId === ecqmId && lineage.version === version ? lineage.derivedFrom : null,
    status: release?.status ?? "unknown",
    statusNote: release?.note ?? null,
  };
}

/** "CMS125FHIR v1.0.000" or "WorkWell translation of CMS137v15 (ww-2027.1)"; null when nothing scored it by name. */
export function formatScoringLogic(logic: ScoringLogic | null | undefined): string | null {
  if (!logic) return null;
  return logic.kind === "workwell-translation" ? `${logic.label} (${logic.version})` : `${logic.ecqmId} v${logic.version}`;
}

/** The authored CQL library's version ("2.0.0"), or "" for a measure with no authored library. */
function authoredLibraryVersion(measureId: string): string {
  const lib = MEASURES[measureId]?.library ?? "";
  const dash = lib.lastIndexOf("-");
  return dash >= 0 ? lib.slice(dash + 1) : "";
}

/**
 * The version of the logic that scored a row. The evidence's version when CMS's artifact or a
 * translation scored it; "" for an errored row or a row of a measure with no authored library (nothing
 * scored it by name); the authored library's version only for a row authored CQL scored (true on TWH,
 * and on rows from before a measure was routed). Never the catalog record's "v1.0".
 */
export function measureVersionOf(measureId: string, evidence: unknown): string {
  const logic = scoringLogicOf(evidence);
  if (logic) return logic.version;
  const e = evidence as { official?: unknown; evaluationError?: unknown } | null | undefined;
  if (e && typeof e === "object" && (e.evaluationError !== undefined || e.official !== undefined)) return "";
  return authoredLibraryVersion(measureId);
}

/** The vendored artifact's executed-logic identity, or null when nothing is vendored under this id. */
export function executedLogicFor(measureId: string): ExecutedLogic | null {
  const manifest = loadOfficialManifest(measureId);
  return manifest ? executedLogicFromManifest(measureId, manifest) : null;
}

/** Pure over a translation's manifest; null unless it is one, covering exactly one calendar year. */
export function translationLogicFromManifest(
  manifest: Pick<OfficialManifest, "version" | "url" | "effectivePeriod" | "derived">,
): TranslationLogic | null {
  const derived = manifest.derived;
  const start = manifest.effectivePeriod?.start?.slice(0, 10);
  const end = manifest.effectivePeriod?.end?.slice(0, 10);
  if (!derived || !start || !end || start.slice(0, 4) !== end.slice(0, 4)) return null;
  return { label: derived.label, version: manifest.version, url: manifest.url, derivedFrom: derived.derivedFrom.ecqm, year: start.slice(0, 4) };
}

/** The committed translation's identity, or null when none is committed under this id. */
export function translationLogicFor(measureId: string): TranslationLogic | null {
  const manifest = loadDerivedManifest(measureId);
  return manifest ? translationLogicFromManifest(manifest) : null;
}

/**
 * The identity a read model serves: the crosswalk row, plus `executed` when the measure is routed to an
 * official artifact on this deployment, plus `translation` when a WorkWell translation is routed beside
 * it. The caller decides routing (it already classifies the measure), so this module stays free of
 * deployment configuration. An authored or not-yet-routed measure carries neither key; a translation is
 * never named without the official routing it rides on.
 */
export function measureIdentityPayloadFor(
  measureId: string,
  officialRouted: boolean,
  translationRouted = false,
  /** Injectable for tests, which supply their own translation rather than reading the committed one. */
  translationOf: (measureId: string) => TranslationLogic | null = translationLogicFor,
): MeasureIdentityPayload | null {
  const identity = measureIdentityFor(measureId);
  if (!identity) return null;
  const executed = officialRouted ? executedLogicFor(measureId) : null;
  const translation = officialRouted && translationRouted ? translationOf(measureId) : null;
  return { ...identity, ...(executed ? { executed } : {}), ...(translation ? { translation } : {}) };
}

type MeasureIdentityEntry = Omit<MeasureIdentity, "improvementNotation"> & { improvementNotation?: MeasureIdentity["improvementNotation"] };

export const MEASURE_IDENTITY: Record<string, MeasureIdentity> = Object.fromEntries(
  (
    [
      ["cms2", { cmsId: "CMS2", mipsQualityId: "134" }],
      ["cms128v14", { cmsId: "CMS128", mipsQualityId: "009" }],
      ["cms159v14", { cmsId: "CMS159", mipsQualityId: "370" }],
      ["cms177v14", { cmsId: "CMS177", mipsQualityId: "382" }],
      ["cms149v14", { cmsId: "CMS149", mipsQualityId: "281" }],
      ["cms136v15", { cmsId: "CMS136", mipsQualityId: "366" }],
      ["cms137", { cmsId: "CMS137", mipsQualityId: "305" }],
      ["cms22v14", { cmsId: "CMS22", mipsQualityId: "317" }],
      ["cms135v14", { cmsId: "CMS135", mipsQualityId: "005" }],
      ["cms144v14", { cmsId: "CMS144", mipsQualityId: "008" }],
      ["cms145v14", { cmsId: "CMS145", mipsQualityId: "007" }],
      ["cms165", { cmsId: "CMS165", mipsQualityId: "236" }],
      ["cms347v9", { cmsId: "CMS347", mipsQualityId: "438" }],
      ["cms90v15", { cmsId: "CMS90", mipsQualityId: "377" }],
      ["cms1173v1", { cmsId: "CMS1173", mipsQualityId: "514" }],
      ["cms122", { cmsId: "CMS122", mipsQualityId: "001", improvementNotation: "decrease" }],
      ["cms131v14", { cmsId: "CMS131", mipsQualityId: "117" }],
      ["cms142v14", { cmsId: "CMS142", mipsQualityId: "019" }],
      ["cms951v4", { cmsId: "CMS951", mipsQualityId: "488" }],
      ["cms1154v1", { cmsId: "CMS1154", mipsQualityId: "515" }],
      ["cms124v14", { cmsId: "CMS124", mipsQualityId: "309" }],
      ["cms125", { cmsId: "CMS125", mipsQualityId: "112" }],
      ["cms130", { cmsId: "CMS130", mipsQualityId: "113" }],
      ["cms69v14", { cmsId: "CMS69", mipsQualityId: "128" }],
      ["cms138v14", { cmsId: "CMS138", mipsQualityId: "226" }],
      ["cms139v14", { cmsId: "CMS139", mipsQualityId: "318" }],
      ["cms155v14", { cmsId: "CMS155", mipsQualityId: "239" }],
      ["cms153v14", { cmsId: "CMS153", mipsQualityId: "310" }],
      ["cms146v14", { cmsId: "CMS146", mipsQualityId: "066" }],
      ["cms154v14", { cmsId: "CMS154", mipsQualityId: "065" }],
      ["cms117v14", { cmsId: "CMS117", mipsQualityId: "240" }],
      ["cms74v15", { cmsId: "CMS74", mipsQualityId: "379" }],
      ["cms75v14", { cmsId: "CMS75", mipsQualityId: "378" }],
      ["cms314v3", { cmsId: "CMS314", mipsQualityId: "338" }],
      ["cms349v8", { cmsId: "CMS349", mipsQualityId: "475" }],
      ["cms1157v2", { cmsId: "CMS1157", mipsQualityId: "340" }],
      ["cms1188v3", { cmsId: "CMS1188", mipsQualityId: "205" }],
      ["cms129v15", { cmsId: "CMS129", mipsQualityId: "102" }],
      ["cms157v14", { cmsId: "CMS157", mipsQualityId: "143" }],
      ["cms646v6", { cmsId: "CMS646", mipsQualityId: "481" }],
      ["cms645v9", { cmsId: "CMS645", mipsQualityId: "462" }],
      ["cms133v14", { cmsId: "CMS133", mipsQualityId: "191" }],
      ["cms143v14", { cmsId: "CMS143", mipsQualityId: "012" }],
      ["cms56v14", { cmsId: "CMS56", mipsQualityId: "376" }],
      ["cms68v15", { cmsId: "CMS68", mipsQualityId: "130" }],
      ["cms156v14", { cmsId: "CMS156", mipsQualityId: "238" }],
      ["cms50v14", { cmsId: "CMS50", mipsQualityId: "374" }],
      ["cms771v7", { cmsId: "CMS771", mipsQualityId: "476" }],
      ["cms1056v3", { cmsId: "CMS1056", mipsQualityId: "494" }],
    ] satisfies Array<[string, MeasureIdentityEntry]>
  ).map(([id, identity]: [string, MeasureIdentityEntry]) => [
    id,
    { ...identity, improvementNotation: identity.improvementNotation ?? "increase" } as MeasureIdentity,
  ]),
);

export function measureIdentityFor(measureId: string): MeasureIdentity | null {
  return MEASURE_IDENTITY[measureId] ?? null;
}
