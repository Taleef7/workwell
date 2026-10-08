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
import type { OutcomeStore, OutcomeRecord } from "../stores/outcome-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import type { MeasureStore } from "../stores/measure-store.ts";
import type { AuditEventRow, CaseEventStore } from "../stores/case-event-store.ts";
import type { EvidenceStore } from "../stores/evidence-store.ts";
import type { AppointmentStore } from "../stores/appointment-store.ts";
import { toRunSummary, toRunOutcomeRow, toRunLogEntries, type RunOutcomeRow } from "../run/read-models.ts";
import { toMeasureDetail } from "../measure/measure-read-models.ts";
import { toCaseDetail } from "../case/case-detail-read-model.ts";
import { generateTraceability } from "../measure/measure-traceability.ts";
import { computeDataReadiness } from "../measure/data-readiness.ts";
import { outcomeForCase } from "../case/case-outcome.ts";
import { distinctScoringLogics } from "../fhir/run-aggregate.ts";
import type { ScoringLogic } from "../measure/measure-identity.ts";

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

const CASE_DISCLAIMERS = [
  "Compliance status is determined solely by CQL evaluation logic, not by AI-generated explanations.",
  "AI-generated explanation text, if present, is assistive only and does not constitute a compliance determination.",
  "This packet reflects WorkWell Measure Studio data as of the generation timestamp.",
  "Evidence files are referenced by metadata only; raw file bytes are not included in this packet.",
];

const APPROVAL_EVENT_TYPES = new Set(["MEASURE_APPROVED", "MEASURE_VERSION_STATUS_CHANGED", "MEASURE_DEPRECATED"]);
const OUTREACH_EVENT_TYPES = new Set(["OUTREACH_SENT", "OUTREACH_DELIVERY_UPDATED"]);

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

export interface CasePacketDeps {
  cases: CaseStore;
  outcomes: OutcomeStore;
  events: CaseEventStore;
  evidence: EvidenceStore;
  appointments: AppointmentStore;
}

/** Trim a raw audit row to the packet ledger shape (Java AuditPacketService projection). */
function auditEntry(e: AuditEventRow): Record<string, unknown> {
  return { eventType: e.eventType, actor: e.actor, occurredAt: e.occurredAt, payload: e.payload };
}

const caseKey = (employeeId: string, measureId: string, evaluationPeriod: string): string =>
  `${employeeId}\u0000${measureId}\u0000${evaluationPeriod}`;

/**
 * Run outcome rows with each non-compliant row traced to its case id (Java's outcomes ↔ cases
 * LEFT JOIN). Looks up the run's cases once per measure, keyed by the TS unique key
 * (employeeId, measureId, evaluationPeriod), then overlays caseId onto the shared row mapper.
 * Sorted by employee name to match the Java ORDER BY.
 */
async function runOutcomeRowsWithCases(caseStore: CaseStore, outcomes: OutcomeRecord[]): Promise<RunOutcomeRow[]> {
  const caseById = new Map<string, string>();
  for (const measureId of new Set(outcomes.map((o) => o.measureId))) {
    // Explicit high limit — a hash-stamped audit artifact must trace EVERY non-compliant outcome to
    // its case, but the store default (50) silently dropped links past the 50th case per measure,
    // misrepresenting later outcomes as caseless (Fable M8). The campaign engine already passes 100000.
    for (const c of await caseStore.listCases({ measureId, limit: 100000 })) {
      caseById.set(caseKey(c.employeeId, c.measureId, c.evaluationPeriod), c.id);
    }
  }
  return outcomes
    .map((o) => ({ ...toRunOutcomeRow(o), caseId: caseById.get(caseKey(o.subjectId, o.measureId, o.evaluationPeriod)) ?? null }))
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}

/**
 * The distinct logics that scored each measure's rows in this run (#769), in the shape and order the
 * run reconciliation serves (`{ measureId, logics }`, `distinctScoringLogics`), computed from the rows
 * the packet already holds. More than one entry for a measure means its rows were scored by more than
 * one logic or measurement period; an authored or errored row has no name to list.
 */
function scoringLogicByMeasure(outcomes: OutcomeRecord[]): Array<{ measureId: string; logics: ScoringLogic[] }> {
  const byMeasure = new Map<string, unknown[]>();
  for (const o of outcomes) {
    const evidences = byMeasure.get(o.measureId) ?? [];
    evidences.push(o.evidence);
    byMeasure.set(o.measureId, evidences);
  }
  return [...byMeasure.keys()].sort().map((measureId) => ({ measureId, logics: distinctScoringLogics(byMeasure.get(measureId)!) }));
}

/** A merged-timeline entry as stored by CaseEventStore (payload carries a timelineSource tag). */
interface TimelineEntry {
  eventType: string;
  actor: string | null;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/** Strip the timelineSource discriminator from a timeline entry's payload (packet projection). */
function timelineEntry(e: TimelineEntry): Record<string, unknown> {
  const { timelineSource: _drop, ...payload } = e.payload;
  return { eventType: e.eventType, actor: e.actor, occurredAt: e.occurredAt, payload };
}

export async function buildCasePacket(
  deps: CasePacketDeps,
  caseId: string,
  actor: string,
  format: PacketFormat,
): Promise<PacketResult> {
  const c = await deps.cases.getCase(caseId);
  if (!c) throw new PacketNotFoundError(`Case not found: ${caseId}`);

  const outcome = await outcomeForCase(deps.outcomes, c.lastRunId, c.employeeId, c.measureId);
  const rawTimeline = (await deps.events.caseTimeline(caseId)) as TimelineEntry[];
  const latest = await deps.events.latestOutreachDeliveryStatus(caseId);
  const detail = toCaseDetail(c, outcome, rawTimeline, latest);
  const appointments = await deps.appointments.listByCase(caseId);
  const attachments = await deps.evidence.listByCase(caseId);

  // Partition the merged timeline the way the Java packet does: operator actions, AI assistance,
  // and the residual audit ledger. Outreach actions are also surfaced as their own section.
  const actions: Record<string, unknown>[] = [];
  const aiAssistance: Record<string, unknown>[] = [];
  const auditEvents: Record<string, unknown>[] = [];
  const outreach: Record<string, unknown>[] = [];
  for (const e of rawTimeline) {
    const source = String(e.payload.timelineSource ?? "");
    const entry = timelineEntry(e);
    if (OUTREACH_EVENT_TYPES.has(e.eventType)) outreach.push(entry);
    if (source === "case_action") actions.push(entry);
    else if (e.eventType.startsWith("AI_")) aiAssistance.push(entry);
    else auditEvents.push(entry);
  }

  const evidence = detail.evidenceJson as Record<string, unknown>;
  const packet: Record<string, unknown> = {
    packetType: "CASE",
    generatedAt: new Date().toISOString(),
    generatedBy: actor,
    case: {
      caseId: detail.caseId,
      status: detail.status,
      priority: detail.priority,
      currentOutcomeStatus: detail.currentOutcomeStatus,
      evaluationPeriod: detail.evaluationPeriod,
      assignee: detail.assignee,
      nextAction: detail.nextAction,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      closedAt: detail.closedAt,
      closedReason: detail.closedReason,
      closedBy: detail.closedBy,
      lastRunId: detail.lastRunId,
    },
    employee: { externalId: detail.employeeId, name: detail.employeeName },
    measure: {
      measureVersionId: detail.measureVersionId,
      name: detail.measureName,
      // The cited outcome's own version and logic (#769, `toCaseDetail`): the artifact's "1.0.000" for a
      // row CMS's artifact scored, "" for an errored row, never the authored library's.
      version: detail.measureVersion,
      logic: detail.logic,
      outcomeSummary: detail.outcomeSummary,
    },
    decisionEvidence: {
      outcomeStatus: detail.outcomeStatus,
      outcomeSummary: detail.outcomeSummary,
      outcomeEvaluatedAt: detail.outcomeEvaluatedAt,
      whyFlagged: evidence.why_flagged ?? {},
      expressionResults: evidence.expressionResults ?? [],
    },
    actions,
    outreach,
    appointments,
    attachments: attachments.map((a) => ({
      evidenceId: a.id,
      filename: a.fileName,
      contentType: a.mimeType,
      sizeBytes: a.fileSizeBytes,
      uploadedBy: a.uploadedBy,
      uploadedAt: a.uploadedAt,
      description: a.description,
    })),
    auditEvents,
    aiAssistance,
    disclaimers: CASE_DISCLAIMERS,
  };

  return finalize(deps.events, packet, "CASE", caseId, actor, format, { refRunId: null, refMeasureVersionId: null });
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
      // The run read model's (#769): a run row carries no evidence, so a measure with a CMS artifact
      // prints no version here; `scoringLogic` below names what scored the rows.
      measureVersion: summary.measureVersion,
      scoringLogic: scoringLogicByMeasure(outcomes),
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
    outcomes: await runOutcomeRowsWithCases(deps.caseStore, outcomes),
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
