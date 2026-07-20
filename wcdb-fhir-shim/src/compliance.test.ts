/**
 * compliance API tests — the committed-artifact parser, param binding, and the HTTP routes over a
 * stubbed executor (no MariaDB — CI-safe). Empirical SQL-vs-CQL correctness is the live parity
 * suite's job (ADR-025), not this file's.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { ShimDb } from "./db.ts";
import { createShimServer } from "./server.ts";
import { loadMeasureSql, parseSqlFile, parsePeriod, ComplianceError } from "./compliance.ts";

// ---------- parser over the REAL committed artifacts ----------

test("loadMeasureSql parses every committed artifact with meta + all three statements", () => {
  const all = loadMeasureSql();
  for (const id of ["hypertension", "cholesterol_ldl", "obesity_bmi", "diabetes_hba1c"]) {
    const m = all.get(id);
    assert.ok(m, `${id}.sql loaded`);
    assert.ok(m!.meta.windowDays, `${id} meta parsed`);
    for (const s of ["per-patient", "single-patient", "cohort"]) {
      assert.ok(m!.statements[s], `${id} has @statement ${s}`);
      assert.ok(!m!.statements[s]!.includes("@statement"), `${id} ${s} split cleanly`);
    }
  }
  const hba1c = all.get("diabetes_hba1c")!;
  assert.equal(hba1c.meta.windowDays, 180);
  assert.equal(hba1c.meta.dueSoonDays, 20);
});

test("parseSqlFile rejects an artifact missing a section", () => {
  assert.throws(() => parseSqlFile("x", "-- header only\nSELECT 1;"), /missing a required @statement/);
});

test("parsePeriod validates dates and defaults end to today", () => {
  const today = () => "2026-07-20";
  assert.deepEqual(parsePeriod(new URLSearchParams("start=2025-07-23&end=2026-07-23"), today), {
    start: "2025-07-23",
    end: "2026-07-23",
  });
  assert.deepEqual(parsePeriod(new URLSearchParams(""), today), { start: undefined, end: "2026-07-20" });
  assert.throws(() => parsePeriod(new URLSearchParams("end=23-07-2026"), today), ComplianceError);
  // Codex P2: shape-valid but non-calendar dates must 400, never reach CAST(? AS DATE).
  assert.throws(() => parsePeriod(new URLSearchParams("end=2026-02-31"), today), ComplianceError);
  assert.throws(() => parsePeriod(new URLSearchParams("end=0000-00-00"), today), ComplianceError);
  assert.throws(() => parsePeriod(new URLSearchParams("start=2026-13-01&end=2026-07-01"), today), ComplianceError);
  assert.doesNotThrow(() => parsePeriod(new URLSearchParams("end=2024-02-29"), today), "leap day is valid");
});

// ---------- HTTP routes over a stubbed executor ----------

const PER_PATIENT_ROWS = [
  { pat_id: 5, subject_id: "wc-5", last_event_date: "2024-05-01", days_since: 31, outcome_status: "COMPLIANT" },
  { pat_id: 6, subject_id: "wc-6", last_event_date: null, days_since: null, outcome_status: "MISSING_DATA" },
];
const COHORT_ROW = { denominator: 2, numerator: 1, compliant: 1, due_soon: 0, overdue: 0, missing_data: 1 };

const captured: Array<{ sql: string; params: unknown[] }> = [];

function stubDb(): ShimDb {
  return {
    countPatients: async () => 0,
    listPatients: async () => [],
    observationsForPatient: async () => [],
    proceduresForPatient: async () => [],
    queryRows: async (sql, params) => {
      captured.push({ sql, params });
      if (/COUNT\(\*\) AS denominator/.test(sql)) return [COHORT_ROW];
      if (/pat_id = \?/.test(sql)) {
        const row = PER_PATIENT_ROWS.find((r) => r.pat_id === params[1]);
        return row ? [row] : [];
      }
      return PER_PATIENT_ROWS;
    },
    end: async () => {},
  };
}

let server: Server;
let base: string;

before(async () => {
  server = createShimServer({ db: stubDb(), today: () => "2024-06-01" }); // real committed sql/ artifacts
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const getJson = async (path: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
};

test("GET /compliance/{measureId}/cohort returns numerator/denominator + per-patient verdicts", async () => {
  captured.length = 0;
  const { status, body } = await getJson("/compliance/hypertension/cohort?start=2023-06-01&end=2024-06-01");
  assert.equal(status, 200);
  assert.equal(body.measureId, "hypertension");
  assert.equal(body.denominator, 2);
  assert.equal(body.numerator, 1);
  assert.equal(body.rate, 50);
  assert.equal(body.counts.MISSING_DATA, 1);
  assert.equal(body.period.evaluationDate, "2024-06-01");
  assert.equal(body.period.requestedStart, "2023-06-01");
  assert.equal(body.period.ruleWindowDays, 365);
  assert.deepEqual(
    body.patients.map((p: any) => [p.subjectId, p.compliant]),
    [
      ["wc-5", true],
      ["wc-6", false],
    ],
  );
  for (const call of captured) assert.deepEqual(call.params.slice(0, 1), ["2024-06-01"], "eval_date bound as a param");
});

test("GET /compliance/{patientId}/{measureId} answers Doug's single-patient question", async () => {
  captured.length = 0;
  const { status, body } = await getJson("/compliance/wc-5/hypertension?end=2024-06-01");
  assert.equal(status, 200);
  assert.equal(body.subjectId, "wc-5");
  assert.equal(body.outcomeStatus, "COMPLIANT");
  assert.equal(body.compliant, true);
  assert.equal(body.daysSince, 31);
  assert.deepEqual(captured[0]?.params, ["2024-06-01", 5], "binds [eval_date, pat_id]");

  const numeric = await getJson("/compliance/5/hypertension?end=2024-06-01");
  assert.equal(numeric.body.subjectId, "wc-5", "bare numeric pat_id accepted");
});

test("compliance API error surface: unknown measure 404, bad date 400, bad patient 400, absent patient 404", async () => {
  assert.equal((await getJson("/compliance/nope/cohort")).status, 404);
  assert.equal((await getJson("/compliance/hypertension/cohort?end=junk")).status, 400);
  assert.equal((await getJson("/compliance/emp-006/hypertension?end=2024-06-01")).status, 400);
  assert.equal((await getJson("/compliance/wc-999/hypertension?end=2024-06-01")).status, 404);
});
