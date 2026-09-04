/**
 * Single source of truth for measure identity: MIPS Quality ID and CMS ID crosswalk.
 * Occupational/OSHA measures have no MIPS ID / CMS ID and return null identity.
 */

export interface MeasureIdentity {
  cmsId: string;
  mipsQualityId: string | null;
  improvementNotation: "increase" | "decrease";
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
      ["cms137v14", { cmsId: "CMS137", mipsQualityId: "305" }],
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
