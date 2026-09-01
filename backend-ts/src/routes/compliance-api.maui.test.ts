import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function runMaui(source: string): Record<string, unknown> {
  const env = { ...process.env, WORKWELL_INSTANCE: "maui" };
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    { cwd: backendRoot, env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

test("latest can read a persisted measure outside Maui while preview refuses it", () => {
  const output = runMaui(`
    import { createSqliteD1 } from "@mieweb/cloud-local";
    import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
    import { SqliteRunStore } from "./src/stores/sqlite/run-store-sqlite.ts";
    import { SqliteOutcomeStore } from "./src/stores/sqlite/outcome-store-sqlite.ts";
    import { handleComplianceApi } from "./src/routes/compliance-api.ts";

    const db = await createSqliteD1(":memory:");
    await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
    const runStore = new SqliteRunStore(db);
    const outcomes = new SqliteOutcomeStore(db);
    const run = await runStore.createRun({
      scopeType: "MEASURE",
      scopeId: "audiogram",
      triggeredBy: "test",
      requestedScope: { measureId: "audiogram" },
      measurementPeriodStart: "2026-08-01T00:00:00.000Z",
      measurementPeriodEnd: "2026-08-01T00:00:00.000Z",
    });
    await runStore.finalizeRun(run.id, "COMPLETED");
    await outcomes.recordOutcome({
      runId: run.id,
      subjectId: "pat-001",
      measureId: "audiogram",
      status: "COMPLIANT",
      evaluationPeriod: "2026-08-01",
      evidence: { expressionResults: [] },
    });
    const env = { DB: db };
    const latest = await handleComplianceApi(
      new Request("http://x/api/v1/compliance/pat-001/audiogram?mode=latest"),
      env,
    );
    const preview = await handleComplianceApi(
      new Request("http://x/api/v1/compliance/pat-001/audiogram?mode=preview"),
      env,
      "ROLE_CASE_MANAGER",
    );
    console.log(JSON.stringify({
      latest: latest.status,
      preview: preview.status,
      previewBody: await preview.json(),
    }));
  `);
  assert.equal(output.latest, 200);
  assert.equal(output.preview, 400);
  assert.equal((output.previewBody as { error: string }).error, "measure_not_in_profile");
});
