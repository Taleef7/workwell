/**
 * `pnpm data-coverage` — per measure, which FHIR data its logic reads and whether WebChart ingest supplies
 * it (#776). Reads committed files only: no database, no network, no credential.
 *
 *   pnpm data-coverage                       every measure the Maui sandbox routes
 *   pnpm data-coverage --measure cms165      one measure (repeatable)
 *   pnpm data-coverage --json                the same tables as JSON
 *
 * Exit 0 with the report, 2 on a usage error.
 */
import { resolveDeploymentProfile } from "../../config/deployment-profile.ts";
import { dataCoverage, type CoverageRow, type MeasureCoverage } from "../../wiring/data-coverage.ts";

export interface DataCoverageArgs {
  readonly measures: readonly string[];
  readonly json: boolean;
}

const USAGE = "usage: pnpm data-coverage [--measure <catalog id>]... [--json]";

export function parseArgs(argv: readonly string[]): DataCoverageArgs | { error: string } {
  const measures: string[] = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") json = true;
    else if (arg === "--measure") {
      const id = argv[++i];
      if (!id || id.startsWith("--")) return { error: "--measure needs a catalog id, e.g. cms165" };
      measures.push(id);
    } else return { error: `unknown argument ${arg}` };
  }
  return { measures, json };
}

const shortProfile = (profile: string): string => profile.split("/").pop()!;

function useOf(row: CoverageRow): string {
  if (row.forScore) return row.forSde ? "score, SDE" : "score";
  return "SDE only";
}

function statusOf(row: CoverageRow): string {
  if (row.status === "served") return `served (${row.how === "population" ? "the patient list" : "fetched"})`;
  if (row.status === "partial") {
    return (
      `PARTLY: ${row.stampedProfiles.map(shortProfile).join(", ")} stamped; ` +
      `not ${row.unstampedProfiles.map(shortProfile).join(", ")}. ${row.reason}`
    );
  }
  const profiles = row.unstampedProfiles.length > 0 ? ` (${row.unstampedProfiles.map(shortProfile).join(", ")})` : "";
  return `NOT SERVED${profiles}: ${row.reason ?? "no reason recorded"}`;
}

/** The plain-text report. */
export function renderText(tables: readonly MeasureCoverage[]): string {
  const lines = [
    "Data coverage (#776): what each measure's logic reads, and whether WebChart ingest supplies it.",
    "This is the WebChart live-tenant path. The Maui sandbox scores a synthetic corpus that carries most of",
    "the types marked NOT SERVED, so its rates are not what WebChart data would give.",
  ];
  for (const table of tables) {
    const scored = table.rows.filter((row) => row.forScore);
    const served = scored.filter((row) => row.status === "served").length;
    lines.push(
      "",
      `${table.measureId} · ${table.logic} (${table.kind === "cms-artifact" ? "CMS's artifact" : "a WorkWell translation"})`,
      `  ${served} of the ${scored.length} types it scores with are served.`,
    );
    if (table.profileSensitive) {
      lines.push(
        "  Retrieves by profile: every profile-typed retrieve is filtered on meta.profile, and with no Patient",
        "  carrying its profile the evaluation fails outright instead of scoring.",
      );
    }
    const width = Math.max(...table.rows.map((row) => row.type.length));
    for (const row of table.rows) {
      lines.push(`  ${row.type.padEnd(width)}  ${useOf(row).padEnd(10)}  ${statusOf(row)}`);
      if (row.status === "served" && row.derived) lines.push(`  ${" ".repeat(width)}  ${" ".repeat(10)}  also derived: ${row.derived}`);
    }
  }
  return lines.join("\n");
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    console.error(`${args.error}\n${USAGE}`);
    return 2;
  }
  const measures = args.measures.length > 0 ? args.measures : resolveDeploymentProfile("maui").runnableMeasureIds;
  let tables: MeasureCoverage[];
  try {
    tables = dataCoverage(measures);
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  console.log(args.json ? JSON.stringify(tables, null, 2) : renderText(tables));
  return 0;
}
