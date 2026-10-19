/**
 * Runs a measure bundle's own `QICoreCommon.prevalenceInterval` on three Conditions (cqframework/
 * clinical_quality_language#1871). The engine and the FHIR data provider are parameters, so the same
 * check can be pointed at another cql-execution to show what an upgrade would change.
 *
 * The bug: the translator compiles `abatementInterval`'s final `else null` into an interval with closed
 * null bounds. cql-execution 3.3.2 still returns null for a resolved Condition with no abatement date
 * (never prevalent, as the CQL intends); 4.0.0-beta.1 returns `[onset, 9999-12-31]` (prevalent forever).
 */

/** The three cases and what the CQL intends for each, as of 2026-07-01. */
export const PREVALENCE_CASES = [
  { id: "active-no-abatement", status: "active", abatement: undefined, prevalentOn20260701: true },
  { id: "resolved-no-abatement", status: "resolved", abatement: undefined, prevalentOn20260701: null },
  { id: "resolved-abated-2021", status: "resolved", abatement: "2021-06-01T00:00:00.000Z", prevalentOn20260701: false },
] as const;

interface ElmLibrary { library: { identifier: { id: string; version?: string } } }
type Bundle = { entry: Array<{ resource: { resourceType: string; content?: Array<{ contentType: string; data?: string }> } }> };

/** The bundle's ELM libraries, keyed by id. */
export function bundleElm(bundle: Bundle): Map<string, ElmLibrary> {
  const out = new Map<string, ElmLibrary>();
  for (const { resource } of bundle.entry) {
    if (resource.resourceType !== "Library") continue;
    const json = resource.content?.find((c) => c.contentType === "application/elm+json")?.data;
    if (!json) continue;
    const elm = JSON.parse(Buffer.from(json, "base64").toString("utf8")) as ElmLibrary;
    out.set(elm.library.identifier.id, elm);
  }
  return out;
}

/**
 * For each case: whether `prevalenceInterval()` contains 2026-07-01, or `null` when the interval itself is
 * null (never prevalent).
 */
export async function prevalenceOn20260701(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cql: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cqlfhir: any,
  libraries: Map<string, ElmLibrary>,
): Promise<Record<string, boolean | null>> {
  const qcc = libraries.get("QICoreCommon");
  const fh = libraries.get("FHIRHelpers");
  if (!qcc || !fh) throw new Error("the bundle carries no QICoreCommon/FHIRHelpers ELM");
  const harness = {
    library: {
      identifier: { id: "PrevalenceHarness", version: "0.0.1" },
      schemaIdentifier: { id: "urn:hl7-org:elm", version: "r1" },
      usings: { def: [
        { localIdentifier: "System", uri: "urn:hl7-org:elm-types:r1" },
        { localIdentifier: "QICore", uri: "http://hl7.org/fhir", version: "6.0.0" },
      ] },
      includes: { def: [
        { localIdentifier: "QICoreCommon", path: "QICoreCommon", version: qcc.library.identifier.version },
        { localIdentifier: "FHIRHelpers", path: "FHIRHelpers", version: fh.library.identifier.version },
      ] },
      contexts: { def: [{ name: "Patient" }] },
      statements: { def: [
        { name: "Patient", context: "Patient", expression: { type: "SingletonFrom", operand: { dataType: "{http://hl7.org/fhir}Patient", type: "Retrieve" } } },
        { name: "Prevalence", context: "Patient", accessLevel: "Public", expression: {
          type: "Query",
          source: [{ alias: "C", expression: { dataType: "{http://hl7.org/fhir}Condition", type: "Retrieve" } }],
          relationship: [],
          return: { expression: { type: "Tuple", element: [
            { name: "id", value: { path: "id", type: "Property", source: { name: "C", type: "AliasRef" } } },
            { name: "interval", value: { name: "prevalenceInterval", libraryName: "QICoreCommon", type: "FunctionRef", operand: [{ name: "C", type: "AliasRef" }] } },
          ] } },
        } },
      ] },
    },
  };
  const repository = new cql.Repository({ PrevalenceHarness: harness, ...Object.fromEntries(libraries) });
  const status = (code: string) => ({ coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code }] });
  const source = cqlfhir.PatientSource.FHIRv401();
  source.loadBundles([{ resourceType: "Bundle", type: "collection", entry: [
    { resource: { resourceType: "Patient", id: "p", birthDate: "1960-01-01" } },
    ...PREVALENCE_CASES.map((c) => ({ resource: {
      resourceType: "Condition", id: c.id, subject: { reference: "Patient/p" }, clinicalStatus: status(c.status),
      onsetDateTime: "2020-01-01T00:00:00.000Z", ...(c.abatement ? { abatementDateTime: c.abatement } : {}),
    } })),
  ] }]);
  const results = await new cql.Executor(repository.resolve("PrevalenceHarness", "0.0.1"), new cql.CodeService({})).exec(source);
  const rows = (Object.values(results.patientResults)[0] as { Prevalence: Array<{ id: unknown; interval: { contains(d: unknown): boolean | null } | null }> }).Prevalence;
  const july = cql.DateTime.parse("2026-07-01T00:00:00.000+00:00");
  const out: Record<string, boolean | null> = {};
  for (const row of rows) {
    const id = String((row.id as { value?: unknown } | null)?.value ?? row.id);
    out[id] = row.interval == null ? null : row.interval.contains(july);
  }
  return out;
}
