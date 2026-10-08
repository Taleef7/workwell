import { test } from "node:test";
import assert from "node:assert/strict";
import { caseLogicKey, scoringLogicForCases } from "./case-scoring-logic.ts";
import type { OutcomeRecord, OutcomeStore } from "../stores/outcome-store.ts";

const cms = { official: { ecqmId: "137FHIR", version: "1.0.000", artifactSha256: "sha256:01e9499c10b252636ea58805a9f913685dc867eec23bd586429520cc966f0a24" } };
const translated = { official: { kind: "derived", label: "WorkWell translation of CMS137v15", url: "urn:workwell:measure:cms137:translation", derivedFrom: "CMS137v15", ecqmId: null, version: "ww-2027.1" } };

const row = (runId: string, subjectId: string, measureId: string, evidence: unknown, evaluatedAt: string): OutcomeRecord =>
  ({ id: `${runId}-${subjectId}-${evaluatedAt}`, runId, subjectId, measureId, status: "OVERDUE", evidence, evaluatedAt }) as unknown as OutcomeRecord;

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
