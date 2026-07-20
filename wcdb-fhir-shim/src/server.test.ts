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
};

function stubDb(): ShimDb {
  return {
    countPatients: async () => PATIENTS.length,
    listPatients: async (limit, offset) => PATIENTS.slice(offset, offset + limit),
    observationsForPatient: async (patId) => OBS[patId] ?? [],
    proceduresForPatient: async (patId) => PROCS[patId] ?? [],
    queryRows: async () => [],
    execute: async () => ({}),
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
  assert.equal(p.birthDate, undefined);
});

test("GET /fhir/Observation?patient=wc-5 returns final LOINC observations with minted ids", async () => {
  const { status, body } = await getJson("/fhir/Observation?patient=wc-5");
  assert.equal(status, 200);
  assert.equal(body.entry.length, 2);
  const ids = body.entry.map((e: any) => e.resource.id);
  assert.deepEqual(ids, ["wc-5-Observation-1", "wc-5-Observation-2"]);
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
  assert.equal(body.entry.length, 2);
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
