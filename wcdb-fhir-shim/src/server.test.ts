/**
 * server.test.ts — HTTP-layer tests over a STUBBED ShimDb (no Docker, no MariaDB — CI-safe).
 * The live 56-patient acceptance runs separately via backend-ts's `hapi-live.test.ts` pointed
 * at a running shim (see README).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { ObservationRow, PatientRow, ProcedureRow, ShimDb } from "./db.ts";
import { createShimServer } from "./server.ts";
import { patIdFromSubjectId, subjectIdFor, cptSystem } from "./fhir-mapping.ts";

const PATIENTS: PatientRow[] = [
  { pat_id: 5, first_name: "Jane", last_name: "Doe", sex: "F", birth_date: "1947-05-09" },
  { pat_id: 7, first_name: "Al", last_name: "Smith", sex: "M", birth_date: "1980-01-02" },
  { pat_id: 9, first_name: null, last_name: null, sex: null, birth_date: null },
];
const OBS: Record<number, ObservationRow[]> = {
  5: [
    { pat_id: 5, loinc: "8480-6", name: "Systolic BP", value: 128, dt: "2024-03-01" },
    { pat_id: 5, loinc: "8480-6", name: "Systolic BP", value: 131, dt: "2024-05-01" },
  ],
};
const PROCS: Record<number, ProcedureRow[]> = {
  5: [{ pat_id: 5, cpt: "G0202", dt: "2024-02-02" }],
  // A non-mammography procedure, so the ADR-044 allowlist has a negative case to fail against.
  7: [{ pat_id: 7, cpt: "92557", dt: "2024-04-04" }],
  // Lower-cased + padded, the shape `webchart/terminology.ts` normalizes before matching.
  9: [{ pat_id: 9, cpt: " g0202 ", dt: "2024-03-03" }],
};

function stubDb(): ShimDb {
  return {
    countPatients: async () => PATIENTS.length,
    listPatients: async (limit, offset) => PATIENTS.slice(offset, offset + limit),
    observationsForPatient: async (patId) => OBS[patId] ?? [],
    proceduresForPatient: async (patId) => PROCS[patId] ?? [],
    queryRows: async () => [],
    execute: async () => ({}),
    withTransaction: async () => {
      throw new Error("read-only test stub");
    },
    end: async () => {},
  };
}

let server: Server;
let base: string;

before(async () => {
  server = createShimServer({ db: stubDb(), measureSql: new Map() });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const getJson = async (path: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, { headers: { authorization: "Bearer test-key" } });
  return { status: res.status, body: await res.json() };
};

test("GET /fhir/metadata returns an R4 CapabilityStatement", async () => {
  const { status, body } = await getJson("/fhir/metadata");
  assert.equal(status, 200);
  assert.equal(body.resourceType, "CapabilityStatement");
  assert.equal(body.fhirVersion, "4.0.1");
});

test("GET /fhir/Patient pages with same-origin link[next] and full total", async () => {
  const { status, body } = await getJson("/fhir/Patient?_count=2");
  assert.equal(status, 200);
  assert.equal(body.resourceType, "Bundle");
  assert.equal(body.type, "searchset");
  assert.equal(body.total, 3);
  assert.equal(body.entry.length, 2);
  assert.equal(body.entry[0].search.mode, "match");
  assert.equal(body.entry[0].resource.id, "wc-5");
  assert.equal(body.entry[0].resource.gender, "female");
  // `us-core-sex` alongside `gender`, both from `patients.sex`. The official CMS125 initial population
  // reads THIS element and never `gender`, comparing against the SNOMED concept id — so the code matters
  // as much as the presence: `"F"` here would be as good as absent (ADR-042).
  assert.deepEqual(body.entry[0].resource.extension, [
    { url: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-sex", valueCode: "248152002" },
  ]);
  assert.equal(body.entry[0].resource.birthDate, "1947-05-09");

  const next = body.link.find((l: any) => l.relation === "next");
  assert.ok(next, "first page carries link[next]");
  const nextUrl = new URL(next.url);
  assert.equal(nextUrl.origin, new URL(base).origin, "next link is same-origin");

  const page2 = await getJson(nextUrl.pathname + nextUrl.search);
  assert.equal(page2.body.entry.length, 1);
  assert.equal(page2.body.entry[0].resource.id, "wc-9");
  assert.equal(page2.body.link.length, 0, "last page has no next link");
});

test("GET /fhir/Patient handles a patient with null name/sex/birth_date", async () => {
  const { body } = await getJson("/fhir/Patient?_count=10&_offset=2");
  const p = body.entry[0].resource;
  assert.equal(p.id, "wc-9");
  assert.equal(p.name[0].text, "wc-9");
  assert.equal(p.gender, undefined);
  // Neither element is emitted when the column names neither sex. Normalization fills in structure a
  // profile requires; it does not invent a recorded sex for a row that carries none (ADR-037/ADR-042).
  // The consequence is deliberate: such a patient stays out of official CMS125's population.
  assert.equal(p.extension, undefined);
  assert.equal(p.birthDate, undefined);
});

test("GET /fhir/Observation?patient=wc-5 returns final LOINC observations with minted ids", async () => {
  const { status, body } = await getJson("/fhir/Observation?patient=wc-5");
  assert.equal(status, 200);
  // The real observation ROWS come first and keep their ordinals; wc-5's dual-stamped mammography
  // Observation (ADR-044, derived from her G0202 procedure) is appended after them.
  assert.equal(body.entry.length, 3);
  const ids = body.entry.map((e: any) => e.resource.id);
  assert.deepEqual(ids, ["wc-5-Observation-1", "wc-5-Observation-2", "wc-5-Observation-1-mammo"]);
  for (const e of body.entry) {
    assert.equal(e.resource.status, "final");
    assert.equal(e.resource.subject.reference, "Patient/wc-5");
    assert.equal(e.resource.code.coding[0].system, "http://loinc.org");
  }
  assert.equal(body.entry[1].resource.valueQuantity.value, 131);
  assert.equal(body.entry[1].resource.effectiveDateTime, "2024-05-01");
});

test("GET /fhir/Observation accepts a Patient/-prefixed reference", async () => {
  const { body } = await getJson("/fhir/Observation?patient=Patient%2Fwc-5");
  // 2 real observation rows + 1 dual-stamped mammography Observation derived from wc-5's G0202
  // procedure row (ADR-044).
  assert.equal(body.entry.length, 3);
});

test("ADR-044: a mammography PROCEDURE also surfaces as a LOINC imaging Observation", async () => {
  // The numerator gap this closes: authored cms125 reads `[Procedure: "Mammography"]` (CPT/HCPCS),
  // official CMS125 reads `isDiagnosticStudyPerformed([Observation: "Mammography"])` over a value set of
  // 92 LOINC codes with no CPT in it. Emitting only the Procedure made official report an
  // already-screened woman OVERDUE — a HIGH-priority case telling an operator to chase a mammogram she
  // already had.
  const { body } = await getJson("/fhir/Observation?patient=wc-5");
  const mammo = body.entry
    .map((e: { resource: Record<string, unknown> }) => e.resource)
    .find((r: Record<string, unknown>) => (r.id as string)?.endsWith("-mammo"));

  assert.ok(mammo, "the G0202 procedure row must surface a derived Observation");
  assert.equal(mammo.code.coding[0].system, "http://loinc.org");
  assert.equal(mammo.code.coding[0].code, "24606-6", "a member of the official Mammography value set");
  assert.equal(mammo.status, "final", "isDiagnosticStudyPerformed requires final/amended/corrected");
  // NOT decoration — `Status.isDiagnosticStudyPerformed` gates on it. A correctly-coded LOINC
  // Observation without this changes no outcome, which is the trap the obvious fix falls into.
  assert.equal(mammo.category[0].coding[0].code, "imaging");
  assert.equal(
    mammo.category[0].coding[0].system,
    "http://terminology.hl7.org/CodeSystem/observation-category",
  );
  // Derived from the real row, never minted: the date is the PROCEDURE's date.
  assert.equal(mammo.effectiveDateTime, "2024-02-02");
});

test("ADR-044: the /Procedure response is UNCHANGED — the authored engine sees what it always saw", async () => {
  // Dual-stamping adds a representation; it must not move or replace the one the authored engine reads.
  const { body } = await getJson("/fhir/Procedure?patient=wc-5");
  assert.equal(body.entry.length, 1, "no derived Observation leaks into the Procedure endpoint");
  assert.equal(body.entry[0].resource.resourceType, "Procedure");
  assert.equal(body.entry[0].resource.code.coding[0].code, "G0202");
});

test("ADR-044: a padded, lower-cased CPT still dual-stamps — matching the crosswalk's normalization", async () => {
  // `webchart/terminology.ts` keys on `code.trim().toUpperCase()`, so a WCDB row carrying `" g0202 "`
  // reconciles for the AUTHORED engine. An exact-match lookup here would skip the dual stamp on exactly
  // that row — reintroducing the false non-compliance this mapping exists to remove (authored COMPLIANT,
  // official OVERDUE) through a whitespace seam. Review, #355.
  const { body } = await getJson("/fhir/Observation?patient=wc-9");
  const mammo = body.entry
    .map((e: { resource: Record<string, unknown> }) => e.resource)
    .find((r: Record<string, unknown>) => (r.id as string)?.endsWith("-mammo"));

  assert.ok(mammo, "a padded/lower-cased mammography code must still dual-stamp");
  assert.equal(mammo.code.coding[0].code, "24606-6");
  assert.equal(mammo.effectiveDateTime, "2024-03-03");
});

test("ADR-044: a NON-mammography procedure mints nothing — the map is an allowlist, not a sweep", async () => {
  // wc-7 carries an unrelated CPT. If this ever returns a derived Observation, the crosswalk has started
  // inventing diagnostic studies from arbitrary procedure codes, which is the fabrication line (ADR-037).
  const { body } = await getJson("/fhir/Observation?patient=wc-7");
  const derived = body.entry
    .map((e: { resource: Record<string, unknown> }) => e.resource)
    .filter((r: Record<string, unknown>) => (r.id as string)?.endsWith("-mammo"));
  assert.equal(derived.length, 0, "only allowlisted screening-mammogram codes dual-stamp");
});

test("GET /fhir/Procedure?patient=wc-5 maps G-codes to HCPCS and status completed", async () => {
  const { body } = await getJson("/fhir/Procedure?patient=wc-5");
  assert.equal(body.entry.length, 1);
  const proc = body.entry[0].resource;
  assert.equal(proc.status, "completed");
  assert.equal(proc.code.coding[0].code, "G0202");
  assert.equal(proc.code.coding[0].system, "http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets");
  assert.equal(proc.performedDateTime, "2024-02-02");
});

test("Condition/Immunization/Encounter searches return valid EMPTY searchsets", async () => {
  for (const type of ["Condition", "Immunization", "Encounter"]) {
    const { status, body } = await getJson(`/fhir/${type}?patient=wc-5`);
    assert.equal(status, 200, type);
    assert.equal(body.resourceType, "Bundle");
    assert.equal(body.total, 0, type);
    assert.deepEqual(body.entry, [], type);
  }
});

test("clinical search without a patient parameter is a 400 OperationOutcome", async () => {
  const { status, body } = await getJson("/fhir/Observation");
  assert.equal(status, 400);
  assert.equal(body.resourceType, "OperationOutcome");
});

test("unknown patient-id shapes and unknown routes behave (empty searchset / 404 / 405)", async () => {
  const unknown = await getJson("/fhir/Observation?patient=not-a-wc-id");
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.total, 0);

  const missing = await getJson("/nope");
  assert.equal(missing.status, 404);

  const post = await fetch(`${base}/fhir/Patient`, { method: "POST" });
  assert.equal(post.status, 405);
});

test("mapping helpers: subject-id round-trip and CPT-vs-HCPCS split", () => {
  assert.equal(subjectIdFor(5), "wc-5");
  assert.equal(patIdFromSubjectId("wc-5"), 5);
  assert.equal(patIdFromSubjectId("hapi-123"), undefined);
  assert.equal(cptSystem("92557"), "http://www.ama-assn.org/go/cpt");
  assert.equal(cptSystem("G0202"), "http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets");
});
