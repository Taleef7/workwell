/**
 * The two measures a patient message never names (the server's `case/care-item.ts`, Q1): CMS2
 * (depression screening and follow-up) and CMS137 (substance use treatment), whose names disclose a
 * condition. The patient page leaves their gaps unticked until a staff member chooses them (#868); the
 * server then names them only as "a visit with your care team". A test pins this list to the server's.
 */
export const SENSITIVE_MEASURES: ReadonlySet<string> = new Set(['cms2', 'cms137']);

/** A measure id as the server keys it: lower case, without a CMS version suffix (`CMS137v14` -> `cms137`). */
function measureKey(measureId: string): string {
  const id = measureId.trim().toLowerCase();
  return /^cms\d+v\d+$/.test(id) ? id.replace(/v\d+$/, '') : id;
}

export function isSensitiveMeasure(measureId: string): boolean {
  return SENSITIVE_MEASURES.has(measureKey(measureId));
}
