/**
 * Immunization forecast route (#76 E6) — advisory ICE-ready forecasting behind the unchanged
 * frontend contract. Authenticated under /api/** by the worker's security matrix. Read-time over
 * the forecaster's synthetic history; no schema.
 *
 *   GET /api/immunization/forecast?subjectId=&asOf=  → ImmunizationForecast
 */
import type { ForecastEnv } from "../engine/immunization/immunization-forecast.ts";
import { resolveForecaster } from "../engine/immunization/resolve-forecaster.ts";
import { parseQueryDate, QueryDateError } from "./query-dates.ts";

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handleImmunizationForecast(req: Request, env: ForecastEnv): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  if (url.pathname !== "/api/immunization/forecast") return null;

  const subjectId = (url.searchParams.get("subjectId") ?? "").trim();
  if (!subjectId) return json({ error: "invalid_request", message: "subjectId is required" }, 400);

  let asOf: string | undefined;
  try {
    asOf = parseQueryDate(url.searchParams.get("asOf"), "asOf");
  } catch (err) {
    if (err instanceof QueryDateError) return json({ error: "invalid_request", message: err.message }, 400);
    throw err;
  }
  const today = new Date().toISOString().slice(0, 10);
  const forecast = await resolveForecaster(env).forecast(subjectId, asOf ?? today);
  return json(forecast);
}
