import { useCallback, useEffect, useState } from 'react';
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
  slaBreached: boolean;
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

  const refetch = useCallback(async () => {
    if (!externalId) return;
    setLoading(true);
    setError(null);
    try {
      setProfile(await api.get<EmployeeProfile>(`/api/employees/${externalId}/profile`));
    } catch (e) {
      setError((e as Error).message ?? "Failed to load profile");
    } finally {
      setLoading(false);
    }
  }, [api, externalId]);

  useEffect(() => {
    // Defer out of the synchronous effect body (matches the compliance page) so refetch's setLoading
    // doesn't trip react-hooks/set-state-in-effect. refetch() is still called directly by Recalculate.
    const t = setTimeout(() => void refetch(), 0);
    return () => clearTimeout(t);
  }, [refetch]);

  return { profile, loading, error, refetch };
}
