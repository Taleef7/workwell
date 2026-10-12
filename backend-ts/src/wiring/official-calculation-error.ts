/**
 * An official calculation that threw while evaluating the bundles it was given (#789).
 *
 * fqm-execution evaluates a whole chunk in one call, so a single patient's unreadable data (a blood
 * pressure in `mmHg` rather than UCUM's `mm[Hg]`, which cql-execution refuses) rejects the call for every
 * patient in the chunk. That is the one failure worth retrying patient by patient. It is told apart from
 * the failures that are not:
 * - a refusal the executor raises on purpose, such as "retrieved nothing for anyone", which per patient
 *   would read as an ordinary answer and hide the misconfiguration it exists to catch;
 * - an artifact or terminology that cannot be loaded, which fails the same way for every patient;
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
