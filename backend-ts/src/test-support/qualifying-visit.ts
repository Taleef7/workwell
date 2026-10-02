/**
 * A qualifying office visit (CPT 99213) as TEST DATA, for WebChart fixtures that carry no Encounter.
 *
 * The committed dev-DB sample has no encounters, so CMS125's initial population admits nobody in it.
 * Tests that probe something else (sex mapping, the mammography numerator, the authored age gate) need
 * patients inside that population, and add this visit themselves. Ingest never does: until 2026-10-02 the
 * enrollment roster stamped this exact resource on live data, which was a made-up clinical fact. One
 * helper, so every test adds the same visit.
 *
 * Dated 2024-03-03, 90 days before the fixtures' evaluation date of 2024-06-01, so it falls inside the
 * measurement period those tests use.
 */
export function testQualifyingVisit(patientId: string): Record<string, unknown> {
  return {
    resourceType: "Encounter",
    meta: { profile: ["http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-encounter"] },
    id: `${patientId}-test-visit`,
    status: "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: `Patient/${patientId}` },
    type: [{ coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "99213", display: "Office visit, established patient" }] }],
    period: { start: "2024-03-03T09:00:00", end: "2024-03-03T09:30:00" },
  };
}

/** A copy of `bundle` with the test visit appended for its Patient; the input is never mutated. */
export function withTestQualifyingVisit(bundle: unknown): unknown {
  const entry = (bundle as { entry?: Array<{ resource?: Record<string, unknown> }> }).entry ?? [];
  const patientId = entry.find((e) => e.resource?.["resourceType"] === "Patient")?.resource?.["id"];
  if (typeof patientId !== "string") return bundle;
  const copy = JSON.parse(JSON.stringify(bundle)) as { entry: Array<{ resource: unknown }> };
  copy.entry.push({ resource: testQualifyingVisit(patientId) });
  return copy;
}
