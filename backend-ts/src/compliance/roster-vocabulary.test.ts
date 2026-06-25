import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCell } from "./roster-vocabulary.ts";

// Evidence is the engine's `{ expressionResults: [{define, result}] }` shape.
const ev = (results: Array<[string, unknown]>) => ({ expressionResults: results.map(([define, result]) => ({ define, result })) });
const PERIOD = "2026-06-12";

test("PERMANENT COMPLIANT → COMPLIANT + dose-count method", () => {
  const cell = deriveCell("COMPLIANT", ev([["Dose Count", 2], ["Refused", false]]), "mmr", PERIOD);
  assert.deepEqual(cell, { status: "COMPLIANT", method: "2 valid dose(s)" });
});

test("PERMANENT COMPLIANT via positive titer (0 doses) → immunity method, not '0 valid dose(s)' (E11.2a)", () => {
  const cell = deriveCell("COMPLIANT", ev([["Dose Count", 0], ["Has Positive Titer", true], ["Refused", false]]), "mmr", PERIOD);
  assert.deepEqual(cell, { status: "COMPLIANT", method: "Immune (positive titer)" });
});

test("PERMANENT COMPLIANT with a full series still shows doses even if a titer is also present", () => {
  const cell = deriveCell("COMPLIANT", ev([["Dose Count", 2], ["Has Positive Titer", true], ["Refused", false]]), "mmr", PERIOD);
  assert.deepEqual(cell, { status: "COMPLIANT", method: "2 valid dose(s)" });
});

test("PERMANENT partial series → IN_PROGRESS (canonical MISSING_DATA)", () => {
  const cell = deriveCell("MISSING_DATA", ev([["Dose Count", 1], ["Refused", false]]), "mmr", PERIOD);
  assert.deepEqual(cell, { status: "IN_PROGRESS", method: "1 of 2 doses on file" });
});

test("PERMANENT no doses → MISSING_DATA", () => {
  const cell = deriveCell("MISSING_DATA", ev([["Dose Count", 0], ["Refused", false]]), "mmr", PERIOD);
  assert.deepEqual(cell, { status: "MISSING_DATA", method: "No doses on file" });
});

test("documented refusal → DECLINED (not excluded, case stays open)", () => {
  const cell = deriveCell("MISSING_DATA", ev([["Dose Count", 0], ["Refused", true]]), "mmr", PERIOD);
  assert.equal(cell.status, "DECLINED");
});

test("contraindication → EXCLUDED wins over refusal", () => {
  const cell = deriveCell("EXCLUDED", ev([["Dose Count", 0], ["Refused", true]]), "mmr", PERIOD);
  assert.equal(cell.status, "EXCLUDED");
});

test("RECURRING OVERDUE → OVERDUE + recency method", () => {
  const cell = deriveCell(
    "OVERDUE",
    ev([["Most Recent Audiogram Date", "2024-01-10T00:00:00Z"], ["Days Since Last Audiogram", 884]]),
    "audiogram",
    PERIOD,
  );
  assert.equal(cell.status, "OVERDUE");
  assert.match(cell.method, /2024-01-10/);
});

test("RECURRING COMPLIANT → COMPLIANT", () => {
  const cell = deriveCell(
    "COMPLIANT",
    ev([["Most Recent Audiogram Date", "2026-03-10T00:00:00Z"], ["Days Since Last Audiogram", 94]]),
    "audiogram",
    PERIOD,
  );
  assert.equal(cell.status, "COMPLIANT");
});

// E11.2c — repointed Hep B (multi-alternative series). deriveCell reads the union `Dose Count` define
// (still emitted by the alternatives CQL) + series.requiredDoses (2) for the method string only; the
// canonical bucket comes from CQL Outcome Status (ADR-008). The roster behavior is unchanged.
test("repointed Hep B COMPLIANT (2 doses) → COMPLIANT + dose-count method", () => {
  const cell = deriveCell("COMPLIANT", ev([["Dose Count", 2], ["Refused", false]]), "hepatitis_b_vaccination_series", PERIOD);
  assert.deepEqual(cell, { status: "COMPLIANT", method: "2 valid dose(s)" });
});

test("repointed Hep B partial (1 dose, canonical MISSING_DATA) → IN_PROGRESS '1 of 2 doses on file'", () => {
  // Display nuance: the IN_PROGRESS denominator uses the union series.requiredDoses (2), so a partial
  // traditional-3 series under-reads as "1 of 2". Accepted — CQL Outcome Status is authoritative.
  const cell = deriveCell("MISSING_DATA", ev([["Dose Count", 1], ["Refused", false]]), "hepatitis_b_vaccination_series", PERIOD);
  assert.deepEqual(cell, { status: "IN_PROGRESS", method: "1 of 2 doses on file" });
});

test("repointed Hep B no doses → MISSING_DATA", () => {
  const cell = deriveCell("MISSING_DATA", ev([["Dose Count", 0], ["Refused", false]]), "hepatitis_b_vaccination_series", PERIOD);
  assert.deepEqual(cell, { status: "MISSING_DATA", method: "No doses on file" });
});

test("RECURRING measure with a documented refusal → DECLINED (class-agnostic refusal check)", () => {
  // adult_immunization is RECURRING but has a Refused define; a refusal displays DECLINED regardless
  // of class (the canonical bucket stays OVERDUE — refusal keeps the case open, never excludes).
  const cell = deriveCell(
    "OVERDUE",
    ev([["Refused", true], ["Most Recent Tdap Date", "2010-01-01T00:00:00Z"], ["Days Since Last Tdap", 6000]]),
    "adult_immunization",
    PERIOD,
  );
  assert.equal(cell.status, "DECLINED");
});
