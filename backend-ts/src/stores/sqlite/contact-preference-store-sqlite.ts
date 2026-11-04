/** SQLite floor adapter for `ContactPreferenceStore` (#886). */
import type { CloudDatabase } from "@mieweb/cloud";
import {
  formatDeclined,
  parseDeclined,
  preferredOrNull,
  type ContactPreference,
  type ContactPreferenceStore,
} from "../contact-preference-store.ts";
import { SQLITE_ID_CHUNK } from "./case-event-store-sqlite.ts";

const COLS = "subject_id, preferred_channel, declined_channels, updated_by, updated_at";

interface Row {
  subject_id: string;
  preferred_channel: string | null;
  declined_channels: string;
  updated_by: string;
  updated_at: string;
}

const toPref = (r: Row): ContactPreference => ({
  subjectId: r.subject_id,
  preferredChannel: preferredOrNull(r.preferred_channel),
  declinedChannels: parseDeclined(r.declined_channels),
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});

export class SqliteContactPreferenceStore implements ContactPreferenceStore {
  constructor(private readonly db: CloudDatabase) {}

  async get(subjectId: string): Promise<ContactPreference | null> {
    const row = await this.db.prepare(`SELECT ${COLS} FROM contact_preferences WHERE subject_id = ?`).bind(subjectId).first<Row>();
    return row ? toPref(row) : null;
  }

  async getMany(subjectIds: readonly string[]): Promise<Record<string, ContactPreference>> {
    const out: Record<string, ContactPreference> = {};
    const ids = [...new Set(subjectIds)];
    for (let start = 0; start < ids.length; start += SQLITE_ID_CHUNK) {
      const slice = ids.slice(start, start + SQLITE_ID_CHUNK);
      const { results } = await this.db
        .prepare(`SELECT ${COLS} FROM contact_preferences WHERE subject_id IN (${slice.map(() => "?").join(", ")})`)
        .bind(...slice)
        .all<Row>();
      for (const r of results ?? []) out[r.subject_id] = toPref(r);
    }
    return out;
  }

  async upsert(pref: ContactPreference): Promise<ContactPreference> {
    await this.db
      .prepare(
        `INSERT INTO contact_preferences (${COLS}) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(subject_id) DO UPDATE SET preferred_channel = excluded.preferred_channel,
           declined_channels = excluded.declined_channels, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(pref.subjectId, pref.preferredChannel, formatDeclined(pref.declinedChannels), pref.updatedBy, pref.updatedAt)
      .run();
    return (await this.get(pref.subjectId))!;
  }

  async remove(subjectId: string): Promise<ContactPreference | null> {
    const existing = await this.get(subjectId);
    if (!existing) return null;
    await this.db.prepare("DELETE FROM contact_preferences WHERE subject_id = ?").bind(subjectId).run();
    return existing;
  }
}
