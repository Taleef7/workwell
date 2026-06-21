/**
 * Run read-model unit tests (#107) — the RunListItem/RunSummary contract math.
 *   node --import tsx --test src/run/read-models.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toRunListItem, toRunSummary, toRunLogEntries, matchesRunFilters, toRunOutcomeRows } from "./read-models.ts";
import type { RunRecord } from "../stores/run-store.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "run-1",
  status: "COMPLETED",
  scopeType: "MEASURE",
  scopeId: "audiogram",
  triggeredBy: "manual",
  site: null,
  requestedScope: {},
  startedAt: "2026-06-13T10:00:00.000Z",
  completedAt: "2026-06-13T10:00:05.000Z",
  measurementPeriodStart: "2025-06-13T00:00:00.000Z",
  measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  ...over,
});

const outcome = (status: string, evaluatedAt: string): OutcomeRecord => ({
  id: crypto.randomUUID(),
  runId: "run-1",
  subjectId: "emp-1",
  measureId: "audiogram",
  evaluationPeriod: "2026-06-13",
  status,
  evidence: {},
  evaluatedAt,
});

const sample: OutcomeRecord[] = [
  outcome("COMPLIANT", "2026-06-13T10:00:01.000Z"),
  outcome("COMPLIANT", "2026-06-13T10:00:02.000Z"),
  outcome("OVERDUE", "2026-06-13T10:00:03.000Z"),
  outcome("MISSING_DATA", "2026-06-13T10:00:04.000Z"),
  outcome("EXCLUDED", "2026-06-13T10:00:04.500Z"),
];

test("toRunListItem resolves measure name + counts (EXCLUDED is neither compliant nor not)", () => {
  const item = toRunListItem(run(), sample);
  assert.equal(item.measureName, "Audiogram");
  assert.equal(item.totalEvaluated, 5);
  assert.equal(item.compliantCount, 2);
  assert.equal(item.nonCompliantCount, 2); // OVERDUE + MISSING_DATA, not EXCLUDED
  assert.equal(item.durationMs, 5000);
  assert.equal(item.triggerType, "MANUAL");
});

test("triggerType reflects triggered_by — seed runs surface as SEED, not MANUAL (Codex P2)", () => {
  assert.equal(toRunListItem(run({ triggeredBy: "manual" }), sample).triggerType, "MANUAL");
  assert.equal(toRunListItem(run({ triggeredBy: "rerun" }), sample).triggerType, "MANUAL");
  assert.equal(toRunListItem(run({ triggeredBy: "seed:trend-history" }), sample).triggerType, "SEED");
  // …and the run-list filter matches on the derived triggerType.
  assert.equal(matchesRunFilters(run({ triggeredBy: "seed:trend-history" }), { triggerType: "MANUAL" }), false);
  assert.equal(matchesRunFilters(run({ triggeredBy: "seed:trend-history" }), { triggerType: "SEED" }), true);
  assert.equal(matchesRunFilters(run({ triggeredBy: "manual" }), { triggerType: "MANUAL" }), true);
});

test("toRunSummary computes passRate as a percentage + outcomeCounts + freshness + version", () => {
  const s = toRunSummary(run(), sample);
  assert.equal(s.measureVersion, "1.0.0");
  assert.equal(s.passRate, 40); // 2 compliant of 5 → 40%
  assert.equal(s.totalCases, 0);
  assert.equal(s.dataFreshAsOf, "2026-06-13T10:00:04.500Z"); // MAX(evaluated_at)
  const counts = Object.fromEntries(s.outcomeCounts.map((c) => [c.status, c.count]));
  assert.deepEqual(counts, { COMPLIANT: 2, OVERDUE: 1, MISSING_DATA: 1, EXCLUDED: 1 });
});

test("an ALL_PROGRAMS run (no scopeId) is labelled 'All Programs', and empty runs read cleanly", () => {
  const s = toRunSummary(run({ scopeType: "ALL_PROGRAMS", scopeId: null }), []);
  assert.equal(s.measureName, "All Programs");
  assert.equal(s.measureVersion, "");
  assert.equal(s.passRate, 0);
  assert.equal(s.totalEvaluated, 0);
  assert.equal(s.dataFreshAsOf, null);
  assert.equal(s.dataFreshnessMinutes, -1);
});

test("an in-flight run (no completedAt) has durationMs 0", () => {
  assert.equal(toRunListItem(run({ completedAt: null, status: "RUNNING" }), []).durationMs, 0);
});

test("matchesRunFilters AND-s status/scopeType/triggerType/site and day-bounded from/to", () => {
  const r = run({ status: "FAILED", scopeType: "SITE", site: "PLANT_A", startedAt: "2026-06-13T10:00:00.000Z" });
  // each filter in isolation
  assert.equal(matchesRunFilters(r, { status: "FAILED" }), true);
  assert.equal(matchesRunFilters(r, { status: "COMPLETED" }), false);
  assert.equal(matchesRunFilters(r, { scopeType: "SITE" }), true);
  assert.equal(matchesRunFilters(r, { scopeType: "MEASURE" }), false);
  assert.equal(matchesRunFilters(r, { site: "PLANT_A" }), true);
  assert.equal(matchesRunFilters(r, { site: "PLANT_B" }), false);
  // triggerType: floor runs are MANUAL, so a SCHEDULED filter excludes them
  assert.equal(matchesRunFilters(r, { triggerType: "MANUAL" }), true);
  assert.equal(matchesRunFilters(r, { triggerType: "SCHEDULED" }), false);
  // day-granular, inclusive bounds
  assert.equal(matchesRunFilters(r, { from: "2026-06-13", to: "2026-06-13" }), true);
  assert.equal(matchesRunFilters(r, { from: "2026-06-14" }), false);
  assert.equal(matchesRunFilters(r, { to: "2026-06-12" }), false);
  // combined AND
  assert.equal(matchesRunFilters(r, { status: "FAILED", site: "PLANT_A", scopeType: "SITE" }), true);
  assert.equal(matchesRunFilters(r, { status: "FAILED", site: "PLANT_B" }), false);
});

test("toRunOutcomeRows resolves employees, derives waiver/days, and sorts by name", () => {
  const oc = (subjectId: string, status: string, evidence: unknown): OutcomeRecord => ({
    id: crypto.randomUUID(),
    runId: "run-1",
    subjectId,
    measureId: "audiogram",
    evaluationPeriod: "2026-06-13",
    status,
    evidence,
    evaluatedAt: "2026-06-13T10:00:00.000Z",
  });
  const rows = toRunOutcomeRows([
    // emp-006 = "Omar Siddiq" (Welder, Plant A) in the ported catalog; OVERDUE, no waiver
    oc("emp-006", "OVERDUE", {
      expressionResults: [
        { define: "Has Active Waiver", result: false },
        { define: "Days Since Last Audiogram", result: 420 },
        { define: "Outcome Status", result: "OVERDUE" },
      ],
    }),
    // emp-005 = "Nadia Anwar"; EXCLUDED via active waiver
    oc("emp-005", "EXCLUDED", { expressionResults: [{ define: "Has Active Waiver", result: true }] }),
    // emp-007 = "Sana Imtiaz"; a CMS eCQM run uses "Has Exclusion" (not "…Waiver")
    oc("emp-007", "EXCLUDED", { expressionResults: [{ define: "Has Exclusion", result: true }] }),
    // unknown subject → degrade gracefully (name = id, role/site = em dash)
    oc("ghost-999", "MISSING_DATA", { expressionResults: [] }),
  ]);

  // sorted by employeeName ASC (resolved names ordered: Nadia before Omar)
  const names = rows.map((r) => r.employeeName);
  assert.ok(names.indexOf("Nadia Anwar") < names.indexOf("Omar Siddiq"), "sorted by employee name");
  assert.ok(names.includes("ghost-999"), "unknown subject still listed (by its id)");
  const omar = rows.find((r) => r.employeeExternalId === "emp-006")!;
  assert.equal(omar.role, "Welder");
  assert.equal(omar.site, "Plant A");
  assert.equal(omar.waiverStatus, "none");
  assert.equal(omar.daysSinceExam, "420");
  assert.equal(omar.caseId, null);

  assert.equal(rows.find((r) => r.employeeExternalId === "emp-005")!.waiverStatus, "active");
  // CMS eCQM exclusion define is recognized too (parity with Java why_flagged)
  assert.equal(rows.find((r) => r.employeeExternalId === "emp-007")!.waiverStatus, "active");

  const ghost = rows.find((r) => r.employeeExternalId === "ghost-999")!;
  assert.equal(ghost.role, "—");
  assert.equal(ghost.daysSinceExam, null);
  assert.equal(ghost.waiverStatus, null);
});

test("toRunLogEntries maps the store row (ts) to the frontend shape (timestamp)", () => {
  assert.deepEqual(toRunLogEntries([{ ts: "2026-06-13T10:00:00.000Z", level: "INFO", message: "started" }]), [
    { timestamp: "2026-06-13T10:00:00.000Z", level: "INFO", message: "started" },
  ]);
});
