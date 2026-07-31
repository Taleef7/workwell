/**
 * DB-less CLI orchestration for the official MADiE diagnostic harness.
 * fqm-execution is reached only through @workwell/official-executor; neither this shell nor any src/ file imports it.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  OFFICIAL_GATED_MEASURES,
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
  type ReductionArtifactIdentity,
} from "../../standards/official-cases.ts";
import { loadOfficialArtifact } from "../../wiring/official-artifacts.ts";
import { officialTerminologyExpander } from "../../wiring/official-terminology.ts";
import { expandArtifactTerminology } from "../../wiring/official-executor-adapter.ts";

/**
 * Build the reduction check's terminology THE WAY THE RUNTIME DOES — same sidecar, same expander, same
 * `expandArtifactTerminology`, same refusal.
 *
 * This is what makes a green gate evidence about production. Before PR-8a the check executed our
 * reduced artifact against the UPSTREAM bundle's ValueSets, so 121/121 proved the reduction was neutral
 * and proved nothing about the terminology the runtime would load — the runtime expanded from our VSAC
 * import, a configuration no gate had ever run. Calling the production code path here, rather than
 * re-deriving an equivalent cache, is the point: an equivalent one can drift.
 *
 * Yields a `reason` instead of a cache when the sidecar is absent (a fresh clone), leaving the check on
 * its pre-PR-8a upstream-ValueSet fallback. The report records which mode ran and why, so a weaker
 * check is never mistaken for the stronger one.
 */

/** Either the runtime's terminology, or why it could not be built — never a bare undefined. */
export interface RuntimeTerminology {
  cache?: unknown[];
  reason?: string;
}

async function runtimeTerminologyCache(measure: OfficialMeasureId): Promise<RuntimeTerminology> {
  const artifact = loadOfficialArtifact(measure);
  if (!artifact) return { reason: `${measure}: no vendored official artifact` };
  try {
    return {
      cache: await expandArtifactTerminology(artifact, officialTerminologyExpander(loadOfficialArtifact)),
    };
  } catch (err) {
    // Not fatal here — the check still runs against upstream terminology and says so, and
    // `officialRoutingProblems` is what refuses to ROUTE the measure. But the REASON must survive:
    // three very different causes reach this line (sidecar absent, sidecar present but hash-mismatched,
    // sidecar verified but missing a canonical the ELM needs), and collapsing them into "not present"
    // made the report assert a file was absent while it sat on disk — obscuring the third case, which
    // is the exact failure this whole PR exists to make loud.
    return { reason: err instanceof Error ? err.message : String(err) };
  }
}

export const USAGE =
  `Usage: pnpm test:official-cases [--measure ${OFFICIAL_GATED_MEASURES.join("|")}] [--content-dir <path>]`;

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
      // Driven by the gate list, not a hardcoded pair: a vendored measure absent from the gate is
      // already refused by `official-gate.test.ts`, so this stays correct as measures are onboarded.
      if (!value || !(OFFICIAL_GATED_MEASURES as readonly string[]).includes(value)) {
        throw new OfficialCasesCliUsageError(
          `--measure must be one of ${OFFICIAL_GATED_MEASURES.join("|")}\n${USAGE}`,
        );
      }
      measure = value as OfficialMeasureId;
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
  return { measures: measure ? [measure] : [...OFFICIAL_GATED_MEASURES], ...(contentDir ? { contentDir } : {}) };
}

/**
 * The number of official test cases each measure MUST run. Without a floor the gate is vacuous in the
 * partial case: if an upstream reorg stops the sparse-checkout patterns matching some case directories,
 * the harness happily reports 12/12 green and exits 0. A shrinking deck is a broken gate, not a pass.
 */
export const REQUIRED_OFFICIAL_CASE_COUNTS: Record<string, number> = {
  cms122: 55,
  cms125: 66,
  cms2: 36,
  cms68: 19,
  cms951: 55,
};

export function exitCodeForRuns(
  runs: Array<Pick<OfficialMeasureRun, "summary"> & Partial<Pick<OfficialMeasureRun, "draftDrift">>>,
): 0 | 1 {
  const officialFailed = runs.some(
    (run) => run.summary.unexpectedMismatches > 0 || run.summary.errors > 0,
  );
  // A deck that shrank silently is a broken gate — fail rather than report a smaller green number.
  const deckShrank = runs.some((run) => {
    const required = REQUIRED_OFFICIAL_CASE_COUNTS[(run as { measure?: string }).measure ?? ""];
    return required !== undefined && run.summary.total < required;
  });
  // The reduction drift check MUST be able to fail this command. It is the only thing that proves
  // vendoring (dropping CQL, ELM XML, narratives, ValueSets) changes no population result, and PR-6
  // builds a CI gate on top of this exit code — a check that reports drift while exiting 0 would let
  // a broken vendored artifact through the gate that exists to catch it.
  const reductionDrifted = runs.some(
    (run) => (run.draftDrift?.changedCases ?? 0) > 0 || (run.draftDrift?.errors ?? 0) > 0,
  );
  return officialFailed || reductionDrifted || deckShrank ? 1 : 0;
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

/**
 * Identify the artifact bytes the reduction check is about to execute.
 *
 * The SHA-256 is computed HERE, over the file on disk, rather than read from `manifest.json` — the
 * manifest's hash is written by `vendor:official` about itself, so quoting it back would make the
 * evidence report circular.
 *
 * The `strippedElmAnnotations` label is descriptive and can only come from the manifest, so it is
 * reported **only when the manifest's own `sha256` matches the bytes we just hashed**. That uses the
 * manifest as corroboration rather than as authority: if the hashes disagree, the manifest describes
 * some other artifact and its label means nothing about this one. Absent/malformed/mismatched all
 * collapse to `undefined` — rendered as "unverified", never as the affirmative "retained", which would
 * be a false claim about a stripped artifact.
 */
export function readArtifactIdentity(bundlePath: string): ReductionArtifactIdentity | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(bundlePath);
  } catch {
    return undefined;
  }
  const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  let strippedElmAnnotations: boolean | undefined;
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(bundlePath), "manifest.json"), "utf8")) as {
      sha256?: unknown;
      reduction?: { strippedElmAnnotations?: unknown };
    };
    if (manifest.sha256 === sha256) {
      strippedElmAnnotations = manifest.reduction?.strippedElmAnnotations === true;
    }
  } catch {
    // absent or malformed: the label stays unverified; the hash and size still identify the artifact
  }
  return {
    sha256,
    ...(strippedElmAnnotations === undefined ? {} : { strippedElmAnnotations }),
    vendoredBytes: bytes.byteLength,
  };
}

export interface OfficialCasesCliDeps {
  cwd: string;
  load: (contentDir: string, measure: OfficialMeasureId) => LoadedOfficialMeasure;
  run: (loaded: LoadedOfficialMeasure) => Promise<OfficialMeasureRun>;
  render: (runs: OfficialMeasureRun[], metadata: OfficialReportMetadata) => string;
  sourceRevision: (contentDir: string) => string;
  loadDraftBundle: (path: string) => FhirBundle;
  artifactIdentity: (bundlePath: string) => ReductionArtifactIdentity | undefined;
  runDraftDrift: (
    loaded: LoadedOfficialMeasure,
    officialRun: OfficialMeasureRun,
    draftBundle: FhirBundle,
    artifact?: ReductionArtifactIdentity,
    terminology?: RuntimeTerminology,
  ) => Promise<Cms122DraftDrift>;
  /** The runtime's own terminology for a measure, or the reason it is unavailable. */
  runtimeTerminology: (measure: OfficialMeasureId) => Promise<RuntimeTerminology>;
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
    artifactIdentity: readArtifactIdentity,
    runDraftDrift: (loaded, officialRun, draftBundle, artifact, terminology) =>
      runCms122DraftDrift(loaded, officialRun, draftBundle, {
        ...(artifact ? { artifact } : {}),
        ...(terminology?.cache ? { valueSetCache: terminology.cache } : {}),
        ...(terminology?.reason ? { valueSetModeReason: terminology.reason } : {}),
      }),
    runtimeTerminology: runtimeTerminologyCache,
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
      // Every vendored measure gets the reduction check, not just cms122: it is the ONLY thing that
      // executes our reduced artifact against the upstream bundle, so a measure without it has its
      // vendoring guarded by nothing but a self-consistent SHA-256 that vendor:official wrote itself.
      const artifactPath = resolve(deps.cwd, "measures", "official", measure, "bundle.json");
      const terminology = await deps.runtimeTerminology(measure);
      // Surfaced here as well as in the report: a downgrade means this run is NOT checking the
      // runtime's terminology, and a developer reading the console should not have to diff a markdown
      // file to discover that.
      if (!terminology.cache) {
        deps.error(
          `official-cases: ${measure.toUpperCase()} reduction check DOWNGRADED to upstream value sets` +
            ` — ${terminology.reason ?? "runtime terminology unavailable"}`,
        );
      }
      run.draftDrift = await deps.runDraftDrift(
        loaded,
        run,
        deps.loadDraftBundle(artifactPath),
        deps.artifactIdentity(artifactPath),
        terminology,
      );
      runs.push(run);
    }
    const markdown = deps.render(runs, {
      generatedDate: deps.generatedDate,
      sourceRevision: deps.sourceRevision(contentDir),
    });
    // The committed report is evidence for the WHOLE gate, so it is written only for a full run — a
    // `--measure` subset would otherwise overwrite it with a partial deck and CI's staleness check would
    // then compare the full run against a one-measure file. Keyed on the gate list rather than a literal
    // count, which silently stopped meaning "full run" the moment a third measure was onboarded.
    const writesCommittedReport = parsed.measures.length === OFFICIAL_GATED_MEASURES.length;
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
