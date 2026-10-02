/**
 * #749: an authored measure's "most recent" result must not depend on the order the results arrive in.
 * `Last(... sort by (performed as FHIR.dateTime))` sorted by a FHIR element the runtime cannot compare:
 * every comparison said "greater", the merge sort reversed the input, and `Last()` returned the FIRST
 * result listed — the OLDEST, for data listed oldest-first (the WebChart dev DB's full history is).
 *
 * Every recency measure gets its in-window result AND its out-of-window one, in both orders, and must
 * read the in-window one both times.
 *   node --import tsx --test src/engine/cql/most-recent-order.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MEASURES } from "./measure-registry.ts";
import { buildSyntheticBundle } from "../synthetic/fhir-bundle-builder.ts";
import { deriveExamConfig } from "../synthetic/exam-config.ts";
import { MEASURE_BINDINGS } from "../synthetic/measure-bindings.ts";
import { EMPLOYEES } from "../synthetic/employee-catalog.ts";
import { createWorkwellEngine } from "./workwell-engine.ts";

const synthRoot = fileURLToPath(new URL("../../../spike/synthetic", import.meta.url));
const EVAL = "2026-06-12";
const engine = createWorkwellEngine();

type Entry = { resource: Record<string, unknown> };
type Bundle = { resourceType: "Bundle"; type: string; entry: Entry[] };
const EVENT_TYPES = new Set(["Procedure", "Immunization", "Observation"]);
const isEvent = (e: Entry) => EVENT_TYPES.has(String(e.resource.resourceType));
const load = (measureId: string, scenario: string): Bundle =>
  JSON.parse(readFileSync(path.join(synthRoot, measureId, `${scenario}.json`), "utf8")) as Bundle;

/** The bundle with `older` placed before (oldest-first) or after (newest-first) its own events. */
function withOlder(bundle: Bundle, older: Entry[], oldestFirst: boolean): Bundle {
  const rest = bundle.entry.filter((e) => !isEvent(e));
  const events = bundle.entry.filter(isEvent);
  return { ...bundle, entry: [...rest, ...(oldestFirst ? [...older, ...events] : [...events, ...older])] };
}

async function outcomeOf(measureId: string, bundle: Bundle): Promise<string> {
  return (await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: EVAL })).outcome;
}

// Recency measures with present_recent (COMPLIANT) and present_old (OVERDUE) fixtures. The series
// measures (no recency window) and the eCQM-shaped cms122/cms125 are covered separately or not at all.
const RECENCY = Object.keys(MEASURES).filter(
  (id) =>
    !["mmr", "varicella", "hepatitis_b_vaccination_series", "cms122", "cms125"].includes(id) &&
    existsSync(path.join(synthRoot, id, "present_recent.json")) &&
    existsSync(path.join(synthRoot, id, "present_old.json")),
);

// flu_vaccine runs here too but cannot fail on the sort: its 12-month period makes DUE_SOON (a last
// vaccine outside the period yet within 365 days) unreachable, so the most recent date never decides it.
test("the recency measures under test are the ones that carry the sort", () => {
  for (const id of ["audiogram", "hypertension", "obesity_bmi", "cholesterol_ldl", "diabetes_hba1c", "tb_surveillance", "hazwoper", "adult_immunization"]) {
    assert.ok(RECENCY.includes(id), `${id} must be covered`);
  }
});

for (const measureId of RECENCY) {
  test(`${measureId}: the in-window result wins whichever order the results arrive in`, async () => {
    const recent = load(measureId, "present_recent");
    // The out-of-window result, moved onto the same patient under its own id.
    const older = load(measureId, "present_old")
      .entry.filter(isEvent)
      .map((e) => JSON.parse(JSON.stringify(e).replaceAll(`${measureId}-present_old`, `${measureId}-present_recent`)) as Entry)
      .map((e, i) => ({ resource: { ...e.resource, id: `${String(e.resource.id)}-older-${i}` } }));
    assert.ok(older.length > 0, "the old scenario carries a result");
    assert.equal(await outcomeOf(measureId, withOlder(recent, older, false)), "COMPLIANT", "newest first");
    assert.equal(await outcomeOf(measureId, withOlder(recent, older, true)), "COMPLIANT", "oldest first");
  });
}

test("authored cms122: the most recent HbA1c decides poor control, not the first one listed", async () => {
  const bundle = buildSyntheticBundle(EMPLOYEES[0]!, deriveExamConfig(MEASURE_BINDINGS["cms122"]!, "COMPLIANT"), EVAL) as Bundle;
  const recentObs = bundle.entry.find((e) => e.resource.resourceType === "Observation")!;
  const recentDay = String(recentObs.resource.effectiveDateTime).slice(0, 10);
  const earlier = new Date(`${recentDay}T00:00:00Z`);
  earlier.setUTCDate(earlier.getUTCDate() - 30);
  // Both results inside the measurement year, or the earlier one would be ignored and prove nothing.
  assert.equal(earlier.toISOString().slice(0, 4), EVAL.slice(0, 4), "the earlier result is still in the measurement year");
  // An earlier, poorly controlled result in the same year: superseded by the recent one.
  const older: Entry = {
    resource: {
      ...recentObs.resource,
      id: `${String(recentObs.resource.id)}-older`,
      effectiveDateTime: earlier.toISOString().slice(0, 10),
      valueQuantity: { value: 10.5, unit: "%", system: "http://unitsofmeasure.org", code: "%" },
    },
  };
  assert.equal(await outcomeOf("cms122", withOlder(bundle, [older], false)), "COMPLIANT", "newest first");
  assert.equal(await outcomeOf("cms122", withOlder(bundle, [older], true)), "COMPLIANT", "oldest first");
});
