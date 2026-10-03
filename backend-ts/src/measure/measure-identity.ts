/**
 * Single source of truth for measure identity: MIPS Quality ID and CMS ID crosswalk.
 * Occupational/OSHA measures have no MIPS ID / CMS ID and return null identity.
 */
import { MEASURE_CATALOG } from "./measure-catalog.ts";
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

/** `CMS125v14` from the catalog row, kept only when its number is the artifact's (`CMS125FHIR`). */
function derivedFromFor(measureId: string, ecqmId: string): string | null {
  const policyRef = MEASURE_CATALOG.find((m) => m.id === measureId)?.policyRef ?? "";
  const qdm = /^CMS(\d+)v\d+$/.exec(policyRef);
  const fhir = /^CMS(\d+)FHIR$/.exec(ecqmId);
  return qdm && fhir && qdm[1] === fhir[1] ? policyRef : null;
}

/** Pure over a manifest, so a test can pin the mapping without the filesystem. */
export function executedLogicFromManifest(
  measureId: string,
  manifest: Pick<OfficialManifest, "cmsId" | "version" | "source">,
): ExecutedLogic | null {
  if (!manifest.cmsId || !manifest.version) return null;
  const ecqmId = /^CMS/i.test(manifest.cmsId) ? manifest.cmsId : `CMS${manifest.cmsId}`;
  const release = CONTENT_RELEASES[manifest.source?.repo ?? ""];
  return {
    ecqmId,
    version: manifest.version,
    status: release?.status ?? "unknown",
    statusNote: release?.note ?? null,
    derivedFrom: derivedFromFor(measureId, ecqmId),
  };
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
export function measureIdentityPayloadFor(measureId: string, officialRouted: boolean, translationRouted = false): MeasureIdentityPayload | null {
  const identity = measureIdentityFor(measureId);
  if (!identity) return null;
  const executed = officialRouted ? executedLogicFor(measureId) : null;
  const translation = officialRouted && translationRouted ? translationLogicFor(measureId) : null;
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
