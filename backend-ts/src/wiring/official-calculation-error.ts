/**
 * An official calculation that threw while evaluating the patients' data it was given (#789).
 *
 * fqm-execution evaluates a whole chunk in one call, so a single patient's unreadable data (a blood
 * pressure in `mmHg` rather than UCUM's `mm[Hg]`, which cql-execution refuses) rejects the call for every
 * patient in the chunk. That is the one failure worth retrying patient by patient. It is told apart from
 * the failures that are not:
 * - a refusal the executor raises on purpose, such as "retrieved nothing for anyone", which per patient
 *   would read as an ordinary answer and hide the misconfiguration it exists to catch;
 * - a calculation that cannot start: fqm-execution or cql-exec-fhir failing to load, an artifact missing
 *   its libraries or value sets, a malformed result. Each fails the same way for every patient (Codex, #798);
 * - a calculation worker that crashed, exited or was closed, which retrying one at a time would only load
 *   further.
 * Those stay plain `Error`s and fail the whole batch, as before.
 */
export class OfficialCalculationError extends Error {
  override readonly name = "OfficialCalculationError";
}

/** By name as well as class, so the mark survives a second copy of this module in the process. */
export const isOfficialCalculationError = (error: unknown): error is OfficialCalculationError =>
  error instanceof OfficialCalculationError || (error instanceof Error && error.name === "OfficialCalculationError");

/**
 * fqm-execution's own prefix for an error cql-execution raised while executing the measure over the patients'
 * data (`Execution.js`, around `executor.exec(patientSource, …)`). Nothing that fails before execution
 * carries it, which is what makes it the mark of a data error.
 */
const CQL_EXECUTION_ERROR = "The following error occurred in the cql-execution engine";

/** The error to throw for a failed calculation's message: marked only when cql-execution raised it on the data. */
export function calculationFailure(message: string, stack?: string): Error {
  const error = message.startsWith(CQL_EXECUTION_ERROR) ? new OfficialCalculationError(message) : new Error(message);
  if (stack) error.stack = stack;
  return error;
}
