/** Postgres ceiling adapter for `ContactPreferenceStore` (#886). Schema-qualified to workwell_spike. */
import type { PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import {
  formatDeclined,
  parseDeclined,
  preferredOrNull,
  type ContactPreference,
  type ContactPreferenceStore,
} from "../contact-preference-store.ts";

const S = SPIKE_SCHEMA;
const COLS = "subject_id, preferred_channel, declined_channels, updated_by, updated_at";
const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

interface Row {
  subject_id: string;
  preferred_channel: string | null;
  declined_channels: string;
  updated_by: string;
  updated_at: Date | string;
}

const toPref = (r: Row): ContactPreference => ({
  subjectId: r.subject_id,
  preferredChannel: preferredOrNull(r.preferred_channel),
  declinedChannels: parseDeclined(r.declined_channels),
  updatedBy: r.updated_by,
  updatedAt: iso(r.updated_at),
});

export class PgContactPreferenceStore implements ContactPreferenceStore {
  constructor(private readonly pool: PgPool) {}

  async get(subjectId: string): Promise<ContactPreference | null> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLS} FROM ${S}.contact_preferences WHERE subject_id = $1`, [subjectId]);
    return rows[0] ? toPref(rows[0]) : null;
  }

  async getMany(subjectIds: readonly string[]): Promise<Record<string, ContactPreference>> {
    const ids = [...new Set(subjectIds)];
    if (ids.length === 0) return {};
    const { rows } = await this.pool.query<Row>(`SELECT ${COLS} FROM ${S}.contact_preferences WHERE subject_id = ANY($1::text[])`, [ids]);
    const out: Record<string, ContactPreference> = {};
    for (const r of rows) out[r.subject_id] = toPref(r);
    return out;
  }

  async upsert(pref: ContactPreference): Promise<ContactPreference> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO ${S}.contact_preferences (${COLS}) VALUES ($1, $2, $3, $4, $5::timestamptz)
       ON CONFLICT (subject_id) DO UPDATE SET preferred_channel = $2, declined_channels = $3, updated_by = $4, updated_at = $5::timestamptz
       RETURNING ${COLS}`,
      [pref.subjectId, pref.preferredChannel, formatDeclined(pref.declinedChannels), pref.updatedBy, pref.updatedAt],
    );
    return toPref(rows[0]!);
  }

  async remove(subjectId: string): Promise<ContactPreference | null> {
    const { rows } = await this.pool.query<Row>(`DELETE FROM ${S}.contact_preferences WHERE subject_id = $1 RETURNING ${COLS}`, [subjectId]);
    return rows[0] ? toPref(rows[0]) : null;
  }
}
