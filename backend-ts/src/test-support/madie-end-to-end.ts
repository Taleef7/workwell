/**
 * Test support (#727): the steward's MADiE test patients through the WHOLE pipeline — the nightly's run
 * path, the stores, and the read APIs the screens use — checked against the steward's expected results.
 *
 * The official-cases gate proves the CALCULATION (fqm-execution in memory, population vectors). Every
 * recent pilot-trust defect sat after it: out-of-population patients counted as gaps, rates over the
 * wrong denominator, the inverse CMS122 read the wrong way round. This drives the same patients through
 * `planManualRun` + `finishOrFail` and asks the report, roster, cases, programs overview and run
 * reconciliation what they show.
 *
 * Import this module only AFTER `WORKWELL_INSTANCE=maui` and `WORKWELL_OFFICIAL_MEASURES` are set: the
 * runnable measure set and the panels are read when their modules load.
 *
 * The ORACLE (`madie-oracle.ts`) is written from the specification (the population table in #727), not by calling
 * `outcomeFromPopulations`, so the test checks the code against the rule rather than against itself.
 */
import assert from "node:assert/strict";
import { loadVendoredOfficialDeck, type OfficialCase, type PopulationCounts } from "../standards/official-cases.ts";
import {
  __setDeploymentDirectoryForTest,
  getDeploymentDirectory,
  type DeploymentDirectory,
} from "../config/deployment-profile.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { FhirBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import type { SubjectBundleSource } from "../wiring/subject-bundle-source.ts";
import { CLINICS, PCPS } from "../engine/synthetic/corpus/corpus-parameters.ts";
import { getStores, type Stores } from "../stores/factory.ts";
import { ensureSegmentSeed, __resetDemoSegments } from "../segment/segment-seed.ts";
import { routedEngineForEnv } from "../wiring/executor-router.ts";
import { finishOrFail, planManualRun, type RunPipelineDeps } from "../run/run-pipeline.ts";
import { handleSubjectLists } from "../routes/subject-lists.ts";
import { handleCompliance } from "../routes/compliance.ts";
import { handleCases } from "../routes/cases.ts";
import { handlePrograms } from "../routes/programs.ts";
import { handleRuns } from "../routes/runs.ts";
import { PROFILE_DEFAULT_PANEL } from "../compliance/panels.ts";
import { expectedCase, expectedStatus, membershipOf, type DisplayStatus } from "./madie-oracle.ts";

export const MAUI_MEASURES = ["cms122", "cms125", "cms2", "cms130", "cms165", "cms137"] as const;
export type MauiMeasure = (typeof MAUI_MEASURES)[number];

/** Every deck resolves to the 2026 calendar year; an evaluation date inside it scores that year. */
export const EVALUATION_DATE = "2026-12-31";
const MEASUREMENT_YEAR = 2026;

// ── The decks as a deployment ────────────────────────────────────────────────────────────────────────

export interface DeckCase {
  measure: MauiMeasure;
  patientId: string;
  uuid: string;
  title: string;
  bundle: FhirBundle;
  rates: PopulationCounts[];
  status: DisplayStatus;
}

export function loadDecks(): DeckCase[] {
  const out: DeckCase[] = [];
  for (const measure of MAUI_MEASURES) {
    const deck = loadVendoredOfficialDeck(measure);
    for (const c of deck.cases as OfficialCase[]) {
      assert.ok(!c.loadError && c.patientId && c.patientBundle && c.expectedRates, `${measure} ${c.uuid}: ${c.loadError ?? "incomplete case"}`);
      out.push({
        measure,
        patientId: c.patientId!,
        uuid: c.uuid,
        title: c.name,
        bundle: c.patientBundle as unknown as FhirBundle,
        rates: c.expectedRates!,
        status: expectedStatus(measure, c.expectedRates!),
      });
    }
  }
  return out;
}

/** "cms165 <uuid> (<series title>)" — what every failure names, so it points at one steward case. */
export const caseLabel = (c: DeckCase): string => `${c.measure} ${c.uuid} (${c.title})`;

function patientName(bundle: FhirBundle): string {
  const patient = bundle.entry.find((e) => (e.resource as { resourceType?: string }).resourceType === "Patient")?.resource as
    | { name?: Array<{ given?: string[]; family?: string }> }
    | undefined;
  const name = patient?.name?.[0];
  return [...(name?.given ?? []), name?.family ?? ""].join(" ").trim() || "Unnamed";
}

function patientFacts(bundle: FhirBundle): { dateOfBirth?: string; sex?: "F" | "M" } {
  const patient = bundle.entry.find((e) => (e.resource as { resourceType?: string }).resourceType === "Patient")?.resource as
    | { birthDate?: string; gender?: string }
    | undefined;
  const sex = patient?.gender === "female" ? "F" : patient?.gender === "male" ? "M" : undefined;
  return { ...(patient?.birthDate ? { dateOfBirth: patient.birthDate } : {}), ...(sex ? { sex } : {}) };
}

/**
 * The Maui directory with the deck patients as its roster, under the steward's own ids, all at one
 * clinic with one PCP, so a failure names the exact steward case and every patient is applicable.
 */
export function installDeckDirectory(cases: readonly DeckCase[]): readonly EmployeeProfile[] {
  const base = getDeploymentDirectory();
  const clinic = CLINICS[0]!.name;
  const pcp = PCPS.find((p) => p.location === clinic)!;
  const EMPLOYEES: EmployeeProfile[] = cases.map((c) => ({
    externalId: c.patientId,
    name: patientName(c.bundle),
    role: "Patient",
    site: clinic,
    providerId: pcp.id,
    tenantId: "maui",
    ...patientFacts(c.bundle),
  }));
  const byId = new Map(EMPLOYEES.map((e) => [e.externalId, e]));
  const directory: DeploymentDirectory = {
    ...base,
    EMPLOYEES,
    EVALUABLE_EMPLOYEES: EMPLOYEES,
    employeeById: (id) => byId.get(id) ?? null,
    employeesForTenant: (tenantId) => (tenantId === "maui" ? [...EMPLOYEES] : []),
  };
  __setDeploymentDirectoryForTest(directory);
  // The Maui segment's site list is derived from the roster and memoized: drop it so it is rebuilt from
  // the deck patients rather than from the corpus it was first built against.
  __resetDemoSegments();
  return EMPLOYEES;
}

/**
 * Each measure evaluates ITS deck's patients with ITS deck's bundles, and nothing else. No
 * `bundleForSubject`: a deck patient's record is written for one measure, and the pipeline would reuse
 * a whole-record bundle across all six. A request for a patient under another measure throws, so a
 * cross-measure leak fails loudly instead of evaluating somebody else's test patient.
 */
export function deckBundleSource(cases: readonly DeckCase[], employees: readonly EmployeeProfile[]): SubjectBundleSource {
  const byPatient = new Map(cases.map((c) => [c.patientId, c]));
  const byId = new Map(employees.map((e) => [e.externalId, e]));
  const ofMeasure = (measureId: string) => cases.filter((c) => c.measure === measureId);
  return {
    targetFor: (_employees, measureId, subjectId) => (byPatient.get(subjectId)?.measure === measureId ? "MISSING_DATA" : null),
    distribution: (_employees, measureId) =>
      ofMeasure(measureId).map((c) => ({ employee: byId.get(c.patientId)!, target: "MISSING_DATA" as const })),
    bundleFor: (employee, measureId) => {
      const c = byPatient.get(employee.externalId);
      if (!c || c.measure !== measureId) {
        throw new Error(`[madie-e2e] ${employee.externalId} is not a ${measureId} deck patient (it is ${c ? caseLabel(c) : "unknown"})`);
      }
      return c.bundle;
    },
  };
}

// ── The run, and every check ─────────────────────────────────────────────────────────────────────────

export interface MadieEnv {
  DB?: unknown;
  DATABASE_URL?: string;
  WORKWELL_OFFICIAL_MEASURES: string;
  [key: string]: unknown;
}

async function body<T>(res: Response | null, what: string): Promise<T> {
  assert.ok(res, `${what}: no handler answered`);
  const text = await res.text();
  assert.equal(res.status, 200, `${what}: ${res.status} ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

/** A tiny CSV reader for the report's own output (quoted cells, no embedded newlines in these rows). */
function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.trim().split(/\r?\n/);
  const cells = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = cells(lines[0]!);
  return lines.slice(1).map((line, n) => {
    const row = cells(line);
    // A cell count off by one (an embedded newline, a stray comma) would shift every column silently.
    assert.equal(row.length, header.length, `report CSV line ${n + 2} has ${row.length} cells, the header ${header.length}`);
    return Object.fromEntries(row.map((v, i) => [header[i]!, v]));
  });
}

async function runOnce(deps: RunPipelineDeps, stores: Stores): Promise<string> {
  const planned = await planManualRun(deps, { scopeType: "ALL_PROGRAMS", evaluationDate: EVALUATION_DATE, triggeredBy: "scheduler" });
  await finishOrFail(deps, planned);
  const runId = planned.run.id;
  const run = await stores.runs.getRun(runId);
  const logs = await stores.runs.listLogs(runId, 500);
  assert.equal(run?.status, "COMPLETED", `run ${runId} ended ${run?.status}:\n${logs.map((l) => `${l.level} ${l.message}`).join("\n")}`);
  // Case audits are best-effort (a failure only WARNs), so a silent ledger gap must be looked for.
  const warnings = logs.filter((l) => /WARN|ERROR/i.test(l.level)).map((l) => l.message);
  assert.deepEqual(warnings, [], `run ${runId} logged warnings`);
  return runId;
}

interface CaseRow {
  caseId: string; employeeId: string; status: string; currentOutcomeStatus: string; closedReason: string | null;
  closedBy: string | null; closedAt?: string | null; priority?: string; nextAction?: string | null; assignee?: string | null;
}

async function casesFor(env: MadieEnv, measure: string): Promise<CaseRow[]> {
  return body<CaseRow[]>(
    await handleCases(new Request(`http://x/api/cases?status=all&measureId=${measure}&limit=500`), env as never, "madie-e2e"),
    `cases ${measure}`,
  );
}

type Summary = Record<string, Record<DisplayStatus, number>>;

/**
 * Every read surface, against the oracle, for the run that should be winning (`runId`). Called after
 * BOTH runs: with two 2026 runs in the store, an overview or roster that summed across runs, or a
 * report that picked the older run, reads differently from one that picks the newest.
 */
async function checkSurfaces(
  env: MadieEnv,
  runId: string,
  cases: readonly DeckCase[],
  byMeasure: ReadonlyMap<string, DeckCase[]>,
  lists: ReadonlyMap<string, string>,
  summary: Summary,
): Promise<void> {
  const at = `after run ${runId}`;

  // 1. Reconciliation: every deck patient set out and persisted once, nothing errored.
  const recon = await body<{ workItems: number | null; rowsPersisted: number; evaluationErrors: number | null; notInPopulation: number }>(
    await handleRuns(new Request(`http://x/api/runs/${runId}/reconciliation`), env as never),
    "reconciliation",
  );
  assert.equal(recon.workItems, cases.length, `${at}: one work item per deck patient`);
  assert.equal(recon.rowsPersisted, cases.length, `${at}: one outcome per deck patient`);
  assert.equal(recon.evaluationErrors, 0, `${at}: no evaluation errors (null would mean the ledger never said)`);
  assert.equal(recon.notInPopulation, cases.filter((c) => c.status === "OUT_OF_POPULATION").length, `${at}: out-of-population count`);

  // 2. The subject-list report, per patient per rate: the steward's populations, from THIS run.
  for (const [m, list] of byMeasure) {
    const res = await handleSubjectLists(
      new Request(`http://x/api/subject-lists/${lists.get(m)}/report?measurementYear=${MEASUREMENT_YEAR}&format=csv`),
      env as never,
      "madie-e2e",
    );
    assert.ok(res);
    const csv = await res.text();
    assert.equal(res.status, 200, `report ${m}: ${csv.slice(0, 400)}`);
    const rows = parseCsv(csv);
    const members = new Set(list.map((c) => c.patientId));
    // The other five measures never evaluated this list's patients: one MISSING_FROM_RUN row each,
    // never an evaluated row (a cross-measure leak would score them).
    for (const r of rows.filter((x) => x.measureId !== m)) {
      assert.equal(r.rowStatus, "MISSING_FROM_RUN", `${m} list: ${r.patientExternalId} under ${r.measureId} must be missing from the run`);
    }
    assert.equal(rows.filter((x) => x.measureId !== m).length, list.length * (MAUI_MEASURES.length - 1), `${m} list: one missing row per other measure`);
    const own = rows.filter((x) => x.measureId === m);
    assert.ok(own.every((r) => members.has(r.patientExternalId ?? "")), `${m} list: rows only for its members`);
    for (const c of list) {
      const mine = own.filter((r) => r.patientExternalId === c.patientId);
      assert.equal(mine.length, c.rates.length, `${caseLabel(c)}: one report row per rate, got ${mine.map((r) => r.rowStatus).join(",")}`);
      c.rates.forEach((counts, i) => {
        const row = mine[i]!;
        const want = membershipOf(counts);
        assert.equal(row.rowStatus, "EVALUATED", `${caseLabel(c)} rate ${i + 1}: evaluated`);
        assert.equal(row.runId, runId, `${caseLabel(c)} rate ${i + 1}: read from the newest 2026 run`);
        assert.equal(row.evaluationError, "false", `${caseLabel(c)} rate ${i + 1}: no evaluation error`);
        assert.equal(row.outOfPopulation, String(c.status === "OUT_OF_POPULATION"), `${caseLabel(c)} rate ${i + 1}: outOfPopulation`);
        assert.deepEqual(
          {
            ipp: row.initialPopulation === "true",
            denom: row.denominator === "true",
            denex: row.denominatorExclusion === "true",
            numer: row.numerator === "true",
            denexcep: row.denominatorException === "true",
          },
          want,
          `${caseLabel(c)} rate ${i + 1}: populations`,
        );
      });
      // A two-rate measure's rows must carry two different labels, in the steward's group order.
      if (c.rates.length > 1) {
        assert.equal(new Set(mine.map((r) => r.rate)).size, c.rates.length, `${caseLabel(c)}: one label per rate`);
      }
    }
  }

  // 3. The roster: each patient's cell for its measure, and "not evaluated" for the other five.
  const cells = new Map<string, Record<string, { status: string }>>();
  const maxPages = Math.ceil(cases.length / 200) + 1;
  for (let page = 1; page <= maxPages; page++) {
    const roster = await body<{ rows: Array<{ subject: { externalId: string }; cells: Record<string, { status: string }> }>; total: number }>(
      await handleCompliance(new Request(`http://x/api/compliance/roster?panel=${PROFILE_DEFAULT_PANEL}&pageSize=200&page=${page}`), env as never),
      `roster page ${page}`,
    );
    for (const r of roster.rows) cells.set(r.subject.externalId, r.cells);
    if (roster.rows.length === 0 || cells.size >= roster.total) break;
  }
  assert.equal(cells.size, cases.length, `${at}: the roster is exactly the deck patients`);
  for (const c of cases) {
    const row = cells.get(c.patientId);
    assert.ok(row, `${caseLabel(c)}: on the roster`);
    assert.equal(row[c.measure]?.status, c.status, `${caseLabel(c)}: roster cell ${at}`);
    for (const other of MAUI_MEASURES.filter((m) => m !== c.measure)) {
      assert.equal(row[other]?.status, "NA", `${caseLabel(c)}: ${other} must read not evaluated (no cross-measure leak)`);
    }
  }

  // 4. Cases: which patients have one, its state, and that an exclusion is a SYSTEM closure.
  for (const [m, list] of byMeasure) {
    const rows = await casesFor(env, m);
    const bySubject = new Map(rows.map((r) => [r.employeeId, r]));
    assert.equal(rows.length, bySubject.size, `${m}: one case per patient at most`);
    assert.equal(rows.length, list.filter((c) => expectedCase(c.status)).length, `${m}: case count ${at}`);
    for (const c of list) {
      const want = expectedCase(c.status);
      const got = bySubject.get(c.patientId);
      if (!want) {
        assert.equal(got, undefined, `${caseLabel(c)}: ${c.status} opens no case`);
        continue;
      }
      assert.equal(got?.status, want.status, `${caseLabel(c)}: case for ${c.status}`);
      assert.equal(got?.currentOutcomeStatus, c.status, `${caseLabel(c)}: the case's outcome`);
      if (c.status === "EXCLUDED") assert.equal(got?.closedBy, null, `${caseLabel(c)}: an exclusion is a system closure`);
    }
  }

  // 5. Programs overview: buckets from the summed oracle, and the steward's rate formula and score.
  const overview = await body<Array<{
    measureId: string; compliant: number; dueSoon: number; overdue: number; missingData: number; notInPopulation: number; excluded: number;
    measureRate: { runId: string; rates: Array<{ numer: number; effectiveDenominator: number; score: number | null }> } | null;
  }>>(await handlePrograms(new Request("http://x/api/programs/overview"), env as never), "programs overview");
  for (const [m, list] of byMeasure) {
    const s = overview.find((o) => o.measureId === m);
    assert.ok(s, `${m}: on the programs overview`);
    const want = summary[m]!;
    assert.deepEqual(
      { compliant: s.compliant, overdue: s.overdue, excluded: s.excluded, notInPopulation: s.notInPopulation, dueSoon: s.dueSoon, missingData: s.missingData },
      { compliant: want.COMPLIANT, overdue: want.OVERDUE, excluded: want.EXCLUDED, notInPopulation: want.OUT_OF_POPULATION, dueSoon: 0, missingData: 0 },
      `${m}: overview buckets ${at}`,
    );
    assert.equal(s.measureRate?.runId, runId, `${m}: the rate is read from the newest run`);
    const rateCount = list[0]!.rates.length;
    assert.equal(s.measureRate?.rates.length, rateCount, `${m}: one rate per steward group`);
    for (let i = 0; i < rateCount; i++) {
      const members = list.map((c) => membershipOf(c.rates[i]!));
      const numer = members.filter((x) => x.numer).length;
      const effective = members.filter((x) => x.denom).length - members.filter((x) => x.denex).length - members.filter((x) => x.denexcep).length;
      const rate: { numer: number; effectiveDenominator: number; score: number | null } = s.measureRate!.rates[i]!;
      assert.deepEqual(
        { numer: rate.numer, effectiveDenominator: rate.effectiveDenominator },
        { numer, effectiveDenominator: effective },
        `${m} rate ${i + 1}: numerator ÷ (denominator − exclusions − exceptions)`,
      );
      // The score as the steward states it — the performance rate, never inverted for an inverse measure.
      if (effective === 0) assert.equal(rate.score, null, `${m} rate ${i + 1}: no score over an empty denominator`);
      else assert.ok(Math.abs((rate.score ?? NaN) - numer / effective) < 1e-9, `${m} rate ${i + 1}: score ${rate.score} ≠ ${numer}/${effective}`);
    }
  }
}

/**
 * Runs the six decks through one ALL_PROGRAMS run on the stores `env` selects, checks every surface
 * against the oracle, then runs again, checks nothing changed, and checks every surface again against
 * the newer run. Returns a per-measure summary for the evidence file.
 */
export async function runMadieEndToEnd(env: MadieEnv): Promise<Summary> {
  const cases = loadDecks();
  const employees = installDeckDirectory(cases);
  await ensureSegmentSeed(env as never);
  const stores = await getStores(env as never);
  const segments = (await stores.segments.listSegments()).filter((s) => s.enabled);
  const engine = await routedEngineForEnv(env as never);
  const deps: RunPipelineDeps = {
    runStore: stores.runs,
    outcomeStore: stores.outcomes,
    caseStore: stores.cases,
    engine,
    segments,
    panels: stores.panels,
    employees,
    qualitySnapshots: stores.qualitySnapshots,
    events: stores.events,
    actor: "scheduler",
    bundleSource: deckBundleSource(cases, employees),
  };

  const byMeasure = new Map<string, DeckCase[]>(MAUI_MEASURES.map((m) => [m, cases.filter((c) => c.measure === m)]));
  const summary: Summary = {};
  for (const [m, list] of byMeasure) {
    summary[m] = { COMPLIANT: 0, OVERDUE: 0, EXCLUDED: 0, OUT_OF_POPULATION: 0 };
    for (const c of list) summary[m]![c.status]++;
  }
  // One list per measure, holding that deck's patients (the import route accepts only `pat-` ids).
  const lists = new Map<string, string>();
  for (const [m, list] of byMeasure) {
    // A UUID, as the import route mints: the Pg ceiling types the column, the SQLite floor does not.
    const id = crypto.randomUUID();
    lists.set(m, id);
    await stores.subjectLists.createList({
      id,
      name: `MADiE ${m}`,
      source: null,
      note: null,
      createdBy: "madie-e2e",
      now: new Date().toISOString(),
      members: list.map((c) => ({ rawIdentifier: c.patientId, subjectId: c.patientId, resolution: "MATCHED" as const })),
    });
  }

  const firstRunId = await runOnce(deps, stores);
  // Positive control for the idempotency check below: the first run DID write a case event for every
  // case it opened or recorded, so "the second run wrote none" is not true merely because events stopped
  // carrying their run.
  const expectedCaseCount = cases.filter((c) => expectedCase(c.status)).length;
  const firstEvents = (await stores.events.auditEventsByRun(firstRunId)).filter((e) => e.eventType.startsWith("CASE_"));
  assert.equal(new Set(firstEvents.map((e) => e.refCaseId)).size, expectedCaseCount, "the first run recorded an event for every case it created");
  await checkSurfaces(env, firstRunId, cases, byMeasure, lists, summary);
  const stable = (r: CaseRow) => ({ id: r.caseId, subject: r.employeeId, status: r.status, outcome: r.currentOutcomeStatus, closedReason: r.closedReason, closedBy: r.closedBy, closedAt: r.closedAt ?? null, priority: r.priority ?? null, nextAction: r.nextAction ?? null, assignee: r.assignee ?? null });
  const casesBefore = new Map<string, ReturnType<typeof stable>[]>();
  for (const m of MAUI_MEASURES) casesBefore.set(m, (await casesFor(env, m)).map(stable).sort((a, b) => a.id.localeCompare(b.id)));

  // Idempotency (DATA_MODEL_CONTRACTS §4): a second run changes no case and writes no case event.
  const secondRunId = await runOnce(deps, stores);
  const caseEvents = (await stores.events.auditEventsByRun(secondRunId)).filter((e) => e.eventType.startsWith("CASE_"));
  assert.deepEqual(caseEvents.map((e) => `${e.eventType} ${e.refCaseId}`), [], "the second run wrote no case event");
  for (const m of MAUI_MEASURES) {
    const after = (await casesFor(env, m)).map(stable).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(after, casesBefore.get(m), `${m}: cases unchanged by the second run`);
  }
  await checkSurfaces(env, secondRunId, cases, byMeasure, lists, summary);

  return summary;
}
