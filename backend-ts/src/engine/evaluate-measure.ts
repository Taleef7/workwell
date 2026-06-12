/**
 * The CQL/eCQM compliance engine as an explicit, swappable COMPUTE BINDING
 * (ADR-008 / companion memo). The worker calls `EvaluateMeasureBinding` the way
 * it calls an AI or vector binding — the portability layer stays JVM-free
 * regardless of which implementation backs it.
 *
 * Binding implementations (chosen on the Phase-1 parity spike, #103):
 *   - PREFERRED: Node ELM execution — compile CQL→ELM offline with the Java
 *     `cql-to-elm` translator at BUILD time, commit the ELM JSON, execute in
 *     Node via cql-execution / fqm-execution. No JVM on the run/deploy path.
 *   - FALLBACK:  JVM evaluator sidecar (stdio/CLI locally, HTTP in server) — only
 *     if Node ELM fails golden parity. "Java where absolutely necessary."
 *
 * Invariant (carried over from the Java backend): the engine NEVER guesses a
 * status. An unconfigured/unsupported binding raises UnsupportedBindingError —
 * the same discipline as "AI never decides compliance; CQL `Outcome Status` is
 * the sole source of truth." The real implementations land in Phase 3 (#106).
 */
import { UnsupportedBindingError, type CloudTarget } from "@mieweb/cloud";

/** Normalized outcome bucket — identical taxonomy to the Java engine. */
export type OutcomeStatus =
  | "COMPLIANT"
  | "DUE_SOON"
  | "OVERDUE"
  | "MISSING_DATA"
  | "EXCLUDED";

/** One CQL define result — mirrors evidence_json.expressionResults (ADR-002). */
export interface ExpressionResult {
  define: string;
  result: unknown;
}

export interface MeasureOutcome {
  subjectId: string;
  measure: string;
  outcome: OutcomeStatus;
  evidence: { expressionResults: ExpressionResult[] };
}

export interface EvaluateMeasureInput {
  /** Measure id (registry key, e.g. "audiogram"). */
  measureId: string;
  /** FHIR R4 patient bundle (transient eval input — WorkWell is not a FHIR server). */
  patientBundle: unknown;
  /** Evaluation date `YYYY-MM-DD`; pins Now()/Today() + the Measurement Period. Defaults to today. */
  evaluationDate?: string;
}

/**
 * Headless, reusable evaluation contract — the TS equivalent of the Java
 * `HeadlessEvaluatorCli` / `evaluateMeasure` Gradle task: "given this patient
 * and this YAML, are they compliant?" with no server and no DB. This is the
 * first-class reusable artifact Doug asked for ("the CQL part can be
 * independent/reusable").
 */
export interface EvaluateMeasureBinding {
  evaluate(input: EvaluateMeasureInput): Promise<MeasureOutcome>;
}

/** Fallback binding when no engine is configured: refuse, never guess. */
export class UnconfiguredEngine implements EvaluateMeasureBinding {
  constructor(private readonly target: CloudTarget = "local") {}

  evaluate(_input: EvaluateMeasureInput): Promise<MeasureOutcome> {
    throw new UnsupportedBindingError(
      "EvaluateMeasure",
      this.target,
      "no CQL engine binding configured",
    );
  }
}
