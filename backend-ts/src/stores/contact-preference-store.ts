/**
 * Storage contract — `ContactPreferenceStore` (#886; B6, #584 item 1). How each subject wants to be
 * reached: a preferred channel and the channels not to use. Keyed by the subject id cases use
 * (`cases.employee_id`), so a person with two linked records has two rows, as their cases do; merging them
 * is the identity work's, not this table's.
 *
 * A preference decides which channel a send defaults to and which it refuses. It never touches compliance.
 */
export const PREFERENCE_CHANNELS = ["EMAIL", "SMS", "PHONE"] as const;
export type PreferenceChannel = (typeof PREFERENCE_CHANNELS)[number];

export const isPreferenceChannel = (v: unknown): v is PreferenceChannel =>
  typeof v === "string" && (PREFERENCE_CHANNELS as readonly string[]).includes(v);

export interface ContactPreference {
  subjectId: string;
  preferredChannel: PreferenceChannel | null;
  /** In EMAIL, SMS, PHONE order, never containing `preferredChannel`. */
  declinedChannels: PreferenceChannel[];
  updatedBy: string;
  updatedAt: string;
}

export interface ContactPreferenceStore {
  get(subjectId: string): Promise<ContactPreference | null>;
  /** The rows for these subjects, keyed by subject id; a subject with no row is absent. Empty input: {}. */
  getMany(subjectIds: readonly string[]): Promise<Record<string, ContactPreference>>;
  /** Replace the subject's row (or create it). */
  upsert(pref: ContactPreference): Promise<ContactPreference>;
  /** Delete the subject's row, returning it (null when there was none). */
  remove(subjectId: string): Promise<ContactPreference | null>;
}

/** The stored comma-separated column as channels, in canonical order, unknown tokens dropped. */
export function parseDeclined(raw: string | null | undefined): PreferenceChannel[] {
  const set = new Set((raw ?? "").split(",").map((t) => t.trim()));
  return PREFERENCE_CHANNELS.filter((c) => set.has(c));
}

export function formatDeclined(channels: readonly PreferenceChannel[]): string {
  return PREFERENCE_CHANNELS.filter((c) => channels.includes(c)).join(",");
}

export const preferredOrNull = (v: string | null | undefined): PreferenceChannel | null => (isPreferenceChannel(v) ? v : null);
