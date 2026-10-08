import type { MeasureOutcomeSummary } from '../hooks/useEmployeeProfile';
import type { ScoringLogic } from '@/lib/measure-identity';
import { COMPLIANCE_STATUS_LABELS, complianceStatusClass, labelFor as statusLabelFor } from '@/lib/status';

/**
 * The status to SHOW: the server's display status, the same one the roster table on this page uses, so
 * a patient outside a measure's population reads "Not in population" here too, not "Missing Data"
 * (#671). The stored bucket is the fallback for a server that predates the field.
 */
export const shownStatusOf = (o: Pick<MeasureOutcomeSummary, 'displayStatus' | 'outcomeStatus'>): string =>
  o.displayStatus ?? o.outcomeStatus;

type MeasureLabel = (measureId: string, fallbackName: string, logic?: ScoringLogic | null) => string;

/**
 * One chip per measure. `labelFor` names the measure in the chip (the page passes the chip form of the
 * logic that scored the row, #769); `titleFor`, when given, is the chip's tooltip (the full form).
 */
export function ComplianceSummaryBar({
  outcomes,
  labelFor = (_measureId, fallbackName) => fallbackName,
  titleFor,
}: {
  outcomes: MeasureOutcomeSummary[];
  labelFor?: MeasureLabel;
  titleFor?: MeasureLabel;
}) {
  return (
    <div className="flex flex-wrap gap-2 py-2">
      {outcomes.map((o) => {
        const status = statusLabelFor(COMPLIANCE_STATUS_LABELS, shownStatusOf(o));
        return (
          <a
            key={o.measureVersionId}
            href={`#measure-${o.measureVersionId}`}
            title={titleFor ? `${titleFor(o.measureId, o.measureName, o.logic)} — ${status}` : undefined}
            className={`inline-flex max-w-full items-center rounded-full px-3 py-1 text-xs font-medium transition-opacity hover:opacity-80 ${complianceStatusClass(shownStatusOf(o))}`}
          >
            {labelFor(o.measureId, o.measureName, o.logic)} — {status}
          </a>
        );
      })}
      {outcomes.length === 0 && (
        <span className="text-xs text-neutral-600 dark:text-neutral-400">No outcome data</span>
      )}
    </div>
  );
}
