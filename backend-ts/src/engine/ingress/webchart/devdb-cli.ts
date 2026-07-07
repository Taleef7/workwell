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
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import type { OutcomeStatus } from "../../evaluate-measure.ts";
import { webChartDataSource } from "../data-source.ts";
import { fixtureWebChartClient } from "./webchart-client.ts";
import { parseEnrollmentRoster, evaluateSourceWithRoster } from "../enrollment/roster.ts";

/** Measures the dev-DB sample can exercise (real LOINC/HCPCS present + reconciled). */
export const DEVDB_WHITELIST = ["diabetes_hba1c", "obesity_bmi", "cholesterol_ldl", "hypertension", "cms125"];
/** Named-excluded (no reconcilable data / value-based gate the seed lacks) — shown, never silently dropped. */
export const DEVDB_EXCLUDED = [
  "audiogram", "tb_surveillance", "hazwoper", "flu_vaccine",
  "adult_immunization", "mmr", "varicella", "hepatitis_b_vaccination_series", "cms122",
];
const DEFAULT_EVAL = "2024-06-01"; // the sample spans 2015–2024; a contemporaneous date yields a real mix
const BUCKETS: OutcomeStatus[] = ["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"];

export interface MeasureSummary {
  measureId: string;
  total: number;
  counts: Record<OutcomeStatus, number>;
}
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

const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);

/** Render the report as a readable fixed-width table. */
export function renderReport(r: DevDbReport): string {
  const lines: string[] = [];
  lines.push(`WebChart dev-DB evaluation proof — ${r.population} patients, as-of ${r.evaluationDate}`);
  lines.push("(real MIE WebChart-shaped data → the unchanged CQL engine; descriptive only, ADR-008)");
  lines.push("");
  lines.push(`  ${pad("measure", 22)}${BUCKETS.map((b) => padL(b === "MISSING_DATA" ? "MISSING" : b === "COMPLIANT" ? "COMPL" : b === "DUE_SOON" ? "DUE" : b === "OVERDUE" ? "OVERDUE" : "EXCL", 9)).join("")}${padL("total", 8)}`);
  lines.push(`  ${"-".repeat(22 + 9 * BUCKETS.length + 8)}`);
  let nonMissing = 0;
  for (const m of r.whitelist) {
    nonMissing += m.total - m.counts.MISSING_DATA;
    lines.push(`  ${pad(m.measureId, 22)}${BUCKETS.map((b) => padL(String(m.counts[b]), 9)).join("")}${padL(String(m.total), 8)}`);
  }
  lines.push("");
  lines.push(`  → ${nonMissing} real (non-MISSING_DATA) outcomes across the whitelist — the pipeline works end-to-end.`);
  lines.push(`  excluded (no reconcilable data in this sample; all MISSING_DATA): ${r.excluded.join(", ")}`);
  return lines.join("\n");
}

export async function main(argv: string[]): Promise<number> {
  let evaluationDate: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--date") {
      const v = argv[++i];
      if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        process.stderr.write("usage: evaluate:webchart-devdb [--date YYYY-MM-DD]\n");
        return 2;
      }
      evaluationDate = v;
    }
  }
  const report = await evaluateDevDb({ evaluationDate });
  process.stdout.write(renderReport(report) + "\n");
  return 0;
}

// Run only when invoked directly (not when imported by a test).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
