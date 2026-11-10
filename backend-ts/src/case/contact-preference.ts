/**
 * Contact preference (#886; B6, #584 item 1): how a subject wants to be reached. Staff set a preferred
 * channel and the channels not to use; sends read it.
 *
 * - **Setting it** is audit-first: `CONTACT_PREFERENCE_SET` (previous and next) or
 *   `CONTACT_PREFERENCE_CLEARED`, entity "subject", then the row. A save that changes nothing writes
 *   nothing; an empty preference deletes the row.
 * - **Sending** (`resolveSendChannel`): no channel given → the preferred one, else the first of EMAIL, SMS,
 *   PHONE not declined, else 409 `all_channels_declined`; a declined channel given → 409
 *   `channel_declined`. Callers check before any audit or send.
 *
 * A preference never touches compliance. Linked records are not merged: a decline on one record does not
 * cover the person's other record, as with their cases.
 */
import type { CaseEventStore } from "../stores/case-event-store.ts";
import {
  PREFERENCE_CHANNELS,
  isPreferenceChannel,
  type ContactPreference,
  type ContactPreferenceStore,
  type PreferenceChannel,
} from "../stores/contact-preference-store.ts";

export class ContactPreferenceError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: string,
    message: string,
    readonly channel?: string,
  ) {
    super(message);
  }
}

export interface ContactPreferenceDeps {
  contactPreferences: ContactPreferenceStore;
  events: Pick<CaseEventStore, "appendAudit">;
}

export interface SetPreferenceInput {
  subjectId: string;
  preferredChannel: PreferenceChannel | null;
  declinedChannels: readonly PreferenceChannel[];
  actor: string;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Save a subject's preference; returns the stored row, or null when it is now empty (deleted). */
export async function setContactPreference(deps: ContactPreferenceDeps, input: SetPreferenceInput): Promise<ContactPreference | null> {
  const declined = PREFERENCE_CHANNELS.filter((c) => input.declinedChannels.includes(c));
  if (input.preferredChannel !== null && declined.includes(input.preferredChannel)) {
    throw new ContactPreferenceError(400, "invalid_request", "The preferred channel cannot also be declined.", input.preferredChannel);
  }
  const existing = await deps.contactPreferences.get(input.subjectId);
  if (input.preferredChannel === null && declined.length === 0) return clearContactPreference(deps, input.subjectId, input.actor);
  if (existing && existing.preferredChannel === input.preferredChannel && sameSet(existing.declinedChannels, declined)) {
    return existing; // no change: no event
  }
  const previous = existing
    ? { preferredChannel: existing.preferredChannel, declinedChannels: existing.declinedChannels }
    : { preferredChannel: null, declinedChannels: [] };
  const next = { preferredChannel: input.preferredChannel, declinedChannels: declined };
  // AUDIT BEFORE MUTATE.
  await deps.events.appendAudit({
    eventType: "CONTACT_PREFERENCE_SET",
    entityType: "subject",
    entityId: input.subjectId,
    actor: input.actor,
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: null,
    payload: { subjectId: input.subjectId, previous, next },
  });
  return deps.contactPreferences.upsert({
    subjectId: input.subjectId,
    ...next,
    updatedBy: input.actor,
    updatedAt: new Date().toISOString(),
  });
}

/** Remove a subject's preference; a subject with none writes nothing. Always returns null. */
export async function clearContactPreference(deps: ContactPreferenceDeps, subjectId: string, actor: string): Promise<null> {
  const existing = await deps.contactPreferences.get(subjectId);
  if (!existing) return null;
  // AUDIT BEFORE MUTATE.
  await deps.events.appendAudit({
    eventType: "CONTACT_PREFERENCE_CLEARED",
    entityType: "subject",
    entityId: subjectId,
    actor,
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: null,
    payload: {
      subjectId,
      previous: { preferredChannel: existing.preferredChannel, declinedChannels: existing.declinedChannels },
    },
  });
  await deps.contactPreferences.remove(subjectId);
  return null;
}

/** The channel a send uses, or why it may not be sent. Pure; `pref` null means no preference recorded. */
export function resolveSendChannel(pref: ContactPreference | null, requested: PreferenceChannel | undefined): PreferenceChannel {
  const declined = pref?.declinedChannels ?? [];
  if (requested !== undefined) {
    if (declined.includes(requested)) {
      throw new ContactPreferenceError(409, "channel_declined", `This person asked not to be contacted by ${requested}.`, requested);
    }
    return requested;
  }
  if (pref?.preferredChannel && !declined.includes(pref.preferredChannel)) return pref.preferredChannel;
  const first = PREFERENCE_CHANNELS.find((c) => !declined.includes(c));
  if (!first) throw new ContactPreferenceError(409, "all_channels_declined", "This person asked not to be contacted on any channel.");
  return first;
}

/** Parse a request body's preference fields, or throw 400. */
export function parsePreferenceBody(body: unknown): { preferredChannel: PreferenceChannel | null; declinedChannels: PreferenceChannel[] } {
  const b = (body ?? {}) as { preferredChannel?: unknown; declinedChannels?: unknown };
  const preferred = b.preferredChannel ?? null;
  if (preferred !== null && !isPreferenceChannel(preferred)) {
    throw new ContactPreferenceError(400, "invalid_request", "preferredChannel must be EMAIL, SMS, PHONE or null");
  }
  const declined = b.declinedChannels ?? [];
  if (!Array.isArray(declined) || !declined.every(isPreferenceChannel)) {
    throw new ContactPreferenceError(400, "invalid_request", "declinedChannels must be an array of EMAIL, SMS or PHONE");
  }
  return { preferredChannel: preferred, declinedChannels: [...new Set(declined)] };
}
