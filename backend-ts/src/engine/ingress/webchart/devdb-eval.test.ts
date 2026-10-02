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
import type { OutcomeStatus } from "@work-well/measure-engine";
import { webChartDataSource, evaluateSource, type PatientDataSource } from "../data-source.ts";
import { fixtureWebChartClient } from "./webchart-client.ts";
import { parseEnrollmentRoster, evaluateSourceWithRoster, isEnrolled } from "../enrollment/roster.ts";
import { withTestQualifyingVisit } from "../../../test-support/qualifying-visit.ts";
// Single source of truth for the whitelist/excluded sets (the CLI module is import-safe — no side effects).
import { DEVDB_EXCLUDED as EXCLUDED } from "./devdb-cli.ts";
import { DEVDB_WHITELIST as WHITELIST } from "./report-table.ts";

const DIR = fileURLToPath(new URL("../../../../spike/webchart/", import.meta.url));
const payloads = JSON.parse(readFileSync(path.join(DIR, "devdb-patients.json"), "utf8")) as unknown[];
const roster = parseEnrollmentRoster(JSON.parse(readFileSync(path.join(DIR, "enrollment-roster.json"), "utf8")));
const EVAL = "2024-06-01";

const source = () => webChartDataSource({ baseUrl: "x", apiKey: "k" }, fixtureWebChartClient(payloads));

/** Each measure is evaluated once per file: the outcomes are deterministic and the tests only read them. */
const evaluated = new Map<string, Promise<Map<string, OutcomeStatus>>>();

function runWithRoster(measureId: string): Promise<Map<string, OutcomeStatus>> {
  let result = evaluated.get(measureId);
  if (!result) {
    result = (async () => {
      const res = await evaluateSourceWithRoster(source(), measureId, roster, { evaluationDate: EVAL });
      assert.equal(res.failed, 0, `${measureId}: no evaluation should error (${res.failed} failed)`);
      return new Map(res.results.filter((r) => r.ok && r.outcome).map((r) => [r.outcome!.subjectId, r.outcome!.outcome]));
    })();
    evaluated.set(measureId, result);
  }
  return result;
}

test("fixtures loaded: full 56-patient dev-DB corpus + a roster", () => {
  assert.equal(payloads.length, 56, `expected every is_patient=1 dev-DB row, got ${payloads.length}`);
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

test("cms125: nobody is admitted without a real visit — the roster no longer invents one", async () => {
  // CMS125's population needs a qualifying encounter, and this sample carries none. The roster used to
  // stamp a CPT 99213 visit, which made wc-8/36/45/47 OVERDUE on a visit that never happened.
  const byId = await runWithRoster("cms125");
  assert.equal(byId.size, 56);
  assert.deepEqual([...new Set(byId.values())], ["MISSING_DATA"]);
});

test("cms125 with a test-data visit: age-in-band women land OVERDUE, and age-out wc-49 stays out", async () => {
  // The visit is TEST DATA, so the authored age gate (42–74) stays covered on every shard.
  // wc-49 has a real HCPCS G0202 mammogram (2015) but was born in 1990, so she is out at 33.
  const base = source();
  const withVisits: PatientDataSource = {
    kind: base.kind,
    loadBundles: async () =>
      (await base.loadBundles()).map((b) => {
        const id = (b as { entry: Array<{ resource: { resourceType: string; id?: string } }> }).entry.find(
          (e) => e.resource.resourceType === "Patient",
        )?.resource.id;
        return id && isEnrolled(roster, id, "cms125") ? withTestQualifyingVisit(b) : b;
      }),
  };
  const res = await evaluateSourceWithRoster(withVisits, "cms125", roster, { evaluationDate: EVAL });
  const byId = new Map(res.results.filter((r) => r.ok && r.outcome).map((r) => [r.outcome!.subjectId, r.outcome!.outcome]));
  assert.equal(byId.get("wc-49"), "MISSING_DATA", "wc-49 is 33 — out of the 42–74 population");
  for (const id of ["wc-8", "wc-36", "wc-45", "wc-47"]) assert.equal(byId.get(id), "OVERDUE", id);
});

test("the sample yields a real outcome distribution — NOT all MISSING_DATA (the proof)", async () => {
  const all: OutcomeStatus[] = [];
  for (const m of WHITELIST) {
    const byId = await runWithRoster(m);
    assert.equal(byId.size, payloads.length, `${m}: every patient should produce an outcome`);
    all.push(...byId.values());
  }
  const seen = new Set(all);
  assert.ok(seen.has("COMPLIANT"), "expected at least one COMPLIANT across the sample");
  assert.ok(seen.has("OVERDUE"), "expected at least one OVERDUE across the sample");
  assert.ok(seen.has("MISSING_DATA"), "expected at least one MISSING_DATA across the sample");
  const nonMissing = all.filter((o) => o !== "MISSING_DATA").length;
  assert.ok(nonMissing >= 5, `expected several real (non-MISSING_DATA) outcomes, got ${nonMissing}`);
});

test("all 56 patients evaluate across the whitelist; sparse Patient-only bundles become MISSING_DATA", async () => {
  for (const m of WHITELIST) {
    const byId = await runWithRoster(m);
    assert.equal(byId.size, 56, `${m}: every dev-DB patient should evaluate without crashing`);
    assert.equal(byId.get("wc-14"), "MISSING_DATA", `${m}: sparse wc-14 has only Patient demographics`);
  }
});

test("excluded measures stay MISSING_DATA (honest boundary — named, not silently dropped)", async () => {
  for (const m of EXCLUDED) {
    const byId = await runWithRoster(m);
    assert.equal(byId.size, 56, `${m}: every dev-DB patient should evaluate without crashing`);
    const outcomes = new Set(byId.values());
    assert.deepEqual([...outcomes], ["MISSING_DATA"], `${m}: not roster-enrolled and/or no matching coded event → all MISSING_DATA`);
  }
});
