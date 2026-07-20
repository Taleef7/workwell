/**
 * Lib for `pnpm generate:sql` — regenerates the committed WCDB SQL artifacts in `wcdb-fhir-shim/sql/`
 * (side-effect-free on import; the runnable entry is generate-sql-bin.ts, the seed-scale pattern).
 *
 * The live "CQL → boom → SQL" moment (#292 / ADR-034): the same measure definitions that compile to
 * CQL are templated to parameterized MariaDB SQL for the WebChart schema. Output is COMMITTED and
 * reviewed (freshness-guarded by generate-sql.test.ts); the shim executes it with bound params.
 *
 * Demo measure set: the four observation-backed windowed-recency measures the dev-wcdb data can
 * exercise (verified LOINC coverage 2026-07-20 — BMI 13 / systolic 9 / HbA1c 4 / LDL 1 patients).
 * Rule params provenance: hypertension + cholesterol_ldl carry `rule:` blocks in their YAML;
 * obesity_bmi + diabetes_hba1c are hand-written CQL of the SAME windowed-recency shape — their bands
 * are read off the CQL (obesity_bmi.cql: <=335 / 336–365 / >365 ⇒ 365/30; diabetes_hba1c.cql:
 * <=160 / 161–180 / >180 ⇒ 180/20).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loincCodesForMeasure } from "../../ingress/webchart/terminology.ts";
import { toSqlFile, type GenerateSqlInput } from "./generate-sql.ts";

const OUT_DIR = fileURLToPath(new URL("../../../../../wcdb-fhir-shim/sql", import.meta.url));

export const WCDB_SQL_MEASURES: GenerateSqlInput[] = [
  { measureId: "hypertension", rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30 }, loincCodes: loincCodesForMeasure("hypertension") },
  { measureId: "cholesterol_ldl", rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30 }, loincCodes: loincCodesForMeasure("cholesterol_ldl") },
  { measureId: "obesity_bmi", rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30 }, loincCodes: loincCodesForMeasure("obesity_bmi") },
  { measureId: "diabetes_hba1c", rule: { type: "windowed-recency", windowDays: 180, dueSoonDays: 20 }, loincCodes: loincCodesForMeasure("diabetes_hba1c") },
];

/** measureId → rendered `.sql` artifact content. */
export function renderAll(): Map<string, string> {
  return new Map(WCDB_SQL_MEASURES.map((m) => [m.measureId, toSqlFile(m.measureId, m)]));
}

export function main(): number {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [measureId, content] of renderAll()) {
    const file = path.join(OUT_DIR, `${measureId}.sql`);
    writeFileSync(file, content);
    console.log(`  wrote ${path.relative(process.cwd(), file)}`);
  }
  console.log(`generated SQL for ${WCDB_SQL_MEASURES.length} measure(s) → wcdb-fhir-shim/sql/`);
  return 0;
}
