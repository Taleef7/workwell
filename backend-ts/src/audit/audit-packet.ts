/**
 * Auditor packets (#108) — TS port of AuditPacketService for the RUN and MEASURE_VERSION
 * packet types. JVM-free.
 *
 * A packet is a self-contained, downloadable evidence bundle (JSON or a human-readable HTML
 * render of the same JSON) assembled from the existing read models + the audit ledger. Every
 * build:
 *   1. serializes the packet to JSON and computes a `sha256:<hex>` integrity digest,
 *   2. writes an AUDIT_PACKET_GENERATED audit_event (CLAUDE.md — every state change is audited),
 *   3. records the export in audit_packet_exports (type/entity/format/actor/hash/size).
 * The hash + size are ALWAYS computed over the JSON bytes (the canonical artifact); HTML is a
 * presentation render of that same content.
 *
 * The CASE packet is intentionally not ported here — it depends on evidence attachments,
 * scheduled appointments, and outreach_records, which are #108-adjacent and not yet ported.
 *
 * Compliance is never decided here: packets only reflect CQL-derived outcomes + ledger state
 * as of the generation timestamp (see the disclaimers).
 */
import type { RunStore } from "../stores/run-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import type { MeasureStore } from "../stores/measure-store.ts";
import type { AuditEventRow, CaseEventStore } from "../stores/case-event-store.ts";
import { toRunSummary, toRunOutcomeRows, toRunLogEntries } from "../run/read-models.ts";
import { toMeasureDetail } from "../measure/measure-read-models.ts";
import { generateTraceability } from "../measure/measure-traceability.ts";
import { computeDataReadiness } from "../measure/data-readiness.ts";

export type PacketFormat = "json" | "html";

export interface PacketResult {
  content: string;
  contentType: string;
  filename: string;
}

/** Thrown when the run / measure version named in the URL does not exist → 404 at the route. */
export class PacketNotFoundError extends Error {}

const RUN_DISCLAIMERS = [
  "Compliance outcomes are determined by CQL evaluation logic only.",
  "This packet reflects WorkWell Measure Studio data as of the generation timestamp.",
  "AI-generated run insights, if present, are assistive only and do not constitute compliance determinations.",
];

const MEASURE_DISCLAIMERS = [
  "CQL text is included as a reference artifact. All compliance determinations are made by evaluating CQL at runtime.",
  "Traceability and data readiness information reflects the state at packet generation time.",
  "Value set governance data reflects the most recently resolved state.",
  "This packet reflects WorkWell Measure Studio data as of the generation timestamp.",
];

const APPROVAL_EVENT_TYPES = new Set(["MEASURE_APPROVED", "MEASURE_VERSION_STATUS_CHANGED", "MEASURE_DEPRECATED"]);

export interface RunPacketDeps {
  runStore: RunStore;
  outcomeStore: OutcomeStore;
  caseStore: CaseStore;
  events: CaseEventStore;
}

export interface MeasurePacketDeps {
  measures: MeasureStore;
  outcomes: OutcomeStore;
  events: CaseEventStore;
}

/** Trim a raw audit row to the packet ledger shape (Java AuditPacketService projection). */
function auditEntry(e: AuditEventRow): Record<string, unknown> {
  return { eventType: e.eventType, actor: e.actor, occurredAt: e.occurredAt, payload: e.payload };
}

export async function buildRunPacket(
  deps: RunPacketDeps,
  runId: string,
  actor: string,
  format: PacketFormat,
): Promise<PacketResult> {
  const run = await deps.runStore.getRun(runId);
  if (!run) throw new PacketNotFoundError(`Run not found: ${runId}`);

  const outcomes = await deps.outcomeStore.listOutcomes(runId);
  const totalCases = await deps.caseStore.countByLastRun(runId);
  const summary = toRunSummary(run, outcomes, totalCases);
  const logs = toRunLogEntries(await deps.runStore.listLogs(runId, 200));
  const auditEvents = (await deps.events.auditEventsByRun(runId)).map(auditEntry);

  const packet: Record<string, unknown> = {
    packetType: "RUN",
    generatedAt: new Date().toISOString(),
    generatedBy: actor,
    run: {
      runId: summary.runId,
      measureName: summary.measureName,
      measureVersion: summary.measureVersion,
      status: summary.status,
      triggerType: summary.triggerType,
      scopeType: summary.scopeType,
      startedAt: summary.startedAt,
      completedAt: summary.completedAt,
      durationMs: summary.durationMs,
    },
    summary: {
      totalEvaluated: summary.totalEvaluated,
      compliant: summary.compliantCount,
      nonCompliant: summary.nonCompliantCount,
      passRate: summary.passRate,
      totalCases: summary.totalCases,
      outcomeCounts: summary.outcomeCounts,
      dataFreshAsOf: summary.dataFreshAsOf,
    },
    outcomes: toRunOutcomeRows(outcomes),
    runLogs: logs,
    auditEvents,
    disclaimers: RUN_DISCLAIMERS,
  };

  return finalize(deps.events, packet, "RUN", runId, actor, format, { refRunId: runId, refMeasureVersionId: null });
}

export async function buildMeasureVersionPacket(
  deps: MeasurePacketDeps,
  measureVersionId: string,
  actor: string,
  format: PacketFormat,
): Promise<PacketResult> {
  const record = await deps.measures.getByVersionId(measureVersionId);
  if (!record) throw new PacketNotFoundError(`Measure version not found: ${measureVersionId}`);

  const detail = toMeasureDetail(record);
  const traceability = generateTraceability(record);
  const readiness = await computeDataReadiness({ outcomes: deps.outcomes }, record);
  const auditEvents = await deps.events.auditEventsByMeasureVersion(measureVersionId);
  const approvalHistory = auditEvents.filter((e) => APPROVAL_EVENT_TYPES.has(e.eventType)).map(auditEntry);

  const cqlText = detail.cqlText ?? "";
  const cqlHash = cqlText.trim() === "" ? "" : await sha256Hex(new TextEncoder().encode(cqlText));

  const packet: Record<string, unknown> = {
    packetType: "MEASURE_VERSION",
    generatedAt: new Date().toISOString(),
    generatedBy: actor,
    measure: {
      measureId: detail.id,
      measureVersionId,
      name: detail.name,
      version: detail.version,
      status: detail.status,
      owner: detail.owner,
      policyRef: detail.policyRef,
      tags: record.tags,
      lastUpdated: record.updatedAt,
    },
    spec: {
      description: detail.description,
      complianceWindow: detail.complianceWindow,
      requiredDataElements: detail.requiredDataElements,
      exclusions: detail.exclusions,
      eligibilityCriteria: detail.eligibilityCriteria,
    },
    cql: { text: cqlText, hash: cqlHash },
    compileStatus: detail.compileStatus,
    valueSets: detail.valueSets,
    // Value-set governance is a separate, not-yet-ported surface; an empty object keeps the
    // packet shape stable (the Java packet emits {} when the governance lookup is unavailable).
    valueSetGovernance: {},
    testFixtures: detail.testFixtures,
    traceability,
    dataReadiness: readiness,
    approvalHistory,
    auditEvents: auditEvents.map(auditEntry),
    disclaimers: MEASURE_DISCLAIMERS,
  };

  return finalize(deps.events, packet, "MEASURE_VERSION", measureVersionId, actor, format, {
    refRunId: null,
    refMeasureVersionId: measureVersionId,
  });
}

/**
 * Serialize → hash → audit + record the export → return the requested representation. The
 * `sha256:<hex>` digest and byte size are always computed over the JSON (the canonical artifact),
 * even when HTML is returned.
 */
async function finalize(
  events: CaseEventStore,
  packet: Record<string, unknown>,
  packetType: string,
  entityId: string,
  actor: string,
  format: PacketFormat,
  refs: { refRunId: string | null; refMeasureVersionId: string | null },
): Promise<PacketResult> {
  const json = JSON.stringify(packet);
  const jsonBytes = new TextEncoder().encode(json);
  const hash = `sha256:${await sha256Hex(jsonBytes)}`;

  await events.appendAudit({
    eventType: "AUDIT_PACKET_GENERATED",
    entityType: "audit_packet",
    entityId,
    actor,
    refRunId: refs.refRunId,
    refCaseId: null,
    refMeasureVersionId: refs.refMeasureVersionId,
    payload: {
      packetType,
      entityId,
      format,
      sizeBytes: jsonBytes.length,
      payloadHash: hash,
      generatedAt: new Date().toISOString(),
      generatedBy: actor,
    },
  });
  await events.insertPacketExport({
    packetType,
    entityId,
    format,
    generatedBy: actor,
    payloadHash: hash,
    payloadSizeBytes: jsonBytes.length,
  });

  const slug = packetType.toLowerCase().replace(/_/g, "-");
  if (format === "html") {
    return {
      content: renderHtml(packet),
      contentType: "text/html",
      filename: `workwell-${slug}-packet-${entityId}.html`,
    };
  }
  return {
    content: json,
    contentType: "application/json",
    filename: `workwell-${slug}-packet-${entityId}.json`,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- HTML render (port of AuditPacketService.renderHtml) ----------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderHtml(packet: Record<string, unknown>): string {
  const packetType = String(packet.packetType ?? "");
  const generatedAt = String(packet.generatedAt ?? "");
  const generatedBy = String(packet.generatedBy ?? "");
  const disclaimers = (packet.disclaimers as string[] | undefined) ?? [];

  const out: string[] = [];
  out.push('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">');
  out.push(`<title>WorkWell Audit Packet — ${esc(packetType)}</title>`);
  out.push(
    "<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:0 auto;padding:24px;color:#111;}" +
      "h1{font-size:1.5rem;border-bottom:2px solid #333;padding-bottom:8px;}" +
      "h2{font-size:1.1rem;margin-top:24px;color:#444;border-bottom:1px solid #ddd;padding-bottom:4px;}" +
      "table{border-collapse:collapse;width:100%;font-size:0.9rem;margin-top:8px;}" +
      "th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;}th{background:#f5f5f5;}" +
      ".meta{color:#666;font-size:0.85rem;} .disclaimer{background:#fffbe6;border:1px solid #ffe082;padding:8px 12px;margin:4px 0;border-radius:4px;font-size:0.85rem;}" +
      "pre{background:#f9f9f9;border:1px solid #ddd;padding:12px;overflow-x:auto;font-size:0.8rem;white-space:pre-wrap;word-break:break-all;}" +
      "</style></head><body>",
  );
  out.push(`<h1>WorkWell Audit Packet: ${esc(packetType)}</h1>`);
  out.push(`<p class="meta">Generated: ${esc(generatedAt)} &nbsp;|&nbsp; By: ${esc(generatedBy)}</p>`);

  out.push(appendSection("Packet Contents", packet, ["packetType", "generatedAt", "generatedBy", "disclaimers"]));

  if (disclaimers.length > 0) {
    out.push("<h2>Disclaimers</h2>");
    for (const d of disclaimers) out.push(`<div class="disclaimer">${esc(d)}</div>`);
  }

  out.push(`<h2>Full Packet (JSON)</h2><pre>${esc(JSON.stringify(packet, null, 2))}</pre>`);
  out.push("</body></html>");
  return out.join("");
}

function appendSection(title: string, data: Record<string, unknown>, excludeKeys: string[]): string {
  const rows: string[] = [`<h2>${esc(title)}</h2>`, "<table><tr><th>Field</th><th>Value</th></tr>"];
  for (const [key, val] of Object.entries(data)) {
    if (excludeKeys.includes(key)) continue;
    let cell: string;
    if (val == null) cell = "<em>null</em>";
    else if (typeof val === "object") cell = `<code>${esc(JSON.stringify(val, null, 2))}</code>`;
    else cell = esc(String(val));
    rows.push(`<tr><td>${esc(key)}</td><td>${cell}</td></tr>`);
  }
  rows.push("</table>");
  return rows.join("");
}
