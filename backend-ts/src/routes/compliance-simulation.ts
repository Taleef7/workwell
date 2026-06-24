/**
 * Compliance-simulation route — GET /api/employees/:externalId/simulate?asOf=YYYY-MM-DD →
 * { externalId, asOf, evaluations[] }. An advisory, non-persisted, as-of-date re-evaluation of one
 * employee's compliance across every active measure (#197). Authenticated read-only under /api/**
 * (all roles, like the immunization forecast). Writes nothing; no schema. handleEmployees only matches
 * `/profile` + `/search`, so this `/simulate` path is not intercepted.
 */
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";
import { parseQueryDate, QueryDateError } from "./query-dates.ts";
import { simulateComplianceAsOf } from "../run/employee-compliance-snapshot.ts";

// The engine is stateless after construction (loaded ELM) — build once, reuse across requests
// (matches the singletons in cases.ts / runs.ts).
const engine: EvaluateMeasureBinding = new CqlExecutionEngine();

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handleComplianceSimulation(req: Request): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/employees\/([^/]+)\/simulate$/);
  if (!match) return null;

  let externalId: string;
  try {
    externalId = decodeURIComponent(match[1]!);
  } catch {
    return json({ error: "not_found", externalId: match[1]! }, 404); // malformed %-encoding → unknown id
  }

  let asOf: string | undefined;
  try {
    asOf = parseQueryDate(url.searchParams.get("asOf"), "asOf");
  } catch (err) {
    if (err instanceof QueryDateError) return json({ error: "invalid_request", message: err.message }, 400);
    throw err;
  }

  const today = new Date().toISOString().slice(0, 10);
  const snapshot = await simulateComplianceAsOf(externalId, asOf ?? today, { engine, today });
  if (!snapshot) return json({ error: "not_found", externalId }, 404);
  return json(snapshot);
}
