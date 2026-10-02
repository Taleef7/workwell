/**
 * db tests — the observation reading rule. The dev seed holds no deleted or unknown-status row in any
 * measure's code set, so the live parity gate stays green whatever the status filter says; these
 * assertions are what fail if it drifts, in the shim or in the fixture export that mirrors it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OBSERVATIONS_FOR_PATIENT_SQL } from "./db.ts";

const FINAL_ONLY = "o.obs_status IN ('','F')";

test("observations are read from the result history, dated by when they were observed", () => {
  const sql = OBSERVATIONS_FOR_PATIENT_SQL;
  assert.match(sql, /FROM observations o JOIN/);
  assert.ok(!sql.includes("observations_current"), "the cache's dates are refresh times and its values are NULL");
  assert.match(sql, /DATE_FORMAT\(o\.observed_datetime,/);
});

test("only a final result is served: a deleted or unknown-status row never becomes a final Observation", () => {
  assert.ok(OBSERVATIONS_FOR_PATIENT_SQL.includes(FINAL_ONLY), OBSERVATIONS_FOR_PATIENT_SQL);
  assert.ok(!/obs_status\s*<>/.test(OBSERVATIONS_FOR_PATIENT_SQL), "an allowlist, not a denylist");
});

test("the fixture export reads observations by the same rule as the shim", () => {
  const script = readFileSync(
    fileURLToPath(new URL("../../backend-ts/scripts/webchart-devdb-export.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(script.includes(FINAL_ONLY), "webchart-devdb-export.ts must filter the status as the shim does");
  assert.match(script, /FROM observations o JOIN/);
  assert.match(script, /DATE_FORMAT\(o\.observed_datetime,/);
});
