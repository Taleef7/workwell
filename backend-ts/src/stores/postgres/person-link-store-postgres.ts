/**
 * Postgres ceiling adapter for `PersonLinkStore` (#187 E15 PR-2). Idempotent upsert via ON CONFLICT
 * on the UNIQUE pair key DO UPDATE (last write wins, keeps the row id). Schema-qualified to
 * workwell_spike. Descriptive only — never decides compliance (ADR-008/ADR-022).
 */
import type { PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import {
  normalizePair,
  type PersonLink,
  type PersonLinkStore,
  type PersonLinkType,
  type UpsertPersonLinkInput,
} from "../person-link-store.ts";

const S = SPIKE_SCHEMA;
const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

interface Row {
  id: string;
  a_tenant_id: string;
  a_external_id: string;
  b_tenant_id: string;
  b_external_id: string;
  link_type: string;
  created_by: string | null;
  created_at: Date | string;
}

const toLink = (r: Row): PersonLink => ({
  id: r.id,
  a: { tenantId: r.a_tenant_id, externalId: r.a_external_id },
  b: { tenantId: r.b_tenant_id, externalId: r.b_external_id },
  linkType: r.link_type as PersonLinkType,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
});

export class PgPersonLinkStore implements PersonLinkStore {
  constructor(private readonly pool: PgPool) {}

  async listLinks(): Promise<PersonLink[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT id, a_tenant_id, a_external_id, b_tenant_id, b_external_id, link_type, created_by, created_at
         FROM ${S}.person_links ORDER BY created_at ASC, id ASC`,
    );
    return rows.map(toLink);
  }

  async upsertLink(input: UpsertPersonLinkInput): Promise<PersonLink> {
    const { a, b } = normalizePair(input.a, input.b);
    const createdAt = new Date().toISOString();
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO ${S}.person_links
         (id, a_tenant_id, a_external_id, b_tenant_id, b_external_id, link_type, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (a_tenant_id, a_external_id, b_tenant_id, b_external_id)
       DO UPDATE SET link_type = $6, created_by = $7, created_at = $8
       RETURNING id, a_tenant_id, a_external_id, b_tenant_id, b_external_id, link_type, created_by, created_at`,
      [crypto.randomUUID(), a.tenantId, a.externalId, b.tenantId, b.externalId, input.linkType, input.createdBy, createdAt],
    );
    return toLink(rows[0]!);
  }
}
