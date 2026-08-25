/**
 * The `$cql` Evaluation Service route (#474).
 *   node --import tsx --test src/routes/cql-evaluation.test.ts
 *
 * Two assertions matter most. **The auth rule**: `POST /$cql` is outside `/api/`, where `authorize`
 * ends in permitAll — exactly the CDS Hooks hazard (ADR-067), except this endpoint executes
 * caller-supplied CQL, so anonymous access would be an open compute service. Asserted as pure
 * `authorize` calls so it cannot be confused with handler behaviour. **The error split**: a
 * TRANSLATION failure is a 400 (the request itself is bad), while a RUNTIME failure is a 200 whose
 * body carries the `evaluation error` parameter — that split is what `cql-tests-runner` grades
 * `invalid="semantic"` vs `invalid="true"` cases on, and collapsing them misgrades both.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { authorize } from "../auth/authorize.ts";
import { handleCqlEvaluation } from "./cql-evaluation.ts";
import type { JwtPrincipal } from "../auth/jwt.ts";

const call = (body: unknown, init: RequestInit = {}) =>
  handleCqlEvaluation(
    new Request("http://x/$cql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...init,
    }),
  );

const cqlRequest = (expression: string, extra: unknown[] = []) => ({
  resourceType: "Parameters",
  parameter: [{ name: "expression", valueString: expression }, ...extra],
});

function returnParams(body: { parameter?: unknown[] }): Record<string, unknown>[] {
  return (body.parameter ?? []) as Record<string, unknown>[];
}

test("POST /$cql evaluates a data-free expression and answers a Parameters `return`", async () => {
  const res = await call(cqlRequest("1 + 2"));
  assert.ok(res, "the handler must claim POST /$cql");
  assert.equal(res!.status, 200);
  const body = (await res!.json()) as { resourceType: string; parameter?: unknown[] };
  assert.equal(body.resourceType, "Parameters");
  assert.deepEqual(returnParams(body), [{ name: "return", valueInteger: 3 }]);
});

test("a translation failure is a 400 OperationOutcome carrying the diagnostic", async () => {
  const res = await call(cqlRequest("1 +"));
  assert.equal(res!.status, 400);
  const body = (await res!.json()) as { resourceType: string; issue: { diagnostics?: string }[] };
  assert.equal(body.resourceType, "OperationOutcome");
  assert.ok(body.issue.length > 0, "the translator's diagnostics must reach the caller");
});

test("a runtime failure is HTTP 200 whose body says `evaluation error`", async () => {
  // `singleton from` over a two-element list is a genuine cql-execution runtime throw (probed —
  // `Message` with severity Error does NOT throw there: its default listener is a no-op).
  const res = await call(cqlRequest("singleton from {1, 2}"));
  assert.equal(res!.status, 200);
  const body = (await res!.json()) as { parameter?: { name: string; resource?: { issue?: { diagnostics?: string }[] } }[] };
  const errorParam = (body.parameter ?? []).find((p) => p.name === "evaluation error");
  assert.ok(errorParam, "runtime errors are in-band per the Evaluation Service convention");
  assert.ok(String(errorParam!.resource?.issue?.[0]?.diagnostics ?? "").length > 0, "the message must reach the caller");
});

test("a request with no expression parameter is a 400, not a crash", async () => {
  const res = await call({ resourceType: "Parameters", parameter: [] });
  assert.equal(res!.status, 400);
  const body = (await res!.json()) as { resourceType: string };
  assert.equal(body.resourceType, "OperationOutcome");
});

test("unsupported operation inputs are REFUSED by name, never silently ignored", async () => {
  // `subject`/`data` imply patient-context evaluation this data-free service does not perform;
  // accepting and ignoring them would return an answer that LOOKS patient-specific and is not —
  // the ADR-061 mode=preview 501 refusal, in a new place.
  const res = await call(cqlRequest("1 + 2", [{ name: "subject", valueString: "Patient/123" }]));
  assert.equal(res!.status, 400);
  const body = (await res!.json()) as { issue: { diagnostics?: string }[] };
  assert.match(String(body.issue[0]?.diagnostics ?? ""), /subject/);
});

test("unparseable JSON is a 400 OperationOutcome", async () => {
  const res = await handleCqlEvaluation(
    new Request("http://x/$cql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }),
  );
  assert.equal(res!.status, 400);
});

test("other paths fall through; a non-POST on /$cql is 405", async () => {
  const misses = await handleCqlEvaluation(new Request("http://x/api/other", { method: "POST" }));
  assert.equal(misses, null);
  const wrongMethod = await handleCqlEvaluation(new Request("http://x/$cql", { method: "GET" }));
  assert.equal(wrongMethod!.status, 405);
});

test("statement injection is REFUSED, not analyzed-harmless: a second define is a 400", async () => {
  // The expression is interpolated after `define Result:`. CQL's grammar already blocks injected
  // declarations (include/using/valueset must precede the first statement), but additional
  // STATEMENTS compile and are evaluated by the executor. The def-count guard turns that from
  // "measured to have no escalation" into "refused".
  const res = await call(cqlRequest("1\ndefine Evil: 2"));
  assert.equal(res!.status, 400);
  const body = (await res!.json()) as { issue: { diagnostics?: string }[] };
  assert.match(String(body.issue[0]?.diagnostics ?? ""), /single expression/i);
});

test("a body that is not a Parameters resource is a 400 (the documented schema is enforced)", async () => {
  const res = await call({ parameter: [{ name: "expression", valueString: "1" }] });
  assert.equal(res!.status, 400);
});

test("an oversized expression is 413 before it reaches the translator (Codex P1)", async () => {
  // /api/measures/compile bounds the same in-process translator at 64 KiB (measures.ts
  // MAX_CQL_BYTES); an unbounded expression here would let one authenticated client block the
  // long-lived worker on synchronous translation.
  const res = await call(cqlRequest(`'${"x".repeat(65 * 1024)}'`));
  assert.equal(res!.status, 413);
  const body = (await res!.json()) as { resourceType: string };
  assert.equal(body.resourceType, "OperationOutcome");
});

test("the auth rule exists: anonymous POST /$cql is 401, machine-client roles pass", () => {
  const admin: JwtPrincipal = { email: "a@workwell.dev", role: "ROLE_ADMIN" } as JwtPrincipal;
  const cm: JwtPrincipal = { email: "cm@workwell.dev", role: "ROLE_CASE_MANAGER" } as JwtPrincipal;
  const mcp: JwtPrincipal = { email: "m@workwell.dev", role: "ROLE_MCP_CLIENT" } as JwtPrincipal;
  const author: JwtPrincipal = { email: "au@workwell.dev", role: "ROLE_AUTHOR" } as JwtPrincipal;

  // `/$cql` is outside `/api/`, where `authorize` otherwise ends in permitAll — this assertion is the
  // whole reason the rule exists (same shape as the CDS Hooks rules, ADR-067).
  assert.deepEqual(authorize("POST", "/$cql", null), { ok: false, status: 401 });
  assert.deepEqual(authorize("POST", "/$cql", admin), { ok: true });
  assert.deepEqual(authorize("POST", "/$cql", cm), { ok: true });
  assert.deepEqual(authorize("POST", "/$cql", mcp), { ok: true });
  assert.deepEqual(authorize("POST", "/$cql", author), { ok: false, status: 403 });
});
