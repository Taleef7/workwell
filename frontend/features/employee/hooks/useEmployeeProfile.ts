import { useEffect, useState } from 'react';
import { useApi } from '@/lib/api/hooks';

export interface MeasureOutcomeSummary {
  measureVersionId: string;
  measureName: string;
  measureVersion: string;
  outcomeStatus: string;
  lastRunDate: string | null;
  daysSinceLastExam: number | null;
  daysUntilDue: number | null;
  openCaseId: string | null;
}

export interface OpenCaseSummary {
  caseId: string;
  measureName: string;
  outcomeStatus: string;
  priority: string;
  assignee: string | null;
  slaDueDate: string | null;
  slaRemainingDays: number | null;
}

export interface EmployeeProfile {
  id: string;
  externalId: string;
  name: string;
  role: string;
  site: string;
  supervisorName: string | null;
  startDate: string | null;
  fhirPatientId: string | null;
  active: boolean;
  measureOutcomes: MeasureOutcomeSummary[];
  openCases: OpenCaseSummary[];
  recentAuditEvents: Array<{
    eventType: string;
    occurredAt: string;
    actor: string;
    measureName: string | null;
    summary: string;
  }>;
}

export function useEmployeeProfile(externalId: string) {
  const api = useApi();
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!externalId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    api.get<EmployeeProfile>(`/api/employees/${externalId}/profile`)
      .then(setProfile)
      .catch((e: Error) => setError(e.message ?? 'Failed to load profile'))
      .finally(() => setLoading(false));
  }, [externalId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { profile, loading, error };
}
