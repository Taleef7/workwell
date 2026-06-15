/**
 * Postgres-ceiling implementation of the OutreachTemplateStore contract (#108 admin write CRUD).
 * Schema-qualified to the isolated `workwell_spike` schema; `active` is a BOOLEAN.
 */
import type { PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
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
  created_at: Date | string;
  updated_at: Date | string;
  active: boolean;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : v);

const toRecord = (r: Row): OutreachTemplateRecord => ({
  id: r.id,
  name: r.name,
  subject: r.subject,
  bodyText: r.body_text,
  type: r.type,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  active: r.active,
});

const COLS = "id, name, subject, body_text, type, created_by, created_at, updated_at, active";

export class PgOutreachTemplateStore implements OutreachTemplateStore {
  constructor(private readonly pool: PgPool) {}

  async isEmpty(): Promise<boolean> {
    const { rows } = await this.pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${SPIKE_SCHEMA}.outreach_templates`);
    return Number(rows[0]?.n ?? 0) === 0;
  }

  async seed(input: SeedTemplateInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${SPIKE_SCHEMA}.outreach_templates (id, name, subject, body_text, type, created_by, created_at, updated_at, active)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), TRUE) ON CONFLICT (id) DO NOTHING`,
      [input.id, input.name, input.subject, input.bodyText, input.type, input.createdBy],
    );
  }

  async listActive(): Promise<OutreachTemplateRecord[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLS} FROM ${SPIKE_SCHEMA}.outreach_templates WHERE active = TRUE ORDER BY created_at DESC, name ASC`,
    );
    return rows.map(toRecord);
  }

  async getById(id: string): Promise<OutreachTemplateRecord | null> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLS} FROM ${SPIKE_SCHEMA}.outreach_templates WHERE id = $1`, [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async create(input: CreateTemplateInput): Promise<OutreachTemplateRecord> {
    await this.pool.query(
      `INSERT INTO ${SPIKE_SCHEMA}.outreach_templates (id, name, subject, body_text, type, created_by, created_at, updated_at, active)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), TRUE)`,
      [input.id, input.name, input.subject, input.bodyText, input.type, input.createdBy],
    );
    return (await this.getById(input.id))!;
  }

  async update(id: string, input: UpdateTemplateInput): Promise<OutreachTemplateRecord | null> {
    const { rowCount } = await this.pool.query(
      `UPDATE ${SPIKE_SCHEMA}.outreach_templates
       SET name = $2, subject = $3, body_text = $4, type = $5, active = $6, updated_at = NOW() WHERE id = $1`,
      [id, input.name, input.subject, input.bodyText, input.type, input.active],
    );
    if (!rowCount) return null;
    return this.getById(id);
  }
}
