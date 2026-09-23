import type { MeasureOutcomeSummary } from '../hooks/useEmployeeProfile';
import { COMPLIANCE_STATUS_LABELS, complianceStatusClass, labelFor as statusLabelFor } from '@/lib/status';

/**
 * The status to SHOW: the server's display status, the same one the roster table on this page uses, so
 * a patient outside a measure's population reads "Not in population" here too, not "Missing Data"
 * (#671). The stored bucket is the fallback for a server that predates the field.
 */
export const shownStatusOf = (o: Pick<MeasureOutcomeSummary, 'displayStatus' | 'outcomeStatus'>): string =>
  o.displayStatus ?? o.outcomeStatus;

export function ComplianceSummaryBar({
  outcomes,
  labelFor = (_measureId, fallbackName) => fallbackName,
}: {
  outcomes: MeasureOutcomeSummary[];
  labelFor?: (measureId: string, fallbackName: string) => string;
}) {
  return (
    <div className="flex flex-wrap gap-2 py-2">
      {outcomes.map((o) => (
        <a
          key={o.measureVersionId}
          href={`#measure-${o.measureVersionId}`}
          className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium transition-opacity hover:opacity-80 ${complianceStatusClass(shownStatusOf(o))}`}
        >
          {labelFor(o.measureId, o.measureName)} — {statusLabelFor(COMPLIANCE_STATUS_LABELS, shownStatusOf(o))}
        </a>
      ))}
      {outcomes.length === 0 && (
        <span className="text-xs text-neutral-600 dark:text-neutral-400">No outcome data</span>
      )}
    </div>
  );
}
