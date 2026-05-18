'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useEmployeeProfile } from '@/features/employee/hooks/useEmployeeProfile';
import { ComplianceSummaryBar } from '@/features/employee/components/ComplianceSummaryBar';
import { SkeletonCard } from '@/components/skeleton-loader';
import { SlaChip } from '@/components/SlaChip';

const PRIORITY_COLORS: Record<string, string> = {
  CRITICAL: 'bg-red-100 text-red-800',
  HIGH: 'bg-orange-100 text-orange-800',
  MEDIUM: 'bg-yellow-100 text-yellow-800',
  LOW: 'bg-slate-100 text-slate-700',
};

export default function EmployeeProfilePage() {
  const { externalId } = useParams<{ externalId: string }>();
  const { profile, loading, error } = useEmployeeProfile(externalId);

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
      <div className="p-8 text-sm text-red-500">
        {error ?? 'Employee not found.'}
      </div>
    );
  }

  const startDate = profile.startDate
    ? new Date(profile.startDate).toLocaleDateString()
    : null;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{profile.name}</h1>
          <p className="text-sm text-slate-500 mt-1">
            {profile.role}
            {profile.site ? ` · ${profile.site}` : ''}
            {profile.supervisorName ? ` · Supervisor: ${profile.supervisorName}` : ''}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            ID: {profile.externalId}
            {profile.fhirPatientId ? ` · FHIR: ${profile.fhirPatientId}` : ''}
            {startDate ? ` · Started: ${startDate}` : ''}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${profile.active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>
          {profile.active ? 'Active' : 'Inactive'}
        </span>
      </div>

      {/* Compliance summary bar */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 pb-2">
          Compliance Posture
        </p>
        <ComplianceSummaryBar outcomes={profile.measureOutcomes} />
      </div>

      {/* Open cases */}
      {profile.openCases.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900 mb-4">Open Cases</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b">
                <th className="pb-2 font-medium">Measure</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Priority</th>
                <th className="pb-2 font-medium">Assignee</th>
                <th className="pb-2 font-medium">SLA</th>
              </tr>
            </thead>
            <tbody>
              {profile.openCases.map((c) => (
                <tr key={c.caseId} className="border-b last:border-0 hover:bg-slate-50">
                  <td className="py-2">
                    <Link
                      href={`/cases/${c.caseId}`}
                      className="text-blue-600 hover:underline font-medium"
                    >
                      {c.measureName}
                    </Link>
                  </td>
                  <td className="py-2 text-slate-600">
                    {c.outcomeStatus.replace(/_/g, ' ')}
                  </td>
                  <td className="py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PRIORITY_COLORS[c.priority] ?? ''}`}>
                      {c.priority}
                    </span>
                  </td>
                  <td className="py-2 text-slate-500">{c.assignee ?? '—'}</td>
                  <td className="py-2">
                    <SlaChip slaRemainingDays={c.slaRemainingDays} slaBreached={c.slaBreached} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Measure details */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900 mb-4">Measure Details</h2>
        {profile.measureOutcomes.length === 0 && (
          <p className="text-sm text-slate-400">No evaluation data yet.</p>
        )}
        <div className="space-y-3">
          {profile.measureOutcomes.map((o) => (
            <div
              key={o.measureVersionId}
              id={`measure-${o.measureVersionId}`}
              className="rounded-lg border border-slate-200 p-4"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-slate-900">
                  {o.measureName}{' '}
                  <span className="text-xs font-normal text-slate-400">v{o.measureVersion}</span>
                </span>
                <span className="rounded-full border border-slate-300 px-2 py-0.5 text-xs font-medium text-slate-700">
                  {o.outcomeStatus.replace(/_/g, ' ')}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-4 text-xs text-slate-500">
                {o.lastRunDate && (
                  <span>Last evaluated: {new Date(o.lastRunDate).toLocaleDateString()}</span>
                )}
                {o.daysSinceLastExam != null && (
                  <span>Days since exam: {o.daysSinceLastExam}</span>
                )}
                {o.daysUntilDue != null && (
                  <span>
                    {o.daysUntilDue >= 0
                      ? `Due in ${o.daysUntilDue}d`
                      : `Overdue by ${Math.abs(o.daysUntilDue)}d`}
                  </span>
                )}
                {o.openCaseId && (
                  <Link
                    href={`/cases/${o.openCaseId}`}
                    className="text-blue-600 hover:underline"
                  >
                    View open case →
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent activity timeline */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900 mb-4">Recent Activity</h2>
        {profile.recentAuditEvents.length === 0 && (
          <p className="text-sm text-slate-400">No activity yet.</p>
        )}
        <div className="space-y-3">
          {profile.recentAuditEvents.map((ev, i) => (
            <div key={i} className="flex gap-3 text-sm">
              <span className="w-36 shrink-0 text-xs text-slate-400">
                {new Date(ev.occurredAt).toLocaleString()}
              </span>
              <span className="text-slate-600">{ev.summary}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Back link */}
      <div>
        <Link
          href="/cases"
          className="rounded border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          ← Back to Cases
        </Link>
      </div>
    </div>
  );
}
