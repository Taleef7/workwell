/**
 * Postgres-ceiling implementation of the AppointmentStore contract (#108 appointments).
 * Schema-qualified to the isolated `workwell_spike` schema (never the canonical `public` tables).
 */
import type { PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import type { AppointmentRecord, AppointmentStore, InsertAppointmentInput } from "../appointment-store.ts";

interface Row {
  id: string;
  case_id: string;
  employee_id: string;
  measure_id: string;
  appointment_type: string;
  scheduled_at: Date | string;
  location: string;
  status: string;
  notes: string | null;
  created_by: string;
  created_at: Date | string;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : v);

const toRecord = (r: Row): AppointmentRecord => ({
  id: r.id,
  caseId: r.case_id,
  employeeId: r.employee_id,
  measureId: r.measure_id,
  appointmentType: r.appointment_type,
  scheduledAt: iso(r.scheduled_at),
  location: r.location,
  status: r.status,
  notes: r.notes,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
});

const SELECT = (schema: string) =>
  `SELECT id, case_id, employee_id, measure_id, appointment_type, scheduled_at, location, status, notes, created_by, created_at FROM ${schema}.scheduled_appointments`;

export class PgAppointmentStore implements AppointmentStore {
  constructor(private readonly pool: PgPool) {}

  async insert(input: InsertAppointmentInput): Promise<AppointmentRecord> {
    const createdAt = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO ${SPIKE_SCHEMA}.scheduled_appointments
         (id, case_id, employee_id, measure_id, appointment_type, scheduled_at, location, status, notes, created_by, created_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
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
      ],
    );
    return { ...input, createdAt };
  }

  async listByCase(caseId: string): Promise<AppointmentRecord[]> {
    const { rows } = await this.pool.query<Row>(
      `${SELECT(SPIKE_SCHEMA)} WHERE case_id = $1 ORDER BY scheduled_at DESC, created_at DESC`,
      [caseId],
    );
    return rows.map(toRecord);
  }
}
