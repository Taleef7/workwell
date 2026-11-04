'use client';

import { useState } from 'react';
import { Button, Checkbox, Select } from '@mieweb/ui';
import { useApi } from '@/lib/api/hooks';
import { emitToast } from '@/lib/toast';
import { SUBJECT } from '@/lib/terminology';
import { CHANNEL_LABELS, SEND_CHANNELS, preferenceLine, type SendChannel } from '@/features/employee/contact-preference';
import type { ContactPreference } from '@/features/employee/hooks/useEmployeeProfile';

const NO_PREFERENCE = '';

/**
 * How this person wants to be reached (#886): a preferred channel and the channels not to use. Sends
 * default to the preference and refuse a declined channel; campaigns skip a person who declined theirs.
 * A preference never changes compliance.
 */
export function ContactPreferenceCard({
  subjectId,
  preference,
  canEdit,
  onSaved,
}: {
  subjectId: string;
  preference: ContactPreference | null;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const [preferred, setPreferred] = useState<string>(preference?.preferredChannel ?? NO_PREFERENCE);
  const [declined, setDeclined] = useState<SendChannel[]>(preference?.declinedChannels ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setPreferred(preference?.preferredChannel ?? NO_PREFERENCE);
    setDeclined(preference?.declinedChannels ?? []);
    setError(null);
    setEditing(true);
  }

  function toggleDeclined(c: SendChannel, on: boolean) {
    setDeclined((d) => (on ? [...d, c] : d.filter((x) => x !== c)));
    if (on && preferred === c) setPreferred(NO_PREFERENCE); // a declined channel is never the preferred one
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.put(`/api/employees/${encodeURIComponent(subjectId)}/contact-preference`, {
        preferredChannel: preferred === NO_PREFERENCE ? null : preferred,
        declinedChannels: declined,
      });
      emitToast('Contact preference saved', 'success');
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the preference');
    } finally {
      setSaving(false);
    }
  }

  const line = preferenceLine(preference);
  const preferredOptions = [
    { value: NO_PREFERENCE, label: 'No preference' },
    ...SEND_CHANNELS.filter((c) => !declined.includes(c)).map((c) => ({ value: c, label: CHANNEL_LABELS[c] })),
  ];

  return (
    <div
      className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-sm"
      data-testid="contact-preference"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">Contact preference</h2>
        {canEdit && !editing ? (
          <Button type="button" variant="outline" size="sm" onClick={startEdit}>
            Edit
          </Button>
        ) : null}
      </div>
      {!editing ? (
        <>
          <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">{line ?? 'No preference recorded.'}</p>
          {preference ? (
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400 [overflow-wrap:anywhere]">
              Set by {preference.updatedBy} on {new Date(preference.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
          ) : null}
        </>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="w-48">
            <Select label="Preferred channel" size="sm" value={preferred} onValueChange={setPreferred} options={preferredOptions} />
          </div>
          <fieldset>
            <legend className="text-sm font-medium text-neutral-800 dark:text-neutral-200">Do not contact by</legend>
            <div className="mt-1 flex flex-wrap gap-4">
              {SEND_CHANNELS.map((c) => (
                <Checkbox key={c} label={CHANNEL_LABELS[c]} checked={declined.includes(c)} onChange={(e) => toggleDeclined(c, e.target.checked)} />
              ))}
            </div>
          </fieldset>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Messages to this {SUBJECT.singular} open on the preferred channel, and a declined one cannot be sent. It does not change any measure.
          </p>
          {error ? <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">{error}</p> : null}
          <div className="flex gap-2">
            <Button type="button" variant="primary" size="sm" onClick={() => void save()} disabled={saving} isLoading={saving} loadingText="Saving...">
              Save
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
