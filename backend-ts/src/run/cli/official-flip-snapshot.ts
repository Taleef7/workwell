/**
 * `official-flip-snapshot` — the before/after distribution a measure's flip is judged on.
 *
 * ## Why this exists as a COMMAND rather than a paragraph
 *
 * ADR-043 moved enforcement of the whole-roster-out-of-IPP hazard off the runtime and onto "the flip
 * gate", which it defined as `devdb-official-eval.test.ts` plus a pre-flip checklist. Review of #354
 * made the fair objection that this is weaker than it sounds: the test pins a FROZEN 56-patient fixture
 * and cannot see a tenant, while the checklist steps that *can* — "confirm a non-zero initial population
 * against the tenant's own data" (step 2) and "take a before/after distribution snapshot" (step 4) —
 * shipped as prose with no command, no tooling and no artifact behind them. A control nobody can run is
 * the same vacuous-guard shape this branch has now been pulled up on three times (#350, #352, #354).
 *
 * This is those two steps, executable, over whichever population the stack is actually configured for.
 *
 * ## What it reports, and what it deliberately does not
 *
 * For each requested measure it evaluates every subject through BOTH engines over the SAME bundles and
 * prints:
 *   - the outcome distribution the roster reads today (authored) and after the flip (official);
 *   - the initial-population count official admits — the ADR-043 signal, and the one number the runtime
 *     WARN cannot interpret for you;
 *   - every subject whose roster row would change, with its before and after.
 *
 * It renders a verdict but does not gate anything, and that split is deliberate. The judgement this
 * supports — "is a zero initial population correct for this cohort, or is the data missing an element
 * the IPP reads?" — is exactly the one ADR-043 established a machine cannot make, because a legitimately
 * all-ineligible cohort is indistinguishable from a mapping gap by shape alone. What a human CAN do is
 * read `authoredActionable > 0 && officialInIpp === 0` and know the cohort is not the explanation. So the
 * tool computes that comparison and states it; it does not pretend the conclusion follows automatically.
 *
 * Descriptive only (ADR-008): it writes nothing, persists nothing, and authors no status.
 */
import { CqlExecutionEngine } from "../../engine/cql/cql-execution-engine.ts";
import { bundledEcqmValueSetResolver } from "../../engine/cql/bundled-ecqm-expansions.ts";
import { officialMeasureExecutor, type OfficialBatchSubject } from "../../wiring/official-executor-adapter.ts";
import { officialTerminologyExpander } from "../../wiring/official-terminology.ts";
import { loadOfficialArtifact } from "../../wiring/official-artifacts.ts";
import type { MeasureOutcome } from "../../engine/evaluate-measure.ts";

export interface SnapshotSubject {
  subjectId: string;
  bundle: unknown;
}

export interface MeasureSnapshot {
  measureId: string;
  subjects: number;
  /** Outcome distribution as the roster reads TODAY. */
  authored: Record<string, number>;
  /** Outcome distribution the roster would read after the flip. */
  official: Record<string, number>;
  /** How many subjects the official artifact admitted to its initial population (ADR-043's signal). */
  officialInIpp: number;
  /** Subjects the AUTHORED engine finds actionable — the counter-evidence to "nobody is eligible". */
  authoredActionable: number;
  /** Every subject whose roster row would change, `subjectId → "BEFORE → AFTER"`. */
  divergence: Record<string, string>;
  /** Set when the executor refused the batch outright (e.g. nothing retrieved for anybody). */
  error?: string;
}

/** Non-compliant statuses — the ones that put a subject on somebody's worklist. */
const ACTIONABLE = new Set(["OVERDUE", "DUE_SOON"]);

const tally = (values: Iterable<string>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
};

/**
 * The official side, evaluated EXACTLY as a run would evaluate it — batch, then per-subject fallback.
 *
 * The batch primitive deliberately OMITS a subject it returned nothing for, and `run-pipeline.ts`
 * re-evaluates each such subject individually before persisting. A snapshot that skipped that step would
 * not be a forecast of the run it claims to forecast: the omitted subjects would be missing from the
 * distribution and from the initial-population count, so a roster whose omitted subjects DO qualify could
 * report zero-in-IPP and earn a spurious DO-NOT-FLIP. Caught by Codex on #355 — the same
 * incomplete-roster mistake as #354's, which is a strong hint that "did you model the fallback?" belongs
 * on the checklist for anything reading `evaluateBatch`.
 */
export interface BatchAndSingle {
  evaluateBatch(
    measureId: string,
    subjects: readonly OfficialBatchSubject[],
    evaluationDate?: string,
  ): Promise<Map<string, MeasureOutcome>>;
  evaluate(input: { measureId: string; patientBundle: unknown; evaluationDate?: string }): Promise<MeasureOutcome>;
}

export async function evaluateLikeTheRunPipeline(
  executor: BatchAndSingle,
  measureId: string,
  subjects: readonly SnapshotSubject[],
  batch: readonly OfficialBatchSubject[],
  evaluationDate: string,
): Promise<Map<string, MeasureOutcome>> {
  const official = await executor.evaluateBatch(measureId, batch, evaluationDate);
  for (const { subjectId, bundle } of subjects) {
    if (official.has(subjectId)) continue;
    try {
      official.set(subjectId, await executor.evaluate({ measureId, patientBundle: bundle, evaluationDate }));
    } catch {
      // The run pipeline persists MISSING_DATA + an `evaluationError` here rather than failing the run.
      // Leaving the subject absent lets the caller report it as such instead of inventing an outcome.
    }
  }
  return official;
}

/**
 * Evaluate one measure both ways over the same bundles.
 *
 * The official side goes through `evaluateBatch` because that is what the run pipeline uses (PR-8f), so
 * the snapshot is a shadow of the real path rather than a study of its own — the ADR-039 lesson. A batch
 * refusal is CAPTURED rather than thrown: a snapshot that dies on the first bad measure tells an operator
 * less than one that reports which measure failed and still prints the rest.
 */
export async function snapshotMeasure(
  measureId: string,
  subjects: readonly SnapshotSubject[],
  evaluationDate: string,
): Promise<MeasureSnapshot> {
  const authoredEngine = new CqlExecutionEngine({ valueSetResolver: bundledEcqmValueSetResolver });
  const authored = new Map<string, string>();
  for (const { subjectId, bundle } of subjects) {
    const outcome = await authoredEngine.evaluate({ measureId, patientBundle: bundle, evaluationDate });
    authored.set(subjectId, outcome.outcome);
  }

  const base: Omit<MeasureSnapshot, "official" | "officialInIpp" | "divergence" | "error"> = {
    measureId,
    subjects: subjects.length,
    authored: tally(authored.values()),
    authoredActionable: [...authored.values()].filter((s) => ACTIONABLE.has(s)).length,
  };

  const executor = officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) });
  let official: Map<string, MeasureOutcome>;
  try {
    const batch: OfficialBatchSubject[] = subjects.map((s) => ({ subjectId: s.subjectId, patientBundle: s.bundle }));
    official = await evaluateLikeTheRunPipeline(executor, measureId, subjects, batch, evaluationDate);
  } catch (err) {
    return {
      ...base,
      official: {},
      officialInIpp: 0,
      divergence: {},
      error: String((err as Error)?.message ?? err),
    };
  }

  const divergence: Record<string, string> = {};
  for (const [subjectId, before] of authored) {
    const after = official.get(subjectId)?.outcome;
    // Only reachable if the per-subject fallback ALSO failed for this subject; the run pipeline would
    // persist MISSING_DATA with an `evaluationError` there, so naming it beats dropping it silently.
    if (after === undefined) divergence[subjectId] = `${before} → (evaluation failed)`;
    else if (after !== before) divergence[subjectId] = `${before} → ${after}`;
  }

  return {
    ...base,
    official: tally([...official.values()].map((o) => o.outcome)),
    officialInIpp: [...official.values()].filter((o) => o.inInitialPopulation).length,
    divergence,
  };
}

/** Human-readable report. Kept separate from the computation so the shape stays testable. */
export function renderSnapshot(snapshots: readonly MeasureSnapshot[]): string {
  const lines: string[] = ["# Official flip snapshot", ""];
  for (const s of snapshots) {
    lines.push(`## ${s.measureId} — ${s.subjects} subject(s)`, "");
    if (s.error) {
      lines.push(`**REFUSED:** ${s.error}`, "", "The measure cannot be routed over this data.", "");
      continue;
    }
    lines.push(
      `| | distribution |`,
      `|---|---|`,
      `| before (authored) | ${JSON.stringify(s.authored)} |`,
      `| after (official) | ${JSON.stringify(s.official)} |`,
      "",
      `- official initial population: **${s.officialInIpp} of ${s.subjects}**`,
      `- authored finds **${s.authoredActionable}** actionable subject(s)`,
      "",
    );
    // The comparison ADR-043 says only a human can make — computed and stated, never auto-resolved.
    if (s.officialInIpp === 0 && s.subjects > 1) {
      lines.push(
        s.authoredActionable > 0
          ? `> **DO NOT FLIP.** Nobody entered the official initial population, yet the authored engine ` +
            `finds ${s.authoredActionable} actionable subject(s) in these same bundles — so "this cohort ` +
            `is ineligible" is demonstrably false here. That points at a data or mapping gap ` +
            `(for a WebChart source see docs/WEBCHART_FHIR_MAPPING.md §3.1).`
          : `> **INCONCLUSIVE — a human decides.** Nobody entered the official initial population, and ` +
            `the authored engine finds nobody actionable either. That is consistent with a genuinely ` +
            `ineligible cohort AND with a data gap that blinds both engines; the shapes are identical. ` +
            `Routing changes no roster row either way, so the flip is inert rather than wrong.`,
        "",
      );
    }
    const diverged = Object.entries(s.divergence);
    lines.push(
      diverged.length === 0
        ? "No subject's roster row changes. The flip is inert for this data."
        : `**${diverged.length} subject(s) change:**`,
      "",
    );
    for (const [subjectId, change] of diverged) lines.push(`- \`${subjectId}\`: ${change}`);
    if (diverged.length > 0) lines.push("");
  }
  return lines.join("\n");
}
