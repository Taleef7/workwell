"use client";

import { useState } from "react";
import { Button, Checkbox, Modal, ModalBody, ModalFooter, ModalHeader, ModalTitle, Select, Textarea } from "@mieweb/ui";
import { useApi } from "@/lib/api/hooks";
import { emitToast } from "@/lib/toast";
import { SUBJECT } from "@/lib/terminology";
import { LocalOnlyNotice } from "@/features/common/LocalOnlyNotice";
import type { ContactPreference } from "@/features/employee/hooks/useEmployeeProfile";

export const LOG_CHANNEL_OPTIONS = [
  { value: "PHONE", label: "Phone call" },
  { value: "SMS", label: "Text" },
  { value: "EMAIL", label: "Email" },
  { value: "IN_PERSON", label: "In person" },
  { value: "LETTER", label: "Letter" },
];
export const LOG_RESULT_OPTIONS = [
  { value: "REACHED", label: "Reached" },
  { value: "NO_ANSWER", label: "No answer" },
  { value: "LEFT_MESSAGE", label: "Left a message" },
  { value: "WRONG_NUMBER", label: "Wrong number" },
  { value: "DECLINED", label: "Declined" },
];
const NOTE_MAX = 500;

interface LogContactResult {
  logged: Array<{ caseId: string; status: string }>;
  failed: string[];
}

/**
 * Log a contact staff made themselves (#886): a call, a text, a letter, a word at the desk. Nothing is
 * sent. The case moves from Open to In progress; the gap still closes only when the result arrives and CQL
 * re-evaluates. By default the contact is also recorded on the person's other open gaps, because one call
 * is about all of them.
 */
export function LogContactModal({
  open,
  onClose,
  caseId,
  otherCaseIds,
  preference,
  onLogged,
}: {
  open: boolean;
  onClose: () => void;
  caseId: string;
  /** The person's other OPEN gaps (null while they load, or when they could not be read). */
  otherCaseIds: string[] | null;
  preference: ContactPreference | null | undefined;
  onLogged: () => void;
}) {
  const api = useApi();
  const [channel, setChannel] = useState("PHONE");
  const [result, setResult] = useState("NO_ANSWER");
  const [note, setNote] = useState("");
  const [includeOthers, setIncludeOthers] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const others = otherCaseIds ?? [];
  const declined = (preference?.declinedChannels ?? []) as string[];
  const onDeclined = declined.includes(channel);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    const caseIds = includeOthers ? [caseId, ...others] : [caseId];
    try {
      const out = await api.post<object, LogContactResult>("/api/cases/contact-log", {
        caseIds,
        channel,
        result,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (out.failed.length > 0) {
        setError(`The contact was recorded on ${out.logged.length} of ${caseIds.length} gaps; the rest could not be recorded. Reload and try those again.`);
      } else {
        emitToast(out.logged.length === 1 ? "Contact logged" : `Contact logged on ${out.logged.length} gaps`, "success");
        setNote("");
        onClose();
      }
      onLogged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not log the contact");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={(o) => { if (!o) onClose(); }} size="md">
      <ModalHeader>
        <ModalTitle>Log contact</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <div className="space-y-3" data-testid="log-contact">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Record a contact you made yourself. Nothing is sent to the {SUBJECT.singular}.
          </p>
          <Select label="How" value={channel} onValueChange={setChannel} options={LOG_CHANNEL_OPTIONS} />
          {onDeclined ? (
            <p className="text-xs font-medium text-amber-700 dark:text-amber-300" role="note">
              This {SUBJECT.singular} asked not to be contacted this way. Log it if they reached you.
            </p>
          ) : null}
          <Select label="Result" value={result} onValueChange={setResult} options={LOG_RESULT_OPTIONS} />
          <Textarea
            label="Note (optional)"
            className="min-h-20"
            maxLength={NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="No clinical details: the case timeline is widely readable."
          />
          {others.length > 0 ? (
            <Checkbox
              label={`Also record on this ${SUBJECT.singular}'s ${others.length} other open ${others.length === 1 ? "gap" : "gaps"}`}
              checked={includeOthers}
              onChange={(e) => setIncludeOthers(e.target.checked)}
            />
          ) : null}
          <LocalOnlyNotice action="This contact" />
          {error ? <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">{error}</p> : null}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" variant="primary" size="sm" onClick={() => void save()} disabled={saving} isLoading={saving} loadingText="Saving...">
          Save contact
        </Button>
      </ModalFooter>
    </Modal>
  );
}
