/**
 * The versioned compliance API (M-C / C3, ADR-061).
 *   node --import tsx --test src/routes/compliance-api.test.ts
 *
 * The load-bearing test is "the population block agrees with the MeasureReport exporter". Everything else
 * here is contract shape; that one is the invariant — ADR-031 exists because two readers of
 * `evidence_json` that can disagree is a defect class, and this route is a new reader unless it provably
 * is not.
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
import { buildIndividualMeasureReport, membershipFor, officialMembership } from "../fhir/measure-report.ts";
import { authorize } from "../auth/authorize.ts";
import { getStores } from "../stores/factory.ts";
import { handleComplianceApi, parseCompliancePath, populationsSource, renderPopulations } from "./compliance-api.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";
import type { RunRecord } from "../stores/run-store.ts";

const dbPath = join(tmpdir(), `ww-compliance-api-${crypto.randomUUID()}.sqlite`);
let env: Record<string, unknown>;
let run: RunRecord;
let officialOutcome: OutcomeRecord;

/** The executor's own population vector, in the shape ADR-031 pins. */
const OFFICIAL_EVIDENCE = {
  official: {
    ecqmId: "CMS125FHIR",
    version: "1.0.000",
    engine: "fqm-execution",
    artifactSha256: "abc123",
    populationResults: [
      { populationType: "initial-population", result: true },
      { populationType: "denominator", result: true },
      { populationType: "denominator-exclusion", result: false },
      { populationType: "numerator", result: false },
    ],
  },
  expressionResults: [{ define: "Outcome Status", result: "OVERDUE" }],
};

const call = (path: string, method = "GET") =>
  handleComplianceApi(new Request(`http://x${path}`, { method }), env as never);

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const runStore = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  run = await runStore.createRun({
    scopeType: "MEASURE", scopeId: "cms125", triggeredBy: "test", requestedScope: { measureId: "cms125" },
    measurementPeriodStart: "2026-06-12T00:00:00.000Z", measurementPeriodEnd: "2026-06-12T00:00:00.000Z",
  });
  // The run must be FINALIZED — `latest` refuses a mid-run row (ADR-061, review #399).
  await runStore.finalizeRun(run.id, "COMPLETED");
  run = (await runStore.getRun(run.id))!;
  officialOutcome = await outcomes.recordOutcome({
    runId: run.id, subjectId: "emp-006", measureId: "cms125", status: "OVERDUE",
    evaluationPeriod: "2026-06-12", evidence: OFFICIAL_EVIDENCE,
  });
  // An AUTHORED outcome — only the initial population is real; the rest are status-derived.
  await outcomes.recordOutcome({
    runId: run.id, subjectId: "emp-007", measureId: "audiogram", status: "COMPLIANT",
    evaluationPeriod: "2026-06-12", evidence: { expressionResults: [{ define: "Initial Population", result: true }] },
  });
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("the path matcher claims only its own shape", () => {
  assert.deepEqual(parseCompliancePath("/api/v1/compliance/emp-006/cms125"), { subjectId: "emp-006", measureId: "cms125" });
  // Percent-encoded ids must survive — a WebChart subject id can carry a `|`.
  assert.deepEqual(parseCompliancePath("/api/v1/compliance/wc%7C123/cms125"), { subjectId: "wc|123", measureId: "cms125" });
  for (const p of ["/api/compliance/roster", "/api/v1/compliance", "/api/v1/compliance/a", "/api/v1/compliance/a/b/c", "/api/v2/compliance/a/b"]) {
    assert.equal(parseCompliancePath(p), null, `${p} must not be claimed`);
  }
});

test("a non-matching path returns null so the worker keeps dispatching", async () => {
  assert.equal(await call("/api/compliance/roster"), null);
});

test("GET latest → status, populations and provenance", async () => {
  const res = (await call("/api/v1/compliance/emp-006/cms125"))!;
  assert.equal(res.status, 200);
  const b = (await res.json()) as Record<string, never>;
  assert.equal(b["status"], "OVERDUE");
  assert.deepEqual(b["subject"], { id: "emp-006" });
  assert.deepEqual(b["populations"], {
    initialPopulation: true, denominator: true, denominatorExclusion: false,
    denominatorException: false, numerator: false,
  });
  assert.equal(b["populationsSource"], "official-evidence");
  const prov = b["provenance"] as unknown as Record<string, unknown>;
  assert.equal(prov["mode"], "latest");
  assert.equal(prov["artifactSha256"], "abc123");
  // Identity comes from the outcome's OWN evidence (ADR-046), never a config flag.
  const measure = b["measure"] as unknown as Record<string, unknown>;
  assert.equal(measure["ecqmId"], "CMS125FHIR");
  assert.equal(measure["version"], "1.0.000");
});

test("THE INVARIANT: the API RESPONSE agrees with the MeasureReport exporter", async () => {
  // A first cut compared `renderPopulations(membershipFor(x))` against `buildIndividualMeasureReport(x)`
  // — and the exporter IS `asCounts(membershipFor(x))`, so it compared f(x) to render(f(x)) and could not
  // fail (review, #399). It also let an ABSENT exporter key pass as `false`, since `undefined === 1` is
  // false, which is how `denominator-exception` slipped through: the exporter emits it only when > 0
  // while the API always emits the key.
  //
  // Now it calls the ROUTE and compares the parsed JSON body, with every population asserted explicitly
  // including the one whose shapes genuinely differ.
  const b = (await (await call("/api/v1/compliance/emp-006/cms125"))!.json()) as Record<string, never>;
  const pops = b["populations"] as unknown as Record<string, boolean>;

  const report = buildIndividualMeasureReport(officialOutcome, run, "cms125", "2026-06-12T00:00:00.000Z");
  const counts = Object.fromEntries(report.group[0]!.population.map((p) => [p.code.coding[0]!.code, p.count]));
  // An absent key means the exporter omitted a zero — `?? 0` makes that explicit instead of relying on
  // `undefined === 1` being false.
  const exported = (code: string) => (counts[code] ?? 0) === 1;

  assert.equal(pops["initialPopulation"], exported("initial-population"));
  assert.equal(pops["denominator"], exported("denominator"));
  assert.equal(pops["numerator"], exported("numerator"));
  assert.equal(pops["denominatorExclusion"], exported("denominator-exclusion"));
  assert.equal(pops["denominatorException"], exported("denominator-exception"));

  // And the same property over an AUTHORED record, where membershipFor takes its other branch.
  const authoredOutcome = { ...officialOutcome, measureId: "audiogram", status: "COMPLIANT", evidence: {} };
  const a2 = (await (await call("/api/v1/compliance/emp-007/audiogram"))!.json()) as Record<string, never>;
  const authoredReport = buildIndividualMeasureReport(authoredOutcome, run, "audiogram", "2026-06-12T00:00:00.000Z");
  const ac = Object.fromEntries(authoredReport.group[0]!.population.map((p) => [p.code.coding[0]!.code, p.count]));
  assert.equal((a2["populations"] as unknown as Record<string, boolean>)["initialPopulation"], (ac["initial-population"] ?? 0) === 1);
});

test("populationsSource distinguishes measured membership from inferred", () => {
  assert.equal(populationsSource(OFFICIAL_EVIDENCE), "official-evidence");
  assert.equal(populationsSource({ expressionResults: [] }), "status-derived");
  assert.equal(populationsSource(null), "status-derived");
  // The label must track the FIELD the membership reader branches on, not the measure id — an authored
  // measure could in principle carry official evidence and vice versa.
  assert.equal(populationsSource({ official: {} }), "status-derived");
});

test("an authored outcome is labelled status-derived", async () => {
  const b = (await (await call("/api/v1/compliance/emp-007/audiogram"))!.json()) as Record<string, never>;
  assert.equal(b["populationsSource"], "status-derived");
  assert.equal(b["status"], "COMPLIANT");
});

test("no outcome is a 404 that says WHICH absence it is", async () => {
  const res = (await call("/api/v1/compliance/emp-999/cms125"))!;
  assert.equal(res.status, 404);
  const b = (await res.json()) as { error: string; message: string };
  assert.equal(b.error, "no_outcome");
  // The distinction that keeps this API safe: "nobody evaluated this" must never read as "compliant".
  assert.match(b.message, /not a compliance answer/);
  assert.match(b.message, /preview/);
});

test("the period filter excludes an out-of-range outcome rather than ignoring it", async () => {
  assert.equal((await call("/api/v1/compliance/emp-006/cms125?start=2020-01-01&end=2020-12-31"))!.status, 404);
  assert.equal((await call("/api/v1/compliance/emp-006/cms125?start=2026-01-01&end=2026-12-31"))!.status, 200);
});

test("malformed input is a 400 naming the field", async () => {
  assert.equal((await call("/api/v1/compliance/emp-006/not-a-measure"))!.status, 400);
  assert.equal((await call("/api/v1/compliance/emp-006/cms125?start=yesterday"))!.status, 400);
  assert.equal((await call("/api/v1/compliance/emp-006/cms125?start=2026-12-01&end=2026-01-01"))!.status, 400);
  assert.equal((await call("/api/v1/compliance/emp-006/cms125?mode=guess"))!.status, 400);
  assert.equal((await call("/api/v1/compliance/emp-006/cms125", "POST"))!.status, 405);
});

test("the route is AUTHENTICATED — an anonymous request never reaches it", () => {
  // The generic `/api/**` fallback already covers this, so no new rule was added. Asserted anyway,
  // because RULES is first-match-wins: a later reordering could put a PERMIT ahead of it, and this API
  // returns per-subject clinical status.
  assert.deepEqual(authorize("GET", "/api/v1/compliance/emp-006/cms125", null), { ok: false, status: 401 });
  assert.deepEqual(
    authorize("GET", "/api/v1/compliance/emp-006/cms125", { sub: "u", role: "ROLE_CASE_MANAGER" } as never),
    { ok: true },
  );
});

test("latest REFUSES a row from a run that is not finalized", async () => {
  // A row exists as soon as the evaluation loop writes it — before the run is terminal, and before
  // /finalize in the QRDA import flow. Serving one would publish a partial result as the contract answer
  // and would silently become wrong if the run later FAILED (review, #399).
  const runStore = new SqliteRunStore((env as { DB: never }).DB);
  const outcomes = new SqliteOutcomeStore((env as { DB: never }).DB);
  const pending = await runStore.createRun({
    scopeType: "MEASURE", scopeId: "cms125", triggeredBy: "test", requestedScope: { measureId: "cms125" },
    measurementPeriodStart: "2026-07-01T00:00:00.000Z", measurementPeriodEnd: "2026-07-01T00:00:00.000Z",
  });
  await outcomes.recordOutcome({
    runId: pending.id, subjectId: "emp-mid-run", measureId: "cms125", status: "COMPLIANT",
    evaluationPeriod: "2026-07-01", evidence: { expressionResults: [] },
  });
  const res = (await call("/api/v1/compliance/emp-mid-run/cms125"))!;
  assert.equal(res.status, 404, "a RUNNING run's outcome is not an answer yet");
  const b = (await res.json()) as { error: string; message: string; pendingRuns?: number };
  assert.equal(b.error, "no_outcome");
  assert.equal(b.pendingRuns, 1, "the count of skipped non-final rows must be reported, not hidden");
  assert.match(b.message, /not finalized/);

  // ...and it becomes the answer the moment the run finalizes. Same row, same request.
  await runStore.finalizeRun(pending.id, "COMPLETED");
  assert.equal((await call("/api/v1/compliance/emp-mid-run/cms125"))!.status, 200);
});

test("populationsSource tracks what membershipFor actually DID, not whether a field exists", async () => {
  // The field was added so a consumer can tell measured membership from inferred. A first cut checked
  // `official.populationResults != null`, which is weaker than the condition `membershipFor` branches on
  // — a MALFORMED vector falls back to status-derived booleans while the label still said
  // official-evidence. The honesty field, lying (review, #399).
  const malformed = { official: { populationResults: "not-an-array-or-object" } };
  assert.equal(populationsSource(malformed), "status-derived");
  // And the two must agree on the same input, which is the property that makes them incapable of drifting.
  assert.equal(officialMembership(malformed), null);
  assert.equal(populationsSource(OFFICIAL_EVIDENCE), "official-evidence");
  assert.notEqual(officialMembership(OFFICIAL_EVIDENCE), null);
});

test("preview is refused for a role that may not trigger compute", async () => {
  // authorize.ts states the viewer posture as "may GET but never write ... or trigger compute". A GET
  // that costs a CQL evaluation is the loophole in that sentence (review, #399).
  const res = (await handleComplianceApi(
    new Request("http://x/api/v1/compliance/emp-001/audiogram?mode=preview"),
    env as never,
    "ROLE_VIEWER",
  ))!;
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as { message: string }).message, /mode=latest is available/);
  // latest stays open to that role — it is a read of an existing row.
  assert.equal(
    (await handleComplianceApi(new Request("http://x/api/v1/compliance/emp-006/cms125"), env as never, "ROLE_VIEWER"))!.status,
    200,
  );
  // CM may preview.
  assert.equal(
    (await handleComplianceApi(new Request("http://x/api/v1/compliance/emp-001/audiogram?mode=preview"), env as never, "ROLE_CASE_MANAGER"))!.status,
    200,
  );
});

test("preview evaluates NOW and says plainly that nothing was written", async () => {
  // emp-001 is in the synthetic directory; audiogram has a binding. The point of this test is not the
  // outcome value (the seeded target decides that) but that the mode runs end to end through the ROUTED
  // engine and labels itself honestly.
  const res = (await call("/api/v1/compliance/emp-001/audiogram?mode=preview"))!;
  assert.equal(res.status, 200);
  const b = (await res.json()) as Record<string, never>;
  const prov = b["provenance"] as unknown as Record<string, unknown>;
  assert.equal(prov["mode"], "preview");
  assert.equal(prov["runId"], null, "a preview has no run — the field must be null, not absent");
  assert.equal(prov["persisted"], false, "stated, not implied");
  assert.ok(typeof b["status"] === "string" && (b["status"] as string).length > 0);
  assert.ok(b["populations"], "a preview answers the same shape as latest");
});

test("preview refuses an unknown subject rather than inventing one", async () => {
  const res = (await call("/api/v1/compliance/nobody-here/audiogram?mode=preview"))!;
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { error: string }).error, "unknown_subject");
});

test("preview writes NOTHING — a REGRESSION guard, not a proof", async () => {
  // Stated accurately (review, #399): `preview()` has no reachable writer today, so this cannot fail as
  // written. It is here to fire the day someone wires a store into that path — which is a real risk,
  // since `latest` right beside it does take one — not to prove the current claim.
  const outcomes = new SqliteOutcomeStore((env as { DB: never }).DB);
  const before = (await outcomes.listOutcomesForEmployee("emp-001", 500)).length;
  await call("/api/v1/compliance/emp-001/audiogram?mode=preview");
  assert.equal((await outcomes.listOutcomesForEmployee("emp-001", 500)).length, before);
});

test("preview REFUSES on a WebChart-configured stack rather than answering from synthetic data", async () => {
  // The critical finding (review, #399): preview composes a SYNTHETIC bundle via seededTargetFor, which
  // picks the intended outcome from a hash of the subject id. On a live stack a run uses the patient's
  // real FHIR bundle, so preview would have been demo playback reported as an evaluation — through the
  // contract MIE consumes.
  const liveEnv = { ...env, WORKWELL_WEBCHART_BASE_URL: "https://wc.example", WORKWELL_WEBCHART_API_KEY: "k" };
  const res = (await handleComplianceApi(
    new Request("http://x/api/v1/compliance/emp-001/audiogram?mode=preview"),
    liveEnv as never,
    "ROLE_ADMIN",
  ))!;
  assert.equal(res.status, 501);
  const b = (await res.json()) as { error: string; message: string };
  assert.equal(b.error, "preview_unavailable");
  assert.match(b.message, /SYNTHETIC/);
  // latest still works there — it reads what a run actually computed over live data.
  assert.equal(
    (await handleComplianceApi(new Request("http://x/api/v1/compliance/emp-006/cms125"), liveEnv as never, "ROLE_ADMIN"))!.status,
    200,
  );
});

test("`period` is the ANSWER's measurement window; `filter` is the caller's own bounds", async () => {
  // A first cut returned the request filter as `period`, directly above `provenance.evaluationPeriod`,
  // and never documented it — an integrator would read it as the result's measurement period, and in a
  // v1 contract a field cannot later change meaning (review, #399).
  const b = (await (await call("/api/v1/compliance/emp-006/cms125?start=2026-01-01&end=2026-12-31"))!.json()) as Record<string, never>;
  assert.deepEqual(b["filter"], { start: "2026-01-01", end: "2026-12-31" }, "the caller's bounds, echoed");
  const period = b["period"] as unknown as { start: string | null; end: string | null };
  assert.equal(period.start, run.measurementPeriodStart, "the RUN's measurement period, not the filter");
  assert.equal(period.end, run.measurementPeriodEnd);
});

test("a malformed percent-escape is a 400, not a 500", async () => {
  const res = (await call("/api/v1/compliance/%E0%A4%A/cms125"))!;
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, "invalid_request");
});

test("preview refuses `start` rather than silently discarding it", async () => {
  const res = (await handleComplianceApi(
    new Request("http://x/api/v1/compliance/emp-001/audiogram?mode=preview&start=2026-01-01"),
    env as never,
    "ROLE_ADMIN",
  ))!;
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { message: string }).message, /does not apply to mode=preview/);
});

test("every answered request writes an audit event", async () => {
  // MCP records one for every tool call; without this there is no record that anyone read a patient's
  // compliance status through the contract MIE consumes (review, #399).
  const stores = await getStores(env as never);
  const count = async () =>
    (await stores.events.listAuditEvents(1000)).filter((e) => e.eventType === "COMPLIANCE_API_READ").length;
  const before = await count();
  await call("/api/v1/compliance/emp-006/cms125");
  assert.equal(await count(), before + 1, "a latest read must be recorded");
  // A 404 is a read too — enumeration attempts must not be the silent case.
  await call("/api/v1/compliance/emp-nobody/cms125");
  assert.equal(await count(), before + 2);
});
