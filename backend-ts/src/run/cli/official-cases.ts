/**
 * DB-less CLI orchestration for the official MADiE diagnostic harness.
 * The fqm-execution import remains in standards/official-cases.ts; this run/cli shell never imports it.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  loadOfficialMeasureCases,
  loadFhirBundleFile,
  renderOfficialCaseReport,
  runCms122DraftDrift,
  runOfficialMeasureCases,
  type Cms122DraftDrift,
  type FhirBundle,
  type LoadedOfficialMeasure,
  type OfficialMeasureId,
  type OfficialMeasureRun,
  type OfficialReportMetadata,
} from "../../standards/official-cases.ts";

export const USAGE =
  "Usage: pnpm test:official-cases [--measure cms122|cms125] [--content-dir <path>]";

export class OfficialCasesCliUsageError extends Error {
  override readonly name = "OfficialCasesCliUsageError";
}

export interface OfficialCasesArgs {
  measures: OfficialMeasureId[];
  contentDir?: string;
}

export function parseArgs(argv: string[]): OfficialCasesArgs {
  let measure: OfficialMeasureId | undefined;
  let contentDir: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--measure") {
      const value = argv[++index];
      if (value !== "cms122" && value !== "cms125") {
        throw new OfficialCasesCliUsageError(`--measure must be cms122|cms125\n${USAGE}`);
      }
      measure = value;
    } else if (arg === "--content-dir") {
      const value = argv[++index];
      if (!value) throw new OfficialCasesCliUsageError(`--content-dir needs a value\n${USAGE}`);
      contentDir = value;
    } else if (arg === "--help" || arg === "-h") {
      throw new OfficialCasesCliUsageError(USAGE);
    } else {
      throw new OfficialCasesCliUsageError(`unknown argument '${arg}'\n${USAGE}`);
    }
  }
  return { measures: measure ? [measure] : ["cms122", "cms125"], ...(contentDir ? { contentDir } : {}) };
}

export function exitCodeForRuns(runs: Array<Pick<OfficialMeasureRun, "summary">>): 0 | 1 {
  return runs.some((run) => run.summary.unexpectedMismatches > 0 || run.summary.errors > 0) ? 1 : 0;
}

function gitDirectory(contentDir: string): string {
  const dotGit = join(contentDir, ".git");
  if (statSync(dotGit).isDirectory()) return dotGit;
  const pointer = readFileSync(dotGit, "utf8").trim();
  if (!pointer.startsWith("gitdir:")) throw new Error(`${dotGit} is not a Git directory pointer`);
  const target = pointer.slice("gitdir:".length).trim();
  return isAbsolute(target) ? target : resolve(dirname(dotGit), target);
}

/** Read the sparse content checkout revision without spawning Git. */
export function readContentRevision(contentDir: string): string {
  const gitDir = gitDirectory(contentDir);
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  if (!head.startsWith("ref:")) return head;
  const ref = head.slice("ref:".length).trim();
  try {
    return readFileSync(join(gitDir, ...ref.split("/")), "utf8").trim();
  } catch {
    const packed = readFileSync(join(gitDir, "packed-refs"), "utf8")
      .split(/\r?\n/)
      .find((line) => line.endsWith(` ${ref}`));
    if (!packed) throw new Error(`cannot resolve content Git ref ${ref}`);
    return packed.split(" ")[0]!;
  }
}

export interface OfficialCasesCliDeps {
  cwd: string;
  load: (contentDir: string, measure: OfficialMeasureId) => LoadedOfficialMeasure;
  run: (loaded: LoadedOfficialMeasure) => Promise<OfficialMeasureRun>;
  render: (runs: OfficialMeasureRun[], metadata: OfficialReportMetadata) => string;
  sourceRevision: (contentDir: string) => string;
  loadDraftBundle: (path: string) => FhirBundle;
  runDraftDrift: (
    loaded: LoadedOfficialMeasure,
    officialRun: OfficialMeasureRun,
    draftBundle: FhirBundle,
  ) => Promise<Cms122DraftDrift>;
  generatedDate: string;
  writeReport: (path: string, markdown: string) => void;
  log: (message: string) => void;
  error: (message: string) => void;
}

function defaultDeps(): OfficialCasesCliDeps {
  return {
    cwd: process.cwd(),
    load: loadOfficialMeasureCases,
    run: runOfficialMeasureCases,
    render: renderOfficialCaseReport,
    sourceRevision: readContentRevision,
    loadDraftBundle: loadFhirBundleFile,
    runDraftDrift: runCms122DraftDrift,
    generatedDate: new Date().toISOString().slice(0, 10),
    writeReport: (path, markdown) => writeFileSync(path, markdown, "utf8"),
    log: console.log,
    error: console.error,
  };
}

export async function main(argv: string[], overrides: Partial<OfficialCasesCliDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  let parsed: OfficialCasesArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof OfficialCasesCliUsageError) {
      deps.error(error.message);
      return 2;
    }
    throw error;
  }

  const contentDir = resolve(deps.cwd, parsed.contentDir ?? ".official-content");
  const reportPath = resolve(deps.cwd, "..", "docs", "OFFICIAL_TESTCASE_REPORT_2026-07.md");
  try {
    const runs: OfficialMeasureRun[] = [];
    for (const measure of parsed.measures) {
      deps.log(`official-cases: loading ${measure.toUpperCase()} from ${contentDir}`);
      const loaded = deps.load(contentDir, measure);
      const run = await deps.run(loaded);
      if (measure === "cms122") {
        const draftPath = resolve(
          deps.cwd,
          "measures",
          "official",
          "cms122v14",
          "CMS122FHIR-v0.5.000-FHIR.json",
        );
        run.draftDrift = await deps.runDraftDrift(loaded, run, deps.loadDraftBundle(draftPath));
      }
      runs.push(run);
    }
    const markdown = deps.render(runs, {
      generatedDate: deps.generatedDate,
      sourceRevision: deps.sourceRevision(contentDir),
    });
    const writesCommittedReport = parsed.measures.length === 2;
    if (writesCommittedReport) deps.writeReport(reportPath, markdown);
    for (const run of runs) {
      const adjusted = run.summary.expectedAgreements + run.summary.referenceAgreements;
      deps.log(
        `${run.measure.toUpperCase()}: raw ${run.summary.expectedAgreements}/${run.summary.total}; ` +
          `reference-adjusted ${adjusted}/${run.summary.total}; unexpected=${run.summary.unexpectedMismatches}; ` +
          `errors=${run.summary.errors}`,
      );
    }
    deps.log(
      writesCommittedReport
        ? `official-cases: wrote ${reportPath}`
        : "official-cases: single-measure run; committed combined report not written",
    );
    return exitCodeForRuns(runs);
  } catch (error) {
    deps.error(`official-cases: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}
