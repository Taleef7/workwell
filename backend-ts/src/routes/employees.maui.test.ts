import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const testScript = `
  import { createSqliteD1 } from "@mieweb/cloud-local";
  import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
  import { handleEmployees } from "./src/routes/employees.ts";

  const db = await createSqliteD1(":memory:");
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
  const env = { DB: db };

  const niloRes = await handleEmployees(new Request("http://x/api/employees/search?q=nilo"), env);
  const nilo = await niloRes.json();

  const omarRes = await handleEmployees(new Request("http://x/api/employees/search?q=omar"), env);
  const omar = await omarRes.json();

  console.log(JSON.stringify({ nilo, omar }));
`;

test("scoped profile (Maui) — employees search returns Maui patients and excludes TWH employees", () => {
  const output = runProfileChild("maui", testScript);
  const nilo = output.nilo as Array<{ externalId: string; name: string; site: string }>;
  const omar = output.omar as Array<{ externalId: string; name: string }>;

  assert.equal(nilo.length, 1, "Maui search for 'nilo' must return exactly 1 result");
  assert.equal(nilo[0]?.externalId, "pat-048", "returned patient must be pat-048");
  assert.equal(nilo[0]?.name, "Nilo Gray", "returned patient name must be Nilo Gray");
  assert.deepEqual(omar, [], "TWH-only name must return empty array on Maui profile");
});

const profileScript = `
  import { createSqliteD1 } from "@mieweb/cloud-local";
  import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
  import { SqliteRunStore } from "./src/stores/sqlite/run-store-sqlite.ts";
  import { SqliteOutcomeStore } from "./src/stores/sqlite/outcome-store-sqlite.ts";
  import { handleEmployees } from "./src/routes/employees.ts";

  const db = await createSqliteD1(":memory:");
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "test",
    status: "COMPLETED",
    measurementPeriodStart: "2026-01-01T00:00:00.000Z",
    measurementPeriodEnd: "2026-12-31T23:59:59.999Z",
  });
  const outcomes = new SqliteOutcomeStore(db);
  // An old authored-era outcome the pilot does not measure, beside two of the six it does.
  for (const [measureId, status] of [["hypertension", "COMPLIANT"], ["cms130", "OVERDUE"], ["cms122", "COMPLIANT"]]) {
    await outcomes.recordOutcome({ runId: run.id, subjectId: "pat-003", measureId, evaluationPeriod: "2026-09-01", status, evidence: {} });
  }
  const res = await handleEmployees(new Request("http://x/api/employees/pat-003/profile"), { DB: db });
  const profile = await res.json();
  console.log(JSON.stringify({ status: res.status, outcomes: profile.measureOutcomes.map((o) => ({ id: o.measureId, name: o.measureName })) }));
`;

test("Maui patient page lists only the measures the deployment runs, by name (#671)", () => {
  const output = runProfileChild("maui", profileScript, {
    WORKWELL_OFFICIAL_MEASURES: "cms122,cms125,cms2,cms130,cms165,cms137",
  });
  assert.equal(output.status, 200);
  const outcomes = output.outcomes as Array<{ id: string; name: string }>;
  assert.deepEqual(outcomes.map((o) => o.id).sort(), ["cms122", "cms130"], "hypertension is not one of the six");
  assert.equal(
    outcomes.find((o) => o.id === "cms130")?.name,
    "Colorectal Cancer Screening",
    "an official-only measure is named from the catalog, not by its id",
  );
});

test("default profile — employees search returns both Maui and TWH employees", () => {
  const output = runProfileChild(undefined, testScript);
  const nilo = output.nilo as Array<{ externalId: string; name: string }>;
  const omar = output.omar as Array<{ externalId: string; name: string }>;

  assert.equal(nilo.length, 1, "default profile search for 'nilo' returns pat-048");
  assert.equal(nilo[0]?.externalId, "pat-048");
  assert.ok(omar.length > 0, "TWH employee returns results on default profile");
  assert.ok(omar.some((e) => e.externalId === "emp-006"), "returns Omar Siddiq (emp-006)");
});

// #769: the patient page names the logic of the rows it shows, from their own evidence, with CMS137 ROUTED
// to CMS's artifact — so a reader that asked routing (or the vendored manifest) would say CMS137FHIR.
const logicScript = `
  import { createSqliteD1 } from "@mieweb/cloud-local";
  import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
  import { SqliteRunStore } from "./src/stores/sqlite/run-store-sqlite.ts";
  import { SqliteOutcomeStore } from "./src/stores/sqlite/outcome-store-sqlite.ts";
  import { SqliteCaseStore } from "./src/stores/sqlite/case-store-sqlite.ts";
  import { SqliteCaseEventStore } from "./src/stores/sqlite/case-event-store-sqlite.ts";
  import { handleEmployees } from "./src/routes/employees.ts";
  import { getEmployeeProfile } from "./src/run/employee-profile.ts";

  const db = await createSqliteD1(":memory:");
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
  const runs = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  const cases = new SqliteCaseStore(db);
  const nightly = (startedAt) => runs.createRun({
    scopeType: "ALL_PROGRAMS", triggeredBy: "scheduler", status: "COMPLETED", startedAt,
    measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2027-12-31T23:59:59.999Z",
  });
  const run2026 = await nightly("2026-12-01T12:00:00.000Z");
  const run2027 = await nightly("2027-02-01T12:00:00.000Z");
  const CMS137 = { official: { ecqmId: "137FHIR", version: "1.0.000", engine: "fqm-execution", artifactSha256: "sha256:01e9499c10b252636ea58805a9f913685dc867eec23bd586429520cc966f0a24" } };
  const TRANSLATION = { official: { kind: "derived", label: "WorkWell translation of CMS137v15", url: "urn:workwell:measure:cms137:translation", derivedFrom: "CMS137v15", ecqmId: null, version: "ww-2027.1" } };
  const CMS125 = { official: { ecqmId: "125FHIR", version: "1.0.000", engine: "fqm-execution", artifactSha256: "sha256:97f737fa5262fca1fbb4620e10ce286f612b87b7de4c3fc06fdfe38dfb666ac8" } };
  const record = (runId, measureId, period, status, evidence) =>
    outcomes.recordOutcome({ runId, subjectId: "pat-003", measureId, evaluationPeriod: period, status, evidence });
  await record(run2026.id, "cms137", "2026-01-01", "OVERDUE", CMS137);
  // The winning (2027) run: the translation scored CMS137; cms122's evaluation failed.
  await record(run2027.id, "cms137", "2027-01-01", "OVERDUE", TRANSLATION);
  await record(run2027.id, "cms125", "2027-01-01", "OVERDUE", CMS125);
  await record(run2027.id, "cms122", "2027-01-01", "MISSING_DATA", { evaluationError: "CQL engine failure", message: "boom" });
  // The 2026 CMS137 case is still open and cites the 2026 run; the cms125 case cites the winning run.
  const old137 = await cases.upsertFromOutcome({ runId: run2026.id, subjectId: "pat-003", measureId: "cms137", evaluationPeriod: "2026-01-01", outcomeStatus: "OVERDUE" });
  const case125 = await cases.upsertFromOutcome({ runId: run2027.id, subjectId: "pat-003", measureId: "cms125", evaluationPeriod: "2027-01-01", outcomeStatus: "OVERDUE" });

  const res = await handleEmployees(new Request("http://x/api/employees/pat-003/profile"), { DB: db });
  const profile = await res.json();

  // The reads one page view costs, counted at the store it is handed.
  const reads = [];
  const counting = new Proxy(outcomes, {
    get(target, key) {
      if (key === "listOutcomes") return (runId, opts) => { reads.push({ runId, opts }); return target.listOutcomes(runId, opts); };
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await getEmployeeProfile({ outcomes: counting, cases, events: new SqliteCaseEventStore(db) }, "pat-003");
  const runName = (id) => (id === run2026.id ? "2026" : id === run2027.id ? "2027" : id);

  console.log(JSON.stringify({
    status: res.status,
    measureOutcomes: profile.measureOutcomes.map((o) => ({ id: o.measureId, version: o.measureVersion, logic: o.logic })),
    openCases: profile.openCases.map((c) => ({ caseId: c.caseId, logic: c.logic })),
    old137: old137.id,
    case125: case125.id,
    reads: reads.map((r) => ({ run: runName(r.runId), measureId: r.opts?.measureId ?? null, subjectIds: r.opts?.subjectIds ?? null })),
  }));
`;

test("Maui patient page: each row names the logic that scored it, never routing's, never '2.0.0' (#769)", () => {
  const output = runProfileChild("maui", logicScript, { WORKWELL_OFFICIAL_MEASURES: "cms122,cms125,cms2,cms130,cms165,cms137" });
  assert.equal(output.status, 200);
  type Logic = { kind: string; label?: string; ecqmId?: string; version: string; derivedFrom: string | null } | null;
  const details = new Map((output.measureOutcomes as Array<{ id: string; version: string; logic: Logic }>).map((o) => [o.id, o]));

  // Measure Details and the summary bar read these rows.
  assert.deepEqual(details.get("cms137")!.logic, {
    kind: "workwell-translation", label: "WorkWell translation of CMS137v15", version: "ww-2027.1",
    url: "urn:workwell:measure:cms137:translation", derivedFrom: "CMS137v15",
  }, "the winning row's evidence names the translation, though routing names CMS137FHIR");
  assert.equal(details.get("cms137")!.version, "ww-2027.1");
  assert.equal(details.get("cms125")!.logic?.ecqmId, "CMS125FHIR");
  assert.equal(details.get("cms125")!.logic?.derivedFrom, "CMS125v14");
  assert.equal(details.get("cms125")!.version, "1.0.000", "the artifact's version: the page no longer shows the authored 2.0.0");
  assert.equal(details.get("cms122")!.logic, null, "an errored row names no logic");
  assert.equal(details.get("cms122")!.version, "", "and no version — never the authored 2.0.0");
  for (const o of details.values()) assert.notEqual(o.version, "2.0.0", `${o.id} must not show the authored library version`);

  // Open cases name their CITED row: the 2026 CMS137 case was scored by CMS's artifact, not the translation.
  const open = new Map((output.openCases as Array<{ caseId: string; logic: Logic }>).map((c) => [c.caseId, c.logic]));
  assert.equal(open.get(output.old137 as string)?.kind, "cms-artifact");
  assert.equal(open.get(output.old137 as string)?.ecqmId, "CMS137FHIR");
  assert.equal(open.get(output.old137 as string)?.derivedFrom, "CMS137v14");
  assert.equal(open.get(output.case125 as string)?.ecqmId, "CMS125FHIR");

  // One read per winning measure, plus ONE bounded read for the case citing an older run; the case citing
  // the winning run reuses the row already read.
  const reads = output.reads as Array<{ run: string; measureId: string | null; subjectIds: string[] | null }>;
  assert.equal(reads.filter((r) => r.run === "2027").length, 3, "the three winning measures' rows");
  assert.deepEqual(reads.filter((r) => r.run === "2026"), [{ run: "2026", measureId: "cms137", subjectIds: ["pat-003"] }]);
  assert.equal(reads.length, 4);
});
