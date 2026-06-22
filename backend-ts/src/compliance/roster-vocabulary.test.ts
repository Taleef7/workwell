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
