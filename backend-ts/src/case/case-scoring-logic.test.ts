import { test } from "node:test";
import assert from "node:assert/strict";
import { caseLogicKey, scoringForCases, scoringLogicForCases } from "./case-scoring-logic.ts";
import { scoringIdentityOf, type OutcomeRecord, type OutcomeStore } from "../stores/outcome-store.ts";

const cms = { official: { ecqmId: "137FHIR", version: "1.0.000", artifactSha256: "sha256:01e9499c10b252636ea58805a9f913685dc867eec23bd586429520cc966f0a24" } };
const translated = { official: { kind: "derived", label: "WorkWell translation of CMS137v15", url: "urn:workwell:measure:cms137:translation", derivedFrom: "CMS137v15", ecqmId: null, version: "ww-2027.1" } };

const row = (runId: string, subjectId: string, measureId: string, evidence: unknown, evaluatedAt: string, evaluationPeriod?: string): OutcomeRecord =>
  ({ id: `${runId}-${subjectId}-${evaluatedAt}`, runId, subjectId, measureId, evaluationPeriod, status: "OVERDUE", evidence, evaluatedAt }) as unknown as OutcomeRecord;

function fakeStore(rows: OutcomeRecord[]) {
  const calls: Array<{ runId: string; opts: unknown }> = [];
  const store: Pick<OutcomeStore, "listOutcomes"> = {
    async listOutcomes(runId, opts) {
      calls.push({ runId, opts });
      return rows
        .filter((r) => r.runId === runId)
        .filter((r) => !opts?.measureId || r.measureId === opts.measureId)
        .filter((r) => !opts?.subjectIds || opts.subjectIds.includes(r.subjectId))
        .sort((a, b) => String((a as { evaluatedAt: string }).evaluatedAt).localeCompare(String((b as { evaluatedAt: string }).evaluatedAt)));
    },
  };
  return { store, calls };
}

test("each case names the logic of ITS cited outcome, even when one run scored two logics", async () => {
  // An import or /evaluate run resolves the date per call, so one run can hold a 2026 row and a 2027 row.
  const { store } = fakeStore([row("r1", "p1", "cms137", cms, "2026-10-01T00:00:00Z"), row("r1", "p2", "cms137", translated, "2026-10-01T00:00:01Z")]);
  const refs = [
    { lastRunId: "r1", employeeId: "p1", measureId: "cms137" },
    { lastRunId: "r1", employeeId: "p2", measureId: "cms137" },
  ];
  const logic = await scoringLogicForCases(store, refs);
  assert.equal(logic.get(caseLogicKey(refs[0]!))?.kind, "cms-artifact");
  assert.equal(logic.get(caseLogicKey(refs[1]!))?.kind, "workwell-translation");
});

test("the first row per subject wins, as on the case page; one bounded read per (run, measure)", async () => {
  const { store, calls } = fakeStore([
    row("r1", "p1", "cms137", cms, "2026-10-01T00:00:00Z"),
    row("r1", "p1", "cms137", translated, "2026-10-01T00:00:09Z"),
    row("r1", "p1", "cms125", { official: { ecqmId: "125FHIR", version: "1.0.000" } }, "2026-10-01T00:00:00Z"),
  ]);
  const refs = [
    { lastRunId: "r1", employeeId: "p1", measureId: "cms137" },
    { lastRunId: "r1", employeeId: "p1", measureId: "cms125" },
  ];
  const logic = await scoringLogicForCases(store, refs);
  assert.equal(logic.get(caseLogicKey(refs[0]!))?.kind, "cms-artifact");
  assert.equal(calls.length, 2);
  for (const c of calls) assert.ok((c.opts as { subjectIds?: string[] }).subjectIds, "a bounded read, never the whole run");
});

test("no run, no row, an errored row or an authored row: null, never a guess from routing", async () => {
  const { store } = fakeStore([
    row("r1", "p1", "cms137", { evaluationError: "CQL engine failure", message: "x" }, "2026-10-01T00:00:00Z"),
    row("r1", "p2", "audiogram", { expressionResults: [] }, "2026-10-01T00:00:00Z"),
  ]);
  const refs = [
    { lastRunId: null, employeeId: "p0", measureId: "cms137" },
    { lastRunId: "r1", employeeId: "p1", measureId: "cms137" },
    { lastRunId: "r1", employeeId: "p2", measureId: "audiogram" },
    { lastRunId: "r1", employeeId: "p9", measureId: "cms137" },
  ];
  const logic = await scoringLogicForCases(store, refs);
  for (const r of refs) {
    assert.ok(logic.has(caseLogicKey(r)), "every ref gets an entry");
    assert.equal(logic.get(caseLogicKey(r)), null);
  }
});

test("scoringForCases carries the cited row's version: the artifact's, '' for an errored row, the authored library's for authored CQL", async () => {
  const { store } = fakeStore([
    row("r1", "p1", "cms137", cms, "2026-10-01T00:00:00Z"),
    row("r1", "p2", "cms125", { evaluationError: "CQL engine failure", message: "x" }, "2026-10-01T00:00:00Z"),
    row("r1", "p3", "cms125", { expressionResults: [] }, "2026-10-01T00:00:00Z"),
  ]);
  const refs = [
    { lastRunId: "r1", employeeId: "p1", measureId: "cms137" },
    { lastRunId: "r1", employeeId: "p2", measureId: "cms125" },
    { lastRunId: "r1", employeeId: "p3", measureId: "cms125" },
    { lastRunId: "r1", employeeId: "p9", measureId: "cms125" },
  ];
  const s = await scoringForCases(store, refs);
  assert.deepEqual(refs.map((r) => s.get(caseLogicKey(r))?.version), ["1.0.000", "", "2.0.0", ""]);
});

test("one run holding a subject's 2026 and 2027 rows: each case names the row of ITS period, whichever was written first", async () => {
  // An /evaluate or import run resolves the date per call: p1's 2026 row (CMS's artifact) was written
  // first, the 2027 row (the translation) after. The 2027 case is about the 2027 row.
  const { store, calls } = fakeStore([
    row("r1", "p1", "cms137", cms, "2026-10-01T00:00:00Z", "2026"),
    row("r1", "p1", "cms137", translated, "2026-10-01T00:00:05Z", "2027"),
    // p2's only row predates the period column (""): no row of the case's period, so the first stands.
    row("r1", "p2", "cms137", cms, "2026-10-01T00:00:00Z", ""),
  ]);
  const refs = [
    { lastRunId: "r1", employeeId: "p1", measureId: "cms137", evaluationPeriod: "2027" },
    { lastRunId: "r1", employeeId: "p1", measureId: "cms137", evaluationPeriod: "2026" },
    { lastRunId: "r1", employeeId: "p2", measureId: "cms137", evaluationPeriod: "2027" },
    // No period given: the first row, as before.
    { lastRunId: "r1", employeeId: "p1", measureId: "cms137" },
  ];
  const s = await scoringForCases(store, refs);
  assert.equal(new Set(refs.map(caseLogicKey)).size, refs.length, "two cases of one subject citing one run stay apart");
  assert.deepEqual(
    refs.map((r) => [s.get(caseLogicKey(r))?.logic?.kind, s.get(caseLogicKey(r))?.version]),
    [["workwell-translation", "ww-2027.1"], ["cms-artifact", "1.0.000"], ["cms-artifact", "1.0.000"], ["cms-artifact", "1.0.000"]],
  );
  assert.equal(calls.length, 1, "still one bounded read for the (run, measure)");
});

/** A store with the identity-only projection; `listOutcomes` throws, so the projection must be what is read. */
function projectionStore(rows: OutcomeRecord[]) {
  const calls: Array<{ runId: string; measureId: string; subjectIds: readonly string[] }> = [];
  const store: Pick<OutcomeStore, "listOutcomes" | "listScoringIdentities"> = {
    async listOutcomes() {
      throw new Error("the projection exists, so the full rows must not be read");
    },
    async listScoringIdentities(runId, { measureId, subjectIds }) {
      calls.push({ runId, measureId, subjectIds });
      return rows
        .filter((r) => r.runId === runId && r.measureId === measureId && subjectIds.includes(r.subjectId))
        .sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt))
        .map((r) => {
          const e = r.evidence as { official?: Record<string, unknown>; evaluationError?: unknown };
          return {
            subjectId: r.subjectId,
            measureId: r.measureId,
            evaluationPeriod: r.evaluationPeriod ?? "",
            official: scoringIdentityOf(e.official),
            errored: "evaluationError" in e,
          };
        });
    },
  };
  return { store, calls };
}

test("with the identity-only projection: the same logics and versions, no evidence read, 900 subjects per read", async () => {
  const subjects = Array.from({ length: 1901 }, (_, i) => `s${i}`);
  const rows: OutcomeRecord[] = [
    ...subjects.map((s) => row("r1", s, "cms137", cms, "2026-10-01T00:00:00Z", "2026")),
    row("r1", "s0", "cms137", translated, "2026-10-01T00:00:09Z", "2027"),
    row("r2", "e1", "cms125", { evaluationError: "CQL engine failure", message: "x", official: { ecqmId: "125FHIR", version: "1.0.000" } }, "2026-10-01T00:00:00Z", "2026"),
    row("r2", "a1", "cms125", { expressionResults: [] }, "2026-10-01T00:00:00Z", "2026"),
  ];
  const { store, calls } = projectionStore(rows);
  const refs = [
    ...subjects.map((s) => ({ lastRunId: "r1", employeeId: s, measureId: "cms137", evaluationPeriod: "2026" })),
    { lastRunId: "r1", employeeId: "s0", measureId: "cms137", evaluationPeriod: "2027" },
    { lastRunId: "r2", employeeId: "e1", measureId: "cms125", evaluationPeriod: "2026" },
    { lastRunId: "r2", employeeId: "a1", measureId: "cms125", evaluationPeriod: "2026" },
  ];
  const s = await scoringForCases(store, refs);
  const at = (i: number) => s.get(caseLogicKey(refs[i]!));
  assert.equal(at(0)?.logic?.kind, "cms-artifact");
  assert.equal(at(0)?.version, "1.0.000");
  assert.equal(at(1900)?.logic?.kind, "cms-artifact");
  assert.equal(at(1901)?.logic?.kind, "workwell-translation", "the projection carries the period too");
  assert.deepEqual([at(1902)?.logic, at(1902)?.version], [null, ""], "an errored row: nothing named scored it, even with an official block");
  assert.deepEqual([at(1903)?.logic, at(1903)?.version], [null, "2.0.0"], "an authored row: the authored library's version");
  assert.deepEqual(
    calls.map((c) => [c.runId, c.measureId, c.subjectIds.length]),
    [["r1", "cms137", 900], ["r1", "cms137", 900], ["r1", "cms137", 101], ["r2", "cms125", 2]],
  );
});

