import { test } from "node:test";
import assert from "node:assert/strict";
import { PANELS, DEFAULT_PANEL, isPanelId, AVAILABLE_PANELS, PROFILE_DEFAULT_PANEL, RUNNABLE_PANELS } from "./panels.ts";
import { runProfileChild } from "../test-support/run-profile-child.ts";

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
  // Pins identity on the default profile: all measures are Active and runnable, so runnable panels equal raw PANELS.
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

test("measures in MEASURES but not Active in MEASURE_CATALOG do not keep a panel in availablePanels", () => {
  const output = runProfileChild(undefined, `
    import { MEASURE_CATALOG } from "./src/measure/measure-catalog.ts";
    for (const m of MEASURE_CATALOG) {
      if (m.id === "audiogram" || m.id === "hazwoper" || m.id === "tb_surveillance") {
        m.status = "Draft";
      }
    }
    const { AVAILABLE_PANELS, RUNNABLE_PANELS } = await import("./src/compliance/panels.ts");
    const { buildRoster } = await import("./src/compliance/roster-read-model.ts");
    const roster = await buildRoster({
      outcomeStore: {
        async listLatestPopulationOutcomes() { return []; },
        async listOutcomes() { return []; },
      },
      segments: [],
    }, { panel: "osha" });

    console.log(JSON.stringify({
      availablePanels: AVAILABLE_PANELS,
      runnableOsha: RUNNABLE_PANELS.osha,
      servedPanel: roster.panel,
      columns: roster.columns.map((c) => c.measureId),
    }));
  `);

  assert.deepEqual(output.runnableOsha, []);
  assert.deepEqual(output.availablePanels, ["immunizations", "wellness"]);
  assert.equal(output.servedPanel, "immunizations");
  assert.ok((output.columns as string[]).length > 0);
  assert.ok(!(output.columns as string[]).includes("audiogram"));
});

test("MM-1 shape: a profile whose runnable measures belong to no panel serves zero columns, and says so via availablePanels", () => {
  const output = runProfileChild(undefined, `
    import { MEASURE_CATALOG } from "./src/measure/measure-catalog.ts";
    const panelMeasureIds = new Set([
      "mmr", "varicella", "hepatitis_b_vaccination_series", "adult_immunization", "flu_vaccine",
      "audiogram", "hazwoper", "tb_surveillance",
      "hypertension", "diabetes_hba1c", "obesity_bmi", "cholesterol_ldl", "cms122", "cms125"
    ]);
    for (const m of MEASURE_CATALOG) {
      if (panelMeasureIds.has(m.id)) {
        m.status = "Draft";
      }
    }
    const { AVAILABLE_PANELS, PROFILE_DEFAULT_PANEL, RUNNABLE_PANELS } = await import("./src/compliance/panels.ts");
    const { buildRoster } = await import("./src/compliance/roster-read-model.ts");
    const roster = await buildRoster({
      outcomeStore: {
        async listLatestPopulationOutcomes() { return []; },
        async listOutcomes() { return []; },
      },
      segments: [],
    }, {});

    console.log(JSON.stringify({
      availablePanels: AVAILABLE_PANELS,
      defaultPanel: PROFILE_DEFAULT_PANEL,
      servedPanel: roster.panel,
      columns: roster.columns,
      runnablePanels: RUNNABLE_PANELS,
    }));
  `);

  // `availablePanels: []` is the honest signal a client reads; `panel` keeps its non-null contract
  // (ADR-061 stability) and degenerates to DEFAULT_PANEL, which by construction now has zero columns.
  // The pairing is what matters: a served panel absent from availablePanels must carry NO columns, so a
  // client can never render a populated grid for a panel it was told is unavailable.
  assert.deepEqual(output.availablePanels, []);
  assert.equal(output.defaultPanel, "immunizations");
  assert.equal(output.servedPanel, "immunizations");
  assert.deepEqual(output.columns, []);
  assert.ok(!(output.availablePanels as string[]).includes(output.servedPanel as string));
});
