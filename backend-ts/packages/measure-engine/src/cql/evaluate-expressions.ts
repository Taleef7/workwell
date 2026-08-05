/**
 * `evaluateExpressions` — run a compiled library with NO patient context and return its define results.
 *
 * ## Why this is a real capability and not a test hook
 *
 * A large part of CQL is data-free: arithmetic, intervals, list and string operators, date/time algebra,
 * type conversion. The language's own conformance suite (`cqframework/cql-tests`, 1,835 cases across 16
 * files) is defined entirely in that subset — every case is one expression and its expected value, with
 * no retrieve, no data model and no terminology anywhere. An engine that can only answer
 * "is this patient compliant?" cannot be measured against the language it claims to implement.
 *
 * `cql-execution` calls this the **unfiltered** context: defines that reference no patient are evaluated
 * once and returned under `unfilteredResults` rather than per subject. This exposes exactly that, and
 * nothing else.
 *
 * ## What it deliberately does not do
 *
 * No terminology, no measurement period, no content injection — a library that retrieves data will
 * simply produce nothing for those defines rather than erroring, which is the honest behaviour for
 * "there is no patient here". Measure evaluation is `CqlExecutionEngine.evaluate`; this is not a
 * shortcut into it.
 */
// eslint-disable-next-line import/no-unresolved
import cql from "cql-execution";

/** A patient source with no patients. `cql-execution` needs the shape, not the data. */
const EMPTY_PATIENT_SOURCE = {
  currentPatient: () => null,
  nextPatient: () => null,
  reset: () => {},
};

export interface EvaluateExpressionsOptions {
  /**
   * Parameters passed to the executor — e.g. `{ "Measurement Period": interval }`. Absent by default:
   * a data-free expression needs none, and inventing one would change what some date operators return.
   */
  parameters?: Record<string, unknown>;
}

/**
 * Execute `elm` with no patient and return every define's value by name.
 *
 * Throws whatever `cql-execution` throws — a runtime error in a define is a real result for a
 * conformance harness, and swallowing it into `undefined` would make an engine defect indistinguishable
 * from a define that legitimately evaluates to null.
 */
export async function evaluateExpressions(
  elm: unknown,
  opts: EvaluateExpressionsOptions = {},
): Promise<Record<string, unknown>> {
  const library = new cql.Library(elm);
  const executor = new cql.Executor(library, undefined, opts.parameters);
  const results = await executor.exec(EMPTY_PATIENT_SOURCE);
  return (results?.unfilteredResults ?? {}) as Record<string, unknown>;
}
