import type { ContactPreference } from './hooks/useEmployeeProfile';

/** The three channels a message can be sent on, in the order the server falls back through them. */
export const SEND_CHANNELS = ['EMAIL', 'SMS', 'PHONE'] as const;
export type SendChannel = (typeof SEND_CHANNELS)[number];

export const CHANNEL_LABELS: Record<SendChannel, string> = { EMAIL: 'Email', SMS: 'SMS', PHONE: 'Phone' };

/**
 * The channel a picker opens on (#886): the server's own rule (`resolveSendChannel`), so what the picker
 * shows is what a send with no channel would use. Null when every channel is declined.
 */
export function defaultChannel(pref: ContactPreference | null | undefined): SendChannel | null {
  const declined = pref?.declinedChannels ?? [];
  if (pref?.preferredChannel && !declined.includes(pref.preferredChannel)) return pref.preferredChannel;
  return SEND_CHANNELS.find((c) => !declined.includes(c)) ?? null;
}

/** Select options with each declined channel marked and disabled. */
export function channelOptions(pref: ContactPreference | null | undefined) {
  const declined = pref?.declinedChannels ?? [];
  return SEND_CHANNELS.map((c) => ({
    value: c,
    label: declined.includes(c) ? `${CHANNEL_LABELS[c]} (declined)` : CHANNEL_LABELS[c],
    disabled: declined.includes(c),
  }));
}

export const declinedAll = (pref: ContactPreference | null | undefined): boolean => defaultChannel(pref) === null;

/** "Prefers SMS · declined Email" — or null when nothing is recorded. */
export function preferenceLine(pref: ContactPreference | null | undefined): string | null {
  if (!pref) return null;
  if (declinedAll(pref)) return 'Declined all contact';
  const parts: string[] = [];
  if (pref.preferredChannel) parts.push(`Prefers ${CHANNEL_LABELS[pref.preferredChannel]}`);
  if (pref.declinedChannels.length) parts.push(`declined ${pref.declinedChannels.map((c) => CHANNEL_LABELS[c]).join(', ')}`);
  return parts.length ? parts.join(' · ') : null;
}
