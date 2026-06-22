/**
 * Route test for the measures surface (#106 + ELM-explorer demo, issue #96).
 *   node --import tsx --test src/routes/measures.test.ts
 *
 * Covers the JVM-free list/evaluate contract plus GET /api/measures/:id/elm —
 * the compiled ELM (the AST that the Node engine actually executes), served as
 * JSON so the Studio ELM-explorer can render source↔AST without a JVM.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { handleMeasures } from "./measures.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";

const dbPath = join(tmpdir(), `workwell-measures-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };

const get = (path: string) => handleMeasures(new Request(`http://x${path}`, { method: "GET" }), env as never, "author@workwell.dev");
const post = (path: string, body?: unknown) =>
  handleMeasures(new Request(`http://x${path}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }), env as never, "author@workwell.dev");
const put = (path: string, body?: unknown) =>
  handleMeasures(new Request(`http://x${path}`, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) }), env as never, "author@workwell.dev");

before(async () => {
  env = { DB: await createSqliteD1(dbPath) };
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

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

test("GET /api/measures returns the full 63-measure catalog (Measure shape), Active-first", async () => {
  const res = await get("/api/measures");
  assert.equal(res?.status, 200);
  const rows = (await res!.json()) as CatalogRow[];
  assert.equal(rows.length, 63, "full TWH catalog");
  // The first row is Active so the runs/studio pickers default to a runnable measure.
  assert.equal(rows[0]!.status, "Active");
  const audiogram = rows.find((m) => m.id === "audiogram")!;
  assert.equal(audiogram.name, "Annual Audiogram Completed");
  assert.equal(audiogram.policyRef, "OSHA 29 CFR 1910.95");
  assert.equal(audiogram.status, "Active");
  assert.ok(audiogram.tags.includes("hearing"));
  // exactly the 13 runnable measures are Active
  assert.equal(rows.filter((m) => m.status === "Active").length, 13);
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
  // Value-set governance (#108): audiogram's 3 demo value sets (procedures + enrollment + waiver)
  // are now attached and resolved to the detail.
  assert.equal(d.valueSets.length, 3);
  assert.ok((d.valueSets as Array<{ name: string }>).some((v) => v.name === "Audiogram Procedures"));
  // V015 seeds 5 demo fixtures for audiogram — they must be carried into the detail.
  assert.equal((d.testFixtures as unknown[]).length, 5);
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
  // Seeded OSHA measure: COMPILED + V015 demo fixtures → ready, no blockers (Java parity).
  const a = (await get("/api/measures/audiogram/activation-readiness").then((r) => r!.json())) as {
    ready: boolean;
    compileStatus: string;
    testFixtureCount: number;
    testValidationPassed: boolean;
    activationBlockers: string[];
  };
  assert.equal(a.ready, true, "seeded fixtures make it activatable");
  assert.equal(a.compileStatus, "COMPILED");
  assert.equal(a.testValidationPassed, true);
  assert.equal(a.testFixtureCount, 5);
  assert.deepEqual(a.activationBlockers, []);

  // Runnable HEDIS measure with no seeded fixtures: COMPILED but not ready → only the fixture blocker.
  const h = (await get("/api/measures/hypertension/activation-readiness").then((r) => r!.json())) as { ready: boolean; testFixtureCount: number; activationBlockers: string[] };
  assert.equal(h.ready, false);
  assert.equal(h.testFixtureCount, 0);
  assert.ok(h.activationBlockers.some((b) => /test fixture/i.test(b)));
  assert.ok(!h.activationBlockers.some((b) => /Compile status/i.test(b)), "COMPILED → no compile blocker");

  // Draft (NOT_COMPILED, no fixtures) → both blockers.
  const d = (await get("/api/measures/cms2v15/activation-readiness").then((r) => r!.json())) as { ready: boolean; activationBlockers: string[]; compileStatus: string };
  assert.equal(d.ready, false);
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

test("concurrent cold-start requests seed the store once (no duplicate-PK 500)", async () => {
  // A brand-new DB: fire two requests before init completes. The in-flight init promise must
  // serialize the (non-idempotent) catalog seed so neither request hits a duplicate-key 500.
  const coldDb = await createSqliteD1(join(tmpdir(), `workwell-measures-cold-${crypto.randomUUID()}.sqlite`));
  const coldEnv = { DB: coldDb } as never;
  const both = await Promise.all([
    handleMeasures(new Request("http://x/api/measures", { method: "GET" }), coldEnv, "a@b.c"),
    handleMeasures(new Request("http://x/api/measures", { method: "GET" }), coldEnv, "a@b.c"),
  ]);
  for (const res of both) {
    assert.equal(res?.status, 200, "no 500 from a racing duplicate seed");
    assert.equal(((await res!.json()) as unknown[]).length, 63, "seeded exactly once");
  }
});

// ---- authoring (run last — these mutate the seeded store) --------------------
test("POST /api/measures creates a Draft measure persisted to the store", async () => {
  const res = await post("/api/measures", { name: "Custom Audiometry", policyRef: "OSHA 29 CFR 1910.95", owner: "author@workwell.dev" });
  assert.equal(res?.status, 201);
  const { id } = (await res!.json()) as { id: string };
  assert.ok(id);
  const d = (await get(`/api/measures/${id}`).then((r) => r!.json())) as { name: string; status: string; owner: string; compileStatus: string };
  assert.equal(d.name, "Custom Audiometry");
  assert.equal(d.status, "Draft");
  assert.equal(d.owner, "author@workwell.dev");
  assert.equal(d.compileStatus, "ERROR", "an empty Draft has no compiled CQL");
  // missing fields → 400
  assert.equal((await post("/api/measures", { name: "x" }))?.status, 400);
});

test("POST /api/measures/:id/status transitions Draft→Approved, but Approved→Active is gated on fixtures", async () => {
  const { id } = (await post("/api/measures", { name: "Lifecycle Demo", policyRef: "CDC", owner: "author@workwell.dev" }).then((r) => r!.json())) as { id: string };
  const approved = await post(`/api/measures/${id}/status`, { targetStatus: "Approved" });
  assert.equal(approved?.status, 200);
  assert.equal(((await approved!.json()) as { status: string }).status, "Approved");
  // Approved→Active is gated: a fresh Draft has compileStatus ERROR, so the compile gate
  // fires first (and if it passed, the no-fixtures gate would block it next) → 400, faithful to Java.
  const activate = await post(`/api/measures/${id}/status`, { targetStatus: "Active" });
  assert.equal(activate?.status, 400);
  assert.match(((await activate!.json()) as { message: string }).message, /compile status|test fixtures/i);
  // an invalid jump (Approved→Deprecated) is rejected
  assert.equal((await post(`/api/measures/${id}/status`, { targetStatus: "Deprecated" }))?.status, 400);
});

test("POST /api/measures/:id/approve is gated; non-Draft → 400", async () => {
  const { id } = (await post("/api/measures", { name: "Approve Gate", policyRef: "CDC", owner: "a@b.c" }).then((r) => r!.json())) as { id: string };
  const res = await post(`/api/measures/${id}/approve`);
  assert.equal(res?.status, 400);
  // a fresh Draft has compileStatus ERROR → the compile gate fires first (Java order)
  assert.match(((await res!.json()) as { message: string }).message, /compile status/i);
  // audiogram is Active, not Draft → "Only Draft measures can be approved"
  const a = await post("/api/measures/audiogram/approve");
  assert.equal(a?.status, 400);
  assert.match(((await a!.json()) as { message: string }).message, /Only Draft/i);
});

test("POST /api/measures/:id/deprecate works on an Active measure; gated otherwise (run last)", async () => {
  // reason required
  assert.equal((await post("/api/measures/hazwoper/deprecate", {}))?.status, 400);
  // a Draft cannot be deprecated
  const { id } = (await post("/api/measures", { name: "Draft NoDep", policyRef: "CDC", owner: "a@b.c" }).then((r) => r!.json())) as { id: string };
  assert.equal((await post(`/api/measures/${id}/deprecate`, { reason: "x" }))?.status, 400);
  // hazwoper is Active → deprecate succeeds and persists
  const res = await post("/api/measures/hazwoper/deprecate", { reason: "Superseded by updated protocol" });
  assert.equal(res?.status, 200);
  assert.equal(((await res!.json()) as { status: string }).status, "Deprecated");
  const d = (await get("/api/measures/hazwoper").then((r) => r!.json())) as { status: string };
  assert.equal(d.status, "Deprecated", "the lifecycle change is persisted");
  assert.equal((await post("/api/measures/nope/deprecate", { reason: "x" }))?.status, 404);
});

// ---- authoring writes (Spec/CQL/Tests tabs) + osha-references (#107) ---------

test("GET /api/osha-references returns the curated lookup (sorted, stable ids)", async () => {
  const rows = (await get("/api/osha-references").then((r) => r!.json())) as Array<{ id: string; cfrCitation: string; title: string; programArea: string }>;
  assert.equal(rows.length, 8);
  assert.ok(rows.every((r) => r.id && r.cfrCitation && r.title && r.programArea));
  assert.ok(rows.some((r) => r.cfrCitation === "29 CFR 1910.95"));
  const ids = rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "ids unique");
});

test("PUT /api/measures/:id/spec saves spec + policyRef, preserves fixtures, audits", async () => {
  const body = {
    policyRef: "OSHA 29 CFR 1910.95 — rev",
    oshaReferenceId: "osha-29-cfr-1910-95",
    description: "edited via spec tab",
    eligibilityCriteria: { roleFilter: "Welder", siteFilter: "Plant A", programEnrollmentText: "HCP" },
    exclusions: [{ label: "Waiver", criteriaText: "on file" }],
    complianceWindow: "Annual",
    requiredDataElements: ["Last audiogram date"],
  };
  const res = await put("/api/measures/audiogram/spec", body);
  assert.equal(res?.status, 200);
  const detail = (await get("/api/measures/audiogram").then((r) => r!.json())) as { description: string; policyRef: string; testFixtures: unknown[] };
  assert.equal(detail.description, "edited via spec tab");
  assert.equal(detail.policyRef, "OSHA 29 CFR 1910.95 — rev");
  assert.ok(detail.testFixtures.length >= 1, "audiogram's seeded fixtures preserved by a spec edit");
  const audits = await new SqliteCaseEventStore(env.DB as never).listAuditEvents();
  assert.ok(audits.some((a) => a.eventType === "MEASURE_VERSION_DRAFT_SAVED" && (a.payload as { field?: string }).field === "spec"));
});

test("PUT /api/measures/:id/spec → 404 unknown measure", async () => {
  assert.equal((await put("/api/measures/nope/spec", { description: "x" }))?.status, 404);
});

test("PUT /api/measures/:id/cql saves CQL; POST /cql/compile compiles + persists status", async () => {
  const saved = await put("/api/measures/audiogram/cql", { cqlText: "library AudiogramCQL version '1.0.0'" });
  assert.equal(saved?.status, 200);

  const compiled = await post("/api/measures/audiogram/cql/compile", { cqlText: "define \"X\": 1 +" });
  assert.equal(compiled?.status, 200);
  const body = (await compiled!.json()) as { status: string; errors: string[]; warnings: string[] };
  assert.ok(["ERROR", "WARNINGS", "COMPILED"].includes(body.status));
  assert.ok(Array.isArray(body.errors) && Array.isArray(body.warnings));
});

test("PUT /api/measures/:id/cql resets compile_status to NOT_COMPILED (no stale gate bypass)", async () => {
  // Compile to a known-good status first, then a raw save must invalidate it.
  await post("/api/measures/hypertension/cql/compile", { cqlText: 'library H version \'1.0.0\'\ndefine "Outcome Status": \'COMPLIANT\'' });
  await put("/api/measures/hypertension/cql", { cqlText: "library H version '1.0.0'  // edited, not recompiled" });
  const readiness = (await get("/api/measures/hypertension/activation-readiness").then((r) => r!.json())) as { compileStatus: string; activationBlockers: string[] };
  assert.equal(readiness.compileStatus, "NOT_COMPILED", "raw save invalidates the prior compile status");
  assert.ok(readiness.activationBlockers.some((b) => /compile/i.test(b)), "a NOT_COMPILED measure carries a compile blocker");
});

test("CQL authoring enforces type + size cap (translator DoS guard)", async () => {
  const huge = "x".repeat(64 * 1024 + 1);
  assert.equal((await post("/api/measures/audiogram/cql/compile", { cqlText: huge }))?.status, 413);
  assert.equal((await put("/api/measures/audiogram/cql", { cqlText: huge }))?.status, 413);
  assert.equal((await post("/api/measures/audiogram/cql/compile", { cqlText: 123 }))?.status, 400);
  assert.equal((await put("/api/measures/audiogram/cql", { cqlText: null }))?.status, 400);
});

test("PUT /api/measures/:id/tests replaces fixtures; POST /tests/validate validates them", async () => {
  const fixtures = [
    { fixtureName: "f-compliant", employeeExternalId: "emp-001", expectedOutcome: "COMPLIANT", notes: "" },
    { fixtureName: "f-overdue", employeeExternalId: "emp-002", expectedOutcome: "OVERDUE", notes: "" },
  ];
  const res = await put("/api/measures/audiogram/tests", { fixtures });
  assert.equal(res?.status, 200);
  const valid = await post("/api/measures/audiogram/tests/validate");
  assert.equal(valid?.status, 200);
  assert.equal(((await valid!.json()) as { passed: boolean }).passed, true);

  // empty fixtures → validation fails with the required-fixture failure
  await put("/api/measures/audiogram/tests", { fixtures: [] });
  const empty = await post("/api/measures/audiogram/tests/validate");
  const emptyBody = (await empty!.json()) as { passed: boolean; failures: string[] };
  assert.equal(emptyBody.passed, false);
  assert.ok(emptyBody.failures.length >= 1);
});

test("authoring writes → 404 for unknown measure", async () => {
  assert.equal((await put("/api/measures/nope/cql", { cqlText: "x" }))?.status, 404);
  assert.equal((await put("/api/measures/nope/tests", { fixtures: [] }))?.status, 404);
  assert.equal((await post("/api/measures/nope/cql/compile", { cqlText: "x" }))?.status, 404);
  assert.equal((await post("/api/measures/nope/tests/validate"))?.status, 404);
});

test("GET /api/measures/:id/traceability returns rows + gaps; unknown → 404", async () => {
  const res = await get("/api/measures/audiogram/traceability");
  assert.equal(res?.status, 200);
  const t = (await res!.json()) as { measureId: string; measureVersionId: string; rows: unknown[]; gaps: unknown[] };
  assert.equal(t.measureId, "audiogram");
  assert.equal(t.measureVersionId, "audiogram-v1.0");
  assert.ok(t.rows.length >= 3, "eligibility + compliance-window rows at minimum");
  assert.ok(Array.isArray(t.gaps));
  assert.equal((await get("/api/measures/does-not-exist/traceability"))?.status, 404);
});

test("GET /api/measures/:id/data-readiness returns element readiness + overall status; unknown → 404", async () => {
  const res = await get("/api/measures/audiogram/data-readiness");
  assert.equal(res?.status, 200);
  const r = (await res!.json()) as { overallStatus: string; requiredElements: Array<{ canonicalElement: string; mappingStatus: string }>; blockers: string[]; warnings: string[] };
  assert.ok(["READY", "READY_WITH_WARNINGS", "NOT_READY"].includes(r.overallStatus));
  assert.ok(r.requiredElements.length >= 1);
  // audiogram's "Last audiogram date" resolves to the seeded procedure.audiogram mapping (MAPPED)
  assert.ok(r.requiredElements.some((e) => e.canonicalElement === "procedure.audiogram" && e.mappingStatus === "MAPPED"));
  assert.equal((await get("/api/measures/does-not-exist/data-readiness"))?.status, 404);
});

test("POST /api/measures/:id/impact-preview returns a dry-run preview; 404 unknown; 400 bad date", async () => {
  assert.equal((await post("/api/measures/does-not-exist/impact-preview"))?.status, 404);
  assert.equal((await post("/api/measures/audiogram/impact-preview", { evaluationDate: "06/15/2026" }))?.status, 400);
  const res = await post("/api/measures/audiogram/impact-preview");
  assert.equal(res?.status, 200);
  const r = (await res!.json()) as { measureId: string; populationEvaluated: number; outcomeCounts: Record<string, number>; caseImpact: { wouldCreate: number }; siteBreakdown: unknown[] };
  assert.equal(r.measureId, "audiogram");
  assert.ok(r.populationEvaluated > 0);
  assert.ok(Object.values(r.outcomeCounts).reduce((a, b) => a + b, 0) === r.populationEvaluated);
  assert.ok(Array.isArray(r.siteBreakdown) && r.siteBreakdown.length >= 1);
});

test("GET /api/measures/:id/versions/:vid/export/mat → FHIR R4 Bundle XML; format + id gates", async () => {
  // resolve the audiogram version id from the version history
  const versions = (await get("/api/measures/audiogram/versions").then((r) => r!.json())) as Array<{ id: string }>;
  const versionId = versions[0]!.id;

  const res = await get(`/api/measures/audiogram/versions/${versionId}/export/mat`);
  assert.equal(res?.status, 200);
  assert.equal(res!.headers.get("content-type"), "application/fhir+xml");
  assert.match(res!.headers.get("content-disposition") ?? "", new RegExp(`attachment; filename="measure-${versionId}-mat\.xml"`));
  const xml = await res!.text();
  assert.match(xml, /<Bundle xmlns="http:\/\/hl7\.org\/fhir">/);
  assert.match(xml, /<Library>/);
  assert.match(xml, /<Measure>/);

  // non-xml format → 400
  assert.equal((await get(`/api/measures/audiogram/versions/${versionId}/export/mat?format=json`))?.status, 400);
  // unknown version → 404
  assert.equal((await get(`/api/measures/audiogram/versions/${crypto.randomUUID()}/export/mat`))?.status, 404);
  // version belongs to a DIFFERENT measure than the path → 404 (measure/version mismatch)
  assert.equal((await get(`/api/measures/hazwoper/versions/${versionId}/export/mat`))?.status, 404);
});
