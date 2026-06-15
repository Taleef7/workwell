/**
 * SQLite/D1 floor implementation of the OutreachTemplateStore contract (#108 admin write CRUD).
 * `active` is stored as INTEGER 0/1 on the floor.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type {
  CreateTemplateInput,
  OutreachTemplateRecord,
  OutreachTemplateStore,
  SeedTemplateInput,
  UpdateTemplateInput,
} from "../outreach-template-store.ts";

interface Row {
  id: string;
  name: string;
  subject: string;
  body_text: string;
  type: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  active: number;
}

const toRecord = (r: Row): OutreachTemplateRecord => ({
  id: r.id,
  name: r.name,
  subject: r.subject,
  bodyText: r.body_text,
  type: r.type,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  active: Number(r.active) === 1,
});

const SELECT =
  "SELECT id, name, subject, body_text, type, created_by, created_at, updated_at, active FROM outreach_templates";

export class SqliteOutreachTemplateStore implements OutreachTemplateStore {
  constructor(private readonly db: CloudDatabase) {}

  async isEmpty(): Promise<boolean> {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM outreach_templates").first<{ n: number }>();
    return Number(row?.n ?? 0) === 0;
  }

  async seed(input: SeedTemplateInput): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO outreach_templates (id, name, subject, body_text, type, created_by, created_at, updated_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO NOTHING`,
      )
      .bind(input.id, input.name, input.subject, input.bodyText, input.type, input.createdBy, now, now)
      .run();
  }

  async listActive(): Promise<OutreachTemplateRecord[]> {
    const { results } = await this.db
      .prepare(`${SELECT} WHERE active = 1 ORDER BY created_at DESC, name ASC`)
      .all<Row>();
    return (results ?? []).map(toRecord);
  }

  async getById(id: string): Promise<OutreachTemplateRecord | null> {
    const row = await this.db.prepare(`${SELECT} WHERE id = ?`).bind(id).first<Row>();
    return row ? toRecord(row) : null;
  }

  async create(input: CreateTemplateInput): Promise<OutreachTemplateRecord> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO outreach_templates (id, name, subject, body_text, type, created_by, created_at, updated_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .bind(input.id, input.name, input.subject, input.bodyText, input.type, input.createdBy, now, now)
      .run();
    return (await this.getById(input.id))!;
  }

  async update(id: string, input: UpdateTemplateInput): Promise<OutreachTemplateRecord | null> {
    if (!(await this.getById(id))) return null;
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `UPDATE outreach_templates SET name = ?, subject = ?, body_text = ?, type = ?, active = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(input.name, input.subject, input.bodyText, input.type, input.active ? 1 : 0, now, id)
      .run();
    return this.getById(id);
  }
}
