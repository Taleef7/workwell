'use client';

import { useState } from 'react';
import { Button, Select } from '@mieweb/ui';
import { useApi } from '@/lib/api/hooks';
import { ApiError } from '@/lib/api/errors';
import { emitToast } from '@/lib/toast';
import { SUBJECT } from '@/lib/terminology';
import type { OpenCaseSummary } from '@/features/employee/hooks/useEmployeeProfile';

const CHANNELS = [
  { value: 'EMAIL', label: 'Email' },
  { value: 'SMS', label: 'SMS' },
  { value: 'PHONE', label: 'Phone' },
];

interface PreviewMessage {
  caseIds: string[];
  subject: string;
  bodyText: string;
}

interface SendResult {
  messages: number;
  unrecorded: string[];
}

/**
 * Message one patient about the gaps ticked on their page (#868), with the message previewed first.
 *
 * Send stays disabled until the CURRENT choice of gaps and channel has been previewed: a change after the
 * preview clears it, so what staff read is what goes out. On a patient deployment the server sends ONE
 * message for every ticked gap; on the employee deployment one per gap, as campaigns do, and the preview
 * shows each.
 */
export function GapOutreach({
  cases,
  labelFor,
  onSent,
}: {
  /** The ticked gaps, in the table's order. */
  cases: OpenCaseSummary[];
  labelFor: (c: OpenCaseSummary) => string;
  /** Re-read the profile: after a send, and to reload a page a refusal found stale. */
  onSent: () => void;
}) {
  const api = useApi();
  const [channel, setChannel] = useState('EMAIL');
  const [preview, setPreview] = useState<{ key: string; messages: PreviewMessage[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ message: string; stale: boolean } | null>(null);
  const [unrecorded, setUnrecorded] = useState<string[]>([]);

  const caseIds = cases.map((c) => c.caseId);
  const key = `${channel}|${caseIds.join(',')}`;
  // Derived, not reset by an effect: a preview of another choice simply is not this choice's preview.
  const previewed = preview !== null && preview.key === key ? preview : null;
  const onePerPatient = SUBJECT.singular === 'patient';
  const n = cases.length;
  const sendLabel = onePerPatient
    ? `Send one message about ${n} ${n === 1 ? 'gap' : 'gaps'}`
    : `Send ${n} ${n === 1 ? 'message' : 'messages'}`;

  async function showPreview() {
    if (n === 0 || previewing || sending) return;
    setPreviewing(true);
    setError(null);
    try {
      const out = await api.post<object, { messages: PreviewMessage[] }>('/api/cases/patient-outreach', { caseIds, channel, dryRun: true });
      setPreview({ key, messages: out.messages });
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : 'Could not preview the message', stale: err instanceof ApiError && err.status === 409 });
    } finally {
      setPreviewing(false);
    }
  }

  async function send() {
    if (!previewed || sending) return;
    setSending(true);
    setError(null);
    setUnrecorded([]);
    try {
      const out = await api.post<object, SendResult>('/api/cases/patient-outreach', { caseIds, channel });
      setPreview(null);
      setUnrecorded(out.unrecorded ?? []);
      emitToast(out.messages === 1 ? 'Message sent' : `${out.messages} messages sent`, 'success');
      onSent();
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : 'Could not send the message', stale: err instanceof ApiError && err.status === 409 });
    } finally {
      setSending(false);
    }
  }

  const byId = new Map(cases.map((c) => [c.caseId, c]));
  const unrecordedLabels = unrecorded.map((id) => (byId.has(id) ? labelFor(byId.get(id)!) : id));

  return (
    <div className="mt-4 rounded-xl border border-neutral-200 dark:border-neutral-800 p-4" data-testid="gap-outreach">
      <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Message the {SUBJECT.singular}</p>
      <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
        {n === 0 ? 'Tick the gaps the message is about.' : onePerPatient ? `One message about the ${n} ticked ${n === 1 ? 'gap' : 'gaps'}.` : `One message for each ticked gap.`}
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="w-36">
          <Select label="Channel" size="sm" value={channel} onValueChange={setChannel} options={CHANNELS} />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void showPreview()}
          disabled={n === 0 || previewing || sending}
          isLoading={previewing}
          loadingText="Previewing..."
        >
          Preview message
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => void send()}
          disabled={!previewed || sending}
          title={!previewed ? 'Preview the message before sending' : undefined}
          isLoading={sending}
          loadingText="Sending..."
        >
          {sendLabel}
        </Button>
      </div>
      {previewed
        ? previewed.messages.map((m) => (
            <div
              key={m.caseIds.join(',')}
              data-testid="gap-outreach-preview"
              className="mt-3 rounded-lg bg-neutral-50 dark:bg-neutral-800/50 p-3 text-sm text-neutral-800 dark:text-neutral-200"
            >
              <p className="font-medium [overflow-wrap:anywhere]">Subject: {m.subject}</p>
              <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{m.bodyText}</p>
            </div>
          ))
        : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error.message}{' '}
          {error.stale ? (
            <button type="button" className="underline" onClick={() => { setError(null); onSent(); }}>
              Reload
            </button>
          ) : null}
        </p>
      ) : null}
      {unrecordedLabels.length > 0 ? (
        <p role="alert" data-testid="gap-outreach-unrecorded" className="mt-3 text-sm text-amber-700 dark:text-amber-400">
          The message went out, but {unrecordedLabels.length === 1 ? 'this gap holds' : 'these gaps hold'} no record of it:{' '}
          {unrecordedLabels.join(', ')}. Check {unrecordedLabels.length === 1 ? 'its' : 'their'} timeline before sending again.
        </p>
      ) : null}
    </div>
  );
}
