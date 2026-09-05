import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gateMeasure,
  renderGate,
  parseArgs,
  writeGateJson,
  calendarPeriodFor,
  FlipGateUsageError,
  type FlipGateMadie,
} from "./official-flip-gate.ts";
import type { BatchAndSingle, SnapshotSubject } from "./official-flip-snapshot.ts";

const subjectsOf = (n: number): SnapshotSubject[] =>
  Array.from({ length: n }, (_, i) => ({ subjectId: `pat-${String(i + 1).padStart(3, "0")}`, bundle: { resourceType: "Bundle" } }));

/**
 * An executor that reports every subject with the given populations, through the batch primitive.
 *
 * `populationResults` is built in fqm-execution's REAL shape — an array of {populationType, result},
 * per OfficialEvidence in packages/measure-engine/src/evaluate-measure.ts. It previously used a keyed
 * record here, which is a shape the engine never produces: the stub and the reader agreed with each
 * other and both disagreed with reality, so the gate's central IPP reading was always 0 against the
 * live executor and every measure got an unconditional ADR-043 "nobody is in the initial population"
 * verdict. A stub that invents its own shape tests nothing.
 */
const executorReporting = (populations: Record<string, number>, outcome = "OVERDUE", omit: readonly string[] = []): BatchAndSingle => ({
  async evaluateBatch(_measureId, subjects) {
    const out = new Map<string, never>();
    const populationResults = Object.entries(populations).map(([populationType, count]) => ({
      populationType,
      result: count > 0,
    }));
    for (const s of subjects) {
      if (omit.includes(s.subjectId)) continue;
      out.set(s.subjectId, { outcome, evidence: { official: { populationResults } } } as never);
    }
    return out as never;
  },
  async evaluate() {
    throw new Error("no single-subject fallback in this stub");
  },
});

const greenMadie: FlipGateMadie = { pass: 68, fail: 0, total: 68 };

test("gateMeasure returns the three readings, and a clean measure reads as evidence FOR the flip", async () => {
  const artifact = { manifest: { catalogId: "cms165", effectivePeriod: { start: "2027-01-01", end: "2027-12-31" } } };
  const report = await gateMeasure("cms165", subjectsOf(48), "2027-06-30", {
    executor: executorReporting({ "initial-population": 1, denominator: 1 }),
    madie: async () => greenMadie,
    loadArtifact: () => artifact as never,
  });

  assert.equal(report.measureId, "cms165");
  assert.equal(report.evaluationDate, "2027-06-30");
  assert.deepEqual(report.madie, greenMadie);
  assert.equal(report.roster.subjects, 48);
  assert.equal(report.roster.inIpp, 48);
  assert.equal(report.roster.denominator, 48);
  assert.equal(report.roster.evaluationErrors, 0);
  assert.equal(report.roster.actionable, 48);
  assert.deepEqual(report.roster.distribution, { OVERDUE: 48 });
  assert.equal(report.effectivePeriod.covered, true);
  assert.equal(report.effectivePeriod.warning, null);
  assert.match(report.verdictText, /evidence FOR the flip/);
});

test("a whole roster out of the initial population fails the gate with the ADR-043 sentence", async () => {
  const report = await gateMeasure("cms130", subjectsOf(48), "2027-06-30", {
    executor: executorReporting({ "initial-population": 0, denominator: 0 }, "MISSING_DATA"),
    madie: async () => greenMadie,
    loadArtifact: () => null,
  });

  assert.equal(report.roster.inIpp, 0);
  assert.match(report.verdictText, /DO NOT FLIP YET/);
  assert.match(report.verdictText, /NOBODY in this deployment's 48 subjects is in the official initial population/);
  assert.match(report.verdictText, /ADR-043/);
  // renderGate prints it rather than burying it in the JSON.
  assert.match(renderGate(report), /NOBODY in this deployment's 48 subjects/);
});

test("a stale artifact vintage is a finding, and names the period it does not cover", async () => {
  const artifact = { manifest: { catalogId: "cms2", effectivePeriod: { start: "2026-01-01", end: "2026-12-31" } } };
  const report = await gateMeasure("cms2", subjectsOf(10), "2027-06-30", {
    executor: executorReporting({ "initial-population": 1, denominator: 1 }),
    madie: async () => ({ pass: 36, fail: 0, total: 36 }),
    loadArtifact: () => artifact as never,
  });

  assert.equal(report.effectivePeriod.covered, false);
  assert.match(report.effectivePeriod.warning ?? "", /2026-01-01\.\.2026-12-31/);
  assert.match(report.verdictText, /DO NOT FLIP YET/);
});

test("MADiE disagreements and unrun decks are different findings — a skip is never reported as a pass", async () => {
  const failing = await gateMeasure("cms2", subjectsOf(4), "2027-06-30", {
    executor: executorReporting({ "initial-population": 1, denominator: 1 }),
    madie: async () => ({ pass: 29, fail: 7, total: 36 }),
    loadArtifact: () => null,
  });
  assert.match(failing.verdictText, /7 of 36 MADiE cases disagree/);

  const unrun = await gateMeasure("cms2", subjectsOf(4), "2027-06-30", {
    executor: executorReporting({ "initial-population": 1, denominator: 1 }),
    madie: async () => ({ pass: 0, fail: 0, total: 0, unavailable: "this context cannot resolve 2.16.840.1.1" }),
    loadArtifact: () => null,
  });
  assert.match(unrun.verdictText, /the MADiE deck did not run/);
  assert.doesNotMatch(unrun.verdictText, /0 of 0 MADiE cases disagree/);
  assert.match(renderGate(unrun), /NOT RUN/);
});

test("a subject the executor returns nothing for is counted as an evaluation error, not as compliant", async () => {
  const report = await gateMeasure("cms165", subjectsOf(10), "2027-06-30", {
    executor: executorReporting({ "initial-population": 1, denominator: 1 }, "OVERDUE", ["pat-003", "pat-007"]),
    madie: async () => greenMadie,
    loadArtifact: () => null,
  });
  assert.equal(report.roster.evaluationErrors, 2);
  assert.equal(report.roster.subjects, 10);
  assert.match(report.verdictText, /2 subject\(s\) produced no outcome/);
});

test("an executor that refuses the batch outright is reported, not thrown", async () => {
  const report = await gateMeasure("cms165", subjectsOf(4), "2027-06-30", {
    executor: {
      async evaluateBatch() { throw new Error("nothing retrieved for anybody"); },
      async evaluate() { throw new Error("unused"); },
    },
    madie: async () => greenMadie,
    loadArtifact: () => null,
  });
  assert.match(report.verdictText, /refused the batch outright: nothing retrieved for anybody/);
  assert.equal(report.roster.evaluationErrors, 4);
});

test("the measurement period is the calendar year the evaluation date falls in", () => {
  assert.deepEqual(calendarPeriodFor("2027-06-30"), { start: "2027-01-01", end: "2027-12-31" });
  assert.deepEqual(calendarPeriodFor("2027-01-01"), { start: "2027-01-01", end: "2027-12-31" });
});

test("parseArgs defaults the evaluation date to today in UTC", () => {
  const args = parseArgs(["--measure", "cms2"], () => new Date("2026-09-05T23:30:00Z"));
  assert.equal(args.measure, "cms2");
  assert.equal(args.evaluationDate, "2026-09-05");

  assert.deepEqual(
    parseArgs(["--measure", "cms165", "--evaluation-date", "2027-06-30"]),
    { measure: "cms165", evaluationDate: "2027-06-30", contentDir: undefined },
  );
  assert.throws(() => parseArgs([]), FlipGateUsageError);
  assert.throws(() => parseArgs(["--measure", "cms2", "--evaluation-date", "June"]), FlipGateUsageError);
  assert.throws(() => parseArgs(["--nope"]), FlipGateUsageError);
  // An unknown id must be a USAGE error here, not an opaque crash later inside the bundle builder
  // (whose switch has no default branch and returns undefined for it).
  assert.throws(() => parseArgs(["--measure", "cms999"]), /--measure must be one of/);
  // And the date must be REAL, not merely YYYY-MM-DD shaped: 2027-99-99 and 2027-02-30 both match the
  // regex and then become an Invalid Date whose toISOString() throws a RangeError.
  assert.throws(() => parseArgs(["--measure", "cms2", "--evaluation-date", "2027-99-99"]), /not a real date/);
  assert.throws(() => parseArgs(["--measure", "cms2", "--evaluation-date", "2027-02-30"]), /not a real date/);
  assert.equal(parseArgs(["--measure", "cms2", "--evaluation-date", "2028-02-29"]).evaluationDate, "2028-02-29", "a real leap day is accepted");
});

test("writeGateJson writes the machine-readable summary under .flip-gate", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "workwell-flip-gate-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const report = await gateMeasure("cms165", subjectsOf(2), "2027-06-30", {
    executor: executorReporting({ "initial-population": 1, denominator: 1 }),
    madie: async () => greenMadie,
    loadArtifact: () => null,
  });
  const path = writeGateJson(cwd, report);
  assert.match(path, /cms165-2027-06-30\.json$/);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), JSON.parse(JSON.stringify(report)));
});
