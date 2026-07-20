/**
 * generate-sql tests — structural invariants of the emitted SQL, guard-rail validation, and the
 * committed-artifact FRESHNESS gate (the generated-files.test.ts pattern): `wcdb-fhir-shim/sql/*.sql`
 * must be byte-identical to a fresh render, so a rule/crosswalk change can never silently drift from
 * what the shim executes. Empirical CORRECTNESS is owned by the shim's live parity suite (ADR-025),
 * not this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { generateSql, toSqlFile } from "./generate-sql.ts";
import { renderAll, WCDB_SQL_MEASURES } from "./generate-sql-cli.ts";
import { loincCodesForMeasure } from "../../ingress/webchart/terminology.ts";

const HYPERTENSION = {
  measureId: "hypertension",
  rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30 } as const,
  loincCodes: ["85354-9", "8480-6"],
};

test("windowed-recency SQL carries the CQL banding thresholds and LOINC set", () => {
  const g = generateSql(HYPERTENSION);
  for (const sql of [g.perPatient, g.singlePatient, g.cohort]) {
    assert.match(sql, /> 365 THEN 'OVERDUE'/, "overdueThreshold = windowDays + grace");
    assert.match(sql, /> 335 THEN 'DUE_SOON'/, "compliantMax = windowDays - dueSoonDays");
    assert.match(sql, /IN \('85354-9','8480-6'\)/, "the crosswalk LOINC set, verbatim");
    assert.match(sql, /IS NULL THEN 'MISSING_DATA'/);
    assert.match(sql, /is_patient = 1/);
    assert.ok(!sql.includes("undefined"), "no interpolation holes");
  }
});

test("grace period folds into the OVERDUE threshold only", () => {
  const g = generateSql({ ...HYPERTENSION, rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30, gracePeriodDays: 14 } });
  assert.match(g.perPatient, /> 379 THEN 'OVERDUE'/);
  assert.match(g.perPatient, /> 335 THEN 'DUE_SOON'/);
});

test("runtime values are placeholders; codes are validated literals", () => {
  const g = generateSql(HYPERTENSION);
  assert.equal((g.perPatient.match(/\?/g) ?? []).length, 1, "per-patient binds eval_date once");
  assert.equal((g.singlePatient.match(/\?/g) ?? []).length, 2, "single-patient binds eval_date + pat_id");
  assert.equal((g.cohort.match(/\?/g) ?? []).length, 1, "cohort binds eval_date once");
  assert.throws(() => generateSql({ ...HYPERTENSION, loincCodes: [] }), /non-empty/);
  assert.throws(
    () => generateSql({ ...HYPERTENSION, loincCodes: ["8480-6' OR '1'='1"] }),
    /not a plausible LOINC/,
    "a non-LOINC-shaped code is refused, never inlined",
  );
});

test("rule validation is shared with generateCql (degenerate params throw)", () => {
  assert.throws(() => generateSql({ ...HYPERTENSION, rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 400 } }), /dueSoonDays/);
  assert.throws(
    () => generateSql({ measureId: "mmr", rule: { type: "series-completion", requiredDoses: 2 } as never, loincCodes: ["4548-4"] }),
    /windowed-recency only/,
  );
});

test("the demo measure set derives its LOINC codes from the crosswalk (single source of truth)", () => {
  for (const m of WCDB_SQL_MEASURES) {
    assert.deepEqual(m.loincCodes, loincCodesForMeasure(m.measureId), m.measureId);
    assert.ok(m.loincCodes.length >= 1, `${m.measureId} has crosswalk LOINC coverage`);
  }
  const hba1c = WCDB_SQL_MEASURES.find((m) => m.measureId === "diabetes_hba1c");
  assert.deepEqual(hba1c?.rule, { type: "windowed-recency", windowDays: 180, dueSoonDays: 20 }, "hba1c bands read off its CQL (<=160/161-180/>180)");
});

test("FRESHNESS: committed wcdb-fhir-shim/sql artifacts are byte-identical to a fresh render", () => {
  const outDir = fileURLToPath(new URL("../../../../../wcdb-fhir-shim/sql", import.meta.url));
  for (const [measureId, content] of renderAll()) {
    let committed: string;
    try {
      committed = readFileSync(path.join(outDir, `${measureId}.sql`), "utf8");
    } catch {
      assert.fail(`wcdb-fhir-shim/sql/${measureId}.sql is missing — run 'pnpm generate:sql' and commit the output`);
    }
    assert.equal(
      committed.replaceAll("\r\n", "\n"),
      content.replaceAll("\r\n", "\n"),
      `wcdb-fhir-shim/sql/${measureId}.sql is stale — run 'pnpm generate:sql' and commit the output`,
    );
  }
});

test("toSqlFile stamps provenance and statement markers", () => {
  const file = toSqlFile("hypertension", HYPERTENSION);
  assert.match(file, /^-- GENERATED FILE/);
  assert.match(file, /-- @statement per-patient/);
  assert.match(file, /-- @statement single-patient/);
  assert.match(file, /-- @statement cohort/);
});
