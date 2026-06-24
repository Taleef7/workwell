/** The committed measures/generated/<id>.cql files exist + have the right shape.
 *   node --import tsx --test src/engine/cql/codegen/generated-files.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const genDir = fileURLToPath(new URL("../../../../measures/generated", import.meta.url));

test("generated/ contains the 6 migrated measures", () => {
  const files = readdirSync(genDir).filter((f) => f.endsWith(".cql")).sort();
  assert.deepEqual(files, [
    "audiogram.cql", "cholesterol_ldl.cql", "hepatitis_b_vaccination_series.cql", "hypertension.cql", "mmr.cql", "varicella.cql",
  ]);
});

test("each generated CQL has a library header + an Outcome Status define", () => {
  for (const f of readdirSync(genDir).filter((x) => x.endsWith(".cql"))) {
    const cql = readFileSync(path.join(genDir, f), "utf8");
    assert.match(cql, /^library \S+ version '/, `${f} library header`);
    assert.match(cql, /define "Outcome Status":/, `${f} Outcome Status`);
  }
});
