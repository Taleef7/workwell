/**
 * ingest.ts — YAML patient data → the WebChart dev database (Doug, 2026-07-20: "ask ai to
 * generate patient data in yaml … ingest … we can put into webchart").
 *
 * The WRITE half of the demo loop: an AI (or a human) authors patients in a small YAML schema
 * (see `patients.example.yaml`), and this module inserts them into the dev-wcdb — after which the
 * ENTIRE existing read pipeline picks them up live with zero further work: the shim serves them as
 * FHIR, the roster enrolls them, CQL evaluates them, the generated SQL bands them (parity gate and
 * all), and the dashboards render them.
 *
 * Safety posture:
 *  - DEV DATABASE ONLY (synthetic data; never a live WebChart; never the demo stack).
 *  - Every write is validated up front against WebChart's own `model` schema catalog
 *    (model-metadata.ts — Doug's portability point made operational).
 *  - LOINC codes must already exist in `observation_codes` — fail-closed, we never invent codes.
 *  - Idempotent by natural key (first+last+birthDate): re-running a file skips existing patients.
 *  - Fully reversible: `rollback` deletes exactly the file's patients (+ their observations).
 *
 * YAML schema:
 *   patients:
 *     - firstName: Ayesha
 *       lastName: Rahman
 *       sex: F                # F | M | (omit for unknown)
 *       birthDate: 1985-03-12
 *       observations:
 *         - loinc: "8480-6"   # must exist in observation_codes
 *           value: 128
 *           date: 2026-06-30
 */
import { parse as parseYaml } from "yaml";
import { loadModelFields, validateAgainstModel, type ModelReader } from "./model-metadata.ts";
import { isRealCalendarDate } from "./compliance.ts";

export interface IngestObservation {
  loinc: string;
  value: number;
  date: string; // YYYY-MM-DD
}

export interface IngestPatient {
  firstName: string;
  lastName: string;
  sex?: "F" | "M";
  birthDate: string; // YYYY-MM-DD
  observations: IngestObservation[];
}

export interface IngestDoc {
  patients: IngestPatient[];
}

/** The exact (object, field) surface ingest writes/reads — validated against the model catalog. */
export const MODEL_TOUCHES: Record<string, string[]> = {
  patients: ["pat_id", "first_name", "last_name", "sex", "birth_date", "is_patient"],
  observations_current: ["pat_id", "obs_code", "obs_result_dec", "obs_result_dt"],
  observation_codes: ["obs_code", "loinc_num"],
};

const LOINC_SHAPE = /^[0-9]{1,7}-[0-9]$/;

function fail(path: string, msg: string): never {
  throw new Error(`ingest YAML invalid at ${path}: ${msg}`);
}

/** Parse + structurally validate a YAML document (pure — no DB, fully unit-testable). */
export function parseIngestYaml(text: string): IngestDoc {
  const raw = parseYaml(text) as unknown;
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { patients?: unknown }).patients)) {
    fail("$", "top level must be { patients: [...] }");
  }
  const patients = (raw as { patients: unknown[] }).patients.map((p, i) => {
    const at = `patients[${i}]`;
    if (!p || typeof p !== "object") fail(at, "must be a mapping");
    const o = p as Record<string, unknown>;
    const firstName = typeof o.firstName === "string" ? o.firstName.trim() : "";
    const lastName = typeof o.lastName === "string" ? o.lastName.trim() : "";
    if (!firstName || !lastName) fail(at, "firstName and lastName are required");
    const birthDate = typeof o.birthDate === "string" ? o.birthDate : String(o.birthDate ?? "");
    if (!isRealCalendarDate(birthDate)) fail(`${at}.birthDate`, `must be a real YYYY-MM-DD date (got '${birthDate}')`);
    const sex = o.sex === undefined ? undefined : String(o.sex).toUpperCase();
    if (sex !== undefined && sex !== "F" && sex !== "M") fail(`${at}.sex`, `must be F or M (got '${o.sex}')`);
    const obsRaw = Array.isArray(o.observations) ? o.observations : [];
    const observations = obsRaw.map((ob, j) => {
      const oat = `${at}.observations[${j}]`;
      if (!ob || typeof ob !== "object") fail(oat, "must be a mapping");
      const q = ob as Record<string, unknown>;
      const loinc = String(q.loinc ?? "");
      if (!LOINC_SHAPE.test(loinc)) fail(`${oat}.loinc`, `not a plausible LOINC code (got '${q.loinc}')`);
      const value = Number(q.value);
      if (!Number.isFinite(value)) fail(`${oat}.value`, `must be numeric (got '${q.value}')`);
      const date = typeof q.date === "string" ? q.date : String(q.date ?? "");
      if (!isRealCalendarDate(date)) fail(`${oat}.date`, `must be a real YYYY-MM-DD date (got '${date}')`);
      return { loinc, value, date };
    });
    return { firstName, lastName, sex: sex as "F" | "M" | undefined, birthDate, observations };
  });
  if (patients.length === 0) fail("$.patients", "at least one patient is required");
  return { patients };
}

export interface IngestDb extends ModelReader {
  execute(sql: string, params: unknown[]): Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface IngestReport {
  modelValidation: string;
  inserted: Array<{ subjectId: string; name: string; observations: number }>;
  skippedExisting: string[];
  dryRun: boolean;
}

async function findPatientId(db: IngestDb, p: IngestPatient): Promise<number | undefined> {
  const rows = await db.queryRows(
    "SELECT pat_id FROM patients WHERE first_name=? AND last_name=? AND DATE(birth_date)=? LIMIT 1",
    [p.firstName, p.lastName, p.birthDate],
  );
  return rows.length ? Number(rows[0]!.pat_id) : undefined;
}

async function obsCodeForLoinc(db: IngestDb, loinc: string): Promise<number> {
  const rows = await db.queryRows(
    "SELECT obs_code FROM observation_codes WHERE loinc_num=? ORDER BY obs_code LIMIT 1",
    [loinc],
  );
  if (!rows.length) {
    throw new Error(
      `LOINC ${loinc} is not in observation_codes — ingest never invents codes (fail-closed). ` +
        `Pick a code the WebChart dictionary already carries.`,
    );
  }
  return Number(rows[0]!.obs_code);
}

/** Ingest a parsed document. Idempotent by (firstName, lastName, birthDate). */
export async function ingest(db: IngestDb, doc: IngestDoc, opts: { dryRun?: boolean } = {}): Promise<IngestReport> {
  const catalog = await loadModelFields(db, Object.keys(MODEL_TOUCHES));
  const modelValidation = validateAgainstModel(catalog, MODEL_TOUCHES);

  const report: IngestReport = { modelValidation, inserted: [], skippedExisting: [], dryRun: opts.dryRun === true };
  for (const p of doc.patients) {
    const label = `${p.firstName} ${p.lastName} (${p.birthDate})`;
    const existing = await findPatientId(db, p);
    if (existing !== undefined) {
      report.skippedExisting.push(`${label} → already pat_id ${existing}`);
      continue;
    }
    // Resolve every LOINC BEFORE any write so a bad code aborts the patient atomically-ish.
    const codes = new Map<string, number>();
    for (const ob of p.observations) {
      if (!codes.has(ob.loinc)) codes.set(ob.loinc, await obsCodeForLoinc(db, ob.loinc));
    }
    if (opts.dryRun) {
      report.inserted.push({ subjectId: "wc-<dry-run>", name: label, observations: p.observations.length });
      continue;
    }
    const res = await db.execute(
      "INSERT INTO patients (first_name, last_name, sex, birth_date, is_patient) VALUES (?,?,?,?,1)",
      [p.firstName, p.lastName, p.sex ?? "", `${p.birthDate} 00:00:00`],
    );
    const patId = Number(res.insertId);
    for (const ob of p.observations) {
      await db.execute(
        "INSERT INTO observations_current (pat_id, obs_code, obs_result_dec, obs_result_dt) VALUES (?,?,?,?)",
        [patId, codes.get(ob.loinc)!, ob.value, `${ob.date} 00:00:00`],
      );
    }
    report.inserted.push({ subjectId: `wc-${patId}`, name: label, observations: p.observations.length });
  }
  return report;
}

export interface RollbackReport {
  removed: string[];
  notFound: string[];
}

/** Reverse an ingest: delete exactly the file's patients (matched by natural key) + their observations. */
export async function rollback(db: IngestDb, doc: IngestDoc): Promise<RollbackReport> {
  const report: RollbackReport = { removed: [], notFound: [] };
  for (const p of doc.patients) {
    const label = `${p.firstName} ${p.lastName} (${p.birthDate})`;
    const patId = await findPatientId(db, p);
    if (patId === undefined) {
      report.notFound.push(label);
      continue;
    }
    await db.execute("DELETE FROM observations_current WHERE pat_id=?", [patId]);
    await db.execute("DELETE FROM patients WHERE pat_id=?", [patId]);
    report.removed.push(`${label} → pat_id ${patId}`);
  }
  return report;
}
