import { test } from "node:test";
import assert from "node:assert/strict";
import { PANELS, DEFAULT_PANEL, isPanelId, AVAILABLE_PANELS, PROFILE_DEFAULT_PANEL, RUNNABLE_PANELS } from "./panels.ts";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function runProfileChild(instance: string | undefined, source: string): Record<string, unknown> {
  const env = { ...process.env };
  if (instance === undefined) delete env.WORKWELL_INSTANCE;
  else env.WORKWELL_INSTANCE = instance;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    { cwd: backendRoot, env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

test("panels expose the three column sets and a default", () => {
  assert.deepEqual(Object.keys(PANELS).sort(), ["immunizations", "osha", "wellness"]);
  assert.ok(PANELS.immunizations.includes("mmr"));
  assert.ok(PANELS.immunizations.includes("hepatitis_b_vaccination_series"));
  assert.equal(DEFAULT_PANEL, "immunizations");
});

test("isPanelId narrows known panel ids", () => {
  assert.equal(isPanelId("osha"), true);
  assert.equal(isPanelId("nope"), false);
});

test("profile-aware exports equal raw constants on default profile", () => {
  assert.deepEqual(RUNNABLE_PANELS, PANELS);
  assert.deepEqual(AVAILABLE_PANELS, ["immunizations", "osha", "wellness"]);
  assert.equal(PROFILE_DEFAULT_PANEL, "immunizations");
});

test("Maui profile scopes panels and roster columns to runnable measures", () => {
  const output = runProfileChild("maui", `
    import { AVAILABLE_PANELS, PROFILE_DEFAULT_PANEL, RUNNABLE_PANELS } from "./src/compliance/panels.ts";
    import { buildRoster } from "./src/compliance/roster-read-model.ts";

    const roster = await buildRoster({
      outcomeStore: {
        async listLatestPopulationOutcomes() { return []; },
        async listOutcomes() { return []; },
      },
      segments: [],
    }, { panel: "immunizations" });

    const wellnessRoster = await buildRoster({
      outcomeStore: {
        async listLatestPopulationOutcomes() { return []; },
        async listOutcomes() { return []; },
      },
      segments: [],
    }, { panel: "wellness" });

    const allColumns = [
      ...roster.columns.map((c) => c.measureId),
      ...wellnessRoster.columns.map((c) => c.measureId),
      ...RUNNABLE_PANELS.immunizations,
      ...RUNNABLE_PANELS.osha,
      ...RUNNABLE_PANELS.wellness,
    ];

    console.log(JSON.stringify({
      availablePanels: AVAILABLE_PANELS,
      defaultPanel: PROFILE_DEFAULT_PANEL,
      servedPanel: roster.panel,
      columnCount: roster.columns.length,
      columns: roster.columns.map((c) => c.measureId),
      allColumns: [...new Set(allColumns)],
    }));
  `);

  assert.deepEqual(output.availablePanels, ["wellness"]);
  assert.equal(output.defaultPanel, "wellness");
  assert.equal(output.servedPanel, "wellness");
  assert.ok((output.columnCount as number) > 0);
  const allowed = new Set(["cms122", "cms125", "hypertension"]);
  for (const col of output.allColumns as string[]) {
    assert.ok(allowed.has(col), `column ${col} must be in allowed Maui measures`);
  }
});
