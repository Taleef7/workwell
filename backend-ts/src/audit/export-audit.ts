/**
 * A bulk download of patient data is recorded before it leaves (production readiness A1).
 *
 * Every export route (the §6 CSVs, the audit ledger, QRDA I/III, MeasureReport) writes `EXPORT_GENERATED`
 * after its checks pass and BEFORE the response is returned, and returns 503 `export_not_recorded` when
 * that write fails: data no one can later account for never leaves. This is stricter than the best-effort
 * `COMPLIANCE_API_READ`, which reads one subject; an export carries the whole roster.
 *
 * The payload names the export, the run it came from and the filters it was taken under, which is what a
 * later "who took this file, and what was in it?" needs. The ledger is ADMIN-only to read.
 */
import type { CaseEventStore } from "../stores/case-event-store.ts";

export type ExportKind =
  | "runs_csv"
  | "outcomes_csv"
  | "cases_csv"
  | "audit_csv"
  | "qrda1"
  | "qrda3"
  | "measure_report";

export interface ExportRecord {
  actor: string;
  kind: ExportKind;
  path: string;
  /** The query the export was taken under (filters), as received. */
  params: URLSearchParams;
  runId?: string | null;
}

export async function recordExport(events: Pick<CaseEventStore, "appendAudit">, record: ExportRecord): Promise<void> {
  const params: Record<string, string> = {};
  for (const [key, value] of record.params) params[key] = params[key] === undefined ? value : `${params[key]},${value}`;
  await events.appendAudit({
    eventType: "EXPORT_GENERATED",
    entityType: "export",
    entityId: crypto.randomUUID(),
    actor: record.actor,
    refRunId: record.runId ?? null,
    refCaseId: null,
    refMeasureVersionId: null,
    payload: {
      kind: record.kind,
      path: record.path,
      params,
      sensitivityLabel: "restricted",
      timestamp: new Date().toISOString(),
    },
  });
}

/** The answer an export gets when its record could not be written: nothing leaves. */
export function exportNotRecorded(error: unknown): Response {
  console.error(`WORKWELL_ALERT export refused: its audit record could not be written: ${String(error)}`);
  return new Response(
    JSON.stringify({ error: "export_not_recorded", message: "The export was not served because it could not be recorded. Try again." }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

/** Record the export, then build the response; a failed record answers 503 and the builder never runs. */
export async function auditedExport(
  events: Pick<CaseEventStore, "appendAudit">,
  record: ExportRecord,
  respond: () => Response | Promise<Response>,
): Promise<Response> {
  try {
    await recordExport(events, record);
  } catch (error) {
    return exportNotRecorded(error);
  }
  return respond();
}
