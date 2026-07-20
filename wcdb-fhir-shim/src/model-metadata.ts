/**
 * model-metadata.ts — WebChart's SELF-DESCRIBING schema catalog (Doug, 2026-07-20):
 * "look at the table named model … it has metadata (object/field). it describes every object and
 * field. we do this instead of doing in sql so it makes it easier to port."
 *
 * The `model` table (685 objects / 7,630 fields in the dev seed; siblings `model_relation`,
 * `model_doc`, …) is WebChart's portable schema definition. This module reads it so WCDB-writing
 * tools validate the objects/fields they touch against WebChart's OWN catalog rather than
 * hardcoded assumptions — a mapping mistake fails loudly up front ("field X is not in the model")
 * instead of as a MariaDB error mid-insert, and a ported/newer WebChart whose shape differs is
 * detected before anything is written.
 */

export interface ModelField {
  object: string;
  field: string;
  label: string;
  dataType: string;
  isNullable: boolean;
  fk: string;
}

export interface ModelReader {
  queryRows(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>>;
}

/** Load the field catalog for the given objects from WebChart's `model` table. */
export async function loadModelFields(db: ModelReader, objects: string[]): Promise<Map<string, ModelField[]>> {
  if (objects.length === 0) return new Map();
  const placeholders = objects.map(() => "?").join(",");
  const rows = await db.queryRows(
    `SELECT object, field, label, data_type, is_nullable, fk FROM model WHERE object IN (${placeholders}) ORDER BY object, pos`,
    objects,
  );
  const out = new Map<string, ModelField[]>();
  for (const r of rows) {
    const object = String(r.object);
    let arr = out.get(object);
    if (!arr) out.set(object, (arr = []));
    arr.push({
      object,
      field: String(r.field),
      label: String(r.label ?? ""),
      dataType: String(r.data_type ?? ""),
      isNullable: String(r.is_nullable ?? "").toUpperCase() === "YES",
      fk: String(r.fk ?? ""),
    });
  }
  return out;
}

/**
 * Assert every (object, field) a write plan touches exists in the model catalog.
 * Returns a human-readable summary line; throws listing every missing field otherwise.
 */
export function validateAgainstModel(
  catalog: Map<string, ModelField[]>,
  touches: Record<string, string[]>,
): string {
  const missing: string[] = [];
  let checked = 0;
  for (const [object, fields] of Object.entries(touches)) {
    const known = new Set((catalog.get(object) ?? []).map((f) => f.field));
    if (known.size === 0) {
      missing.push(`object '${object}' is not in the model catalog`);
      continue;
    }
    for (const field of fields) {
      checked++;
      if (!known.has(field)) missing.push(`${object}.${field} is not in the model catalog`);
    }
  }
  if (missing.length) {
    throw new Error(`WebChart model-catalog validation failed:\n  ${missing.join("\n  ")}`);
  }
  const objects = Object.keys(touches).length;
  return `validated ${checked} field(s) across ${objects} object(s) against WebChart's model catalog`;
}

/** The value KIND a writer intends to store in a field — checked against the catalog's data_type. */
export type ValueKind = "string" | "number" | "datetime";

// Order matters: "datetime"/"timestamp" contain 'time' and must not fall through to the numeric
// bucket; unknown data_type strings (a ported WebChart may extend the vocabulary) are skipped, not
// failed — the field-existence check above remains the hard floor.
const KIND_OF_DATA_TYPE: Array<[RegExp, ValueKind]> = [
  [/date|time/i, "datetime"],
  [/char|text|enum|blob/i, "string"],
  [/int|dec|float|double|bit|num/i, "number"],
];

export function kindOfDataType(dataType: string): ValueKind | undefined {
  for (const [re, kind] of KIND_OF_DATA_TYPE) if (re.test(dataType)) return kind;
  return undefined;
}

/**
 * Assert the catalog's declared data_type is compatible with the value kind a write plan intends
 * for each field (dev seed vocabulary: varchar/int/smallint/decimal/datetime). Catches the "a
 * ported/newer WebChart kept the field name but changed its type" case BEFORE any write, instead
 * of as a mid-batch MariaDB error. Returns a summary line; throws listing every mismatch.
 */
export function validateFieldTypes(
  catalog: Map<string, ModelField[]>,
  expectations: Record<string, Record<string, ValueKind>>,
): string {
  const mismatches: string[] = [];
  let checked = 0;
  for (const [object, fields] of Object.entries(expectations)) {
    const byField = new Map((catalog.get(object) ?? []).map((f) => [f.field, f]));
    for (const [field, expected] of Object.entries(fields)) {
      const entry = byField.get(field);
      if (!entry) continue; // absence is validateAgainstModel's finding, not a type mismatch
      const declared = kindOfDataType(entry.dataType);
      if (declared === undefined) continue; // unknown vocabulary — stay lenient
      checked++;
      if (declared !== expected) {
        mismatches.push(
          `${object}.${field}: model declares ${entry.dataType} (${declared}) but ingest writes ${expected}`,
        );
      }
    }
  }
  if (mismatches.length) {
    throw new Error(`WebChart model-catalog TYPE validation failed:\n  ${mismatches.join("\n  ")}`);
  }
  return `type-checked ${checked} field(s) against the model catalog's declared data types`;
}
