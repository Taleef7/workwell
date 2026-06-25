/** Behavioral goldens for E11.2a codegen extensions — translate generated CQL → ELM (compileCql),
 * evaluate inline synthetic bundles, assert the resulting Outcome Status (+ Refused). No hand-written
 * CQL exists for these shapes, so the asserted outcomes ARE the golden.
 *   node --import tsx --test src/engine/cql/codegen/generate-cql-extensions.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CqlExecutionEngine } from "../cql-execution-engine.ts";
import { compileCql } from "../cql-translator.ts";
import { generateCql, type GenerateCqlInput } from "./generate-cql.ts";

const EVAL = "2026-06-12";
const engine = new CqlExecutionEngine();

async function evalGen(measureId: string, input: GenerateCqlInput, bundle: unknown) {
  const compiled = compileCql(generateCql(input));
  assert.ok(compiled.ok, `generated CQL must translate: ${JSON.stringify(compiled.diagnostics)}`);
  return engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: EVAL, elm: compiled.elm });
}

let seq = 0;
const bundle = (entries: unknown[]) => ({ resourceType: "Bundle", type: "collection", entry: entries });
const patient = (pid: string) => ({ resource: { resourceType: "Patient", id: pid } });
const condition = (pid: string, system: string, code: string) => ({
  resource: { resourceType: "Condition", id: `${pid}-c-${code}`, subject: { reference: `Patient/${pid}` }, code: { coding: [{ system, code }] } },
});
const procedure = (pid: string, system: string, code: string, performedDateTime: string) => ({
  resource: { resourceType: "Procedure", id: `${pid}-p`, status: "completed", subject: { reference: `Patient/${pid}` }, code: { coding: [{ system, code }] }, performedDateTime },
});
const immunization = (pid: string, system: string, code: string) => ({
  resource: { resourceType: "Immunization", id: `${pid}-i-${seq++}`, status: "completed", patient: { reference: `Patient/${pid}` }, vaccineCode: { coding: [{ system, code }] }, occurrenceDateTime: "2026-04-23T00:00:00.000Z" },
});
const observation = (pid: string, system: string, code: string, value: number) => ({
  resource: { resourceType: "Observation", id: `${pid}-o`, status: "final", subject: { reference: `Patient/${pid}` }, code: { coding: [{ system, code }] }, effectiveDateTime: "2026-04-23T00:00:00.000Z", valueQuantity: { value, unit: "ratio" } },
});
/** E11.2c — an Immunization with an explicit occurrence date. */
const immz = (pid: string, system: string, code: string, dateISO: string) => ({
  resource: { resourceType: "Immunization", id: `${pid}-i-${seq++}`, status: "completed", patient: { reference: `Patient/${pid}` }, vaccineCode: { coding: [{ system, code }] }, occurrenceDateTime: dateISO },
});

const WIN = {
  enrollment: { code: "e", valueSet: "urn:vs:e" },
  waiver: { code: "w", valueSet: "urn:vs:w" },
  event: { code: "ev", valueSet: "urn:vs:ev", type: "procedure" as const },
};
const winRule = (gracePeriodDays?: number): GenerateCqlInput => ({
  library: "AnnualAudiogramCompleted", version: "1.0.0",
  rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30, ...(gracePeriodDays != null ? { gracePeriodDays } : {}) },
  bindings: WIN,
});

test("grace shifts the OVERDUE boundary: a ~380-day-old exam is DUE_SOON with grace=30, OVERDUE with grace=0", async () => {
  const b = bundle([patient("g"), condition("g", "urn:vs:e", "e"), procedure("g", "urn:vs:ev", "ev", "2025-05-28T00:00:00.000Z")]);
  assert.equal((await evalGen("audiogram", winRule(30), b)).outcome, "DUE_SOON");
  assert.equal((await evalGen("audiogram", winRule(0), b)).outcome, "OVERDUE");
});

test("grace: an exam past the grace window is OVERDUE even with grace", async () => {
  const b = bundle([patient("g2"), condition("g2", "urn:vs:e", "e"), procedure("g2", "urn:vs:ev", "ev", "2025-01-01T00:00:00.000Z")]);
  assert.equal((await evalGen("audiogram", winRule(30), b)).outcome, "OVERDUE");
});

const SER = {
  enrollment: { code: "ie", valueSet: "urn:vs:ie" },
  waiver: { code: "wc", valueSet: "urn:vs:wc" },
  event: { code: "vx", valueSet: "urn:vs:vx", type: "immunization" as const },
  titer: { code: "ti", valueSet: "urn:vs:ti", minValue: 10 },
};
const serRule = (allowPositiveTiter: boolean): GenerateCqlInput => ({
  library: "MmrSeries", version: "1.0.0",
  rule: { type: "series-completion", requiredDoses: 2, allowPositiveTiter },
  bindings: SER,
});

test("titer: a positive titer (>= minValue) with 0 doses is COMPLIANT", async () => {
  const b = bundle([patient("t"), condition("t", "urn:vs:ie", "ie"), observation("t", "urn:vs:ti", "ti", 12)]);
  assert.equal((await evalGen("mmr", serRule(true), b)).outcome, "COMPLIANT");
});

test("titer: a sub-threshold titer (< minValue) with 0 doses is MISSING_DATA", async () => {
  const b = bundle([patient("t2"), condition("t2", "urn:vs:ie", "ie"), observation("t2", "urn:vs:ti", "ti", 8)]);
  assert.equal((await evalGen("mmr", serRule(true), b)).outcome, "MISSING_DATA");
});

test("titer: a partial series (1 of 2 doses) with no titer is MISSING_DATA", async () => {
  const b = bundle([patient("t3"), condition("t3", "urn:vs:ie", "ie"), immunization("t3", "urn:vs:vx", "vx")]);
  assert.equal((await evalGen("mmr", serRule(true), b)).outcome, "MISSING_DATA");
});

test("titer: disabled — a positive titer is ignored (0 doses → MISSING_DATA)", async () => {
  const b = bundle([patient("t4"), condition("t4", "urn:vs:ie", "ie"), observation("t4", "urn:vs:ti", "ti", 12)]);
  assert.equal((await evalGen("mmr", serRule(false), b)).outcome, "MISSING_DATA");
});

test("declination: a refusal Condition sets Refused=true; Outcome Status is the canonical bucket (MISSING_DATA)", async () => {
  const input: GenerateCqlInput = {
    library: "AnnualAudiogramCompleted", version: "1.0.0",
    rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30 },
    bindings: { ...WIN, refusal: { code: "rf", valueSet: "urn:vs:rf" } },
  };
  const b = bundle([patient("d"), condition("d", "urn:vs:e", "e"), condition("d", "urn:vs:rf", "rf")]);
  const res = await evalGen("audiogram", input, b);
  assert.equal(res.outcome, "MISSING_DATA");
  const refused = res.evidence.expressionResults.find((r) => r.define === "Refused");
  assert.ok(refused && /true/i.test(String(refused.result)), "Refused define must be true");
});

// E11.2c — multi-alternative series (Hep B: Heplisav-B 2-dose OR traditional 3-dose, multi-CVX, min intervals).
const HEPB_SYS = "urn:workwell:vs:hepb-vaccines";
const hepbRule: GenerateCqlInput = {
  library: "HepatitisBVaccinationSeries", version: "1.0.0",
  rule: {
    type: "series-completion", requiredDoses: 2,
    alternatives: [
      { label: "Heplisav-B", requiredDoses: 2, minIntervalDays: [28] },
      { label: "Traditional", requiredDoses: 3, minIntervalDays: [28, 56] },
    ],
  },
  bindings: {
    enrollment: { code: "ie", valueSet: "urn:vs:ie" },
    waiver: { code: "wc", valueSet: "urn:vs:wc" },
    event: { code: "hepb", valueSet: HEPB_SYS, type: "immunization" as const },
    eventAlternatives: [
      { label: "Heplisav-B", codes: [{ code: "189", valueSet: HEPB_SYS }] },
      { label: "Traditional", codes: [{ code: "08", valueSet: HEPB_SYS }, { code: "43", valueSet: HEPB_SYS }, { code: "44", valueSet: HEPB_SYS }, { code: "45", valueSet: HEPB_SYS }] },
    ],
  },
};
const enrolled = (pid: string) => condition(pid, "urn:vs:ie", "ie");

test("alternatives: 2 Heplisav (CVX 189) doses ≥28d apart → COMPLIANT", async () => {
  const b = bundle([patient("h1"), enrolled("h1"),
    immz("h1", HEPB_SYS, "189", "2026-01-01T00:00:00.000Z"),
    immz("h1", HEPB_SYS, "189", "2026-02-15T00:00:00.000Z")]); // 45d apart
  assert.equal((await evalGen("hepatitis_b_vaccination_series", hepbRule, b)).outcome, "COMPLIANT");
});

test("alternatives: 2 traditional (CVX 08) doses → MISSING_DATA (needs 3)", async () => {
  const b = bundle([patient("h2"), enrolled("h2"),
    immz("h2", HEPB_SYS, "08", "2026-01-01T00:00:00.000Z"),
    immz("h2", HEPB_SYS, "08", "2026-03-01T00:00:00.000Z")]);
  assert.equal((await evalGen("hepatitis_b_vaccination_series", hepbRule, b)).outcome, "MISSING_DATA");
});

test("alternatives: 3 traditional doses spaced 60d (≥28,≥56) → COMPLIANT", async () => {
  const b = bundle([patient("h3"), enrolled("h3"),
    immz("h3", HEPB_SYS, "08", "2026-01-01T00:00:00.000Z"),
    immz("h3", HEPB_SYS, "08", "2026-03-02T00:00:00.000Z"),  // 60d
    immz("h3", HEPB_SYS, "08", "2026-05-01T00:00:00.000Z")]); // 60d
  assert.equal((await evalGen("hepatitis_b_vaccination_series", hepbRule, b)).outcome, "COMPLIANT");
});

test("alternatives: 3 traditional doses where one consecutive gap is 27d (<28) → MISSING_DATA", async () => {
  const b = bundle([patient("h4"), enrolled("h4"),
    immz("h4", HEPB_SYS, "08", "2026-01-01T00:00:00.000Z"),
    immz("h4", HEPB_SYS, "08", "2026-01-28T00:00:00.000Z"),  // 27d gap (<28)
    immz("h4", HEPB_SYS, "08", "2026-05-01T00:00:00.000Z")]);
  assert.equal((await evalGen("hepatitis_b_vaccination_series", hepbRule, b)).outcome, "MISSING_DATA");
});

test("alternatives: 3 traditional doses with a gap exactly 28d (inclusive boundary) → COMPLIANT", async () => {
  const b = bundle([patient("h5"), enrolled("h5"),
    immz("h5", HEPB_SYS, "08", "2026-01-01T00:00:00.000Z"),
    immz("h5", HEPB_SYS, "08", "2026-01-29T00:00:00.000Z"),  // exactly 28d
    immz("h5", HEPB_SYS, "08", "2026-03-26T00:00:00.000Z")]); // 56d after
  assert.equal((await evalGen("hepatitis_b_vaccination_series", hepbRule, b)).outcome, "COMPLIANT");
});

test("alternatives: 1 Heplisav + 1 traditional (mixed brand, neither alt complete) → MISSING_DATA", async () => {
  const b = bundle([patient("h6"), enrolled("h6"),
    immz("h6", HEPB_SYS, "189", "2026-01-01T00:00:00.000Z"),
    immz("h6", HEPB_SYS, "08", "2026-03-01T00:00:00.000Z")]);
  assert.equal((await evalGen("hepatitis_b_vaccination_series", hepbRule, b)).outcome, "MISSING_DATA");
});

test("alternatives: enrollment + a contraindication condition → EXCLUDED", async () => {
  const b = bundle([patient("h7"), enrolled("h7"), condition("h7", "urn:vs:wc", "wc")]);
  assert.equal((await evalGen("hepatitis_b_vaccination_series", hepbRule, b)).outcome, "EXCLUDED");
});
