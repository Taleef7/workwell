import type { MeasureOutcomeSummary } from '../hooks/useEmployeeProfile';

const STATUS_COLORS: Record<string, string> = {
  COMPLIANT: 'bg-green-100 text-green-800 border border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-900',
  DUE_SOON: 'bg-yellow-100 text-yellow-800 border border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-900',
  OVERDUE: 'bg-red-100 text-red-800 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-900',
  MISSING_DATA: 'bg-neutral-100 text-neutral-700 border border-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:border-neutral-700',
  EXCLUDED: 'bg-neutral-50 text-neutral-500 border border-neutral-100 dark:bg-neutral-800/50 dark:text-neutral-400 dark:border-neutral-800',
};

export function ComplianceSummaryBar({ outcomes }: { outcomes: MeasureOutcomeSummary[] }) {
  return (
    <div className="flex flex-wrap gap-2 py-2">
      {outcomes.map((o) => (
        <a
          key={o.measureVersionId}
          href={`#measure-${o.measureVersionId}`}
          className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium transition-opacity hover:opacity-80 ${STATUS_COLORS[o.outcomeStatus] ?? 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400'}`}
        >
          {o.measureName} — {o.outcomeStatus.replace(/_/g, ' ')}
        </a>
      ))}
      {outcomes.length === 0 && (
        <span className="text-xs text-neutral-400">No outcome data</span>
      )}
    </div>
  );
}
