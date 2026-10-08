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
}

/**
 * Which QDM measure each vendored CMS FHIR artifact was derived from, pinned by the artifact's own sha
 * (the committed manifest's `sha256`, which every outcome records as `official.artifactSha256`).
 *
 * Neither the bundles nor the catalog can answer this for an old row: the bundles do not carry it, and
 * the catalog's `policyRef` moves when the catalog moves to a new year, which would relabel every 2026
 * row as derived from the 2027 measure. A re-vendor changes the sha, and the test that every committed
 * manifest has an entry fails until this table names it. Versions are the 2026 performance-period eCQMs
 * on the eCQI Resource Center (the catalog's own ids), which is what `dqm-content-qicore-2025` drafted.
 */
const CMS_ARTIFACT_LINEAGE: Readonly<Record<string, CmsArtifactLineage>> = {
  "sha256:c0d99a8ebda8941a1912d6938eb2648b42e8954937d46ea3801f3e71cdcb8552": { measureId: "cms122", ecqmId: "CMS122FHIR", version: "1.0.000", derivedFrom: "CMS122v14", contentRepo: "cqframework/dqm-content-qicore-2025" },
  "sha256:97f737fa5262fca1fbb4620e10ce286f612b87b7de4c3fc06fdfe38dfb666ac8": { measureId: "cms125", ecqmId: "CMS125FHIR", version: "1.0.000", derivedFrom: "CMS125v14", contentRepo: "cqframework/dqm-content-qicore-2025" },
  "sha256:aab26d665b79bc91454640923472f294c77072e36be098f927a4301081d72629": { measureId: "cms130", ecqmId: "CMS130FHIR", version: "1.0.000", derivedFrom: "CMS130v14", contentRepo: "cqframework/dqm-content-qicore-2025" },
  "sha256:01e9499c10b252636ea58805a9f913685dc867eec23bd586429520cc966f0a24": { measureId: "cms137", ecqmId: "CMS137FHIR", version: "1.0.000", derivedFrom: "CMS137v14", contentRepo: "cqframework/dqm-content-qicore-2025" },
  "sha256:219b52a38363ac6968d47b0d51b6b45656da6b01a9a9d2496bd05aab25280eb4": { measureId: "cms138", ecqmId: "CMS138FHIR", version: "1.0.000", derivedFrom: "CMS138v14", contentRepo: "cqframework/dqm-content-qicore-2025" },
  "sha256:ae317d0db4136e322900ff139982621d547f411d5b0e14fa75ad8fea9a53645e": { measureId: "cms165", ecqmId: "CMS165FHIR", version: "1.0.000", derivedFrom: "CMS165v14", contentRepo: "cqframework/dqm-content-qicore-2025" },
  "sha256:4d69acfa4b5bc6d7010ad89279b9d61be77470cc5e37f38f2357bae176e2f1ec": { measureId: "cms2", ecqmId: "CMS2FHIR", version: "1.0.000", derivedFrom: "CMS2v15", contentRepo: "cqframework/dqm-content-qicore-2025" },
  "sha256:f114b6edf657db98b6a11b625aa3b5d43e55ab736b0067dda56eeb6f312fb970": { measureId: "cms68", ecqmId: "CMS68FHIR", version: "1.0.000", derivedFrom: "CMS68v15", contentRepo: "cqframework/dqm-content-qicore-2025" },
  "sha256:a005f4527d70fdd7495b9d75ab03b5ab43f1146fcdad81cbfba7d81b7caf1dae": { measureId: "cms951", ecqmId: "CMS951FHIR", version: "1.0.000", derivedFrom: "CMS951v4", contentRepo: "cqframework/dqm-content-qicore-2025" },
};

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
    return matches.length === 1 ? matches[0] : undefined;
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
