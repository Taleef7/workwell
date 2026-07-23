'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useEmployeeProfile } from '@/features/employee/hooks/useEmployeeProfile';
import { ComplianceSummaryBar } from '@/features/employee/components/ComplianceSummaryBar';
import { IndividualComplianceStatus } from '@/features/employee/components/IndividualComplianceStatus';
import { SimulateComplianceHistory } from '@/features/employee/components/SimulateComplianceHistory';
import { SkeletonCard } from '@/components/skeleton-loader';
import { SlaChip } from '@/components/SlaChip';
import { OUTCOME_LABELS, labelFor, outcomeStatusClass } from '@/lib/status';

const PRIORITY_COLORS: Record<string, string> = {
  CRITICAL: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  HIGH: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  MEDIUM: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  LOW: 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300',
};

export default function EmployeeProfilePage() {
  const { externalId: rawExternalId } = useParams<{ externalId: string }>();
  // useParams returns the segment still percent-encoded; live WebChart ids contain "|" (wc%7Cwc-6),
  // so decode once here and let each fetch re-encode for transport.
  const externalId = decodeURIComponent(rawExternalId ?? '');
  const { profile, loading, error, refetch } = useEmployeeProfile(externalId);

  if (loading) {
    return (
      <div className="p-6 space-y-4 max-w-5xl mx-auto">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="p-8 text-sm text-red-500 dark:text-red-400">
        {error ?? 'Employee not found.'}
      </div>
    );
  }

  const startDate = profile.startDate
    ? new Date(profile.startDate).toLocaleDateString()
    : null;
  // SLA fields are null on the synthetic directory — only show the column if any case has a value.
  const hasSla = profile.openCases.some((c) => c.slaRemainingDays != null);

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">{profile.name}</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            {profile.role}
            {profile.site ? ` · ${profile.site}` : ''}
            {profile.supervisorName ? ` · Supervisor: ${profile.supervisorName}` : ''}
          </p>
          <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
            ID: {profile.externalId}
            {profile.fhirPatientId ? ` · FHIR: ${profile.fhirPatientId}` : ''}
            {startDate ? ` · Started: ${startDate}` : ''}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${profile.active ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400'}`}>
          {profile.active ? 'Active' : 'Inactive'}
        </span>
      </div>

      {/* Compliance summary bar */}
      <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400 pb-2">
          Compliance Posture
        </p>
        <ComplianceSummaryBar outcomes={profile.measureOutcomes} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
      <IndividualComplianceStatus externalId={externalId} onRecalculated={refetch} />
      <SimulateComplianceHistory externalId={externalId} />
      {/* Open cases */}
      {profile.openCases.length > 0 && (
        <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-sm">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100 mb-4">Open Cases</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-neutral-500 dark:text-neutral-400 border-b border-neutral-200 dark:border-neutral-800">
                <th scope="col" className="pb-2 font-medium">Measure</th>
                <th scope="col" className="pb-2 font-medium">Status</th>
                <th scope="col" className="pb-2 font-medium">Priority</th>
                <th scope="col" className="pb-2 font-medium">Assignee</th>
                {hasSla ? <th scope="col" className="pb-2 font-medium">SLA</th> : null}
              </tr>
            </thead>
            <tbody>
              {profile.openCases.map((c) => (
                <tr key={c.caseId} className="border-b border-neutral-200 dark:border-neutral-800 last:border-0 hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
                  <td className="py-2">
                    <Link
                      href={`/cases/${c.caseId}`}
                      className="text-primary-600 dark:text-primary-400 hover:underline font-medium"
                    >
                      {c.measureName}
                    </Link>
                  </td>
                  <td className="py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${outcomeStatusClass(c.outcomeStatus)}`}>
                      {labelFor(OUTCOME_LABELS, c.outcomeStatus)}
                    </span>
                  </td>
                  <td className="py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PRIORITY_COLORS[c.priority] ?? ''}`}>
                      {c.priority}
                    </span>
                  </td>
                  <td className="py-2 text-neutral-500 dark:text-neutral-400">{c.assignee ?? '—'}</td>
                  {hasSla ? (
                    <td className="py-2">
                      <SlaChip slaRemainingDays={c.slaRemainingDays} slaBreached={c.slaBreached} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Measure details */}
      <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-sm">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100 mb-4">Measure Details</h2>
        {profile.measureOutcomes.length === 0 && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">No evaluation data yet.</p>
        )}
        <div className="space-y-3">
          {profile.measureOutcomes.map((o) => (
            <div
              key={o.measureVersionId}
              id={`measure-${o.measureVersionId}`}
              className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">
                  {o.measureName}{' '}
                  <span className="text-xs font-normal text-neutral-600 dark:text-neutral-400">{o.measureVersion}</span>
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${outcomeStatusClass(o.outcomeStatus)}`}>
                  {labelFor(OUTCOME_LABELS, o.outcomeStatus)}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">
                {o.lastRunDate && (
                  <span>Last evaluated: {new Date(o.lastRunDate).toLocaleDateString()}</span>
                )}
                {o.daysSinceLastExam != null && (
                  <span>Days since exam: {o.daysSinceLastExam}</span>
                )}
                {o.daysUntilDue != null && (
                  <span className={o.daysUntilDue >= 0 ? 'font-medium text-amber-700 dark:text-amber-400' : 'font-semibold text-rose-700 dark:text-rose-400'}>
                    {o.daysUntilDue >= 0
                      ? `Due in ${o.daysUntilDue}d`
                      : `Overdue by ${Math.abs(o.daysUntilDue)}d`}
                  </span>
                )}
                {o.openCaseId && (
                  <Link
                    href={`/cases/${o.openCaseId}`}
                    className="text-primary-600 dark:text-primary-400 hover:underline"
                  >
                    View open case →
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      </div>

      <aside className="space-y-6 lg:sticky lg:top-6 lg:self-start">
      {/* Recent activity timeline */}
      <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-sm">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100 mb-4">Recent Activity</h2>
        {profile.recentAuditEvents.length === 0 && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">No activity yet.</p>
        )}
        <div className="space-y-3">
          {profile.recentAuditEvents.map((ev, i) => (
            <div key={`${ev.occurredAt}-${ev.eventType}-${ev.actor}-${i}`} className="flex gap-3 text-sm">
              <span className="w-36 shrink-0 text-xs text-neutral-600 dark:text-neutral-400">
                {new Date(ev.occurredAt).toLocaleString()}
              </span>
              <span className="text-neutral-600 dark:text-neutral-400">{ev.summary}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Back link */}
      <div>
        <Link
          href="/cases"
          className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-xs font-semibold text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
        >
          ← Back to Cases
        </Link>
      </div>
      </aside>
      </div>
    </div>
  );
}
