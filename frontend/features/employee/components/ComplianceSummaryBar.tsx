import type { MeasureOutcomeSummary } from '../hooks/useEmployeeProfile';

const STATUS_COLORS: Record<string, string> = {
  COMPLIANT: 'bg-green-100 text-green-800 border border-green-200',
  DUE_SOON: 'bg-yellow-100 text-yellow-800 border border-yellow-200',
  OVERDUE: 'bg-red-100 text-red-800 border border-red-200',
  MISSING_DATA: 'bg-slate-100 text-slate-700 border border-slate-200',
  EXCLUDED: 'bg-slate-50 text-slate-500 border border-slate-100',
};

export function ComplianceSummaryBar({ outcomes }: { outcomes: MeasureOutcomeSummary[] }) {
  return (
    <div className="flex flex-wrap gap-2 py-2">
      {outcomes.map((o) => (
        <a
          key={o.measureVersionId}
          href={`#measure-${o.measureVersionId}`}
          className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium transition-opacity hover:opacity-80 ${STATUS_COLORS[o.outcomeStatus] ?? 'bg-slate-100 text-slate-600'}`}
        >
          {o.measureName} — {o.outcomeStatus.replace(/_/g, ' ')}
        </a>
      ))}
      {outcomes.length === 0 && (
        <span className="text-xs text-slate-400">No outcome data</span>
      )}
    </div>
  );
}
