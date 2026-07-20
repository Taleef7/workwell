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
 *  - DEV DATABASE ONLY (synthetic data; never a live WebChart; never the demo stack). The CLI
 *    additionally refuses non-local / non-wcdb-looking targets (see ingest-cli.ts).
 *  - Every write is validated up front against WebChart's own `model` schema catalog — both field
 *    EXISTENCE and declared data TYPE (model-metadata.ts — Doug's portability point, operational).
 *  - LOINC codes must already exist in `observation_codes` — fail-closed, we never invent codes.
 *  - Idempotent by natural key (first+last+birthDate): re-running a file skips existing patients.
 *  - All writes for a run happen in ONE transaction — a mid-batch failure leaves nothing behind.
 *  - Reversible via a MANIFEST: ingest records exactly the pat_ids it created
 *    (`<file>.ingested.json`, written by the CLI); rollback deletes exactly those rows and refuses
 *    to guess by natural key (a YAML patient that happened to collide with a pre-existing WebChart
 *    patient was SKIPPED at ingest, so it must never be deleted at rollback).
 *
 * YAML schema:
 *   patients:
 *     - firstName: Ayesha
 *       lastName: Rahman
 *       sex: F                # F | M | (omit for unknown)
 *       birthDate: 1985-03-12
 *       observations:
 *         - loinc: "8480-6"   # must exist in observation_codes
 *           value: 128        # must be a YAML number (strings/booleans/empty are rejected)
 *           date: 2026-06-30
 */
import { parse as parseYaml } from "yaml";
import {
  loadModelFields,
  validateAgainstModel,
  validateFieldTypes,
  type ModelReader,
  type ValueKind,
} from "./model-metadata.ts";
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

/** The value kind ingest writes into each touched field — checked against `model.data_type`. */
export const MODEL_TYPE_EXPECTATIONS: Record<string, Record<string, ValueKind>> = {
  patients: {
    pat_id: "number",
    first_name: "string",
    last_name: "string",
    sex: "string",
    birth_date: "datetime",
    is_patient: "number",
  },
  observations_current: {
    pat_id: "number",
    obs_code: "number",
    obs_result_dec: "number",
    obs_result_dt: "datetime",
  },
  observation_codes: { obs_code: "number", loinc_num: "string" },
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
    // `observations` may be omitted (a designed MISSING_DATA patient), but a PRESENT non-array is
    // a malformed file — silently treating it as empty would fabricate a MISSING_DATA outcome.
    if (o.observations !== undefined && !Array.isArray(o.observations)) {
      fail(`${at}.observations`, "must be a YAML sequence (a list of { loinc, value, date } entries)");
    }
    const obsRaw = Array.isArray(o.observations) ? o.observations : [];
    const observations = obsRaw.map((ob, j) => {
      const oat = `${at}.observations[${j}]`;
      if (!ob || typeof ob !== "object") fail(oat, "must be a mapping");
      const q = ob as Record<string, unknown>;
      const loinc = String(q.loinc ?? "");
      if (!LOINC_SHAPE.test(loinc)) fail(`${oat}.loinc`, `not a plausible LOINC code (got '${q.loinc}')`);
      // Strict: a YAML number only. Coercing null/""/booleans through Number() would silently
      // store 0 and fabricate a compliance-relevant observation value.
      if (typeof q.value !== "number" || !Number.isFinite(q.value)) {
        fail(`${oat}.value`, `must be a YAML number (got ${JSON.stringify(q.value)})`);
      }
      const value = q.value;
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

/** The DB surface ingest/rollback need: reads + writes + an all-or-nothing transaction scope. */
export interface IngestRunner extends IngestDb {
  withTransaction<T>(fn: (tx: IngestDb) => Promise<T>): Promise<T>;
}

/** One created patient — the unit of the manifest that makes rollback exact. */
export interface CreatedPatient {
  patId: number;
  firstName: string;
  lastName: string;
  birthDate: string;
  observations: number;
}

/** Written by the CLI as `<file>.ingested.json` — the ONLY authority rollback trusts. */
export interface IngestManifest {
  createdAt: string;
  database: string;
  created: CreatedPatient[];
}

export interface IngestReport {
  modelValidation: string;
  inserted: Array<{ subjectId: string; name: string; observations: number }>;
  /** The rows this run actually created — the CLI persists these into the manifest. */
  created: CreatedPatient[];
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

/**
 * Ingest a parsed document. Idempotent by (firstName, lastName, birthDate); every write of the run
 * happens inside ONE transaction, so a mid-batch failure (bad LOINC, connection drop) leaves the
 * database untouched — no partial patient a later idempotent run would skip but never repair.
 */
export async function ingest(db: IngestRunner, doc: IngestDoc, opts: { dryRun?: boolean } = {}): Promise<IngestReport> {
  const catalog = await loadModelFields(db, Object.keys(MODEL_TOUCHES));
  const fieldCheck = validateAgainstModel(catalog, MODEL_TOUCHES);
  const typeCheck = validateFieldTypes(catalog, MODEL_TYPE_EXPECTATIONS);
  const report: IngestReport = {
    modelValidation: `${fieldCheck}; ${typeCheck}`,
    inserted: [],
    created: [],
    skippedExisting: [],
    dryRun: opts.dryRun === true,
  };

  // Plan phase (reads only): resolve existing patients + every LOINC before any write.
  const plans: Array<{ p: IngestPatient; codes: Map<string, number> }> = [];
  for (const p of doc.patients) {
    const label = `${p.firstName} ${p.lastName} (${p.birthDate})`;
    const existing = await findPatientId(db, p);
    if (existing !== undefined) {
      report.skippedExisting.push(`${label} → already pat_id ${existing}`);
      continue;
    }
    const codes = new Map<string, number>();
    for (const ob of p.observations) {
      if (!codes.has(ob.loinc)) codes.set(ob.loinc, await obsCodeForLoinc(db, ob.loinc));
    }
    if (opts.dryRun) {
      report.inserted.push({ subjectId: "wc-<dry-run>", name: label, observations: p.observations.length });
      continue;
    }
    plans.push({ p, codes });
  }
  if (opts.dryRun || plans.length === 0) return report;

  // Write phase: one transaction for the whole run.
  await db.withTransaction(async (tx) => {
    for (const { p, codes } of plans) {
      const label = `${p.firstName} ${p.lastName} (${p.birthDate})`;
      const res = await tx.execute(
        "INSERT INTO patients (first_name, last_name, sex, birth_date, is_patient) VALUES (?,?,?,?,1)",
        [p.firstName, p.lastName, p.sex ?? "", `${p.birthDate} 00:00:00`],
      );
      const patId = Number(res.insertId);
      for (const ob of p.observations) {
        await tx.execute(
          "INSERT INTO observations_current (pat_id, obs_code, obs_result_dec, obs_result_dt) VALUES (?,?,?,?)",
          [patId, codes.get(ob.loinc)!, ob.value, `${ob.date} 00:00:00`],
        );
      }
      report.inserted.push({ subjectId: `wc-${patId}`, name: label, observations: p.observations.length });
      report.created.push({
        patId,
        firstName: p.firstName,
        lastName: p.lastName,
        birthDate: p.birthDate,
        observations: p.observations.length,
      });
    }
  });
  return report;
}

export interface RollbackReport {
  removed: string[];
  notFound: string[];
  /** Manifest entries whose current DB row no longer matches the recorded natural key — NOT deleted. */
  mismatched: string[];
}

/**
 * Reverse an ingest using its MANIFEST: delete exactly the pat_ids this tool created, after
 * re-verifying each row still carries the recorded natural key. Never deletes by natural-key
 * search — a YAML patient that collided with a pre-existing WebChart patient was skipped at ingest
 * time and therefore has no manifest entry, so it can never be deleted here.
 */
export async function rollback(db: IngestRunner, manifest: IngestManifest): Promise<RollbackReport> {
  const report: RollbackReport = { removed: [], notFound: [], mismatched: [] };
  await db.withTransaction(async (tx) => {
    for (const entry of manifest.created) {
      const label = `${entry.firstName} ${entry.lastName} (${entry.birthDate})`;
      const rows = await tx.queryRows(
        "SELECT first_name, last_name, DATE(birth_date) AS birth FROM patients WHERE pat_id=? LIMIT 1",
        [entry.patId],
      );
      if (!rows.length) {
        report.notFound.push(`${label} → pat_id ${entry.patId} already absent`);
        continue;
      }
      const row = rows[0]!;
      const matches =
        String(row.first_name) === entry.firstName &&
        String(row.last_name) === entry.lastName &&
        String(row.birth).slice(0, 10) === entry.birthDate;
      if (!matches) {
        report.mismatched.push(
          `${label} → pat_id ${entry.patId} now holds '${row.first_name} ${row.last_name}' — refusing to delete`,
        );
        continue;
      }
      await tx.execute("DELETE FROM observations_current WHERE pat_id=?", [entry.patId]);
      await tx.execute("DELETE FROM patients WHERE pat_id=?", [entry.patId]);
      report.removed.push(`${label} → pat_id ${entry.patId}`);
    }
  });
  return report;
}
