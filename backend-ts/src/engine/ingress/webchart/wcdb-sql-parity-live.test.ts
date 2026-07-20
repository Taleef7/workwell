/**
 * LIVE SQL-vs-CQL golden-parity gate (#292 / ADR-025 / ADR-034) — the wave's headline test.
 *
 * For every measure with generated WCDB SQL, compare — PER PATIENT across the whole 56-subject
 * dev-wcdb population — two independent execution paths that share nothing but the database:
 *
 *   SQL path : the wcdb-fhir-shim compliance API executing the committed generated SQL
 *              (`GET {base}/compliance/{measureId}/cohort`) directly against MariaDB;
 *   CQL path : this repo's engine (the ORACLE) evaluating the same population fetched as FHIR
 *              from the same shim (`httpWebChartClient` → roster stamp → `evaluateBatch`).
 *
 * ADR-025: a measure that has never passed this gate is never served by SQL; on divergence the
 * SQL template is wrong by definition — the oracle is never adjusted to match it.
 *
 * Self-skips unless the DEDICATED `WCDB_SHIM_PARITY_BASE_URL` is set AND reachable (the
 * hapi-live.test.ts precedent; deliberately not the runtime var, and not the HAPI test var — HAPI
 * has no /compliance surface):
 *
 *   docker compose -f ../infra/docker-compose.yml --profile wcdb up -d wcdb wcdb-fhir-shim
 *   WCDB_SHIM_PARITY_BASE_URL=http://localhost:8085 pnpm test src/engine/ingress/webchart/wcdb-sql-parity-live.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureWebChartClient, httpWebChartClient } from "./webchart-client.ts";
import { webChartDataSource } from "../data-source.ts";
import { parseEnrollmentRoster, evaluateSourceWithRoster } from "../enrollment/roster.ts";
import { WCDB_SQL_MEASURES } from "../../cql/codegen/generate-sql-cli.ts";

const BASE_URL = (process.env.WCDB_SHIM_PARITY_BASE_URL ?? "").trim().replace(/\/+$/, "");
const PARITY_DATE = "2024-06-01"; // data-contemporaneous with the dev-wcdb seed (the devdb CLI default)
/**
 * Derived from the codegen's own measure list (never a hand copy — review M1): a measure added to
 * WCDB_SQL_MEASURES gets a committed, shim-executable artifact, and MUST enter this gate with it;
 * per ADR-025 an artifact with no parity coverage would defeat the wave's central invariant.
 */
const SQL_MEASURES = WCDB_SQL_MEASURES.map((m) => m.measureId);

async function shimReachable(): Promise<boolean> {
  if (!BASE_URL) return false;
  try {
    const res = await fetch(`${BASE_URL}/fhir/metadata`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

const skip = (await shimReachable())
  ? false
  : BASE_URL
    ? `wcdb-fhir-shim at ${BASE_URL} is not reachable — skipping the SQL parity suite`
    : "WCDB_SHIM_PARITY_BASE_URL not set — SQL parity suite not available";

test("GOLDEN PARITY: generated-SQL verdicts == CQL-oracle verdicts, per patient, per measure", { skip }, async () => {
  const cfg = { baseUrl: BASE_URL, apiKey: "parity-test" };

  // One population fetch (the shim's FHIR surface), replayed per measure through the fixture client.
  const payloads = await httpWebChartClient(cfg).fetchPatientPayloads();
  assert.equal(payloads.length, 56, "the full dev-wcdb population");
  const subjectIds = payloads
    .map((p) => {
      const entry = (p as { entry?: { resource?: { resourceType?: string; id?: string } }[] }).entry ?? [];
      return entry.find((e) => e.resource?.resourceType === "Patient")?.resource?.id;
    })
    .filter((id): id is string => typeof id === "string");
  const roster = parseEnrollmentRoster(Object.fromEntries(subjectIds.map((id) => [id, SQL_MEASURES])));

  const failures: string[] = [];
  for (const measureId of SQL_MEASURES) {
    // CQL oracle: engine over the shim's own FHIR output.
    const src = webChartDataSource(cfg, fixtureWebChartClient(payloads));
    const res = await evaluateSourceWithRoster(src, measureId, roster, { evaluationDate: PARITY_DATE });
    const oracle = new Map<string, string>();
    for (const r of res.results) {
      if (r.ok && r.outcome) oracle.set(r.outcome.subjectId, r.outcome.outcome);
      else failures.push(`${measureId}: CQL evaluation failed for item #${r.index}: ${r.ok ? "no outcome" : r.error}`);
    }

    // SQL path: the shim's compliance API executing the committed generated SQL against MariaDB.
    const httpRes = await fetch(`${BASE_URL}/compliance/${measureId}/cohort?end=${PARITY_DATE}`, {
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(httpRes.status, 200, `${measureId}: shim has generated SQL + a working cohort endpoint`);
    const cohort = (await httpRes.json()) as { patients: Array<{ subjectId: string; outcomeStatus: string }> };
    const sql = new Map(cohort.patients.map((p) => [p.subjectId, p.outcomeStatus]));

    assert.equal(sql.size, 56, `${measureId}: SQL cohort covers the full population`);
    assert.equal(oracle.size, 56, `${measureId}: CQL oracle covers the full population`);
    for (const [subjectId, cqlOutcome] of oracle) {
      const sqlOutcome = sql.get(subjectId);
      if (sqlOutcome !== cqlOutcome) {
        failures.push(`${measureId} ${subjectId}: SQL='${sqlOutcome}' CQL='${cqlOutcome}'`);
      }
    }
  }

  assert.deepEqual(failures, [], `SQL/CQL divergence — fix the SQL template, never the oracle:\n${failures.join("\n")}`);
});

test("parity date sensitivity: EVERY SQL measure agrees on a shifted evaluation date too", { skip }, async () => {
  // A second date exercises different DATEDIFF bandings per measure (subjects cross
  // COMPLIANT→DUE_SOON/OVERDUE at measure-specific thresholds — hba1c's 180/20 bands shift on a
  // different cadence than the 365/30 measures, so the full matrix is 4 measures × 56 × 2 dates
  // and no measure/date combination is claimed untested (Codex P2 ×2).
  const ALT_DATE = "2024-11-15";
  const cfg = { baseUrl: BASE_URL, apiKey: "parity-test" };
  const payloads = await httpWebChartClient(cfg).fetchPatientPayloads();
  const subjectIds = payloads
    .map((p) => {
      const entry = (p as { entry?: { resource?: { resourceType?: string; id?: string } }[] }).entry ?? [];
      return entry.find((e) => e.resource?.resourceType === "Patient")?.resource?.id;
    })
    .filter((id): id is string => typeof id === "string");
  const roster = parseEnrollmentRoster(Object.fromEntries(subjectIds.map((id) => [id, SQL_MEASURES])));

  for (const measureId of SQL_MEASURES) {
    const src = webChartDataSource(cfg, fixtureWebChartClient(payloads));
    const res = await evaluateSourceWithRoster(src, measureId, roster, { evaluationDate: ALT_DATE });
    const oracle = new Map<string, string>();
    for (const r of res.results) {
      assert.ok(r.ok && r.outcome, `${measureId}@${ALT_DATE}: CQL evaluation failed for item #${r.index}`);
      oracle.set(r.outcome!.subjectId, r.outcome!.outcome);
    }
    assert.equal(oracle.size, 56, `${measureId}@${ALT_DATE}: oracle covers the full population (no vacuous pass)`);

    const cohort = (await (await fetch(`${BASE_URL}/compliance/${measureId}/cohort?end=${ALT_DATE}`)).json()) as {
      patients: Array<{ subjectId: string; outcomeStatus: string }>;
    };
    const sql = new Map(cohort.patients.map((p) => [p.subjectId, p.outcomeStatus]));
    assert.equal(sql.size, 56, `${measureId}@${ALT_DATE}: SQL cohort covers the full population`);
    for (const [subjectId, cqlOutcome] of oracle) {
      assert.equal(sql.get(subjectId), cqlOutcome, `${measureId}@${ALT_DATE} ${subjectId}`);
    }
  }
});
