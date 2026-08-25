/**
 * The `$cql` Evaluation Service route (#474) — the entry ticket to CQL Engine Parity testing.
 *
 *   POST /$cql   → evaluate one data-free CQL expression, answer FHIR `Parameters`
 *
 * This is the system-level `$cql` operation of the CQL IG ("Using CQL With FHIR", Evaluation Service
 * CapabilityStatement) in the exact subset `cqframework/cql-tests-runner` drives: an `expression`
 * in, a `return` parameter out, no patient, no data model, no terminology. The engine side already
 * existed (`evaluateExpressions`, ADR-060 — the language conformance suite is defined in this
 * subset); this route is the transport plus the CQL→FHIR serialization (`cql-result-parameters.ts`).
 *
 * ## The error split is load-bearing
 *
 * A TRANSLATION failure answers **400** with an OperationOutcome — the request itself is defective.
 * A RUNTIME failure answers **200** whose body carries the `evaluation error` parameter — the
 * request was fine and the evaluation's outcome was an error, which is a *result*. The runner
 * grades `invalid="semantic"` and `invalid="true"` cases on exactly this split (either shape counts
 * as "the engine erred", but collapsing runtime errors into transport failures would hide the
 * distinction our own conformance report keeps as its deliverable — ADR-060's separate columns).
 *
 * ## Refusals
 *
 * Operation inputs this service does not evaluate (`subject`, `data`, `prefetchData`, `library`,
 * endpoints…) are REFUSED by name with a 400, never accepted-and-ignored: an answer computed while
 * silently dropping `subject` would look patient-specific and not be — ADR-061's `mode=preview`
 * 501 refusal, applied here. `parameters` is likewise refused until someone needs it, because a
 * caller who supplied CQL parameters and got an answer computed without them has been lied to.
 *
 * ## Auth
 *
 * `/$cql` is outside `/api/`, where `authorize` ends in permitAll (the ADR-067 hazard) — and this
 * endpoint executes caller-supplied CQL, so the explicit rule in `authorize.ts` gates it to the
 * machine-client authority (`/sse`, `/mcp/**`, CDS invoke). The translator bounds the blast radius
 * (data-free subset, no retrieves resolve, UCUM validation per ADR-064), but "anonymous compute
 * service" is not a surface this app offers.
 *
 * No audit event is written: nothing here reads or changes application state — no subject, no
 * store, no clinical data. The hard rule audits state changes; a pure computation has none.
 */
import { evaluateExpressions } from "@work-well/measure-engine";
import { compileCql } from "../measure/cql-translator.ts";
import { resultToParameters, evaluationErrorParameters } from "../fhir/cql-result-parameters.ts";

/**
 * Every response gets a FRESH headers object — never a shared module-level one. The local host layer
 * writes the computed `Content-Length` INTO the headers object it is handed, so a shared object is
 * mutated by the first response and poisons every later one with the first body's length (measured:
 * a 321-byte Parameters served under `Content-Length: 78` — clients hang on shorter bodies and see
 * trailing-garbage parse errors on longer ones).
 */
const jsonHeaders = () => ({ "content-type": "application/json" });

/** Inputs of the `$cql` OperationDefinition this service deliberately does not evaluate. */
const UNSUPPORTED_INPUTS = new Set([
  "subject",
  "data",
  "prefetchData",
  "library",
  "useServerData",
  "dataEndpoint",
  "contentEndpoint",
  "terminologyEndpoint",
  "parameters",
]);

function operationOutcome(status: number, diagnostics: string[]): Response {
  return new Response(
    JSON.stringify({
      resourceType: "OperationOutcome",
      issue: diagnostics.map((d) => ({ severity: "error", code: "invalid", diagnostics: d })),
    }),
    { status, headers: jsonHeaders() },
  );
}

interface ParametersIn {
  resourceType?: string;
  parameter?: { name?: string; valueString?: string }[];
}

export async function handleCqlEvaluation(req: Request): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  if (pathname !== "/$cql") return null;
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...jsonHeaders(), allow: "POST" },
    });
  }

  let body: ParametersIn;
  try {
    body = (await req.json()) as ParametersIn;
  } catch {
    return operationOutcome(400, ["request body is not valid JSON"]);
  }

  const parameters = Array.isArray(body?.parameter) ? body.parameter : [];
  const unsupported = parameters
    .map((p) => p?.name)
    .filter((n): n is string => typeof n === "string" && UNSUPPORTED_INPUTS.has(n));
  if (unsupported.length > 0) {
    return operationOutcome(400, [
      `unsupported $cql input(s): ${[...new Set(unsupported)].join(", ")} — this service evaluates ` +
        "data-free expressions only (no subject, no data, no library resolution)",
    ]);
  }

  const expressions = parameters.filter((p) => p?.name === "expression");
  const expression = expressions[0]?.valueString;
  if (expressions.length !== 1 || typeof expression !== "string" || expression.trim() === "") {
    return operationOutcome(400, ["exactly one `expression` parameter with a valueString is required"]);
  }

  // One define wrapping the caller's expression; the translator's own diagnostics decide validity.
  // `compileCql` applies the shared UCUM validator (ADR-064) — the defect class where a service-less
  // translator rejects every quantity literal is exactly what that ADR closed.
  const compiled = compileCql(`library CqlEvaluationRequest version '1.0.0'\ndefine Result: ${expression}\n`);
  if (!compiled.ok) {
    const diagnostics = compiled.diagnostics.map(
      (d) => (d as { message?: string }).message ?? JSON.stringify(d),
    );
    return operationOutcome(400, diagnostics.length > 0 ? diagnostics : ["CQL translation failed"]);
  }

  try {
    const results = await evaluateExpressions(compiled.elm);
    const value = (results as Record<string, unknown>).Result;
    return new Response(JSON.stringify(resultToParameters(value)), { status: 200, headers: jsonHeaders() });
  } catch (err) {
    // A runtime error is a RESULT (see the module docblock): in-band `evaluation error`, HTTP 200.
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify(evaluationErrorParameters(message)), {
      status: 200,
      headers: jsonHeaders(),
    });
  }
}
