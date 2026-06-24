/** Outcome-Status parity (E11.1): for each migrated measure × synthetic scenario, the GENERATED CQL's
 * Outcome Status equals the HAND-WRITTEN measure's — proving codegen ≡ hand-written on the compliance
 * authority (ADR-008). Self-contained (both evaluated in Node).
 *   node --import tsx --test src/engine/cql/codegen/codegen-parity.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CqlExecutionEngine } from "../cql-execution-engine.ts";
import { compileCql } from "../cql-translator.ts";

const MIGRATED = ["mmr", "varicella", "hepatitis_b_vaccination_series", "audiogram", "hypertension", "cholesterol_ldl"];
const SCENARIOS = ["present_recent", "present_old", "missing", "excluded"];
const EVAL = "2026-06-12";

const synthRoot = fileURLToPath(new URL("../../../../spike/synthetic", import.meta.url));
const genRoot = fileURLToPath(new URL("../../../../measures/generated", import.meta.url));
const engine = new CqlExecutionEngine();

for (const measureId of MIGRATED) {
  test(`generated CQL matches hand-written Outcome Status for ${measureId}`, async () => {
    const generatedCql = readFileSync(path.join(genRoot, `${measureId}.cql`), "utf8");
    const compiled = compileCql(generatedCql);
    assert.ok(compiled.ok, `generated ${measureId} CQL must translate: ${JSON.stringify(compiled.diagnostics)}`);

    for (const scenario of SCENARIOS) {
      const bundle = JSON.parse(readFileSync(path.join(synthRoot, measureId, `${scenario}.json`), "utf8"));
      const handWritten = await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: EVAL });
      const generated = await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: EVAL, elm: compiled.elm });
      assert.equal(generated.outcome, handWritten.outcome, `${measureId}/${scenario}`);
    }
  });
}

// The shared 4-scenario fixtures only resolve to COMPLIANT/OVERDUE/MISSING_DATA/EXCLUDED, so they never
// exercise the windowed DUE_SOON band nor the series partial-dose boundary — the parametric surfaces this
// codegen actually adds. Construct those two cases inline and assert generated ≡ hand-written on them too.
const gen = (measureId: string): unknown =>
  compileCql(readFileSync(path.join(genRoot, `${measureId}.cql`), "utf8")).elm;
const bothOutcomes = async (measureId: string, bundle: unknown) => ({
  hand: (await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: EVAL })).outcome,
  generated: (await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: EVAL, elm: gen(measureId) })).outcome,
});
const conditionEntry = (pid: string, system: string, code: string) => ({
  resource: { resourceType: "Condition", id: `${pid}-c-${code}`, subject: { reference: `Patient/${pid}` }, code: { coding: [{ system, code }] } },
});

test("DUE_SOON band: generated ≡ hand-written (audiogram exam ~346 days old)", async () => {
  const pid = "audiogram-due_soon";
  const bundle = {
    resourceType: "Bundle", type: "collection",
    entry: [
      { resource: { resourceType: "Patient", id: pid } },
      conditionEntry(pid, "urn:workwell:vs:hearing-enrollment", "hearing-enrollment"),
      { resource: { resourceType: "Procedure", id: `${pid}-evt`, status: "completed", subject: { reference: `Patient/${pid}` },
        code: { coding: [{ system: "urn:workwell:vs:audiogram-procedures", code: "audiogram-procedure" }] },
        performedDateTime: "2025-07-01T00:00:00.000Z" } }, // ~346 days before 2026-06-12 → (335, 365]
    ],
  };
  const { hand, generated } = await bothOutcomes("audiogram", bundle);
  assert.equal(hand, "DUE_SOON", "fixture must land in the DUE_SOON band");
  assert.equal(generated, hand, "generated audiogram DUE_SOON parity");
});

test("partial series: generated ≡ hand-written (mmr with 1 of 2 doses → MISSING_DATA)", async () => {
  const pid = "mmr-partial";
  const bundle = {
    resourceType: "Bundle", type: "collection",
    entry: [
      { resource: { resourceType: "Patient", id: pid } },
      conditionEntry(pid, "urn:workwell:vs:immz-enrollment", "immz-enrolled"),
      { resource: { resourceType: "Immunization", id: `${pid}-d0`, status: "completed", patient: { reference: `Patient/${pid}` },
        vaccineCode: { coding: [{ system: "urn:workwell:vs:mmr-vaccines", code: "mmr-vaccine" }] }, occurrenceDateTime: "2026-04-23T00:00:00.000Z" } },
    ],
  };
  const { hand, generated } = await bothOutcomes("mmr", bundle);
  assert.equal(hand, "MISSING_DATA", "1 of 2 doses is an incomplete series");
  assert.equal(generated, hand, "generated mmr partial-series parity");
});
