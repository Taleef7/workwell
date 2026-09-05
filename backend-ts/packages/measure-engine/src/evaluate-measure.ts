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
 * status. An unconfigured/unsupported binding refuses (see the app-side
 * `UnconfiguredEngine` in `src/wiring/unconfigured-engine.ts`) — the same
 * discipline as "AI never decides compliance; CQL `Outcome Status` is the sole
 * source of truth."
 *
 * BOUNDARY (extraction PR-1): this module is part of the publishable engine
 * surface and imports NOTHING from the app layer (stores/, @mieweb/*) — enforced
 * by the engine-boundary arch test.
 */

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

/**
 * Provenance + REGULATORY population truth for an outcome produced by running the official published
 * artifact (roadmap §7.3). Present only on official-routed outcomes.
 *
 * `populationResults` is the lossless record of what the measure's own CQL decided. Exporters read it in
 * preference to `outcome`, because the five-bucket status is a WORKFLOW vocabulary: it cannot express
 * denominator-exception, and it inverts for a measure whose numerator counts failures (ADR-031, PR-3).
 */
export interface OfficialEvidence {
  ecqmId: string | null;
  version: string;
  engine: string;
  artifactSha256: string;
  /**
   * The executor's population array, verbatim. This is one of exactly two shapes the exporter's
   * `officialMembership` accepts, and a third shape is not "close enough": it is rejected and alerted,
   * which degrades the report to status-derived membership — the very thing evidence-first exporting
   * exists to prevent. A round-trip test pins the two halves together.
   */
  populationResults: Array<{ populationType: string; result: boolean; [key: string]: unknown }>;
  /**
   * The measurement period the artifact was actually executed over (ADR-072: the calendar year
   * containing the evaluation date, not the authored path's rolling window). Recorded because a
   * population count is meaningless without the window it was counted over, and because the vendored
   * artifacts are a prior-year vintage — a reader needs to see which year the numbers describe.
   * Optional: outcomes persisted before ADR-072 do not carry it, and back-filling stored evidence
   * would be inventing a fact about a run that already happened.
   */
  measurementPeriod?: { start: string; end: string };
}

export interface MeasureOutcome {
  subjectId: string;
  measure: string;
  outcome: OutcomeStatus;
  /**
   * L17: whether the subject is in the measure's **Initial Population** (read from the CQL "Initial
   * Population" define). `false` means the subject is out of scope for this measure — not enrolled / not
   * eligible — which is distinct from an in-population `MISSING_DATA` (enrolled but no qualifying data).
   * On the real-data path this lets a consumer show "not applicable" instead of reading an out-of-program
   * patient as non-compliance. `undefined` when the measure emits no boolean "Initial Population" define.
   * Descriptive only (ADR-008): it never changes `outcome`.
   */
  inInitialPopulation?: boolean;
  evidence: { expressionResults: ExpressionResult[]; official?: OfficialEvidence };
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
