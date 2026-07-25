/**
 * Evaluate a measure by running the OFFICIAL published artifact (roadmap §7.2/§7.3, PR-7a).
 *
 * This is Nicole's first correction made executable: for a measure CMS publishes, run the steward's own
 * CQL rather than an authored approximation of it. The adapter implements the same
 * `EvaluateMeasureBinding` the authored engine implements, so PR-7b's router can dispatch per measure
 * with no signature change anywhere downstream.
 *
 * **Nothing routes here yet.** This ships dark: the router lands in PR-7b, the shadow comparison in
 * PR-8, and the flip in PR-9.
 *
 * ## Three safety properties, in order of how badly they fail
 *
 * 1. **Terminology completeness is checked BEFORE evaluating, and refuses.** `buildValueSetCache` emits a
 *    canonical it cannot expand as *empty but present*, because fqm aborts a whole batch on a missing
 *    value set. Empty is the conservative direction for a diagnostic, and a catastrophe for production:
 *    a retrieve against an empty set matches nothing, so a measure whose OIDs were never imported
 *    reports every subject as out-of-population — indistinguishable, downstream, from a genuinely
 *    ineligible roster. This adapter therefore expands first, and throws if ANY referenced value set is
 *    empty. Today that matters concretely: `pnpm resolve-valuesets` has only ever imported CMS122's 21
 *    OIDs, so CMS125 would silently report an empty population.
 * 2. **A measure with no recorded semantics cannot run.** See `official-measure-semantics.ts` — there is
 *    no safe default for "does the numerator mean compliant".
 * 3. **The measurement period matches the authored path** (`evaluationDate - periodMonths` …
 *    `evaluationDate`), not the artifact's `effectivePeriod`. That keeps the PR-8 shadow diff isolating
 *    the LOGIC difference rather than confounding it with a period change. Whether production should
 *    instead use the calendar measurement period an eCQM is defined on is a real question, deliberately
 *    left to PR-9 where the flip's semantics are decided in the open.
 */
import {
  buildValueSetCache,
  calculateOfficialDetailed,
  normalizePeriodEnd,
  referencedValueSetUrls,
  oidFromValueSetUrl,
  type ExpandedCode,
  type FqmCalculate,
  type FqmStatementResult,
  type PopulationMembership,
} from "@workwell/official-executor";
import type {
  EvaluateMeasureBinding,
  EvaluateMeasureInput,
  ExpressionResult,
  MeasureOutcome,
  OutcomeStatus,
} from "../engine/evaluate-measure.ts";
import { loadOfficialArtifact, type OfficialArtifact } from "./official-artifacts.ts";
import { officialMeasureSemantics } from "./official-measure-semantics.ts";

/** Expand one VSAC OID to its codes — the app supplies this from the imported `value_sets` rows. */
export type ExpandValueSet = (oid: string) => Promise<ExpandedCode[]>;

export interface OfficialExecutorDeps {
  expand: ExpandValueSet;
  /** Injectable for tests; defaults to the real (lazily imported) fqm calculator. */
  calculate?: FqmCalculate;
  /** Injectable for tests; defaults to the vendored-artifact loader. */
  loadArtifact?: (catalogId: string) => OfficialArtifact | null;
}

/**
 * Map official population membership onto WorkWell's five-bucket workflow vocabulary.
 *
 * The enum deliberately does NOT grow (roadmap §7.3): regulatory truth is persisted losslessly in
 * `evidence_json.official.populationResults`, and this is only the operator-facing bucket.
 *
 * - **not in IPP** → `MISSING_DATA` with `inInitialPopulation: false`. The pair is what distinguishes
 *   "out of scope for this measure" from "eligible but we have no data", which is the L17 signal.
 * - **DENEX** → `EXCLUDED`.
 * - **DENEXCEP** → `EXCLUDED` too. An excepted patient needs no outreach, which is the only question
 *   this vocabulary answers; the distinction that matters for reporting survives in populationResults.
 *   This is what unblocks CMS68-class measures with zero enum change.
 * - **numerator** → `COMPLIANT` or `OVERDUE` depending on the measure's semantics.
 *
 * `DUE_SOON` is never emitted: official CQL has no forecast define, and inventing one would be authoring
 * logic on top of the steward's. Accepted and documented — the forecaster remains a descriptive overlay.
 */
export function outcomeFromPopulations(
  populations: PopulationMembership,
  numeratorMeansCompliant: boolean,
): { outcome: OutcomeStatus; inInitialPopulation: boolean } {
  const inIpp = populations["initial-population"] === true;
  if (!inIpp) return { outcome: "MISSING_DATA", inInitialPopulation: false };
  if (populations["denominator-exclusion"] === true || populations["denominator-exception"] === true) {
    return { outcome: "EXCLUDED", inInitialPopulation: true };
  }
  const inNumerator = populations["numerator"] === true;
  const compliant = inNumerator === numeratorMeansCompliant;
  return { outcome: compliant ? "COMPLIANT" : "OVERDUE", inInitialPopulation: true };
}

/**
 * The statements worth persisting: the measure's OWN library, not its 8-9 includes.
 *
 * A full CMS122 evaluation returns 419 statement results; keeping all of them would put ~25 KB of
 * evidence on every outcome row, against ~1-3 KB for an authored measure, on a database whose compute
 * budget has already caused one outage. The root library is where the population logic and the
 * measure-specific defines live — the includes are FHIRHelpers, status/date helpers, and shared
 * hospice/palliative libraries whose per-statement values explain nothing an operator would read.
 */
export function evidenceStatements(
  statements: readonly FqmStatementResult[],
  rootLibraryName: string,
): ExpressionResult[] {
  return statements
    .filter((s) => s.libraryName === rootLibraryName && typeof s.statementName === "string")
    .map((s) => ({ define: s.statementName as string, result: s.final ?? null }));
}

/** `YYYY-MM-DD` minus n months, clamping to the end of a shorter month (2026-03-31 - 1 → 2026-02-28). */
function subtractMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * Expand every value set the artifact's ELM retrieves, refusing if any comes back empty.
 *
 * Exported so PR-7b can preflight at ROUTER CONSTRUCTION — an operator who flips a measure whose
 * terminology was never imported should learn about it at boot, not from a population run that quietly
 * reports nobody as eligible.
 */
export async function expandArtifactTerminology(
  artifact: OfficialArtifact,
  expand: ExpandValueSet,
): Promise<unknown[]> {
  const referenced = referencedValueSetUrls(artifact.bundle);
  const empty: string[] = [];
  const cache = await buildValueSetCache(artifact.bundle, async (oid) => {
    const codes = await expand(oid);
    if (codes.length === 0) empty.push(oid);
    return codes;
  });
  if (empty.length > 0) {
    throw new Error(
      `${artifact.manifest.catalogId}: ${empty.length} of ${referenced.length} value sets expanded to ` +
        `zero codes (${empty.slice(0, 5).join(", ")}${empty.length > 5 ? ", …" : ""}). Official ` +
        `execution would report every subject out-of-population. Import them with ` +
        `'pnpm resolve-valuesets' before routing ${artifact.manifest.catalogId} officially.`,
    );
  }
  return cache;
}

/** The bare OIDs an artifact needs expanded — for preflight reporting and the import CLI. */
export function requiredOids(artifact: OfficialArtifact): string[] {
  return referencedValueSetUrls(artifact.bundle).map(oidFromValueSetUrl);
}

/**
 * An `EvaluateMeasureBinding` that runs the official artifact for whichever measure it is asked about.
 *
 * Single-subject by design at this stage: it is the binding contract every caller already uses. That
 * costs an ELM parse per subject, which is why PR-7b adds measure-major iteration and batches subjects
 * through one `calculateOfficialDetailed` call — the package's batch entry point already exists for it.
 */
export function officialMeasureExecutor(deps: OfficialExecutorDeps): EvaluateMeasureBinding {
  return {
    async evaluate(input: EvaluateMeasureInput): Promise<MeasureOutcome> {
      const artifact = (deps.loadArtifact ?? loadOfficialArtifact)(input.measureId);
      if (!artifact) {
        throw new Error(`${input.measureId}: no executable official artifact is vendored`);
      }
      const semantics = officialMeasureSemantics(input.measureId);
      if (!semantics) {
        throw new Error(
          `${input.measureId}: no recorded official measure semantics — refusing to guess whether its ` +
            `numerator means compliant (see official-measure-semantics.ts)`,
        );
      }

      const evaluationDate = input.evaluationDate ?? new Date().toISOString().slice(0, 10);
      const periodMonths = 12;
      const period = {
        start: subtractMonths(evaluationDate, periodMonths),
        end: normalizePeriodEnd(evaluationDate),
      };

      const valueSetCache = await expandArtifactTerminology(artifact, deps.expand);
      const results = await calculateOfficialDetailed({
        bundle: artifact.bundle,
        patientBundles: [input.patientBundle],
        period,
        valueSetCache,
        ...(deps.calculate ? { calculate: deps.calculate } : {}),
        // Official artifacts are QICore-profiled, and their retrieves are written against those
        // profiles — retrieving by base resource type finds nothing (this is what `hasRetrieveSignal`
        // exists to detect in the diagnostic harness).
        options: { trustMetaProfile: true },
      });

      const [subjectId, result] = [...results][0] ?? [];
      if (!subjectId || !result) {
        throw new Error(`${input.measureId}: the official artifact returned no result for this subject`);
      }

      const { outcome, inInitialPopulation } = outcomeFromPopulations(
        result.populations,
        semantics.numeratorMeansCompliant,
      );
      return {
        subjectId,
        measure: artifact.manifest.measureName,
        outcome,
        inInitialPopulation,
        evidence: {
          expressionResults: evidenceStatements(result.statements, artifact.manifest.measureName),
          // The regulatory truth, verbatim and lossless. MeasureReport/QRDA read THIS (ADR-031/PR-3),
          // never the workflow bucket above — the bucket cannot express DENEXCEP and inverts for an
          // inverse measure.
          official: {
            ecqmId: artifact.manifest.cmsId,
            version: artifact.manifest.version,
            engine: "fqm-execution",
            artifactSha256: artifact.manifest.sha256,
            populationResults: result.populationResults,
          },
        },
      };
    },
  };
}
