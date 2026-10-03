import { SUBJECT } from "@/lib/terminology";
import { cn } from "@/lib/utils";

/**
 * WebChart, which is certified, calculates and submits the pilot group's reported measure rates.
 * WorkWell's rates come from CMS's FHIR versions of the same measures and are an estimate of those,
 * so every screen that shows a rate on the patient deployment says so beside it.
 *
 * Patient deployment only. On the occupational deployment the measures are WorkWell's own, there is no
 * other system calculating a reported rate, and "estimate" would be wrong.
 */
export const RATE_ESTIMATE_TEXT = "WorkWell's estimate from CMS's FHIR logic. WebChart calculates and submits the reported rate.";
/** For a rate whose engine is not known to be CMS's FHIR logic (an authored run, or one not yet read). */
export const RATE_ESTIMATE_TEXT_ANY_ENGINE = "WorkWell's estimate. WebChart calculates and submits the reported rate.";

export function showsRateEstimateNote(): boolean {
  return SUBJECT.singular === "patient";
}

/** `fhirLogic={false}` drops the engine claim where the rates shown may not come from CMS's FHIR logic. */
export function RateEstimateNote({ id, className, fhirLogic = true }: { id?: string; className?: string; fhirLogic?: boolean }) {
  if (!showsRateEstimateNote()) return null;
  return (
    <p id={id} data-testid="rate-estimate-note" className={cn("text-xs text-neutral-500 dark:text-neutral-400", className)}>
      {fhirLogic ? RATE_ESTIMATE_TEXT : RATE_ESTIMATE_TEXT_ANY_ENGINE}
    </p>
  );
}
