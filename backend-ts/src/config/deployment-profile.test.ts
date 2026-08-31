import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import {
  EMPLOYEES as RAW_EMPLOYEES,
  PROVIDERS as RAW_PROVIDERS,
  TENANTS as RAW_TENANTS,
} from "../engine/synthetic/employee-catalog.ts";
import { seededDistribution } from "../run/distribution.ts";
import {
  composeDeploymentDirectory,
  DEPLOYMENT_PROFILE,
  EVALUABLE_EMPLOYEES,
  EMPLOYEES,
  EVALUATION_EXCLUDED_TENANTS,
  isRunnableMeasure,
  PROVIDERS,
  resolveDeploymentProfile,
  RUNNABLE_MEASURE_IDS,
  TENANTS,
  employeeById,
  providerById,
} from "./deployment-profile.ts";

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

test("resolveDeploymentProfile is pure, normalized, and defaults safely", () => {
  assert.deepEqual(resolveDeploymentProfile(undefined), resolveDeploymentProfile(""));
  assert.equal(resolveDeploymentProfile(" TWH ").id, "default");
  assert.equal(resolveDeploymentProfile("unknown").id, "default");
  assert.deepEqual(resolveDeploymentProfile(" Maui "), {
    id: "maui",
    visibleTenantIds: ["maui"],
    runnableMeasureIds: ["cms122", "cms125", "hypertension"],
  });
});

test("pure directory composition scopes both profiles after full attribution", () => {
  const defaultDirectory = composeDeploymentDirectory(resolveDeploymentProfile(undefined));
  assert.deepEqual(defaultDirectory.EMPLOYEES, RAW_EMPLOYEES);
  assert.deepEqual(defaultDirectory.PROVIDERS, RAW_PROVIDERS);
  assert.deepEqual(defaultDirectory.TENANTS, RAW_TENANTS);
  assert.deepEqual(defaultDirectory.EVALUABLE_EMPLOYEES, EVALUABLE_EMPLOYEES);
  assert.deepEqual([...defaultDirectory.EVALUATION_EXCLUDED_TENANTS], ["maui"]);

  const maui = composeDeploymentDirectory(resolveDeploymentProfile("maui"));
  assert.equal(maui.EMPLOYEES.length, 48);
  assert.equal(maui.PROVIDERS.length, 4);
  assert.deepEqual(maui.TENANTS.map((tenant) => tenant.id), ["maui"]);
  assert.deepEqual([...maui.EVALUATION_EXCLUDED_TENANTS], RAW_TENANTS.filter((t) => t.id !== "maui").map((t) => t.id));
  assert.equal(maui.EVALUABLE_EMPLOYEES.length, 48);
  assert.equal(maui.employeeById("emp-001"), null);
  assert.match(maui.employeeById("pat-001")?.providerId ?? "", /^maui-prov-/);
  assert.equal(maui.providerById("prov-001"), null);
  assert.equal(maui.providerById("maui-prov-001")?.tenantId, "maui");
});

/**
 * Pre-existing hash behavior: sequential `pat-*` ids cluster in the `orderKey` band, so Maui is
 * ordered essentially `pat-001` through `pat-048` for every rate key. CMS122 and CMS125 therefore
 * receive identical targets; changing that would reshuffle the legacy `emp-*` distribution too.
 */
test("Maui distribution counts stay pinned to the measured target buckets", () => {
  const maui = composeDeploymentDirectory(resolveDeploymentProfile("maui"));
  const expected = {
    cms122: { COMPLIANT: 38, EXCLUDED: 3, MISSING_DATA: 2, DUE_SOON: 2, OVERDUE: 3 },
    cms125: { COMPLIANT: 38, EXCLUDED: 3, MISSING_DATA: 2, DUE_SOON: 2, OVERDUE: 3 },
    hypertension: { COMPLIANT: 35, EXCLUDED: 3, MISSING_DATA: 2, DUE_SOON: 4, OVERDUE: 4 },
  };
  const actual = Object.fromEntries(
    Object.keys(expected).map((measureId) => {
      const assignments = seededDistribution(maui.EVALUABLE_EMPLOYEES, MEASURE_BINDINGS[measureId]!.rateKey);
      return [measureId, Object.fromEntries(Object.keys(expected[measureId as keyof typeof expected]).map((bucket) => [
        bucket,
        assignments.filter((assignment) => assignment.target === bucket).length,
      ]))];
    }),
  );
  assert.deepEqual(actual, expected);
});

test("the loaded default module exports the default scoped directory and measure set", () => {
  assert.equal(DEPLOYMENT_PROFILE.id, "default");
  assert.deepEqual(EMPLOYEES, RAW_EMPLOYEES);
  assert.deepEqual(PROVIDERS, RAW_EMPLOYEES.length > 0 ? composeDeploymentDirectory(resolveDeploymentProfile(undefined)).PROVIDERS : []);
  assert.deepEqual(TENANTS, RAW_TENANTS);
  assert.equal(EVALUABLE_EMPLOYEES.length, 150);
  assert.deepEqual([...EVALUATION_EXCLUDED_TENANTS], ["maui"]);
  assert.deepEqual(RUNNABLE_MEASURE_IDS, Object.keys(MEASURES));
  assert.equal(isRunnableMeasure("audiogram"), true);
  assert.equal(isRunnableMeasure("hazwoper"), true);
  assert.equal(employeeById("pat-001")?.tenantId, "maui");
  assert.equal(providerById("maui-prov-001")?.tenantId, "maui");
});

test("a fresh Maui process wires the profile into counts and /api/tenants", async () => {
  const output = runProfileChild("maui", `
    import { EMPLOYEES, PROVIDERS, TENANTS, EVALUABLE_EMPLOYEES, EVALUATION_EXCLUDED_TENANTS, RUNNABLE_MEASURE_IDS, isRunnableMeasure } from "./src/config/deployment-profile.ts";
    import { handleTenants } from "./src/routes/tenants.ts";
    const response = await handleTenants(new Request("http://localhost/api/tenants"), {});
    console.log(JSON.stringify({
      employees: EMPLOYEES.length,
      providers: PROVIDERS.length,
      tenants: TENANTS.map((t) => t.id),
      evaluable: EVALUABLE_EMPLOYEES.length,
      excluded: [...EVALUATION_EXCLUDED_TENANTS],
      runnable: RUNNABLE_MEASURE_IDS,
      audiogramRunnable: isRunnableMeasure("audiogram"),
      tenantRoute: await response.json(),
    }));
  `);
  assert.equal(output.employees, 48);
  assert.equal(output.providers, 4);
  assert.deepEqual(output.tenants, ["maui"]);
  assert.equal(output.evaluable, 48);
  assert.deepEqual(output.excluded, ["twh", "ihn", "mhn"]);
  assert.deepEqual(output.runnable, ["cms122", "cms125", "hypertension"]);
  assert.equal(output.audiogramRunnable, false);
  assert.deepEqual(output.tenantRoute, [{ id: "maui", name: "Maui Pilot Clinic" }]);
});

test("Maui run planning accepts patients and refuses hidden employees and occupational measures", () => {
  const output = runProfileChild("maui", `
    import { planManualRun } from "./src/run/run-pipeline.ts";
    const deps = {
      runStore: {
        async createRun() { return { id: "run" }; },
        async markRunning() {},
        async appendLog() {},
      },
      outcomeStore: {},
      engine: {},
    };
    async function attempt(request) {
      try {
        const planned = await planManualRun(deps, request);
        return { ok: true, total: planned.items.length, measures: planned.measureIds };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    }
    console.log(JSON.stringify({
      patient: await attempt({ scopeType: "EMPLOYEE", employeeExternalId: "pat-001" }),
      employee: await attempt({ scopeType: "EMPLOYEE", employeeExternalId: "emp-001" }),
      occupational: await attempt({ scopeType: "MEASURE", measureId: "audiogram" }),
    }));
  `);
  assert.deepEqual(output.patient, { ok: true, total: 3, measures: ["cms122", "cms125", "hypertension"] });
  assert.equal((output.employee as { ok: boolean }).ok, false);
  assert.match((output.employee as { message: string }).message, /Unknown employee/);
  assert.equal((output.occupational as { ok: boolean }).ok, false);
  assert.match((output.occupational as { message: string }).message, /maui/);
});

test("default and unrecognized profiles refuse the Maui patient without throwing at load", () => {
  const source = `
    import { planManualRun } from "./src/run/run-pipeline.ts";
    const deps = { runStore: { async createRun() { return { id: "run" }; }, async markRunning() {}, async appendLog() {} }, outcomeStore: {}, engine: {} };
    try {
      await planManualRun(deps, { scopeType: "EMPLOYEE", employeeExternalId: "pat-001" });
      console.log(JSON.stringify({ ok: true }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, message: error.message }));
    }
  `;
  const defaultResult = runProfileChild(undefined, source);
  assert.equal(defaultResult.ok, false);
  assert.match(defaultResult.message as string, /directory-only/);
  const fallbackResult = runProfileChild("not-a-profile", source);
  assert.equal(fallbackResult.ok, false);
  assert.match(fallbackResult.message as string, /directory-only/);
});
