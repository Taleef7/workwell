/**
 * WebChart dev-DB evaluation proof (#246, PR-2) — the committed offline end-to-end test.
 *   node --import tsx --test src/engine/ingress/webchart/devdb-eval.test.ts
 *
 * Runs MIE's real WebChart dev-DB sample (exported to `spike/webchart/devdb-patients.json` by
 * `scripts/webchart-devdb-export.ts`) through the UNCHANGED ingress + engine and asserts REAL,
 * deterministic compliance outcomes — proving the WebChart→FHIR pipeline end-to-end with no live API and
 * no MariaDB driver. The fixtures are committed, so this runs in CI with no Docker.
 *
 * Honest scope: the dev seed is rich on lab observations (real LOINC) but sparse on procedures and carries
 * no CVX vaccines, so the demonstrable whitelist is the lab/vital measures below + cms125 (one HCPCS
 * G0202 mammogram). The measures the seed can't exercise are named in EXCLUDED and asserted to stay
 * MISSING_DATA — never silently dropped. Descriptive only (ADR-008): reconciliation + roster supply coded
 * FHIR; the CQL engine decides every outcome here.
 *
 * EVAL is data-contemporaneous (the sample spans 2015–2024) so the recency measures produce a genuine
 * COMPLIANT/OVERDUE/MISSING_DATA mix rather than a uniform "everything is years old".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { OutcomeStatus } from "../../evaluate-measure.ts";
import { webChartDataSource, evaluateSource } from "../data-source.ts";
import { fixtureWebChartClient } from "./webchart-client.ts";
import { parseEnrollmentRoster, evaluateSourceWithRoster } from "../enrollment/roster.ts";

const DIR = fileURLToPath(new URL("../../../../spike/webchart/", import.meta.url));
const payloads = JSON.parse(readFileSync(path.join(DIR, "devdb-patients.json"), "utf8")) as unknown[];
const roster = parseEnrollmentRoster(JSON.parse(readFileSync(path.join(DIR, "enrollment-roster.json"), "utf8")));
const EVAL = "2024-06-01";

/** Measures the dev-DB sample can exercise (real LOINC/HCPCS present + reconciled). */
const WHITELIST = ["diabetes_hba1c", "obesity_bmi", "cholesterol_ldl", "hypertension", "cms125"] as const;
/** Named-excluded: the seed has no matching data (OSHA CPTs, CVX vaccines) or the gate needs data it lacks
 * (cms122 is value-based + needs a diabetes dx). NOT silently dropped — asserted to stay MISSING_DATA. */
const EXCLUDED = ["audiogram", "tb_surveillance", "flu_vaccine", "adult_immunization", "cms122"] as const;

const source = () => webChartDataSource({ baseUrl: "x", apiKey: "k" }, fixtureWebChartClient(payloads));

async function runWithRoster(measureId: string): Promise<Map<string, OutcomeStatus>> {
  const res = await evaluateSourceWithRoster(source(), measureId, roster, { evaluationDate: EVAL });
  assert.equal(res.failed, 0, `${measureId}: no evaluation should error (${res.failed} failed)`);
  return new Map(res.results.filter((r) => r.ok && r.outcome).map((r) => [r.outcome!.subjectId, r.outcome!.outcome]));
}

test("fixtures loaded: 26 patient bundles + a roster", () => {
  assert.ok(payloads.length >= 20, `expected the dev-DB sample, got ${payloads.length}`);
});

test("diabetes_hba1c: a real HbA1c drives OVERDUE; no HbA1c → MISSING_DATA; no roster → MISSING_DATA", async () => {
  const byId = await runWithRoster("diabetes_hba1c");
  assert.equal(byId.get("wc-8"), "OVERDUE"); // HbA1c dated 2015 → well past the 180d window
  assert.equal(byId.get("wc-42"), "MISSING_DATA"); // enrolled, but the subject has no HbA1c on file
  // Control — WITHOUT the roster, wc-8 has no enrollment Condition, so the gate fails → MISSING_DATA.
  const control = await evaluateSource(source(), "diabetes_hba1c", { evaluationDate: EVAL });
  const controlById = new Map(control.results.filter((r) => r.ok && r.outcome).map((r) => [r.outcome!.subjectId, r.outcome!.outcome]));
  assert.equal(controlById.get("wc-8"), "MISSING_DATA");
});

test("obesity_bmi: recent BMI → COMPLIANT; old BMI → OVERDUE", async () => {
  const byId = await runWithRoster("obesity_bmi");
  assert.equal(byId.get("wc-42"), "COMPLIANT"); // BMI dated 2024-03-01, ~92d before EVAL
  assert.equal(byId.get("wc-13"), "OVERDUE"); // BMI dated 2015
});

test("hypertension: systolic-BP LOINC 8480-6 (MIE's actual code, new crosswalk row) evaluates", async () => {
  const byId = await runWithRoster("hypertension");
  assert.equal(byId.get("wc-40"), "COMPLIANT"); // systolic BP 2024-03-01
  assert.equal(byId.get("wc-13"), "OVERDUE"); // systolic BP 2015
});

test("cholesterol_ldl: LDL LOINC 2089-1 (MIE's actual code, new crosswalk row) evaluates", async () => {
  const byId = await runWithRoster("cholesterol_ldl");
  assert.equal(byId.get("wc-13"), "OVERDUE"); // LDL dated 2015
});

test("cms125: a real HCPCS G0202 mammogram (2015) → OVERDUE", async () => {
  const byId = await runWithRoster("cms125");
  assert.equal(byId.get("wc-49"), "OVERDUE"); // mammogram 2015-07-05, past the 820d window
});

test("the sample yields a real outcome distribution — NOT all MISSING_DATA (the proof)", async () => {
  const all: OutcomeStatus[] = [];
  for (const m of WHITELIST) all.push(...(await runWithRoster(m)).values());
  const seen = new Set(all);
  assert.ok(seen.has("COMPLIANT"), "expected at least one COMPLIANT across the sample");
  assert.ok(seen.has("OVERDUE"), "expected at least one OVERDUE across the sample");
  assert.ok(seen.has("MISSING_DATA"), "expected at least one MISSING_DATA across the sample");
  const nonMissing = all.filter((o) => o !== "MISSING_DATA").length;
  assert.ok(nonMissing >= 5, `expected several real (non-MISSING_DATA) outcomes, got ${nonMissing}`);
});

test("excluded measures stay MISSING_DATA (honest boundary — named, not silently dropped)", async () => {
  for (const m of EXCLUDED) {
    const byId = await runWithRoster(m);
    const outcomes = new Set(byId.values());
    assert.deepEqual([...outcomes], ["MISSING_DATA"], `${m}: the seed has no data for it → all MISSING_DATA`);
  }
});
