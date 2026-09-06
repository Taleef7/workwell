import test from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

/**
 * The directory is composed on FIRST ACCESS and memoized, and every consumer reaches it through that
 * memo rather than holding an array captured at import.
 *
 * A note on what can and cannot be tested here, because the obvious test is vacuous. Setting
 * `WORKWELL_MAUI_CORPUS_SIZE` in a child process before it starts does NOT distinguish lazy from
 * eager: the variable is already set by the time any module is imported, so a module-load composition
 * reads it too and reports the same numbers. The defect an eager capture actually causes is
 * DIVERGENCE — `employees()` re-reads the memo while `DIRECTORY.employees` and the demo seed keep the
 * array they captured — so that is what the first test forces, by re-composing inside a live process
 * and asking every consumer again. It fails against a captured array; the before-import version does
 * not.
 */
test("no consumer holds a captured array — DIRECTORY and the demo seed follow a re-composition", () => {
  const out = runProfileChild("maui", `
    const profile = await import("./src/config/deployment-profile.ts");
    const seed = await import("./src/segment/segment-seed.ts");
    const sites = () => seed.demoSegments()[0].rule.conditions[0].value.length;
    const before = { employees: profile.employees().length, directory: profile.DIRECTORY.employees.length, sites: sites() };

    process.env.WORKWELL_MAUI_CORPUS_SIZE = "300";
    profile.__resetDeploymentDirectory();
    seed.__resetDemoSegments();

    console.log(JSON.stringify({
      before,
      after: {
        employees: profile.employees().length,
        directory: profile.DIRECTORY.employees.length,
        evaluable: profile.evaluableEmployees().length,
        resolvesLateSubject: profile.DIRECTORY.employeeById("pat-00300") !== null,
        sites: sites(),
      },
    }));
  `);
  assert.deepEqual(out.before, { employees: 48, directory: 48, sites: 2 }, "the default is the fixture prefix at two clinics");
  assert.deepEqual(out.after, {
    employees: 300,
    // These two are the assertions an eager capture fails: they would still read 48 while
    // `employees()` reported 300, and eleven modules take their roster from `DIRECTORY`.
    directory: 300,
    evaluable: 300,
    resolvesLateSubject: true,
    // 48 fixture patients sit at two clinics; 300 reaches all five, and the demo seed derives its
    // site list from the roster — a captured seed would still say 2.
    sites: 5,
  });
});

test("a worker booted with the size already set serves that corpus everywhere", () => {
  const out = runProfileChild("maui", `
    const { employees, DIRECTORY, evaluableEmployees } = await import("./src/config/deployment-profile.ts");
    const { demoSegments } = await import("./src/segment/segment-seed.ts");
    console.log(JSON.stringify({
      employees: employees().length,
      directoryEmployees: DIRECTORY.employees.length,
      evaluable: evaluableEmployees().length,
      sites: demoSegments()[0].rule.conditions[0].value.length,
      first: DIRECTORY.employees[0].externalId,
    }));
  `, { WORKWELL_MAUI_CORPUS_SIZE: "300" });
  assert.equal(out.employees, 300);
  assert.equal(out.directoryEmployees, 300);
  assert.equal(out.evaluable, 300);
  assert.equal(out.sites, 5);
  assert.equal(out.first, "pat-001", "the fixture prefix is still the prefix at any size");
});

test("with no size set, every consumer sees the 48-patient fixture prefix", () => {
  const out = runProfileChild("maui", `
    const { employees, DIRECTORY } = await import("./src/config/deployment-profile.ts");
    const { demoSegments } = await import("./src/segment/segment-seed.ts");
    console.log(JSON.stringify({
      employees: employees().length,
      directoryEmployees: DIRECTORY.employees.length,
      sites: demoSegments()[0].rule.conditions[0].value.length,
    }));
  `, { WORKWELL_MAUI_CORPUS_SIZE: undefined });
  assert.equal(out.employees, 48);
  assert.equal(out.directoryEmployees, 48);
  assert.equal(out.sites, 2);
});

test("the default profile is untouched by the corpus size", () => {
  const out = runProfileChild(undefined, `
    const { employees } = await import("./src/config/deployment-profile.ts");
    console.log(JSON.stringify({ employees: employees().length }));
  `, { WORKWELL_MAUI_CORPUS_SIZE: "5000" });
  // 198 = 150 evaluable + the 48 fixture patients the STATIC catalog still carries on this profile.
  // The corpus generator is reached only through the maui branch, so the size variable is inert here.
  assert.equal(out.employees, 198, "a Maui-only variable must not resize the default roster");
});
