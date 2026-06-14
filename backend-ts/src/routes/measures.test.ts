/**
 * Route test for the measures surface (#106 + ELM-explorer demo, issue #96).
 *   node --import tsx --test src/routes/measures.test.ts
 *
 * Covers the JVM-free list/evaluate contract plus GET /api/measures/:id/elm —
 * the compiled ELM (the AST that the Node engine actually executes), served as
 * JSON so the Studio ELM-explorer can render source↔AST without a JVM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMeasures } from "./measures.ts";

const get = (path: string) => handleMeasures(new Request(`http://x${path}`, { method: "GET" }));
const post = (path: string, body?: unknown) =>
  handleMeasures(new Request(`http://x${path}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }));

interface CatalogRow {
  id: string;
  name: string;
  policyRef: string;
  version: string;
  status: string;
  owner: string;
  tags: string[];
  lastUpdated: string;
  statusUpdatedAt: string;
  statusUpdatedBy: string;
}

test("GET /api/measures returns the full 60-measure catalog (Measure shape), Active-first", async () => {
  const res = await get("/api/measures");
  assert.equal(res?.status, 200);
  const rows = (await res!.json()) as CatalogRow[];
  assert.equal(rows.length, 60, "full TWH catalog");
  // The first row is Active so the runs/studio pickers default to a runnable measure.
  assert.equal(rows[0]!.status, "Active");
  const audiogram = rows.find((m) => m.id === "audiogram")!;
  assert.equal(audiogram.name, "Annual Audiogram Completed");
  assert.equal(audiogram.policyRef, "OSHA 29 CFR 1910.95");
  assert.equal(audiogram.status, "Active");
  assert.ok(audiogram.tags.includes("hearing"));
  // exactly the 10 runnable measures are Active
  assert.equal(rows.filter((m) => m.status === "Active").length, 10);
});

test("GET /api/measures?status=Draft filters by lifecycle status", async () => {
  const rows = (await get("/api/measures?status=Draft").then((r) => r!.json())) as CatalogRow[];
  assert.ok(rows.length >= 47, "the CMS eCQM drafts (+ Respirator Fit Test)");
  assert.ok(rows.every((m) => m.status === "Draft"));
});

test("GET /api/measures?search matches name or tag (case-insensitive)", async () => {
  const byName = (await get("/api/measures?search=hazwoper").then((r) => r!.json())) as CatalogRow[];
  assert.ok(byName.some((m) => m.id === "hazwoper"));
  const byTag = (await get("/api/measures?search=cardiovascular").then((r) => r!.json())) as CatalogRow[];
  assert.ok(byTag.length >= 2 && byTag.every((m) => m.tags.includes("cardiovascular")));
});

test("GET /api/measures/:id returns MeasureDetail with spec + reconstructed CQL (runnable)", async () => {
  const res = await get("/api/measures/audiogram");
  assert.equal(res?.status, 200);
  const d = (await res!.json()) as {
    id: string;
    name: string;
    description: string;
    eligibilityCriteria: { roleFilter: string; programEnrollmentText: string };
    exclusions: Array<{ label: string }>;
    complianceWindow: string;
    requiredDataElements: string[];
    cqlText: string;
    compileStatus: string;
    valueSets: unknown[];
    testFixtures: unknown[];
  };
  assert.equal(d.id, "audiogram");
  assert.equal(d.name, "Annual Audiogram Completed");
  assert.match(d.description, /noise-exposed/);
  assert.equal(d.eligibilityCriteria.programEnrollmentText, "Hearing Conservation Program");
  assert.ok(d.exclusions.some((e) => e.label === "Waiver"));
  assert.ok(d.requiredDataElements.includes("Last audiogram date"));
  assert.equal(d.compileStatus, "COMPILED");
  assert.match(d.cqlText, /^library AnnualAudiogramCompleted version '1\.0\.0'/);
  assert.deepEqual(d.valueSets, []);
  assert.deepEqual(d.testFixtures, []);
});

test("GET /api/measures/:id for a catalog-only draft: generic spec, empty CQL, NOT_COMPILED", async () => {
  const d = (await get("/api/measures/cms2v15").then((r) => r!.json())) as { cqlText: string; compileStatus: string; description: string };
  assert.equal(d.compileStatus, "NOT_COMPILED");
  assert.equal(d.cqlText, "", "no compiled CQL for a draft");
  assert.match(d.description, /CQL authoring pending/);
});

test("GET /api/measures/:id/versions returns the version history; unknown measure → 404", async () => {
  const versions = (await get("/api/measures/audiogram/versions").then((r) => r!.json())) as Array<{ id: string; version: string; status: string; author: string }>;
  assert.equal(versions.length, 1);
  assert.equal(versions[0]!.version, "v1.0");
  assert.equal(versions[0]!.status, "Active");
  // The version id must be DISTINCT from the measure slug so version-scoped Studio actions
  // (auditor packet, MAT export) target the version, not the measure.
  assert.notEqual(versions[0]!.id, "audiogram");
  assert.equal(versions[0]!.id, "audiogram-v1.0");
  assert.equal((await get("/api/measures/does-not-exist"))?.status, 404);
  assert.equal((await get("/api/measures/does-not-exist/versions"))?.status, 404);
});

test("GET /api/measures/:id preserves the Hepatitis B 'Documented Immunity' exclusion (V017 parity)", async () => {
  const d = (await get("/api/measures/hepatitis_b_vaccination_series").then((r) => r!.json())) as {
    exclusions: Array<{ label: string; criteriaText: string }>;
  };
  assert.ok(
    d.exclusions.some((e) => e.label === "Documented Immunity" && /anti-HBs titer/i.test(e.criteriaText)),
    "the V017 exclusion is carried through",
  );
});

test("GET /api/measures/:id/activation-readiness reflects the compile + fixture gate", async () => {
  // Runnable (COMPILED) but no fixtures → not ready, only the fixture blocker.
  const a = (await get("/api/measures/audiogram/activation-readiness").then((r) => r!.json())) as {
    ready: boolean;
    compileStatus: string;
    testFixtureCount: number;
    valueSetCount: number;
    testValidationPassed: boolean;
    activationBlockers: string[];
  };
  assert.equal(a.ready, false);
  assert.equal(a.compileStatus, "COMPILED");
  assert.equal(a.testValidationPassed, false);
  assert.equal(a.testFixtureCount, 0);
  assert.equal(a.valueSetCount, 0);
  assert.ok(a.activationBlockers.some((b) => /test fixture/i.test(b)));
  assert.ok(!a.activationBlockers.some((b) => /Compile status/i.test(b)), "COMPILED → no compile blocker");

  // Draft (NOT_COMPILED) → adds the compile blocker too.
  const d = (await get("/api/measures/cms2v15/activation-readiness").then((r) => r!.json())) as { activationBlockers: string[]; compileStatus: string };
  assert.equal(d.compileStatus, "NOT_COMPILED");
  assert.ok(d.activationBlockers.some((b) => /Compile status must be COMPILED or WARNINGS/.test(b)));

  assert.equal((await get("/api/measures/nope/activation-readiness"))?.status, 404);
});

test("GET /api/measures/:id/elm returns the compiled ELM (AST) for the measure", async () => {
  const res = await get("/api/measures/audiogram/elm");
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as {
    measureId: string;
    name: string;
    library: string;
    elm: { library: { statements: { def: Array<{ name: string }> }; annotation: unknown[] } };
  };
  assert.equal(body.measureId, "audiogram");
  assert.equal(body.library, "AnnualAudiogramCompleted-1.0.0");
  // The reconstructed CQL source is present and recompilable (seeds the editor).
  assert.match((body as unknown as { cql: string }).cql, /^library AnnualAudiogramCompleted version '1\.0\.0'/);
  // The ELM is the AST: statement defines are present (the executed expressions)…
  const defineNames = body.elm.library.statements.def.map((d) => d.name);
  assert.ok(defineNames.includes("Outcome Status"), "canonical compliance define present");
  assert.ok(defineNames.includes("Days Since Last Audiogram"));
  // …and annotations carry the CQL source narrative for source↔AST highlighting.
  assert.ok(Array.isArray(body.elm.library.annotation));
});

test("GET /api/measures/:id/elm for an unknown measure → 404", async () => {
  const res = await get("/api/measures/nope/elm");
  assert.equal(res?.status, 404);
  const body = (await res!.json()) as { error: string };
  assert.equal(body.error, "unknown_measure");
});

test("POST /api/measures/compile translates valid CQL → ELM with no errors", async () => {
  const cql = "library Demo version '1.0.0'\nusing FHIR version '4.0.1'\ncontext Patient\ndefine \"Two Plus Two\": 2 + 2";
  const res = await post("/api/measures/compile", { cql });
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as { ok: boolean; diagnostics: unknown[]; elm: { library: { statements: { def: { name: string }[] } } } };
  assert.equal(body.ok, true);
  assert.equal(body.diagnostics.length, 0);
  assert.ok(body.elm.library.statements.def.some((d) => d.name === "Two Plus Two"));
});

test("POST /api/measures/compile surfaces CQL errors as diagnostics (ok:false), not a 500", async () => {
  const res = await post("/api/measures/compile", { cql: "library Bad version '1.0.0'\ndefine \"Oops\": 2 +" });
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as { ok: boolean; diagnostics: { severity: string; message: string }[] };
  assert.equal(body.ok, false);
  assert.ok(body.diagnostics.length > 0);
  assert.ok(body.diagnostics.some((d) => d.severity.toLowerCase() === "error"));
});

test("POST /api/measures/compile rejects a non-string body → 400", async () => {
  const res = await post("/api/measures/compile", { cql: 42 });
  assert.equal(res?.status, 400);
});
