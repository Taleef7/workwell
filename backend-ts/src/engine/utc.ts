/**
 * Pins this process to UTC (#845). Every entry point imports this FIRST: the server, the dev worker, the
 * official-calculation thread and every CLI. So does the test runner (`--import`), and the image sets
 * `TZ=UTC` as well. `utc-entrypoints.test.ts` refuses an entry point that does not.
 *
 * Why it matters for results, not just for logs:
 * - cql-exec-fhir parses a FHIR `dateTime` with no offset (a date-only `"2026-06-30"` is the common case)
 *   with the host's current offset.
 * - fqm-execution evaluates the measurement period at offset 0.
 * - So on a non-UTC host, patient dates are compared in a different offset from the period, and a result
 *   can flip. This was measured on a CMS165 hypertension onset (cqframework/cql-exec-fhir#49).
 *
 * CQL's rule is the evaluation request's offset, which fqm makes 0, so the process must be 0 too. Node
 * applies an assignment to `process.env.TZ` immediately, on Windows as well. A worker thread created
 * afterwards inherits it.
 */
process.env.TZ = "UTC";
