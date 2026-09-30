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
 * The ORACLE below is written from the specification (the population table in #727), not by calling
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

export const MAUI_MEASURES = ["cms122", "cms125", "cms2", "cms130", "cms165", "cms137"] as const;
export type MauiMeasure = (typeof MAUI_MEASURES)[number];

/** Every deck resolves to the 2026 calendar year; an evaluation date inside it scores that year. */
export const EVALUATION_DATE = "2026-12-31";
const MEASUREMENT_YEAR = 2026;

/** CMS122 counts POOR control, so being in its numerator is the gap (`official-measure-semantics.ts`). */
const NUMERATOR_IS_THE_GAP = new Set<string>(["cms122"]);

// ── The oracle ───────────────────────────────────────────────────────────────────────────────────────

export type DisplayStatus = "COMPLIANT" | "OVERDUE" | "EXCLUDED" | "OUT_OF_POPULATION";

/** The steward's populations for one rate, as booleans, normalised the way the QI-Core IG scores them. */
export interface Membership {
  ipp: boolean;
  denom: boolean;
  denex: boolean;
  numer: boolean;
  denexcep: boolean;
}

/**
 * A rate's membership as the eCQM counts it: an excluded patient is not scored in the numerator, and an
 * exception applies only to a patient who did not meet the numerator (QI-Core Measure IG, "Denominator
 * Membership" / "Numerator Membership").
 */
export function membershipOf(counts: PopulationCounts): Membership {
  const ipp = counts["initial-population"] > 0;
  const denom = counts.denominator > 0;
  const denex = counts["denominator-exclusion"] > 0;
  const numerRaw = counts.numerator > 0;
  const denexcepRaw = counts["denominator-exception"] > 0;
  return { ipp, denom, denex, numer: numerRaw && !denex, denexcep: denexcepRaw && !denex && !numerRaw };
}

/** One rate's display status, from the population table in #727. */
function rateStatus(measure: string, counts: PopulationCounts): DisplayStatus {
  if (counts["initial-population"] === 0) return "OUT_OF_POPULATION";
  if (counts.denominator === 0) return "EXCLUDED";
  if (counts["denominator-exclusion"] > 0 || counts["denominator-exception"] > 0) return "EXCLUDED";
  const inNumerator = counts.numerator > 0;
  const gap = NUMERATOR_IS_THE_GAP.has(measure) ? inNumerator : !inNumerator;
  return gap ? "OVERDUE" : "COMPLIANT";
}

/** Worst first. A multi-rate patient shows the worst result across the rates they are in. */
const SEVERITY: Record<Exclude<DisplayStatus, "OUT_OF_POPULATION">, number> = { OVERDUE: 2, COMPLIANT: 1, EXCLUDED: 0 };

export function expectedStatus(measure: string, rates: readonly PopulationCounts[]): DisplayStatus {
  const inPopulation = rates.map((r) => rateStatus(measure, r)).filter((s): s is Exclude<DisplayStatus, "OUT_OF_POPULATION"> => s !== "OUT_OF_POPULATION");
  if (inPopulation.length === 0) return "OUT_OF_POPULATION";
  return inPopulation.reduce((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst));
}

/** The case a status leaves: a gap opens one, an exclusion records a closed one, the rest none. */
export function expectedCase(status: DisplayStatus): { status: string } | null {
  if (status === "OVERDUE") return { status: "OPEN" };
  if (status === "EXCLUDED") return { status: "EXCLUDED" };
  return null;
}

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
  return lines.slice(1).map((line) => Object.fromEntries(cells(line).map((v, i) => [header[i]!, v])));
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

interface CaseRow { caseId: string; employeeId: string; status: string; currentOutcomeStatus: string; closedReason: string | null; priority?: string; nextAction?: string | null; assignee?: string | null; closedAt?: string | null }

async function casesFor(env: MadieEnv, measure: string): Promise<CaseRow[]> {
  const rows = await body<CaseRow[]>(
    await handleCases(new Request(`http://x/api/cases?status=all&measureId=${measure}&limit=500`), env as never, "madie-e2e"),
    `cases ${measure}`,
  );
  return rows;
}

/**
 * Runs the six decks through one ALL_PROGRAMS run on the stores `env` selects, checks every surface
 * against the oracle, then runs again and checks nothing changed. Returns a per-measure summary for the
 * evidence file.
 */
export async function runMadieEndToEnd(env: MadieEnv): Promise<Record<string, Record<DisplayStatus, number>>> {
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

  const runId = await runOnce(deps, stores);
  const byMeasure = new Map<string, DeckCase[]>(MAUI_MEASURES.map((m) => [m, cases.filter((c) => c.measure === m)]));
  const summary: Record<string, Record<DisplayStatus, number>> = {};
  for (const [m, list] of byMeasure) {
    summary[m] = { COMPLIANT: 0, OVERDUE: 0, EXCLUDED: 0, OUT_OF_POPULATION: 0 };
    for (const c of list) summary[m]![c.status]++;
  }

  // 1. Reconciliation: every deck patient persisted once, nothing errored.
  const recon = await body<{ rowsPersisted: number; evaluationErrors: number | null; notInPopulation: number }>(
    await handleRuns(new Request(`http://x/api/runs/${runId}/reconciliation`), env as never),
    "reconciliation",
  );
  assert.equal(recon.rowsPersisted, cases.length, "one outcome per deck patient");
  assert.equal(recon.evaluationErrors ?? 0, 0, "no evaluation errors");
  assert.equal(recon.notInPopulation, cases.filter((c) => c.status === "OUT_OF_POPULATION").length, "out-of-population count");

  // 2. The subject-list report, per patient per rate: the steward's populations exactly.
  for (const [m, list] of byMeasure) {
    // A UUID, as the import route mints: the Pg ceiling types the column, the SQLite floor does not.
    const listId = crypto.randomUUID();
    await stores.subjectLists.createList({
      id: listId,
      name: `MADiE ${m}`,
      source: null,
      note: null,
      createdBy: "madie-e2e",
      now: new Date().toISOString(),
      members: list.map((c) => ({ rawIdentifier: c.patientId, subjectId: c.patientId, resolution: "MATCHED" as const })),
    });
    const res = await handleSubjectLists(
      new Request(`http://x/api/subject-lists/${listId}/report?measurementYear=${MEASUREMENT_YEAR}&format=csv`),
      env as never,
      "madie-e2e",
    );
    assert.ok(res);
    const csv = await res.text();
    assert.equal(res.status, 200, `report ${m}: ${csv.slice(0, 400)}`);
    const rows = parseCsv(csv).filter((r) => r.measureId === m);
    for (const c of list) {
      const mine = rows.filter((r) => r.patientExternalId === c.patientId);
      assert.equal(mine.length, c.rates.length, `${caseLabel(c)}: one report row per rate, got ${mine.map((r) => r.rowStatus).join(",")}`);
      c.rates.forEach((counts, i) => {
        const row = mine[i]!;
        const want = membershipOf(counts);
        const got = {
          ipp: row.initialPopulation === "true",
          denom: row.denominator === "true",
          denex: row.denominatorExclusion === "true",
          numer: row.numerator === "true",
          denexcep: row.denominatorException === "true",
        };
        assert.equal(row.rowStatus, "EVALUATED", `${caseLabel(c)} rate ${i + 1}: evaluated`);
        assert.deepEqual(got, want, `${caseLabel(c)} rate ${i + 1}: populations`);
      });
    }
  }

  // 3. The roster: each patient's cell for its measure, and "not evaluated" for the other five.
  const cells = new Map<string, Record<string, { status: string }>>();
  for (let page = 1; ; page++) {
    const roster = await body<{ rows: Array<{ subject: { externalId: string }; cells: Record<string, { status: string }> }>; total: number }>(
      await handleCompliance(new Request(`http://x/api/compliance/roster?panel=${PROFILE_DEFAULT_PANEL}&pageSize=200&page=${page}`), env as never),
      `roster page ${page}`,
    );
    for (const r of roster.rows) cells.set(r.subject.externalId, r.cells);
    if (roster.rows.length === 0 || cells.size >= roster.total) break;
  }
  assert.equal(cells.size, cases.length, "the roster is exactly the deck patients");
  for (const c of cases) {
    const row = cells.get(c.patientId);
    assert.ok(row, `${caseLabel(c)}: on the roster`);
    assert.equal(row[c.measure]?.status, c.status, `${caseLabel(c)}: roster cell`);
    for (const other of MAUI_MEASURES.filter((m) => m !== c.measure)) {
      assert.equal(row[other]?.status, "NA", `${caseLabel(c)}: ${other} must read not evaluated (no cross-measure leak)`);
    }
  }

  // 4. Cases: which patients have one, and its state.
  const casesBefore = new Map<string, CaseRow[]>();
  for (const [m, list] of byMeasure) {
    const rows = await casesFor(env, m);
    casesBefore.set(m, rows);
    const bySubject = new Map(rows.map((r) => [r.employeeId, r]));
    assert.equal(rows.length, bySubject.size, `${m}: one case per patient at most`);
    for (const c of list) {
      const want = expectedCase(c.status);
      const got = bySubject.get(c.patientId);
      if (!want) assert.equal(got, undefined, `${caseLabel(c)}: ${c.status} opens no case`);
      else assert.equal(got?.status, want.status, `${caseLabel(c)}: case for ${c.status}`);
    }
  }

  // 5. Programs overview: buckets from the summed oracle, and the steward's rate formula.
  const overview = await body<Array<{
    measureId: string; compliant: number; dueSoon: number; overdue: number; missingData: number; notInPopulation: number; excluded: number;
    measureRate: { rates: Array<{ numer: number; effectiveDenominator: number; score: number | null }> } | null;
  }>>(await handlePrograms(new Request("http://x/api/programs/overview"), env as never), "programs overview");
  for (const [m, list] of byMeasure) {
    const s = overview.find((o) => o.measureId === m);
    assert.ok(s, `${m}: on the programs overview`);
    const want = summary[m]!;
    assert.deepEqual(
      { compliant: s.compliant, overdue: s.overdue, excluded: s.excluded, notInPopulation: s.notInPopulation, dueSoon: s.dueSoon, missingData: s.missingData },
      { compliant: want.COMPLIANT, overdue: want.OVERDUE, excluded: want.EXCLUDED, notInPopulation: want.OUT_OF_POPULATION, dueSoon: 0, missingData: 0 },
      `${m}: overview buckets`,
    );
    const rateCount = list[0]!.rates.length;
    assert.equal(s.measureRate?.rates.length, rateCount, `${m}: one rate per steward group`);
    for (let i = 0; i < rateCount; i++) {
      const members = list.map((c) => membershipOf(c.rates[i]!));
      const numer = members.filter((x) => x.numer).length;
      const effective = members.filter((x) => x.denom).length - members.filter((x) => x.denex).length - members.filter((x) => x.denexcep).length;
      const rate: { numer: number; effectiveDenominator: number } = s.measureRate!.rates[i]!;
      assert.deepEqual(
        { numer: rate.numer, effectiveDenominator: rate.effectiveDenominator },
        { numer, effectiveDenominator: effective },
        `${m} rate ${i + 1}: numerator ÷ (denominator − exclusions − exceptions)`,
      );
    }
  }

  // 6. Idempotency (DATA_MODEL_CONTRACTS §4): a second run changes no case and writes no case event.
  const secondRunId = await runOnce(deps, stores);
  const caseEvents = (await stores.events.auditEventsByRun(secondRunId)).filter((e) => e.eventType.startsWith("CASE_"));
  assert.deepEqual(caseEvents.map((e) => `${e.eventType} ${e.refCaseId}`), [], "the second run wrote no case event");
  const stable = (r: CaseRow) => ({ id: r.caseId, subject: r.employeeId, status: r.status, outcome: r.currentOutcomeStatus, closedReason: r.closedReason, closedAt: r.closedAt ?? null, priority: r.priority ?? null, nextAction: r.nextAction ?? null, assignee: r.assignee ?? null });
  for (const m of MAUI_MEASURES) {
    const after = (await casesFor(env, m)).map(stable).sort((a, b) => a.id.localeCompare(b.id));
    const before = casesBefore.get(m)!.map(stable).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(after, before, `${m}: cases unchanged by the second run`);
  }

  return summary;
}
