/**
 * Impact-preview integration (#108): dry-run evaluation over a small injected population through the
 * real JVM-free engine + case-impact estimate vs seeded open cases. No persistence of outcomes.
 *   node --import tsx --test src/measure/impact-preview.test.ts
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
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import type { MeasureRecord } from "../stores/measure-store.ts";
import { previewImpact, ImpactPreviewError, type ImpactPreviewDeps } from "./impact-preview.ts";

const dbPath = join(tmpdir(), `workwell-impact-${crypto.randomUUID()}.sqlite`);
let db: import("@mieweb/cloud").CloudDatabase;
let deps: ImpactPreviewDeps;

// emp-001..004 (HQ) keeps the real-engine eval fast.
const population = EMPLOYEES.slice(0, 4);

function audiogram(): MeasureRecord {
  return {
    measureId: "audiogram",
    name: "Audiogram",
    policyRef: "OSHA 29 CFR 1910.95",
    owner: "system",
    tags: [],
    versionId: "audiogram-v1.0",
    version: "v1.0",
    status: "Active",
    spec: { description: "", eligibilityCriteria: { roleFilter: "", siteFilter: "", programEnrollmentText: "" }, exclusions: [], complianceWindow: "Annual", requiredDataElements: [], testFixtures: [] },
    cqlText: "",
    compileStatus: "COMPILED",
    changeSummary: null,
    approvedBy: null,
    activatedAt: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
  };
}

before(async () => {
  db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  deps = { cases: new SqliteCaseStore(db), events: new SqliteCaseEventStore(db), engine: new CqlExecutionEngine(), employees: population };
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

test("previews the population without persisting; counts + breakdowns + audit", async () => {
  const r = await previewImpact(deps, audiogram(), { evaluationDate: "2090-01-01" }, "approver@x");
  assert.equal(r.measureId, "audiogram");
  assert.equal(r.populationEvaluated, 4);
  assert.equal(sum(r.outcomeCounts), 4, "every subject counted exactly once");
  // emp-001..004 are all site HQ → one site row summing to 4
  assert.equal(r.siteBreakdown.length, 1);
  assert.equal(r.siteBreakdown[0]!.site, "HQ");
  assert.ok(r.roleBreakdown.length >= 1);
  // no outcomes were persisted (dry run)
  assert.equal((await new SqliteRunStore(db).listRuns(100)).length, 0, "no run created");
  // audit event written
  const audits = await new SqliteCaseEventStore(db).listAuditEvents();
  const ev = audits.find((a) => a.eventType === "MEASURE_IMPACT_PREVIEWED")!;
  assert.ok(ev, "MEASURE_IMPACT_PREVIEWED written");
  assert.equal(ev.actor, "approver@x");
  assert.equal((ev.payload as { dryRun: boolean }).dryRun, true);
});

test("case impact: non-compliant with no existing case → wouldCreate; with an open case → wouldUpdate", async () => {
  const period = "2091-02-02";
  const first = await previewImpact(deps, audiogram(), { evaluationDate: period });
  const nonCompliant = (first.outcomeCounts.DUE_SOON ?? 0) + (first.outcomeCounts.OVERDUE ?? 0) + (first.outcomeCounts.MISSING_DATA ?? 0);
  assert.equal(first.caseImpact.wouldUpdate, 0, "no existing cases yet");
  assert.equal(first.caseImpact.wouldCreate, nonCompliant, "all non-compliant would create");

  if (nonCompliant > 0) {
    // Seed an open case for a real run so one non-compliant subject already has a case.
    const run = await new SqliteRunStore(db).createRun({ scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "t", requestedScope: {}, measurementPeriodStart: period, measurementPeriodEnd: period });
    // find a non-compliant subject from a fresh preview's breakdown is hard; seed cases for all 4 at this period
    for (const e of population) {
      await new SqliteCaseStore(db).upsertFromOutcome({ runId: run.id, subjectId: e.externalId, measureId: "audiogram", evaluationPeriod: period, outcomeStatus: "OVERDUE" });
    }
    const second = await previewImpact(deps, audiogram(), { evaluationDate: period });
    assert.equal(second.caseImpact.wouldCreate, 0, "all non-compliant now have open cases");
    assert.equal(second.caseImpact.wouldUpdate, nonCompliant, "non-compliant now update existing cases");
  }
});

test("scope filter narrows the population; an empty match warns", async () => {
  const hq = await previewImpact(deps, audiogram(), { evaluationDate: "2092-03-03", scope: { site: "HQ" } });
  assert.equal(hq.populationEvaluated, 4);
  const none = await previewImpact(deps, audiogram(), { evaluationDate: "2092-03-03", scope: { site: "Atlantis" } });
  assert.equal(none.populationEvaluated, 0);
  assert.ok(none.warnings.some((w) => /no employees matched/i.test(w)));
});

test("rejects malformed AND impossible calendar dates (400)", async () => {
  for (const bad of ["06/15/2026", "2026-13-01", "2026-02-30", "2026-00-10", "not-a-date"]) {
    await assert.rejects(previewImpact(deps, audiogram(), { evaluationDate: bad }), ImpactPreviewError, `should reject ${bad}`);
  }
});

test("a non-runnable measure returns an empty preview with a warning AND still writes a dry-run audit", async () => {
  const draft = { ...audiogram(), measureId: "cms2v15", versionId: "cms2v15-v1.0" };
  const r = await previewImpact(deps, draft, { evaluationDate: "2093-04-04" }, "approver@x");
  assert.equal(r.populationEvaluated, 0);
  assert.ok(r.warnings.some((w) => /no runnable CQL binding/i.test(w)));
  const audits = await new SqliteCaseEventStore(db).listAuditEvents();
  const ev = audits.find((a) => a.eventType === "MEASURE_IMPACT_PREVIEWED" && (a.payload as { measureVersionId: string }).measureVersionId === "cms2v15-v1.0");
  assert.ok(ev, "non-runnable preview still audited");
  assert.equal((ev!.payload as { populationEvaluated: number; dryRun: boolean }).populationEvaluated, 0);
  assert.equal((ev!.payload as { dryRun: boolean }).dryRun, true);
});

test("an engine failure returns an empty preview + warning AND writes a dry-run audit", async () => {
  const failing: ImpactPreviewDeps = {
    ...deps,
    engine: { async evaluate() { throw new Error("engine down"); } },
  };
  const r = await previewImpact(failing, audiogram(), { evaluationDate: "2094-05-05" }, "approver@x");
  assert.equal(r.populationEvaluated, 0);
  assert.ok(r.warnings.some((w) => /CQL evaluation failed/i.test(w)));
  const audits = await new SqliteCaseEventStore(db).listAuditEvents();
  assert.ok(
    audits.some((a) => a.eventType === "MEASURE_IMPACT_PREVIEWED" && (a.payload as { evaluationDate: string }).evaluationDate === "2094-05-05"),
    "eval-failure preview still audited",
  );
});
