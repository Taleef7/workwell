/**
 * Auditor packets name the logic that scored their results (#769).
 *
 * A packet is hash-stamped and handed to an auditor, so a version in it is a claim about what computed
 * the numbers. The case packet printed the authored library's "2.0.0" on a row CMS125FHIR v1.0.000
 * scored; the run packet printed it for the whole run. Fakes stand in for the stores, so each packet is
 * built from exactly the rows below.
 *
 *   node --import tsx --test src/audit/audit-packet.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CaseRecord } from "../stores/case-store.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";
import type { RunRecord } from "../stores/run-store.ts";
import { buildCasePacket, buildRunPacket, type CasePacketDeps, type RunPacketDeps } from "./audit-packet.ts";

const RUN = "run-769";
const CMS125 = {
  official: { ecqmId: "125FHIR", version: "1.0.000", engine: "fqm-execution", artifactSha256: "sha256:97f737fa5262fca1fbb4620e10ce286f612b87b7de4c3fc06fdfe38dfb666ac8" },
  expressionResults: [{ define: "official:numerator", result: false }],
};
const TRANSLATION = {
  official: { kind: "derived", label: "WorkWell translation of CMS137v15", url: "urn:workwell:measure:cms137:translation", derivedFrom: "CMS137v15", ecqmId: null, version: "ww-2027.1" },
  expressionResults: [{ define: "official:Initiation:numerator", result: false }],
};
const ERRORED = { evaluationError: "CQL engine failure", message: "x" };

const row = (id: string, subjectId: string, measureId: string, evidence: unknown): OutcomeRecord => ({
  id, runId: RUN, subjectId, measureId, evaluationPeriod: "2026-01-01", status: "OVERDUE", evidence, evaluatedAt: "2026-06-13T00:00:00Z",
});
const ROWS: OutcomeRecord[] = [
  row("o-1", "emp-020", "cms125", CMS125),
  row("o-2", "emp-021", "cms125", CMS125),
  row("o-3", "emp-022", "cms125", ERRORED),
  row("o-4", "emp-023", "cms137", TRANSLATION),
  row("o-5", "emp-024", "audiogram", { expressionResults: [{ define: "Outcome Status", result: "OVERDUE" }] }),
  // cms122: CMS's artifact scored one row and authored CQL the other — one NAME, but two logics.
  row("o-6", "emp-025", "cms122", { official: { ecqmId: "122FHIR", version: "1.0.000" }, expressionResults: [] }),
  row("o-7", "emp-026", "cms122", { expressionResults: [{ define: "Outcome Status", result: "OVERDUE" }] }),
];

const caseOf = (id: string, employeeId: string, measureId: string): CaseRecord => ({
  id, employeeId, measureId, evaluationPeriod: "2026-01-01", status: "OPEN", priority: "HIGH", assignee: null, nextAction: null,
  nextActionSource: "SYSTEM", assignmentSource: null, currentOutcomeStatus: "OVERDUE", lastRunId: RUN,
  createdAt: "2026-06-13T00:00:00Z", updatedAt: "2026-06-13T00:00:00Z", closedAt: null, closedReason: null, closedBy: null,
});

const listOutcomes = async (runId: string, opts?: { subjectId?: string; measureId?: string; limit?: number }) => {
  let out = runId === RUN ? ROWS : [];
  if (opts?.subjectId) out = out.filter((o) => o.subjectId === opts.subjectId);
  if (opts?.measureId) out = out.filter((o) => o.measureId === opts.measureId);
  return opts?.limit ? out.slice(0, opts.limit) : out;
};
const events = () => ({
  caseTimeline: async () => [],
  latestOutreachDeliveryStatus: async () => null,
  auditEventsByRun: async () => [],
  appendAudit: async () => {},
  insertPacketExport: async () => {},
});

const casePacket = async (c: CaseRecord) => {
  const deps = {
    cases: { getCase: async () => c },
    outcomes: { listOutcomes },
    events: events(),
    evidence: { listByCase: async () => [] },
    appointments: { listByCase: async () => [] },
  } as unknown as CasePacketDeps;
  return JSON.parse((await buildCasePacket(deps, c.id, "auditor@example.org", "json")).content) as {
    measure: { version: string; logic: Record<string, unknown> | null };
  };
};

test("the CASE packet's measure version and logic are the cited row's own (#769)", async () => {
  const official = await casePacket(caseOf("c-1", "emp-020", "cms125"));
  assert.equal(official.measure.version, "1.0.000", "the artifact's version, never the authored 2.0.0");
  assert.equal(official.measure.logic?.kind, "cms-artifact");
  assert.equal(official.measure.logic?.ecqmId, "CMS125FHIR");

  const translated = await casePacket(caseOf("c-2", "emp-023", "cms137"));
  assert.equal(translated.measure.version, "ww-2027.1");
  assert.equal(translated.measure.logic?.label, "WorkWell translation of CMS137v15");
  assert.ok(!("ecqmId" in (translated.measure.logic ?? {})), "a translation never carries a CMS eCQM id");

  const errored = await casePacket(caseOf("c-3", "emp-022", "cms125"));
  assert.equal(errored.measure.version, "", "nothing scored an errored row");
  assert.equal(errored.measure.logic, null);

  const authored = await casePacket(caseOf("c-4", "emp-024", "audiogram"));
  assert.equal(authored.measure.version, "1.0.0", "an authored row keeps its library's version");
  assert.equal(authored.measure.logic, null);
});

const runPacket = async (run: Partial<RunRecord>) => {
  const deps = {
    runStore: { getRun: async () => ({ id: RUN, status: "COMPLETED", triggeredBy: "manual", startedAt: "2026-06-13T00:00:00Z", completedAt: "2026-06-13T00:01:00Z", ...run }), listLogs: async () => [] },
    outcomeStore: { listOutcomes },
    caseStore: { countByLastRun: async () => 0, listCases: async () => [] },
    events: events(),
  } as unknown as RunPacketDeps;
  return JSON.parse((await buildRunPacket(deps, RUN, "auditor@example.org", "json")).content) as {
    run: { measureVersion: string; scoringLogic: Array<{ measureId: string; logics: Array<Record<string, unknown>>; conflict: boolean }> };
  };
};

test("the RUN packet never prints the authored or catalog version for a measure CMS's artifact scores, and names what scored each measure (#769)", async () => {
  const cms125Run = await runPacket({ scopeType: "MEASURE", scopeId: "cms125", requestedScope: { measureId: "cms125" } });
  assert.notEqual(cms125Run.run.measureVersion, "2.0.0", "the authored library's version names logic that may not have run");
  assert.notEqual(cms125Run.run.measureVersion, "v1.0", "the catalog record's version names no logic at all");

  // What scored the rows, per measure, from the rows themselves: two CMS125FHIR rows are ONE logic,
  // the errored row adds none, and the authored measure has no name to list. cms122's authored row
  // beside a CMS row is a conflict the one name cannot show — the reconciliation's rule (`scoringOfRows`).
  assert.deepEqual(
    cms125Run.run.scoringLogic.map((m) => ({
      measureId: m.measureId,
      names: m.logics.map((l) => (l.kind === "cms-artifact" ? `${l.ecqmId} v${l.version}` : `${l.label} (${l.version})`)),
      conflict: m.conflict,
    })),
    [
      { measureId: "audiogram", names: [], conflict: false },
      { measureId: "cms122", names: ["CMS122FHIR v1.0.000"], conflict: true },
      { measureId: "cms125", names: ["CMS125FHIR v1.0.000"], conflict: false },
      { measureId: "cms137", names: ["WorkWell translation of CMS137v15 (ww-2027.1)"], conflict: false },
    ],
  );

  const authoredRun = await runPacket({ scopeType: "MEASURE", scopeId: "audiogram", requestedScope: { measureId: "audiogram" } });
  assert.equal(authoredRun.run.measureVersion, "1.0.0", "an authored-only measure has one logic, so its version stands");
});
