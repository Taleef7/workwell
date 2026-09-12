/**
 * Provider panels (MM-2 PR 2, ADR-080) — the mapping a supervisor edits, and the backfill it drives.
 *
 *   GET    /api/panels              every provider, mapped or not → PanelRow[]
 *   PUT    /api/panels/{providerId} map the panel to a staff account → 200 | 400 | 404
 *   DELETE /api/panels/{providerId} un-map it (open cases keep their assignee) → 200 | 404
 *
 * The GET lists EVERY provider in the directory rather than only the mapped ones, because the
 * question the page answers is "who works whose patients", and a provider nobody owns is the most
 * important row on it — the unassigned queue. A list of only the mapped providers would make an
 * un-covered panel invisible on exactly the screen meant to reveal it.
 */
import { getStores } from "../stores/factory.ts";
import type { CloudDatabase } from "@mieweb/cloud";
import { assignPanel, unassignPanel } from "../case/panel-assignment.ts";
import { employees, providerById, providers } from "../config/deployment-profile.ts";
import { assignableUsers, resolveAssignable } from "../auth/demo-users.ts";

export interface PanelsEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** One row of the panels screen: a provider, how many patients they have, and who works them. */
interface PanelRow {
  providerId: string;
  providerName: string;
  location: string;
  /** Patients attributed to this provider in the directory — the size of the panel being handed over. */
  patients: number;
  assignee: string | null;
  updatedAt: string | null;
}

export async function handlePanels(req: Request, env: PanelsEnv, actor = "system"): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/panels")) return null;

  if (url.pathname === "/api/panels" && req.method === "GET") return listPanels(env);

  const providerId = url.pathname.match(/^\/api\/panels\/([^/]+)$/)?.[1];
  if (!providerId) return null;
  const decoded = decodeURIComponent(providerId);

  if (req.method === "PUT") return putPanel(req, env, decoded, actor);
  if (req.method === "DELETE") return deletePanel(env, decoded, actor);
  return null;
}

async function listPanels(env: PanelsEnv): Promise<Response> {
  const stores = await getStores(env);
  const mapped = new Map((await stores.panels.listAll()).map((p) => [p.providerId, p]));
  // One pass over the directory for the patient counts, rather than a count per provider: the
  // directory is in memory and a per-provider scan is O(providers x patients) for a number the page
  // shows as a hint.
  const patientsByProvider = new Map<string, number>();
  for (const employee of employees()) {
    patientsByProvider.set(employee.providerId, (patientsByProvider.get(employee.providerId) ?? 0) + 1);
  }
  const rows: PanelRow[] = [...providers()]
    .map((p) => {
      const assignment = mapped.get(p.id);
      return {
        providerId: p.id,
        providerName: p.name,
        location: p.location,
        patients: patientsByProvider.get(p.id) ?? 0,
        assignee: assignment?.assignee ?? null,
        updatedAt: assignment?.updatedAt ?? null,
      };
    })
    // Unmapped first, then by location and name. The unassigned queues are the actionable rows, and a
    // screen that buries them under forty covered panels is a screen nobody finds the gap on.
    .sort(
      (a, b) =>
        Number(a.assignee !== null) - Number(b.assignee !== null) ||
        a.location.localeCompare(b.location) ||
        a.providerName.localeCompare(b.providerName),
    );
  return json(rows);
}

async function putPanel(req: Request, env: PanelsEnv, providerId: string, actor: string): Promise<Response> {
  // Resource first: an unknown provider is a 404 whatever the body says, matching every case action —
  // so a validation message can never turn "that provider does not exist" into "that assignee is wrong".
  const provider = providerById(providerId);
  if (!provider) return json({ error: "not_found", providerId }, 404);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_request", message: "a JSON body is required" }, 400);
  }
  const requested = String((body as { assignee?: unknown })?.assignee ?? "").trim();
  if (!requested) {
    return json(
      { error: "invalid_request", parameter: "assignee", message: "assignee is required; DELETE the panel to un-map it" },
      400,
    );
  }
  // The same validation every other assign surface uses, against the same list `/api/users/assignable`
  // offers the UI — so a mistyped address cannot park a whole provider's patients on an account
  // nobody signs in as.
  const assignee = resolveAssignable(requested);
  if (!assignee) {
    return json(
      {
        error: "invalid_request",
        parameter: "assignee",
        message: `assignee must be one of: ${assignableUsers().map((u) => u.email).join(", ")}`,
      },
      400,
    );
  }

  const stores = await getStores(env);
  const result = await assignPanel(
    { panels: stores.panels, cases: stores.cases, events: stores.events, roster: employees() },
    { providerId, assignee, actor, providerName: provider.name },
  );
  return json({ ...result, providerName: provider.name });
}

async function deletePanel(env: PanelsEnv, providerId: string, actor: string): Promise<Response> {
  const stores = await getStores(env);
  const removed = await unassignPanel({ panels: stores.panels, events: stores.events }, { providerId, actor });
  if (!removed) return json({ error: "not_found", providerId }, 404);
  // The response names what was removed rather than echoing the request, because the caller's screen
  // needs to say whose panel it just gave up.
  return json({ providerId, previousAssignee: removed.assignee });
}
