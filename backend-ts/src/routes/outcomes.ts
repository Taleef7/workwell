/**
 * Outcome evidence route — GET /api/outcomes/:outcomeId → { outcomeId, status, evidenceJson }.
 * Hydrates a roster cell's `evidenceRef` so the per-employee compliance card can show the CQL
 * expressionResults/why_flagged inline (the same evidence the case-detail page shows). Authenticated
 * read-only under the /api/** matrix (all roles). Read-only; no schema.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";

interface OutcomesEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handleOutcomes(req: Request, env: OutcomesEnv): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/outcomes\/([^/]+)$/);
  if (!match) return null;

  let outcomeId: string;
  try {
    outcomeId = decodeURIComponent(match[1]!);
  } catch {
    // A malformed percent-encoding (e.g. a bare `%`) is a non-existent id → 404, not a thrown 500.
    return json({ error: "not_found", outcomeId: match[1]! }, 404);
  }
  const stores = await getStores(env);
  const outcome = await stores.outcomes.getOutcomeById(outcomeId);
  if (!outcome) return json({ error: "not_found", outcomeId }, 404);
  return json({ outcomeId: outcome.id, status: outcome.status, evidenceJson: outcome.evidence });
}
