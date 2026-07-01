/**
 * SQLite floor adapter for `PersonLinkStore` (#187 E15 PR-2). `INSERT OR REPLACE` on the UNIQUE pair
 * key (last write wins) — re-asserting a pair (e.g. UNLINK after CONFIRM) overwrites in place and gets
 * a fresh `id` (the id isn't referenced elsewhere). Descriptive only (ADR-008/ADR-022).
 */
import type { CloudDatabase } from "@mieweb/cloud";
import {
  normalizePair,
  type PersonLink,
  type PersonLinkStore,
  type PersonLinkType,
  type UpsertPersonLinkInput,
} from "../person-link-store.ts";

interface Row {
  id: string;
  a_tenant_id: string;
  a_external_id: string;
  b_tenant_id: string;
  b_external_id: string;
  link_type: string;
  created_by: string | null;
  created_at: string;
}

const toLink = (r: Row): PersonLink => ({
  id: r.id,
  a: { tenantId: r.a_tenant_id, externalId: r.a_external_id },
  b: { tenantId: r.b_tenant_id, externalId: r.b_external_id },
  linkType: r.link_type as PersonLinkType,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

export class SqlitePersonLinkStore implements PersonLinkStore {
  constructor(private readonly db: CloudDatabase) {}

  async listLinks(): Promise<PersonLink[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, a_tenant_id, a_external_id, b_tenant_id, b_external_id, link_type, created_by, created_at
           FROM person_links ORDER BY created_at ASC, id ASC`,
      )
      .all<Row>();
    return (results ?? []).map(toLink);
  }

  async upsertLink(input: UpsertPersonLinkInput): Promise<PersonLink> {
    const { a, b } = normalizePair(input.a, input.b);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO person_links
           (id, a_tenant_id, a_external_id, b_tenant_id, b_external_id, link_type, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, a.tenantId, a.externalId, b.tenantId, b.externalId, input.linkType, input.createdBy, createdAt)
      .run();
    return { id, a, b, linkType: input.linkType, createdBy: input.createdBy, createdAt };
  }
}
