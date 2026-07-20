/**
 * db.ts — the shim's only MariaDB touch-point (mysql2/promise pool).
 *
 * The row-reading surface is the small `ShimDb` interface so the HTTP layer and its tests never
 * need a live database (tests stub `ShimDb`; only `createDb()` binds mysql2). Queries mirror
 * `backend-ts/scripts/webchart-devdb-export.ts` — the committed-fixture generator — because the
 * live parity suite (`hapi-live.test.ts`) asserts shim-served data evaluates bucket-identical to
 * those fixtures.
 */
import mysql from "mysql2/promise";

export interface PatientRow {
  pat_id: number;
  first_name: string | null;
  last_name: string | null;
  sex: string | null;
  birth_date: string | null; // YYYY-MM-DD or null
}

export interface ObservationRow {
  pat_id: number;
  loinc: string;
  name: string | null;
  value: number | null;
  dt: string | null; // YYYY-MM-DD or null
}

export interface ProcedureRow {
  pat_id: number;
  cpt: string;
  dt: string | null; // YYYY-MM-DD or null
}

export interface ShimDb {
  countPatients(): Promise<number>;
  listPatients(limit: number, offset: number): Promise<PatientRow[]>;
  observationsForPatient(patId: number): Promise<ObservationRow[]>;
  proceduresForPatient(patId: number): Promise<ProcedureRow[]>;
  end(): Promise<void>;
}

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    host: env.WCDB_HOST ?? "localhost",
    port: Number(env.WCDB_PORT ?? 33306),
    database: env.WCDB_DATABASE ?? "wc_miehr_wctroot",
    user: env.WCDB_USER ?? "root",
    password: env.WCDB_PASSWORD ?? "pmg2bhok", // dev-wcdb's published dev credential
  };
}

export function createDb(cfg: DbConfig = configFromEnv()): ShimDb {
  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    connectionLimit: 5,
    // Dates come back as strings so day-precision values survive untouched (no TZ shifting).
    dateStrings: true,
  });

  return {
    async countPatients() {
      const [rows] = await pool.query("SELECT COUNT(*) AS n FROM patients WHERE is_patient=1");
      return Number((rows as Array<{ n: unknown }>)[0]?.n ?? 0);
    },
    async listPatients(limit, offset) {
      const [rows] = await pool.query(
        "SELECT pat_id, first_name, last_name, sex, DATE_FORMAT(birth_date,'%Y-%m-%d') AS birth_date " +
          "FROM patients WHERE is_patient=1 ORDER BY pat_id LIMIT ? OFFSET ?",
        [limit, offset],
      );
      return rows as PatientRow[];
    },
    async observationsForPatient(patId) {
      const [rows] = await pool.query(
        "SELECT o.pat_id AS pat_id, oc.loinc_num AS loinc, oc.obs_name AS name, o.obs_result_dec AS value, " +
          "DATE_FORMAT(COALESCE(o.obs_result_dt,o.obs_ts),'%Y-%m-%d') AS dt " +
          "FROM observations_current o JOIN observation_codes oc ON oc.obs_code=o.obs_code " +
          "WHERE oc.loinc_num IS NOT NULL AND oc.loinc_num<>'' AND o.pat_id=? ORDER BY o.id",
        [patId],
      );
      return rows as ObservationRow[];
    },
    async proceduresForPatient(patId) {
      const [rows] = await pool.query(
        "SELECT pat_id, cpt_code AS cpt, DATE_FORMAT(service_date,'%Y-%m-%d') AS dt " +
          "FROM patient_procedures WHERE cpt_code IS NOT NULL AND cpt_code<>'' AND pat_id=? ORDER BY prochist_id",
        [patId],
      );
      return rows as ProcedureRow[];
    },
    async end() {
      await pool.end();
    },
  };
}
