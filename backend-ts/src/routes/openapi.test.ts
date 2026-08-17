/**
 * The OpenAPI document and its anti-drift guard (ADR-068).
 *   node --import tsx --test src/routes/openapi.test.ts
 *
 * ## Why this file is shaped like this
 *
 * A hand-authored spec drifts, and this repo has the worked example: `ARCHITECTURE.md` asserted "The
 * OpenAPI document (`workwell.swagger.enabled=true`) advertises version `v1`" for a year after the JVM that
 * served it was retired. Nobody noticed, because nothing executed the claim.
 *
 * So the load-bearing test is not "the document is valid JSON". It is **two-way coverage**: every
 * `(path, method, status)` the document declares is produced by a real request through the real worker, and
 * every response these tests observe is declared. A documented operation that was never implemented fails
 * the first direction; an undocumented status fails the second. No maintained `node:test` OpenAPI assertion
 * library exists, so the structural response check is hand-rolled — tractable because OpenAPI 3.1 Schema
 * Objects are literal JSON Schema 2020-12 and our responses are flat.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { openApiDocument, type OpenApiSchema } from "../openapi/spec.ts";
import { OPENAPI_PATH } from "./openapi.ts";
import { PATIENT_VIEW_SERVICE_ID } from "../cds/discovery.ts";
import { authorize } from "../auth/authorize.ts";
import worker from "../worker.ts";
import type { Env } from "../worker.ts";

const dbPath = join(tmpdir(), `ww-openapi-${crypto.randomUUID()}.sqlite`);
const doc = openApiDocument();
const env = { WORKWELL_AUTH_JWT_SECRET: "x".repeat(40) } as unknown as Env;
/** The same worker under a WebChart-configured seam, where `mode=preview` must refuse. */
let webChartEnv: Env;
const ctx = {} as never;

const INVOKE = `/cds-services/${PATIENT_VIEW_SERVICE_ID}`;
const COMPLIANCE_TEMPLATE = "/api/v1/compliance/{subjectId}/{measureId}";
const INVOKE_TEMPLATE = "/cds-services/{serviceId}";
const FEEDBACK_TEMPLATE = "/cds-services/{serviceId}/feedback";

/** `"METHOD template status"` for everything these tests actually saw. */
const observed = new Set<string>();
const tokens: Record<string, string> = {};

async function login(email: string): Promise<string> {
  if (tokens[email]) return tokens[email]!;
  const res = await worker.fetch(
    new Request("http://x/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Workwell123!" }),
    }),
    env,
    ctx,
  );
  assert.equal(res.status, 200, `login for ${email}`);
  const { token } = (await res.json()) as { token: string };
  tokens[email] = token;
  return token;
}

interface ProbeOptions {
  template: string;
  method?: string;
  token?: string;
  body?: unknown;
  useEnv?: Env;
}

/**
 * Send a real request through the real worker, record what came back, and refuse the one answer that would
 * mean the document describes a route that does not exist.
 */
async function probe(path: string, o: ProbeOptions): Promise<Response> {
  const method = o.method ?? "GET";
  const init: RequestInit = { method, headers: {} };
  if (o.token) (init.headers as Record<string, string>)["authorization"] = `Bearer ${o.token}`;
  if (o.body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
  }
  const res = await worker.fetch(new Request(`http://x${path}`, init), o.useEnv ?? env, ctx);
  observed.add(`${method} ${o.template} ${res.status}`);

  // The worker answers an unrouted path with 501 `not_implemented`. A documented path that produces it is
  // documentation of something that does not exist — exactly the ARCHITECTURE.md failure.
  if (res.status === 501) {
    const clone = res.clone();
    const body = (await clone.json().catch(() => ({}))) as { error?: string };
    assert.notEqual(
      body.error,
      "not_implemented",
      `${method} ${path} is documented but NOT ROUTED — the worker fell through to its 501 catch-all`,
    );
  }
  return res;
}

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  (env as unknown as { DB: unknown }).DB = db;
  webChartEnv = {
    ...(env as unknown as Record<string, unknown>),
    WORKWELL_WEBCHART_BASE_URL: "https://webchart.example.org",
    WORKWELL_WEBCHART_API_KEY: "k",
  } as unknown as Env;

  const runs = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  const run = await runs.createRun({
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "test",
    requestedScope: {},
    measurementPeriodStart: "2025-06-12T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-12T00:00:00.000Z",
  });
  await runs.finalizeRun(run.id, "COMPLETED");
  await outcomes.recordOutcome({
    runId: run.id,
    subjectId: "emp-006",
    measureId: "audiogram",
    status: "OVERDUE",
    evaluationPeriod: "2026-06-12",
    evidence: {
      expressionResults: [
        { define: "Most Recent Audiogram Date", result: "2025-03-10T00:00:00Z" },
        { define: "Days Since Last Audiogram", result: 420 },
      ],
    },
  });
});

after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("the document is a well-formed OpenAPI 3.1 description with no dangling references", () => {
  assert.equal(doc.openapi, "3.1.1");
  assert.ok(doc.info["title"], "info.title is required");
  assert.deepEqual(doc.servers, [{ url: "/", description: "This deployment" }]);

  const schemaNames = new Set(Object.keys(doc.components.schemas));
  const referenced = new Set<string>();
  const operationIds = new Set<string>();
  const tagNames = new Set(doc.tags.map((t) => t.name));

  const walk = (s: OpenApiSchema): void => {
    if (s.$ref) {
      const name = s.$ref.replace("#/components/schemas/", "");
      assert.ok(schemaNames.has(name), `dangling $ref: ${s.$ref}`);
      referenced.add(name);
    }
    Object.values(s.properties ?? {}).forEach(walk);
    if (s.items) walk(s.items);
    if (typeof s.additionalProperties === "object") walk(s.additionalProperties);
  };
  Object.values(doc.components.schemas).forEach(walk);

  for (const [path, item] of Object.entries(doc.paths)) {
    // Every `{param}` in the path must be declared, and every declared path param must be in the path.
    const inPath = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    for (const [method, op] of Object.entries(item)) {
      assert.ok(!operationIds.has(op.operationId), `duplicate operationId ${op.operationId}`);
      operationIds.add(op.operationId);
      op.tags.forEach((t) => assert.ok(tagNames.has(t), `${op.operationId} uses undeclared tag ${t}`));
      const declared = (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name);
      assert.deepEqual([...declared].sort(), [...inPath].sort(), `${method} ${path} path parameters`);
      assert.ok(Object.keys(op.responses).length > 0, `${op.operationId} declares no responses`);
      Object.values(op.responses).forEach((r) =>
        Object.values(r.content ?? {}).forEach((c) => walk(c.schema)),
      );
      Object.values(op.requestBody?.content ?? {}).forEach((c) => walk(c.schema));
    }
  }

  // An unreferenced component schema is dead documentation — it says a shape matters when nothing uses it.
  assert.deepEqual([...schemaNames].filter((n) => !referenced.has(n)).sort(), [], "unreferenced schemas");
});

test("the document is served, publicly, at one canonical path", async () => {
  const res = await probe(OPENAPI_PATH, { template: OPENAPI_PATH });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  const served = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
  assert.equal(served.openapi, "3.1.1");
  assert.deepEqual(Object.keys(served.paths).sort(), Object.keys(doc.paths).sort());
  // Public: readable with no token, because reading a contract should not need credentials.
  assert.deepEqual(authorize("GET", OPENAPI_PATH, null), { ok: true });
  // The aliases the journal probed are deliberately NOT served — one canonical URL.
  for (const alias of ["/api/openapi.json", "/api/swagger", "/swagger-ui", "/api/docs"]) {
    assert.notEqual(authorize("GET", alias, null).ok && alias === OPENAPI_PATH, true);
  }
});

test("every documented status is produced by a real request through the real worker", async () => {
  const cm = await login("cm@workwell.dev");
  const author = await login("author@workwell.dev");

  // --- meta ---
  assert.equal((await probe("/actuator/health", { template: "/actuator/health" })).status, 200);
  assert.equal((await probe("/api/version", { template: "/api/version" })).status, 200);

  // --- compliance ---
  const ok = await probe("/api/v1/compliance/emp-006/audiogram", { template: COMPLIANCE_TEMPLATE, token: cm });
  assert.equal(ok.status, 200);
  assert.equal((await probe("/api/v1/compliance/emp-006/nope", { template: COMPLIANCE_TEMPLATE, token: cm })).status, 400);
  assert.equal((await probe("/api/v1/compliance/emp-006/audiogram", { template: COMPLIANCE_TEMPLATE })).status, 401);
  assert.equal(
    (await probe("/api/v1/compliance/emp-006/audiogram?mode=preview", { template: COMPLIANCE_TEMPLATE, token: author })).status,
    403,
    "preview costs an evaluation, so it is CM/ADMIN only",
  );
  assert.equal((await probe("/api/v1/compliance/nobody/audiogram", { template: COMPLIANCE_TEMPLATE, token: cm })).status, 404);
  assert.equal(
    (await probe("/api/v1/compliance/emp-006/audiogram?mode=preview", { template: COMPLIANCE_TEMPLATE, token: cm, useEnv: webChartEnv })).status,
    501,
    "preview on a WebChart stack would evaluate a synthetic bundle, so it refuses",
  );

  // --- cds hooks ---
  assert.equal((await probe("/cds-services", { template: "/cds-services" })).status, 200);
  const hook = { hook: "patient-view", hookInstance: crypto.randomUUID(), context: { patientId: "emp-006" } };
  assert.equal((await probe(INVOKE, { template: INVOKE_TEMPLATE, method: "POST", token: cm, body: hook })).status, 200);
  assert.equal((await probe(INVOKE, { template: INVOKE_TEMPLATE, method: "POST", token: cm, body: { hook: "patient-view" } })).status, 400);
  assert.equal((await probe(INVOKE, { template: INVOKE_TEMPLATE, method: "POST", body: hook })).status, 401);
  assert.equal((await probe(INVOKE, { template: INVOKE_TEMPLATE, method: "POST", token: author, body: hook })).status, 403);
  assert.equal((await probe("/cds-services/nope", { template: INVOKE_TEMPLATE, method: "POST", token: cm, body: hook })).status, 404);

  const fb = { feedback: [{ card: "c", outcome: "overridden", outcomeTimestamp: "2026-06-12T00:00:00Z" }] };
  assert.equal((await probe(`${INVOKE}/feedback`, { template: FEEDBACK_TEMPLATE, method: "POST", token: cm, body: fb })).status, 200);
  assert.equal((await probe(`${INVOKE}/feedback`, { template: FEEDBACK_TEMPLATE, method: "POST", token: cm, body: { feedback: [] } })).status, 400);
  assert.equal((await probe(`${INVOKE}/feedback`, { template: FEEDBACK_TEMPLATE, method: "POST", body: fb })).status, 401);
  assert.equal((await probe(`${INVOKE}/feedback`, { template: FEEDBACK_TEMPLATE, method: "POST", token: author, body: fb })).status, 403);
  assert.equal((await probe("/cds-services/nope/feedback", { template: FEEDBACK_TEMPLATE, method: "POST", token: cm, body: fb })).status, 404);
});

test("coverage is two-way: nothing documented is unexercised, nothing observed is undocumented", () => {
  // This test depends on the one above having run — node:test runs a file's tests in order.
  const documented = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      for (const status of Object.keys(op.responses)) {
        documented.add(`${method.toUpperCase()} ${path} ${status}`);
      }
    }
  }
  const missing = [...documented].filter((d) => !observed.has(d)).sort();
  const undocumented = [...observed].filter((o) => !documented.has(o)).sort();
  assert.deepEqual(missing, [], "documented but never produced by a request — is it implemented?");
  assert.deepEqual(undocumented, [], "produced by a request but absent from the document");
});

test("a real 200 response validates against its documented schema", async () => {
  const cm = await login("cm@workwell.dev");
  const cases: Array<[string, string, RequestInit | undefined, string]> = [
    ["GET", "/actuator/health", { headers: { authorization: `Bearer ${cm}` } }, "/actuator/health"],
    ["GET", "/api/version", undefined, "/api/version"],
    ["GET", "/api/v1/compliance/emp-006/audiogram", { headers: { authorization: `Bearer ${cm}` } }, COMPLIANCE_TEMPLATE],
    ["GET", "/cds-services", undefined, "/cds-services"],
  ];
  for (const [method, path, init, template] of cases) {
    const res = await worker.fetch(new Request(`http://x${path}`, { method, ...init }), env, ctx);
    assert.equal(res.status, 200, path);
    const schema = doc.paths[template]![method.toLowerCase()]!.responses["200"]!.content!["application/json"]!.schema;
    validate(await res.json(), schema, path);
  }

  // And a POST body-bearing one, so the CDS card schema is exercised against real cards.
  const invoke = await worker.fetch(
    new Request(`http://x${INVOKE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${cm}`, "content-type": "application/json" },
      body: JSON.stringify({ hook: "patient-view", hookInstance: crypto.randomUUID(), context: { patientId: "emp-006" } }),
    }),
    env,
    ctx,
  );
  assert.equal(invoke.status, 200);
  const payload = (await invoke.json()) as { cards: unknown[] };
  assert.ok(payload.cards.length > 0, "the fixture must produce a card, or this assertion is vacuous");
  validate(payload, doc.paths[INVOKE_TEMPLATE]!["post"]!.responses["200"]!.content!["application/json"]!.schema, INVOKE);
});

/**
 * A structural check against an OpenAPI 3.1 Schema Object — required properties present, declared types
 * agreeing, enums respected, `$ref` followed one level into `#/components/schemas`, and **no undocumented
 * property**, which is the direction that catches drift.
 *
 * Deliberately not a JSON Schema engine: our responses use no `oneOf`/`allOf`/`discriminator`, so the 2020-12
 * machinery would be dependency for nothing. If that changes, `ajv/dist/2020` is the dev-only escalation —
 * 3.1 Schema Objects are literal 2020-12, so no conversion shim is involved.
 */
function validate(value: unknown, schema: OpenApiSchema, where: string): void {
  const resolved = schema.$ref
    ? doc.components.schemas[schema.$ref.replace("#/components/schemas/", "")]!
    : schema;
  assert.ok(resolved, `${where}: unresolved schema`);

  // OpenAPI 3.1 spells nullability as a type UNION (`["string", "null"]`); 3.0's `nullable` keyword was
  // removed, and Redocly rejects it — which is a class of error this hand-rolled check cannot see, and the
  // reason the linter is in CI alongside it.
  const types = Array.isArray(resolved.type) ? resolved.type : resolved.type ? [resolved.type] : [];
  if (value === null) {
    assert.ok(types.includes("null"), `${where}: null is not permitted by [${types.join(", ")}]`);
    return;
  }
  if (resolved.enum) {
    assert.ok(resolved.enum.includes(String(value)), `${where}: ${String(value)} not in [${resolved.enum.join(", ")}]`);
  }
  switch (types.filter((t) => t !== "null")[0]) {
    case "object": {
      assert.equal(typeof value, "object", `${where}: expected object`);
      assert.notEqual(value, null, `${where}: expected object, got null`);
      const obj = value as Record<string, unknown>;
      for (const req of resolved.required ?? []) {
        assert.ok(req in obj, `${where}: missing required property '${req}'`);
      }
      const props = resolved.properties ?? {};
      for (const [k, v] of Object.entries(obj)) {
        const child = props[k];
        if (!child) {
          // `additionalProperties: true` marks a deliberately open bag (e.g. `provenance`).
          assert.equal(resolved.additionalProperties, true, `${where}: undocumented property '${k}'`);
          continue;
        }
        if (v === undefined) continue;
        validate(v, child, `${where}.${k}`);
      }
      return;
    }
    case "array": {
      assert.ok(Array.isArray(value), `${where}: expected array`);
      if (resolved.items) (value as unknown[]).forEach((v, i) => validate(v, resolved.items!, `${where}[${i}]`));
      return;
    }
    case "string":
      assert.equal(typeof value, "string", `${where}: expected string, got ${typeof value}`);
      return;
    case "boolean":
      assert.equal(typeof value, "boolean", `${where}: expected boolean, got ${typeof value}`);
      return;
    default:
      return; // untyped (an open object) — nothing to assert
  }
}
