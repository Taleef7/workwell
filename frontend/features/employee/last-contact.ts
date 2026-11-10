import type { OpenCaseSummary } from "./hooks/useEmployeeProfile";

const CONTACT_VERBS: Record<string, string> = {
  EMAIL: "Emailed",
  SMS: "Texted",
  PHONE: "Called",
  IN_PERSON: "Spoke in person",
  LETTER: "Sent a letter",
};
/** What came of a contact staff logged themselves (#886). */
const RESULT_LABELS: Record<string, string> = {
  REACHED: "reached",
  NO_ANSWER: "no answer",
  LEFT_MESSAGE: "left a message",
  WRONG_NUMBER: "wrong number",
  DECLINED: "declined",
};
const DELIVERY_LABELS: Record<string, string> = { SIMULATED: "simulated", SENT: "sent", QUEUED: "queued", FAILED: "delivery failed" };

/**
 * When the gap was last contacted, how and by whom (#868), so staff do not message a patient twice
 * without knowing it. A contact staff logged themselves (#886) says what came of it. Null for a server from before the fields: absent is not "never contacted".
 *
 * Shared by the patient page's Open Cases and the case page's other open gaps (#880), so both say the
 * same thing about one gap.
 */
export function lastContactLine(
  c: Pick<OpenCaseSummary, "lastOutreachAt" | "lastOutreachBy" | "lastOutreachChannel" | "lastOutreachDeliveryStatus" | "lastContactResult">,
): string | null {
  if (c.lastOutreachAt === undefined) return null;
  if (c.lastOutreachAt === null) return "Not contacted yet";
  const at = new Date(c.lastOutreachAt);
  if (Number.isNaN(at.getTime())) return null;
  const day = at.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const verb = CONTACT_VERBS[c.lastOutreachChannel ?? ""] ?? "Contacted";
  const by = c.lastOutreachBy ? ` by ${c.lastOutreachBy}` : "";
  const status = c.lastOutreachDeliveryStatus;
  const delivery = status ? ` · ${DELIVERY_LABELS[status] ?? status.toLowerCase()}` : "";
  const result = c.lastContactResult ? RESULT_LABELS[c.lastContactResult] : undefined;
  return `${verb} ${day}${by}${delivery}${result ? ` — ${result}` : ""}`;
}
