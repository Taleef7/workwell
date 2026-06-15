/**
 * AppointmentStore contract (#108 appointments) — scheduled follow-up appointments on a case.
 * Mirrors the canonical scheduled_appointments table (DATA_MODEL / V005). employeeId/measureId are
 * the floor case's subject + measure slug. (The V005 outreach_records side is not modeled — TS
 * represents outreach as case_actions, not a separate table.)
 */
export interface AppointmentRecord {
  id: string;
  caseId: string;
  employeeId: string;
  measureId: string;
  appointmentType: string;
  scheduledAt: string;
  location: string;
  status: string;
  notes: string | null;
  createdBy: string;
  createdAt: string;
}

export interface InsertAppointmentInput {
  id: string;
  caseId: string;
  employeeId: string;
  measureId: string;
  appointmentType: string;
  scheduledAt: string;
  location: string;
  status: string;
  notes: string | null;
  createdBy: string;
}

export interface AppointmentStore {
  insert(input: InsertAppointmentInput): Promise<AppointmentRecord>;
  /** Appointments for one case, newest-first (scheduled_at DESC, created_at DESC). */
  listByCase(caseId: string): Promise<AppointmentRecord[]>;
}
