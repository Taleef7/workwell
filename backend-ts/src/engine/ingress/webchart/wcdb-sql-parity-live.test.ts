/**
 * LIVE SQL-vs-CQL golden-parity gate (#292 / ADR-025 / ADR-034) — the wave's headline test.
 *
 * For every measure with generated WCDB SQL, compare — PER PATIENT across the whole dev-wcdb
 * population — two independent execution paths that share nothing but the database:
 *
 *   SQL path : the wcdb-fhir-shim compliance API executing the committed generated SQL
 *              (`GET {base}/compliance/{measureId}/cohort`) directly against MariaDB;
 *   CQL path : this repo's engine (the ORACLE) evaluating the same population fetched as FHIR
 *              from the same shim (`httpWebChartClient` → roster stamp → `evaluateBatch`).
 *
 * ADR-025: a measure that has never passed this gate is never served by SQL; on divergence the
 * SQL template is wrong by definition — the oracle is never adjusted to match it.
 *
 * FAIL-CLOSED (Codex P1): the suite self-skips ONLY when `WCDB_SHIM_PARITY_BASE_URL` is unset.
 * A set-but-unreachable shim (typo, crashed container) FAILS the gate — a configured parity run
 * that silently skips would let unverified SQL pass review.
 *
 * Band coverage: the 56-patient seed exercises COMPLIANT/OVERDUE/MISSING_DATA (asserted). The
 * DUE_SOON band is exercised when the designed ingest fixtures are present
 * (`cd wcdb-fhir-shim && npm run ingest -- --file patients.example.yaml` — Marcus Demoson lands
 * DUE_SOON); when the population is the bare seed, the suite prints a notice. Either way, parity
 * is asserted per patient over EVERY subject actually present.
 *
 *   docker compose -f ../infra/docker-compose.yml --profile wcdb up -d wcdb wcdb-fhir-shim
 *   WCDB_SHIM_PARITY_BASE_URL=http://localhost:8085 pnpm test src/engine/ingress/webchart/wcdb-sql-parity-live.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fixtureWebChartClient, httpWebChartClient } from "./webchart-client.ts";
import { webChartDataSource } from "../data-source.ts";
import { parseEnrollmentRoster, evaluateSourceWithRoster } from "../enrollment/roster.ts";
import { WCDB_SQL_MEASURES } from "../../cql/codegen/generate-sql-cli.ts";

const BASE_URL = (process.env.WCDB_SHIM_PARITY_BASE_URL ?? "").trim().replace(/\/+$/, "");
const PARITY_DATE = "2024-06-01"; // data-contemporaneous with the dev-wcdb seed (the devdb CLI default)
const ALT_DATE = "2024-11-15"; // 5.5 months on — subjects cross band thresholds (asserted below)
const SEED_POPULATION = 56;
/**
 * Derived from the codegen's own measure list (never a hand copy — review M1): a measure added to
 * WCDB_SQL_MEASURES gets a committed, shim-executable artifact, and MUST enter this gate with it;
 * per ADR-025 an artifact with no parity coverage would defeat the wave's central invariant.
 */
const SQL_MEASURES = WCDB_SQL_MEASURES.map((m) => m.measureId);

// Self-skip ONLY on unset; reachability is asserted inside the tests (fail-closed).
const skip = BASE_URL ? false : "WCDB_SHIM_PARITY_BASE_URL not set — SQL parity suite not available";

async function assertShimReachable(): Promise<void> {
  let ok = false;
  try {
    const res = await fetch(`${BASE_URL}/fhir/metadata`, { signal: AbortSignal.timeout(2_000) });
    ok = res.ok;
  } catch {
    ok = false;
  }
  assert.ok(
    ok,
    `WCDB_SHIM_PARITY_BASE_URL is set but ${BASE_URL} is unreachable — a CONFIGURED parity gate ` +
      `must FAIL, never skip (fail-closed): fix the URL or start the shim ` +
      `(docker compose --profile wcdb up -d wcdb wcdb-fhir-shim)`,
  );
}

/** The committed artifact set must equal the measure registry — no orphaned or unmatched SQL. */
test("committed SQL artifacts exactly match the codegen measure registry", () => {
  const sqlDir = fileURLToPath(new URL("../../../../../wcdb-fhir-shim/sql/", import.meta.url));
  const artifacts = readdirSync(sqlDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.slice(0, -4))
    .sort();
  assert.deepEqual(
    artifacts,
    [...SQL_MEASURES].sort(),
    "an artifact without a registry entry would be served without ever entering this gate (or vice versa)",
  );
});

async function fetchPopulation(cfg: { baseUrl: string; apiKey: string }) {
  const payloads = await httpWebChartClient(cfg).fetchPatientPayloads();
  const subjectIds = payloads
    .map((p) => {
      const entry = (p as { entry?: { resource?: { resourceType?: string; id?: string } }[] }).entry ?? [];
      return entry.find((e) => e.resource?.resourceType === "Patient")?.resource?.id;
    })
    .filter((id): id is string => typeof id === "string");
  const roster = parseEnrollmentRoster(Object.fromEntries(subjectIds.map((id) => [id, SQL_MEASURES])));
  return { payloads, roster, population: payloads.length };
}

async function fetchSqlVerdicts(measureId: string, date: string): Promise<Map<string, string>> {
  const httpRes = await fetch(`${BASE_URL}/compliance/${measureId}/cohort?end=${date}`, {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(httpRes.status, 200, `${measureId}@${date}: shim has generated SQL + a working cohort endpoint`);
  const cohort = (await httpRes.json()) as { patients: Array<{ subjectId: string; outcomeStatus: string }> };
  return new Map(cohort.patients.map((p) => [p.subjectId, p.outcomeStatus]));
}

// Filled by the first test; the date-sensitivity assertion in the second reads it.
const oracleByDate = new Map<string, Map<string, string>>(); // `${measureId}@${date}` → subject → outcome

test("GOLDEN PARITY: generated-SQL verdicts == CQL-oracle verdicts, per patient, per measure", { skip }, async () => {
  await assertShimReachable();
  const cfg = { baseUrl: BASE_URL, apiKey: "parity-test" };
  const { payloads, roster, population } = await fetchPopulation(cfg);
  assert.ok(population >= SEED_POPULATION, `at least the full dev-wcdb seed population (got ${population})`);

  const failures: string[] = [];
  const statusesSeen = new Set<string>();
  for (const measureId of SQL_MEASURES) {
    // CQL oracle: engine over the shim's own FHIR output.
    const src = webChartDataSource(cfg, fixtureWebChartClient(payloads));
    const res = await evaluateSourceWithRoster(src, measureId, roster, { evaluationDate: PARITY_DATE });
    const oracle = new Map<string, string>();
    for (const r of res.results) {
      if (r.ok && r.outcome) oracle.set(r.outcome.subjectId, r.outcome.outcome);
      else failures.push(`${measureId}: CQL evaluation failed for item #${r.index}: ${r.ok ? "no outcome" : r.error}`);
    }
    for (const status of oracle.values()) statusesSeen.add(status);
    oracleByDate.set(`${measureId}@${PARITY_DATE}`, oracle);

    const sql = await fetchSqlVerdicts(measureId, PARITY_DATE);
    assert.equal(sql.size, population, `${measureId}: SQL cohort covers the full population`);
    assert.equal(oracle.size, population, `${measureId}: CQL oracle covers the full population`);
    for (const [subjectId, cqlOutcome] of oracle) {
      const sqlOutcome = sql.get(subjectId);
      if (sqlOutcome !== cqlOutcome) {
        failures.push(`${measureId} ${subjectId}: SQL='${sqlOutcome}' CQL='${cqlOutcome}'`);
      }
    }
  }

  assert.deepEqual(failures, [], `SQL/CQL divergence — fix the SQL template, never the oracle:\n${failures.join("\n")}`);

  // Non-vacuity: a gate whose oracle only ever says one thing proves nothing (Codex P2).
  for (const required of ["COMPLIANT", "OVERDUE", "MISSING_DATA"]) {
    assert.ok(statusesSeen.has(required), `the population exercises the ${required} band (got: ${[...statusesSeen].join(", ")})`);
  }
  if (population > SEED_POPULATION) {
    assert.ok(
      statusesSeen.has("DUE_SOON"),
      "with the designed ingest fixtures present, the DUE_SOON band must be exercised (Marcus Demoson)",
    );
  } else if (!statusesSeen.has("DUE_SOON")) {
    console.log(
      "notice: bare seed population — no DUE_SOON subject at this date; for full band coverage run " +
        "`cd wcdb-fhir-shim && npm run ingest -- --file patients.example.yaml` and re-run this suite " +
        "(roll back afterwards)",
    );
  }
});

test("parity date sensitivity: EVERY SQL measure agrees on a shifted evaluation date too", { skip }, async () => {
  await assertShimReachable();
  // A second date exercises different DATEDIFF bandings per measure (subjects cross
  // COMPLIANT→DUE_SOON/OVERDUE at measure-specific thresholds — hba1c's 180/20 bands shift on a
  // different cadence than the 365/30 measures), so the full matrix is measures × population × 2
  // dates and no measure/date combination is claimed untested (Codex P2 ×2).
  const cfg = { baseUrl: BASE_URL, apiKey: "parity-test" };
  const { payloads, roster, population } = await fetchPopulation(cfg);

  let anyDateShift = false;
  for (const measureId of SQL_MEASURES) {
    const src = webChartDataSource(cfg, fixtureWebChartClient(payloads));
    const res = await evaluateSourceWithRoster(src, measureId, roster, { evaluationDate: ALT_DATE });
    const oracle = new Map<string, string>();
    for (const r of res.results) {
      assert.ok(r.ok && r.outcome, `${measureId}@${ALT_DATE}: CQL evaluation failed for item #${r.index}`);
      oracle.set(r.outcome!.subjectId, r.outcome!.outcome);
    }
    assert.equal(oracle.size, population, `${measureId}@${ALT_DATE}: oracle covers the full population (no vacuous pass)`);

    const sql = await fetchSqlVerdicts(measureId, ALT_DATE);
    assert.equal(sql.size, population, `${measureId}@${ALT_DATE}: SQL cohort covers the full population`);
    for (const [subjectId, cqlOutcome] of oracle) {
      assert.equal(sql.get(subjectId), cqlOutcome, `${measureId}@${ALT_DATE} ${subjectId}`);
    }

    // Date sensitivity: if NO subject's outcome moves between the two dates for ANY measure, the
    // "second date" adds nothing and an end-date-ignoring SQL bug would be invisible (Codex P2).
    const atParity = oracleByDate.get(`${measureId}@${PARITY_DATE}`);
    if (atParity) {
      for (const [subjectId, outcome] of oracle) {
        if (atParity.get(subjectId) !== outcome) anyDateShift = true;
      }
    }
  }
  if (oracleByDate.size > 0) {
    assert.ok(
      anyDateShift,
      `no subject changed outcome between ${PARITY_DATE} and ${ALT_DATE} on any measure — the alternate date ` +
        `is not exercising the date-banding logic; pick dates that move at least one subject across a band`,
    );
  }
});
