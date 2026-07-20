/**
 * ingest tests — pure YAML parsing/validation, model-catalog validation, and the ingest/rollback
 * flows over a stubbed DB (no MariaDB — CI-safe). The live loop (ingest → shim → CQL/SQL →
 * rollback) is verified manually per the README/demo script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseIngestYaml, ingest, rollback, MODEL_TOUCHES, type IngestDb } from "./ingest.ts";
import { validateAgainstModel, type ModelField } from "./model-metadata.ts";

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

function catalogOf(entries: Record<string, string[]>): Map<string, ModelField[]> {
  return new Map(
    Object.entries(entries).map(([object, fields]) => [
      object,
      fields.map((field) => ({ object, field, label: field, dataType: "varchar", isNullable: false, fk: "" })),
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

interface StubState {
  patients: Array<{ pat_id: number; first_name: string; last_name: string; birth: string }>;
  obs: Array<{ pat_id: number; obs_code: number }>;
  executed: string[];
}

function stubIngestDb(state: StubState): IngestDb {
  return {
    async queryRows(sql, params) {
      if (sql.includes("FROM model")) {
        return Object.entries(MODEL_TOUCHES).flatMap(([object, fields]) =>
          fields.map((field) => ({ object, field, label: field, data_type: "varchar", is_nullable: "NO", fk: "" })),
        );
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
    async end() {},
  } as IngestDb;
}

test("ingest inserts patients + observations, is idempotent, and rollback reverses exactly", async () => {
  const state: StubState = { patients: [], obs: [], executed: [] };
  const db = stubIngestDb(state);
  const doc = parseIngestYaml(EXAMPLE);

  const first = await ingest(db, doc);
  assert.match(first.modelValidation, /validated/);
  assert.equal(first.inserted.length, 4);
  assert.equal(first.skippedExisting.length, 0);
  assert.equal(state.patients.length, 4);
  assert.equal(state.obs.length, 4 + 2 + 3 + 0);
  assert.match(first.inserted[0]!.subjectId, /^wc-\d+$/, "subject ids use the shim's wc- scheme");

  const second = await ingest(db, doc);
  assert.equal(second.inserted.length, 0, "re-running the same file inserts nothing");
  assert.equal(second.skippedExisting.length, 4);

  const rb = await rollback(db, doc);
  assert.equal(rb.removed.length, 4);
  assert.equal(state.patients.length, 0);
  assert.equal(state.obs.length, 0);

  const rb2 = await rollback(db, doc);
  assert.equal(rb2.notFound.length, 4, "rollback of an absent file is a clean no-op");
});

test("ingest dry-run writes nothing; unknown LOINC fails closed before any write", async () => {
  const state: StubState = { patients: [], obs: [], executed: [] };
  const db = stubIngestDb(state);
  const doc = parseIngestYaml(EXAMPLE);

  const dry = await ingest(db, doc, { dryRun: true });
  assert.equal(dry.inserted.length, 4);
  assert.equal(state.executed.length, 0, "dry-run executes no writes");

  const badDoc = parseIngestYaml(
    "patients:\n  - firstName: Bad\n    lastName: Loinc\n    birthDate: 1990-01-01\n    observations:\n      - { loinc: \"0000-0\", value: 1, date: 2026-01-01 }",
  );
  await assert.rejects(ingest(db, badDoc), /never invents codes/);
  assert.equal(state.executed.length, 0, "the failed patient wrote nothing");
});
