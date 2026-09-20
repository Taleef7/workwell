/**
 * "Recorded here — not sent to the chart."
 *
 * Raised in the 2026-09-03 sandbox critique as §8E ("say what is not wired") and again in the
 * 2026-09-07 expert review, which recorded that it had never been implemented. Every control this
 * sits under writes a WorkWell row and nothing else: outreach is a simulated send, an appointment is
 * a WorkWell-only record, an evidence upload is an attachment on a case, and an order proposal is a
 * bundle to copy. The screens gave no sign of that, so a quality lead who schedules an appointment or
 * uploads a mammogram result reasonably believes the clinic can now see it. They cannot.
 *
 * **Unconditional, not gated on the pilot profile.** The original ask scoped this to the pilot, but
 * no deployment has a WebChart write path at all — that is the whole of #565 — so gating it would
 * leave every other deployment implying something untrue for the sake of a narrower change.
 *
 * **Deliberately not an error or a warning.** Nothing is broken; the capability does not exist yet.
 * It renders as muted helper text in the same register as a field hint, because a red banner over a
 * working control teaches people to ignore red banners.
 *
 * The one place this does NOT belong is anywhere a compliance number is shown — a gap closes when
 * the result data arrives and CQL re-evaluates (LOCKED §4A.3), and that is a different statement
 * from "this action did not leave the building".
 */
export function LocalOnlyNotice({
  /** What the operator just did, in their words: "This appointment", "Uploaded evidence". */
  action,
  /**
   * A second sentence for the one surface where "it did not leave the building" is not the whole
   * answer. The practice asked directly whether uploading a result with the right document type
   * closes the gap; it does not, and that is a different fact from the write-back one. Saying only
   * the first would leave the more consequential belief intact.
   */
  also,
  className = "",
}: {
  action: string;
  also?: string;
  className?: string;
}) {
  return (
    <p className={`text-xs text-neutral-500 dark:text-neutral-400 ${className}`.trim()}>
      {action} is recorded in WorkWell only — it is not sent to WebChart, so it will not appear in the
      patient&apos;s chart.
      {also ? ` ${also}` : ""}
    </p>
  );
}
