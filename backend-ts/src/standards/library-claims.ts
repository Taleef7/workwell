/**
 * The profile claims a Library WorkWell rewrote still meets (#848).
 *
 * CMS's Libraries claim `cql-library`, `elm-xml-library` and `crmi-publishablelibrary`. A translation's
 * main and changed libraries carry ELM JSON only and lose CMS's publication `date`, so those claims become
 * false the moment WorkWell rewrites them (the HL7 validator reports clb-1, exl-1 and the missing date).
 * Shared by `derived-identity.ts` (the main library) and `derived-changed-library.ts` (an edited one), so
 * the two can never drop different claims.
 */

/** The Library profiles that each assert one content type (CQL IG: clb-1, exl-1, ejl-1). */
export const LIBRARY_CONTENT_PROFILES: Readonly<Record<string, string>> = {
  "http://hl7.org/fhir/uv/cql/StructureDefinition/cql-library": "text/cql",
  "http://hl7.org/fhir/uv/cql/StructureDefinition/elm-xml-library": "application/elm+xml",
  "http://hl7.org/fhir/uv/cql/StructureDefinition/elm-json-library": "application/elm+json",
};

export const PUBLISHABLE_LIBRARY = "http://hl7.org/fhir/uv/crmi/StructureDefinition/crmi-publishablelibrary";

/**
 * Drop, in place, a content profile whose content type the library does not carry, and
 * `crmi-publishablelibrary` once it has no `date`. Every other claim is kept as CMS wrote it.
 */
export function dropUnmetLibraryClaims(library: Record<string, unknown>): void {
  const meta = library["meta"] as { profile?: string[] } | undefined;
  if (!meta?.profile) return;
  const types = ((library["content"] as Array<{ contentType?: unknown }> | undefined) ?? []).map((c) => c.contentType);
  meta.profile = meta.profile.filter((profile) => {
    const needs = LIBRARY_CONTENT_PROFILES[profile];
    if (needs && !types.includes(needs)) return false;
    return !(profile === PUBLISHABLE_LIBRARY && typeof library["date"] !== "string");
  });
}
