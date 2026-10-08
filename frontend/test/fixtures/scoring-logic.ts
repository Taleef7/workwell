import type { ExecutedLogic, ScoringLogic } from "@/lib/measure-identity";

/**
 * The logic that scored one result (#769), as the backend serves it, plus today's routing for the same
 * measures. Kept together so a test can make routing and the row DISAGREE: a surface that reads
 * `identity.executed` instead of the row's `logic` then renders the wrong label and fails.
 */

/** CMS's 2026 FHIR draft scored the row. */
export const CMS125_ARTIFACT: ScoringLogic = {
  kind: "cms-artifact",
  ecqmId: "CMS125FHIR",
  version: "1.0.000",
  derivedFrom: "CMS125v14",
  status: "draft",
  statusNote: "posted for public comment Jan–Feb 2026",
};

export const CMS137_ARTIFACT: ScoringLogic = {
  kind: "cms-artifact",
  ecqmId: "CMS137FHIR",
  version: "1.0.000",
  derivedFrom: "CMS137v14",
  status: "draft",
  statusNote: "posted for public comment Jan–Feb 2026",
};

/** WorkWell's translation scored the row (2027). */
export const CMS137_TRANSLATION: ScoringLogic = {
  kind: "workwell-translation",
  label: "WorkWell translation of CMS137v15",
  version: "ww-2027.1",
  url: "urn:workwell:measure:cms137:translation",
  derivedFrom: "CMS137v15",
};

/** Today's routing: what `/api/measures` says the measure runs. Never what a row's badge reads. */
export const CMS125_EXECUTED: ExecutedLogic = {
  ecqmId: "CMS125FHIR",
  version: "1.0.000",
  status: "draft",
  statusNote: "posted for public comment Jan–Feb 2026",
  derivedFrom: "CMS125v14",
};

export const CMS137_EXECUTED: ExecutedLogic = {
  ecqmId: "CMS137FHIR",
  version: "1.0.000",
  status: "draft",
  statusNote: "posted for public comment Jan–Feb 2026",
  derivedFrom: "CMS137v14",
};

/** `/api/measures` rows whose identity carries today's routing (`executed`). */
export const ROUTED_IDENTITIES = {
  cms125: { cmsId: "CMS125", mipsQualityId: "112", executed: CMS125_EXECUTED },
  cms137: { cmsId: "CMS137", mipsQualityId: "305", executed: CMS137_EXECUTED },
} as const;

/** The strings each form renders, pinned whole (a substring like "MIPS 112 · CMS125" matches all of them). */
export const LABELS = {
  cms125Plain: "MIPS 112 · CMS125",
  cms125Full: "MIPS 112 · CMS125FHIR v1.0.000 (from CMS125v14)",
  cms125Short: "MIPS 112 · CMS125FHIR (from CMS125v14)",
  cms125Title: "MIPS 112 · CMS125FHIR v1.0.000 (from CMS125v14), a CMS draft",
  cms137Plain: "MIPS 305 · CMS137",
  cms137ArtifactFull: "MIPS 305 · CMS137FHIR v1.0.000 (from CMS137v14)",
  cms137ArtifactShort: "MIPS 305 · CMS137FHIR (from CMS137v14)",
  cms137TranslationFull: "MIPS 305 · WorkWell translation of CMS137v15 (ww-2027.1)",
  cms137TranslationShort: "MIPS 305 · WW translation of CMS137v15",
  cms137TranslationTitle: "MIPS 305 · WorkWell translation of CMS137v15 (ww-2027.1), not a CMS measure",
} as const;
