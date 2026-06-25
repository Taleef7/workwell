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
