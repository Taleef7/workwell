/**
 * What a measure created in Studio may be called (item 13). A practice's own measure is calculated and
 * exported, but it must never be mistaken for a submittable CMS measure, so its name and policy reference
 * may not state a CMS eCQM id or a MIPS quality id, and its name may not repeat another measure's.
 *
 * The seeded catalog is not judged here: its CMS rows ARE the CMS crosswalk (LOCKED §4A.2) and keep their
 * names. Pure, so the rules are pinned without a store.
 */

/** "CMS125", "CMS125v14", "cms125FHIR": an eCQM id. "CMS-1500" (a claim form) and "CMS 2026" are not. */
const ECQM_ID = /\bCMS\d{1,4}(?:v\d+)?(?:FHIR)?\b/i;
/** "MIPS 112", "QID 112", "Quality ID #001": a three-digit MIPS quality id. "MIPS 2026" is not. */
const MIPS_QUALITY_ID = /\b(?:MIPS|QID|Quality\s*ID)\s*#?\s*\d{3}\b/i;

/** The CMS identity `text` states, as the author wrote it, or null when it states none. */
export function claimedCmsIdentity(text: string): string | null {
  return text.match(ECQM_ID)?.[0] ?? text.match(MIPS_QUALITY_ID)?.[0] ?? null;
}

/** Two measure names are the same name: trimmed, case-insensitive, inner spaces collapsed. */
export function sameMeasureName(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}

/** The 400 message for a field that states a CMS identity; null when it states none. */
export function cmsIdentityRefusal(field: "name" | "policyRef", text: string): string | null {
  const claimed = claimedCmsIdentity(text);
  return claimed
    ? `${field} states a CMS measure identity ("${claimed}"). A measure created in Studio is WorkWell's own, not a CMS measure, so it may not carry a CMS eCQM id or a MIPS quality id; describe what it is based on in the description instead.`
    : null;
}
