/**
 * SQLite/D1 floor implementation of the AppointmentStore contract (#108 appointments).
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type { AppointmentRecord, AppointmentStore, InsertAppointmentInput } from "../appointment-store.ts";

interface Row {
  id: string;
  case_id: string;
  employee_id: string;
  measure_id: string;
  appointment_type: string;
  scheduled_at: string;
  location: string;
  status: string;
  notes: string | null;
  created_by: string;
  created_at: string;
}

const toRecord = (r: Row): AppointmentRecord => ({
  id: r.id,
  caseId: r.case_id,
  employeeId: r.employee_id,
  measureId: r.measure_id,
  appointmentType: r.appointment_type,
  scheduledAt: r.scheduled_at,
  location: r.location,
  status: r.status,
  notes: r.notes,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

const SELECT =
  "SELECT id, case_id, employee_id, measure_id, appointment_type, scheduled_at, location, status, notes, created_by, created_at FROM scheduled_appointments";

export class SqliteAppointmentStore implements AppointmentStore {
  constructor(private readonly db: CloudDatabase) {}

  async insert(input: InsertAppointmentInput): Promise<AppointmentRecord> {
    const createdAt = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO scheduled_appointments
           (id, case_id, employee_id, measure_id, appointment_type, scheduled_at, location, status, notes, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.caseId,
        input.employeeId,
        input.measureId,
        input.appointmentType,
        input.scheduledAt,
        input.location,
        input.status,
        input.notes,
        input.createdBy,
        createdAt,
      )
      .run();
    return { ...input, createdAt };
  }

  async listByCase(caseId: string): Promise<AppointmentRecord[]> {
    const { results } = await this.db
      .prepare(`${SELECT} WHERE case_id = ? ORDER BY scheduled_at DESC, created_at DESC`)
      .bind(caseId)
      .all<Row>();
    return (results ?? []).map(toRecord);
  }
}
