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
