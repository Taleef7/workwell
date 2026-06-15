/**
 * Outreach template service (#108 admin write CRUD) — TS port of OutreachTemplateService.
 * list / preview (with placeholder render) / create / update over the OutreachTemplateStore,
 * plus the V007 demo-template seed. Backs Admin → Outreach Templates.
 */
import type {
  OutreachTemplateRecord,
  OutreachTemplateStore,
} from "../stores/outreach-template-store.ts";

export class OutreachTemplateError extends Error {}

/** The 4 demo templates from V007 (fixed ids so the seed is idempotent). */
const DEMO_TEMPLATES = [
  {
    id: "11111111-0000-0000-0000-000000000001",
    name: "Hearing Conservation Overdue Outreach",
    subject: "Action Needed: Overdue Audiogram Follow-up",
    bodyText: "Your annual audiogram is overdue. Please coordinate with occupational health for immediate scheduling.",
    type: "OUTREACH",
  },
  {
    id: "11111111-0000-0000-0000-000000000002",
    name: "TB Surveillance Follow-Up",
    subject: "Upcoming TB Screening Due Date",
    bodyText: "Your TB surveillance screening is due soon. Please book your screening within the compliance window.",
    type: "OUTREACH",
  },
  {
    id: "11111111-0000-0000-0000-000000000003",
    name: "General Compliance Reminder",
    subject: "Compliance Follow-up Required",
    bodyText: "Please review your pending occupational health requirement and complete the required follow-up as soon as possible.",
    type: "OUTREACH",
  },
  {
    id: "11111111-0000-0000-0000-000000000004",
    name: "Appointment Confirmation",
    subject: "Appointment Scheduled: Occupational Health Follow-up",
    bodyText: "Your appointment has been scheduled. Please arrive on time and bring any required documentation.",
    type: "APPOINTMENT_REMINDER",
  },
] as const;

export async function seedOutreachTemplates(store: OutreachTemplateStore): Promise<void> {
  if (!(await store.isEmpty())) return;
  for (const t of DEMO_TEMPLATES) {
    await store.seed({ id: t.id, name: t.name, subject: t.subject, bodyText: t.bodyText, type: t.type, createdBy: "system" });
  }
}

const VALID_TYPES = new Set(["OUTREACH", "APPOINTMENT_REMINDER", "ESCALATION"]);

/** OutreachTemplateService.normalizeType — default OUTREACH; reject unknown types. */
function normalizeType(type: string | null | undefined): string {
  if (!type || type.trim() === "") return "OUTREACH";
  const normalized = type.trim().toUpperCase();
  if (!VALID_TYPES.has(normalized)) throw new OutreachTemplateError(`Unsupported template type: ${type}`);
  return normalized;
}

export interface TemplatePreview {
  id: string;
  name: string;
  subject: string;
  bodyText: string;
}

/** OutreachTemplateService.render — sample placeholder values for the Admin preview. */
function render(raw: string): string {
  return raw
    .replace(/\{employee_name\}/g, "Jane Smith")
    .replace(/\{measure_name\}/g, "Annual Audiogram")
    .replace(/\{due_date\}/g, "2026-05-30")
    .replace(/\{assignee_name\}/g, "Sarah Mitchell");
}

export async function listTemplates(store: OutreachTemplateStore): Promise<OutreachTemplateRecord[]> {
  return store.listActive();
}

export async function previewTemplate(store: OutreachTemplateStore, id: string): Promise<TemplatePreview> {
  const t = await store.getById(id);
  if (!t) throw new OutreachTemplateError(`Outreach template not found: ${id}`);
  return { id: t.id, name: t.name, subject: render(t.subject), bodyText: render(t.bodyText) };
}

export interface CreateTemplateRequest {
  name: string;
  subject: string;
  bodyText: string;
  type: string | null;
}

export async function createTemplate(
  store: OutreachTemplateStore,
  req: CreateTemplateRequest,
  actor: string,
): Promise<OutreachTemplateRecord> {
  if (!req.name?.trim() || !req.subject?.trim() || !req.bodyText?.trim()) {
    throw new OutreachTemplateError("name, subject, and bodyText are required");
  }
  return store.create({
    id: crypto.randomUUID(),
    name: req.name.trim(),
    subject: req.subject.trim(),
    bodyText: req.bodyText.trim(),
    type: normalizeType(req.type),
    createdBy: actor,
  });
}

export interface UpdateTemplateRequest {
  name: string;
  subject: string;
  bodyText: string;
  type: string | null;
  active: boolean;
}

export async function updateTemplate(
  store: OutreachTemplateStore,
  id: string,
  req: UpdateTemplateRequest,
): Promise<OutreachTemplateRecord | null> {
  if (!req.name?.trim() || !req.subject?.trim() || !req.bodyText?.trim()) {
    throw new OutreachTemplateError("name, subject, and bodyText are required");
  }
  return store.update(id, {
    name: req.name.trim(),
    subject: req.subject.trim(),
    bodyText: req.bodyText.trim(),
    type: normalizeType(req.type),
    active: req.active,
  });
}
