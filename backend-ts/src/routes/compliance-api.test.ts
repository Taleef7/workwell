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
import { buildIndividualMeasureReport, membershipFor } from "../fhir/measure-report.ts";
import { authorize } from "../auth/authorize.ts";
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

test("THE INVARIANT: the population block agrees with the MeasureReport exporter", () => {
  // If these two ever disagree, one of them is lying about the same persisted evidence. Asserted against
  // the exporter's real output rather than a hand-written expectation, so the test cannot drift into
  // agreeing with a bug in either.
  const report = buildIndividualMeasureReport(officialOutcome, run, "cms125", "2026-06-12T00:00:00.000Z");
  const fromExporter = Object.fromEntries(report.group[0]!.population.map((p) => [p.code.coding[0]!.code, p.count]));
  // The same helper the route uses, over the same record.
  const fromApi = renderPopulations(membershipFor(officialOutcome, "cms125"));
  assert.equal(fromApi.initialPopulation, fromExporter["initial-population"] === 1);
  assert.equal(fromApi.denominator, fromExporter["denominator"] === 1);
  assert.equal(fromApi.numerator, fromExporter["numerator"] === 1);
  assert.equal(fromApi.denominatorExclusion, fromExporter["denominator-exclusion"] === 1);
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

test("preview writes NOTHING — the outcome count is unchanged after one", async () => {
  // The claim `persisted: false` makes is worth checking rather than trusting: a preview that quietly
  // recorded an outcome would corrupt the audit trail and every downstream count.
  const outcomes = new SqliteOutcomeStore((env as { DB: never }).DB);
  const before = (await outcomes.listOutcomesForEmployee("emp-001", 500)).length;
  await call("/api/v1/compliance/emp-001/audiogram?mode=preview");
  assert.equal((await outcomes.listOutcomesForEmployee("emp-001", 500)).length, before);
});
