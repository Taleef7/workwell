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

test("GET /api/measures lists runnable measures with id + name", async () => {
  const res = await get("/api/measures");
  assert.equal(res?.status, 200);
  const rows = (await res!.json()) as Array<{ id: string; name: string }>;
  assert.ok(rows.some((m) => m.id === "audiogram" && m.name === "Audiogram"));
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
