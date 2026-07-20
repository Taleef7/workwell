/**
 * ingest tests — pure YAML parsing/validation, model-catalog validation (existence + types), and
 * the ingest/rollback flows over a stubbed DB (no MariaDB — CI-safe). The live loop (ingest →
 * shim → CQL/SQL → rollback) is verified manually per the README/demo script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseIngestYaml,
  ingest,
  rollback,
  MODEL_TOUCHES,
  MODEL_TYPE_EXPECTATIONS,
  type IngestRunner,
  type IngestManifest,
} from "./ingest.ts";
import { validateAgainstModel, validateFieldTypes, type ModelField } from "./model-metadata.ts";

const EXAMPLE = readFileSync(fileURLToPath(new URL("../patients.example.yaml", import.meta.url)), "utf8");

test("parseIngestYaml accepts the committed AI-generated example (4 patients, varied outcomes)", () => {
  const doc = parseIngestYaml(EXAMPLE);
  assert.equal(doc.patients.length, 4);
  assert.equal(doc.patients[0]!.firstName, "Zainab");
  assert.equal(doc.patients[0]!.observations.length, 4);
  assert.equal(doc.patients[3]!.observations.length, 0, "the MISSING_DATA patient has no observations");
});

test("parseIngestYaml fails loudly on structural problems", () => {
  assert.throws(() => parseIngestYaml("nope: []"), /top level/);
  assert.throws(() => parseIngestYaml("patients: []"), /at least one/);
  assert.throws(() => parseIngestYaml("patients:\n  - lastName: X\n    birthDate: 1990-01-01"), /firstName/);
  assert.throws(
    () => parseIngestYaml("patients:\n  - firstName: A\n    lastName: B\n    birthDate: 1990-13-01"),
    /birthDate/,
  );
  assert.throws(
    () =>
      parseIngestYaml(
        "patients:\n  - firstName: A\n    lastName: B\n    birthDate: 1990-01-01\n    observations:\n      - { loinc: \"DROP TABLE\", value: 1, date: 2026-01-01 }",
      ),
    /LOINC/,
  );
});

test("parseIngestYaml rejects non-numeric observation values and non-sequence observations", () => {
  // Number(null|""|false) would silently become 0 — a fabricated observation value.
  for (const v of ["", "null", "false", '"128"']) {
    assert.throws(
      () =>
        parseIngestYaml(
          `patients:\n  - firstName: A\n    lastName: B\n    birthDate: 1990-01-01\n    observations:\n      - { loinc: "8480-6", value: ${v}, date: 2026-01-01 }`,
        ),
      /value.*must be a YAML number/,
      `value ${v || "(empty)"} must be rejected`,
    );
  }
  // A present-but-not-a-list observations field is a malformed file, not an empty list — silently
  // dropping it would fabricate a MISSING_DATA outcome.
  assert.throws(
    () =>
      parseIngestYaml(
        'patients:\n  - firstName: A\n    lastName: B\n    birthDate: 1990-01-01\n    observations: { loinc: "8480-6", value: 128, date: 2026-01-01 }',
      ),
    /observations.*sequence/,
  );
});

/** Realistic per-field data types mirroring the live dev-wcdb `model` rows (verified 2026-07-20). */
function dataTypeOf(field: string): string {
  if (field === "pat_id" || field === "obs_code") return "int";
  if (field === "is_patient") return "smallint";
  if (field === "obs_result_dec") return "decimal";
  if (field === "birth_date" || field === "obs_result_dt") return "datetime";
  return "varchar";
}

function catalogOf(entries: Record<string, string[]>): Map<string, ModelField[]> {
  return new Map(
    Object.entries(entries).map(([object, fields]) => [
      object,
      fields.map((field) => ({ object, field, label: field, dataType: dataTypeOf(field), isNullable: false, fk: "" })),
    ]),
  );
}

test("validateAgainstModel passes on a complete catalog and names every missing field", () => {
  const ok = validateAgainstModel(catalogOf(MODEL_TOUCHES), MODEL_TOUCHES);
  assert.match(ok, /validated \d+ field/);
  const broken = catalogOf({ ...MODEL_TOUCHES, patients: ["pat_id"] });
  assert.throws(() => validateAgainstModel(broken, MODEL_TOUCHES), /patients\.first_name is not in the model/);
  assert.throws(
    () => validateAgainstModel(new Map(), { patients: ["pat_id"] }),
    /object 'patients' is not in the model/,
  );
});

test("validateFieldTypes passes on the real dev-wcdb type vocabulary and catches a changed type", () => {
  const ok = validateFieldTypes(catalogOf(MODEL_TOUCHES), MODEL_TYPE_EXPECTATIONS);
  assert.match(ok, /type-checked \d+ field/);
  // A ported/newer WebChart that kept the field name but re-typed it must fail BEFORE any write.
  const retyped = catalogOf(MODEL_TOUCHES);
  const obs = retyped.get("observations_current")!;
  obs.find((f) => f.field === "obs_result_dec")!.dataType = "varchar";
  assert.throws(
    () => validateFieldTypes(retyped, MODEL_TYPE_EXPECTATIONS),
    /obs_result_dec.*varchar.*writes number/,
  );
  // An unknown vocabulary entry is skipped (lenient), not failed.
  const exotic = catalogOf(MODEL_TOUCHES);
  exotic.get("patients")!.find((f) => f.field === "sex")!.dataType = "mystery_type";
  assert.match(validateFieldTypes(exotic, MODEL_TYPE_EXPECTATIONS), /type-checked/);
});

interface StubState {
  patients: Array<{ pat_id: number; first_name: string; last_name: string; birth: string }>;
  obs: Array<{ pat_id: number; obs_code: number }>;
  executed: string[];
}

function stubIngestDb(state: StubState, opts: { failOnInsertOfLastName?: string } = {}): IngestRunner {
  const db: IngestRunner = {
    async queryRows(sql, params) {
      if (sql.includes("FROM model")) {
        return Object.entries(MODEL_TOUCHES).flatMap(([object, fields]) =>
          fields.map((field) => ({
            object,
            field,
            label: field,
            data_type: dataTypeOf(field),
            is_nullable: "NO",
            fk: "",
          })),
        );
      }
      if (sql.includes("WHERE pat_id=?")) {
        const hit = state.patients.find((p) => p.pat_id === Number(params[0]));
        return hit ? [{ first_name: hit.first_name, last_name: hit.last_name, birth: hit.birth }] : [];
      }
      if (sql.includes("FROM patients")) {
        const [fn, ln, bd] = params as [string, string, string];
        const hit = state.patients.find((p) => p.first_name === fn && p.last_name === ln && p.birth === bd);
        return hit ? [{ pat_id: hit.pat_id }] : [];
      }
      if (sql.includes("FROM observation_codes")) {
        const loinc = String(params[0]);
        return loinc === "0000-0" ? [] : [{ obs_code: 500 + Number(loinc.split("-")[0]!.slice(0, 3)) }];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async execute(sql, params) {
      state.executed.push(sql.split(" ").slice(0, 3).join(" "));
      if (sql.startsWith("INSERT INTO patients")) {
        if (opts.failOnInsertOfLastName && String(params[1]) === opts.failOnInsertOfLastName) {
          throw new Error(`simulated mid-batch failure inserting ${params[1]}`);
        }
        const patId = 1000 + state.patients.length;
        state.patients.push({
          pat_id: patId,
          first_name: String(params[0]),
          last_name: String(params[1]),
          birth: String(params[3]).slice(0, 10),
        });
        return { insertId: patId };
      }
      if (sql.startsWith("INSERT INTO observations_current")) {
        state.obs.push({ pat_id: Number(params[0]), obs_code: Number(params[1]) });
        return { affectedRows: 1 };
      }
      if (sql.startsWith("DELETE FROM observations_current")) {
        state.obs = state.obs.filter((o) => o.pat_id !== Number(params[0]));
        return { affectedRows: 1 };
      }
      if (sql.startsWith("DELETE FROM patients")) {
        state.patients = state.patients.filter((p) => p.pat_id !== Number(params[0]));
        return { affectedRows: 1 };
      }
      throw new Error(`unexpected execute: ${sql}`);
    },
    // Mirrors the real pool's semantics: a throw inside fn restores the pre-transaction state.
    async withTransaction(fn) {
      const snapshot = { patients: [...state.patients], obs: [...state.obs] };
      try {
        return await fn(db);
      } catch (err) {
        state.patients = snapshot.patients;
        state.obs = snapshot.obs;
        throw err;
      }
    },
  };
  return db;
}

function manifestFor(report: { created: IngestManifest["created"] }): IngestManifest {
  return { createdAt: "2026-07-20T00:00:00Z", database: "stub", created: report.created };
}

test("ingest inserts patients + observations, is idempotent, and manifest rollback reverses exactly", async () => {
  const state: StubState = { patients: [], obs: [], executed: [] };
  const db = stubIngestDb(state);
  const doc = parseIngestYaml(EXAMPLE);

  const first = await ingest(db, doc);
  assert.match(first.modelValidation, /validated/);
  assert.match(first.modelValidation, /type-checked/);
  assert.equal(first.inserted.length, 4);
  assert.equal(first.created.length, 4, "every inserted row is recorded for the manifest");
  assert.equal(first.skippedExisting.length, 0);
  assert.equal(state.patients.length, 4);
  assert.equal(state.obs.length, 4 + 2 + 3 + 0);
  assert.match(first.inserted[0]!.subjectId, /^wc-\d+$/, "subject ids use the shim's wc- scheme");

  const second = await ingest(db, doc);
  assert.equal(second.inserted.length, 0, "re-running the same file inserts nothing");
  assert.equal(second.created.length, 0, "an idempotent re-run adds nothing to the manifest");
  assert.equal(second.skippedExisting.length, 4);

  const rb = await rollback(db, manifestFor(first));
  assert.equal(rb.removed.length, 4);
  assert.equal(rb.mismatched.length, 0);
  assert.equal(state.patients.length, 0);
  assert.equal(state.obs.length, 0);

  const rb2 = await rollback(db, manifestFor(first));
  assert.equal(rb2.notFound.length, 4, "rolling back already-removed rows is a clean no-op");
});

test("rollback never deletes a row the manifest didn't create: pre-existing collisions and reused pat_ids survive", async () => {
  const state: StubState = { patients: [], obs: [], executed: [] };
  const db = stubIngestDb(state);
  // A patient that ALREADY exists in WebChart under the same natural key as a YAML entry.
  state.patients.push({ pat_id: 7, first_name: "Zainab", last_name: "Testwell", birth: "1988-04-17" });

  const doc = parseIngestYaml(EXAMPLE);
  const rep = await ingest(db, doc);
  assert.equal(rep.skippedExisting.length, 1, "the collision is skipped, not re-inserted");
  assert.equal(rep.created.length, 3, "…and therefore never enters the manifest");

  const rb = await rollback(db, manifestFor(rep));
  assert.equal(rb.removed.length, 3);
  assert.ok(
    state.patients.some((p) => p.pat_id === 7),
    "the pre-existing patient is untouched by rollback",
  );

  // A manifest entry whose pat_id now holds a DIFFERENT patient (id reuse) is refused, not deleted.
  state.patients.push({ pat_id: 999, first_name: "Someone", last_name: "Else", birth: "1970-01-01" });
  const stale: IngestManifest = {
    createdAt: "2026-07-20T00:00:00Z",
    database: "stub",
    created: [{ patId: 999, firstName: "Marcus", lastName: "Demoson", birthDate: "1979-11-02", observations: 2 }],
  };
  const rb2 = await rollback(db, stale);
  assert.equal(rb2.mismatched.length, 1, "natural-key mismatch is refused");
  assert.ok(state.patients.some((p) => p.pat_id === 999), "the mismatched row survives");
});

test("a mid-batch insert failure rolls the whole run back (no partial patients)", async () => {
  const state: StubState = { patients: [], obs: [], executed: [] };
  // Priya is the third YAML patient — the first two will have inserted before the failure.
  const db = stubIngestDb(state, { failOnInsertOfLastName: "Sampleton" });
  const doc = parseIngestYaml(EXAMPLE);
  await assert.rejects(ingest(db, doc), /simulated mid-batch failure/);
  assert.equal(state.patients.length, 0, "the transaction leaves no partial patients behind");
  assert.equal(state.obs.length, 0, "…and no orphaned observations");
});

test("ingest dry-run writes nothing; unknown LOINC fails closed before any write", async () => {
  const state: StubState = { patients: [], obs: [], executed: [] };
  const db = stubIngestDb(state);
  const doc = parseIngestYaml(EXAMPLE);

  const dry = await ingest(db, doc, { dryRun: true });
  assert.equal(dry.inserted.length, 4);
  assert.equal(dry.created.length, 0, "dry-run records nothing for the manifest");
  assert.equal(state.executed.length, 0, "dry-run executes no writes");

  const badDoc = parseIngestYaml(
    "patients:\n  - firstName: Bad\n    lastName: Loinc\n    birthDate: 1990-01-01\n    observations:\n      - { loinc: \"0000-0\", value: 1, date: 2026-01-01 }",
  );
  await assert.rejects(ingest(db, badDoc), /never invents codes/);
  assert.equal(state.executed.length, 0, "the failed patient wrote nothing");
});
