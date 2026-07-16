/**
 * `pnpm evaluate:webchart-devdb` — the demoable WebChart dev-DB evaluation proof (#246, PR-3).
 *
 * Loads the committed WebChart dev-DB sample (`spike/webchart/*.json`, produced by
 * `scripts/webchart-devdb-export.ts`) and runs it through the UNCHANGED ingress + engine, printing a
 * per-measure outcome summary — the showable artifact of "we ran MIE's own WebChart data through our CQL
 * engine". No live API, no MariaDB driver, no DB: it reads the committed fixtures only.
 *
 * Descriptive only (ADR-008): reconciliation + the OH roster supply coded FHIR; the CQL engine decides
 * every outcome. `--date YYYY-MM-DD` overrides the (data-contemporaneous) default eval date.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { OutcomeStatus } from "../../evaluate-measure.ts";
import { webChartDataSource } from "../data-source.ts";
import { fixtureWebChartClient } from "./webchart-client.ts";
import { parseEnrollmentRoster, evaluateSourceWithRoster } from "../enrollment/roster.ts";
import { BUCKETS, isValidDate, measureTableLines, type MeasureSummary } from "./report-table.ts";

export type { MeasureSummary } from "./report-table.ts";

/** Measures the dev-DB sample can exercise (real LOINC/HCPCS present + reconciled). */
export const DEVDB_WHITELIST = ["diabetes_hba1c", "obesity_bmi", "cholesterol_ldl", "hypertension", "cms125"];
/** Named-excluded (no reconcilable data / value-based gate the seed lacks) — shown, never silently dropped. */
export const DEVDB_EXCLUDED = [
  "audiogram", "tb_surveillance", "hazwoper", "flu_vaccine",
  "adult_immunization", "mmr", "varicella", "hepatitis_b_vaccination_series", "cms122",
];
const DEFAULT_EVAL = "2024-06-01"; // the sample spans 2015–2024; a contemporaneous date yields a real mix
export interface DevDbReport {
  evaluationDate: string;
  population: number;
  whitelist: MeasureSummary[];
  excluded: string[];
}

const DIR = fileURLToPath(new URL("../../../../spike/webchart/", import.meta.url));

function loadFixtures() {
  const payloads = JSON.parse(readFileSync(path.join(DIR, "devdb-patients.json"), "utf8")) as unknown[];
  const roster = parseEnrollmentRoster(JSON.parse(readFileSync(path.join(DIR, "enrollment-roster.json"), "utf8")));
  return { payloads, roster };
}

/** Evaluate the committed dev-DB sample across the whitelisted measures; return per-measure bucket counts. */
export async function evaluateDevDb(opts?: { evaluationDate?: string }): Promise<DevDbReport> {
  const { payloads, roster } = loadFixtures();
  const evaluationDate = opts?.evaluationDate ?? DEFAULT_EVAL;
  const whitelist: MeasureSummary[] = [];
  for (const measureId of DEVDB_WHITELIST) {
    const src = webChartDataSource({ baseUrl: "x", apiKey: "k" }, fixtureWebChartClient(payloads));
    const res = await evaluateSourceWithRoster(src, measureId, roster, { evaluationDate });
    const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<OutcomeStatus, number>;
    for (const r of res.results) if (r.ok && r.outcome) counts[r.outcome.outcome]++;
    whitelist.push({ measureId, total: res.results.filter((r) => r.ok).length, counts });
  }
  return { evaluationDate, population: payloads.length, whitelist, excluded: DEVDB_EXCLUDED };
}

/** Render the report as a readable fixed-width table. */
export function renderReport(r: DevDbReport): string {
  const lines: string[] = [];
  lines.push(`WebChart dev-DB evaluation proof — ${r.population} patients, as-of ${r.evaluationDate}`);
  lines.push("(real MIE WebChart-shaped data → the unchanged CQL engine; descriptive only, ADR-008)");
  lines.push("");
  lines.push(...measureTableLines(r.whitelist));
  const nonMissing = r.whitelist.reduce((n, m) => n + m.total - m.counts.MISSING_DATA, 0);
  lines.push("");
  lines.push(`  → ${nonMissing} real (non-MISSING_DATA) outcomes across the whitelist — the pipeline works end-to-end.`);
  lines.push(`  excluded (no reconcilable data in this sample; all MISSING_DATA): ${r.excluded.join(", ")}`);
  return lines.join("\n");
}

const USAGE = "usage: evaluate:webchart-devdb [--date YYYY-MM-DD]\n";

export async function main(argv: string[]): Promise<number> {
  let evaluationDate: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--date") {
      const v = argv[++i];
      if (!v || !isValidDate(v)) {
        process.stderr.write(USAGE);
        return 2;
      }
      evaluationDate = v;
    } else {
      process.stderr.write(`unrecognized argument: ${arg}\n${USAGE}`);
      return 2;
    }
  }
  const report = await evaluateDevDb({ evaluationDate });
  process.stdout.write(renderReport(report) + "\n");
  return 0;
}
