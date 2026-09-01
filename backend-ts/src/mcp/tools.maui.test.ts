import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const testScript = `
  import { createSqliteD1 } from "@mieweb/cloud-local";
  import { RUN_STORE_FLOOR_DDL, migrateFloorSchema } from "./src/stores/sqlite/schema.ts";
  import { SqliteCaseStore } from "./src/stores/sqlite/case-store-sqlite.ts";
  import { SqliteOutcomeStore } from "./src/stores/sqlite/outcome-store-sqlite.ts";
  import { SqliteRunStore } from "./src/stores/sqlite/run-store-sqlite.ts";
  import { SqliteMeasureStore } from "./src/stores/sqlite/measure-store-sqlite.ts";
  import { SqliteCaseEventStore } from "./src/stores/sqlite/case-event-store-sqlite.ts";
  import { seedMeasureStore } from "./src/measure/measure-seed.ts";
  import { callTool } from "./src/mcp/dispatch.ts";

  const db = await createSqliteD1(":memory:");
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
  await migrateFloorSchema(db);
  const measureStore = new SqliteMeasureStore(db);
  await seedMeasureStore(measureStore, () => "");
  const events = new SqliteCaseEventStore(db);
  const deps = {
    caseStore: new SqliteCaseStore(db),
    outcomeStore: new SqliteOutcomeStore(db),
    runStore: new SqliteRunStore(db),
    measureStore,
    webChartEnv: {
      WORKWELL_WEBCHART_BASE_URL: "http://webchart.test",
      WORKWELL_WEBCHART_API_KEY: "fixture-key",
    },
  };

  const run = await deps.runStore.createRun({
    scopeType: "MEASURE",
    scopeId: "cms122",
    triggeredBy: "test",
    requestedScope: { measureId: "cms122" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  await deps.runStore.finalizeRun(run.id, "COMPLETED");

  const patCase = await deps.caseStore.upsertFromOutcome({ runId: run.id, subjectId: "pat-001", measureId: "cms122", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
  const foreignCase = await deps.caseStore.upsertFromOutcome({ runId: run.id, subjectId: "emp-001", measureId: "cms122", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
  const unresolvedCase = await deps.caseStore.upsertFromOutcome({ runId: run.id, subjectId: "cypress-mrn-foreign", measureId: "cms122", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
  const liveCase = await deps.caseStore.upsertFromOutcome({ runId: run.id, subjectId: "wc|live-mcp-subject", measureId: "cms122", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
  await deps.outcomeStore.recordOutcome({ runId: run.id, subjectId: "wc|live-mcp-subject", measureId: "cms122", status: "OVERDUE", evidence: {} });
  await deps.outcomeStore.recordOutcome({ runId: run.id, subjectId: "wc|persisted-mcp-subject", measureId: "cms122", status: "COMPLIANT", evidence: {} });

  const ctx = { deps, events, actor: "cm@workwell.dev", role: "ROLE_ADMIN", enforce: true };

  const getEmpPatRes = await callTool("get_employee", { employeeExternalId: "pat-001" }, ctx);
  const getEmpPat = JSON.parse(getEmpPatRes.content[0].text);
  const getEmpForeignRes = await callTool("get_employee", { employeeExternalId: "emp-001" }, ctx);
  const getEmpForeign = JSON.parse(getEmpForeignRes.content[0].text);

  const listCasesRes = await callTool("list_cases", { status: "open" }, ctx);
  const listCasesJson = JSON.parse(listCasesRes.content[0].text);

  const listNoncompliantRes = await callTool("list_noncompliant", {}, ctx);
  const listNoncompliantJson = JSON.parse(listNoncompliantRes.content[0].text);
  const getCaseForeignRes = await callTool("get_case", { caseId: foreignCase.id }, ctx);
  const explainForeignRes = await callTool("explain_outcome", { caseId: foreignCase.id }, ctx);
  const getCaseUnresolvedRes = await callTool("get_case", { caseId: unresolvedCase.id }, ctx);
  const getCaseLiveRes = await callTool("get_case", { caseId: liveCase.id }, ctx);
  const checkForeignRes = await callTool("check_compliance", { employeeExternalId: "emp-001", measureName: "Diabetes: Glycemic Status Assessment Greater Than 9%" }, ctx);
  const checkLiveRes = await callTool("check_compliance", { employeeExternalId: "wc|live-mcp-subject", measureName: "Diabetes: Glycemic Status Assessment Greater Than 9%" }, ctx);
  const getEmpInventedRes = await callTool("get_employee", { employeeExternalId: "wc|not-a-patient" }, ctx);
  const checkInventedRes = await callTool("check_compliance", { employeeExternalId: "wc|not-a-patient", measureName: "Diabetes: Glycemic Status Assessment Greater Than 9%" }, ctx);
  const getEmpPersistedRes = await callTool("get_employee", { employeeExternalId: "wc|persisted-mcp-subject" }, ctx);
  const checkPersistedRes = await callTool("check_compliance", { employeeExternalId: "wc|persisted-mcp-subject", measureName: "Diabetes: Glycemic Status Assessment Greater Than 9%" }, ctx);
  const listMeasuresRes = await callTool("list_measures", {}, ctx);
  const listMeasuresJson = JSON.parse(listMeasuresRes.content[0].text);

  console.log(JSON.stringify({
    patFound: !getEmpPat.error,
    foreignFound: !getEmpForeign.error,
    listCasesEmployees: listCasesJson.results.map(r => r.employee_id),
    listNoncompliantEmployees: listNoncompliantJson.results.map(r => r.employeeExternalId),
    listNoncompliantNames: listNoncompliantJson.results.map(r => r.employeeName),
    getCaseForeign: JSON.parse(getCaseForeignRes.content[0].text),
    explainForeign: JSON.parse(explainForeignRes.content[0].text),
    getCaseUnresolved: JSON.parse(getCaseUnresolvedRes.content[0].text),
    getCaseLive: JSON.parse(getCaseLiveRes.content[0].text),
    checkForeign: JSON.parse(checkForeignRes.content[0].text),
    checkLive: JSON.parse(checkLiveRes.content[0].text),
    getEmpInvented: JSON.parse(getEmpInventedRes.content[0].text),
    checkInvented: JSON.parse(checkInventedRes.content[0].text),
    getEmpPersisted: JSON.parse(getEmpPersistedRes.content[0].text),
    checkPersisted: JSON.parse(checkPersistedRes.content[0].text),
    measures: listMeasuresJson.results.map(r => r.measureId),
  }));
`;

test("scoped profile (Maui) — MCP tools isolate subjects to Maui profile directory", () => {
  const output = runProfileChild("maui", testScript);
  assert.equal(output.patFound, true, "pat-001 must be found on Maui");
  assert.equal(output.foreignFound, false, "emp-001 must not be found on Maui");

  const listCasesEmployees = output.listCasesEmployees as string[];
  assert.ok(listCasesEmployees.includes("pat-001"), "pat-001 must be present in list_cases on Maui");
  assert.ok(listCasesEmployees.includes("wc|live-mcp-subject"), "live wc subject must be present in list_cases via the injected directory");
  assert.ok(!listCasesEmployees.includes("emp-001"), "emp-001 must be excluded from list_cases on Maui");
  assert.ok(!listCasesEmployees.includes("cypress-mrn-foreign"), "cypress-mrn-foreign must be excluded from list_cases on Maui");

  const listNoncompliantEmployees = output.listNoncompliantEmployees as string[];
  const listNoncompliantNames = output.listNoncompliantNames as string[];
  assert.ok(listNoncompliantEmployees.includes("pat-001"), "pat-001 must be present in list_noncompliant on Maui");
  assert.ok(!listNoncompliantEmployees.includes("emp-001"), "emp-001 must be excluded from list_noncompliant on Maui");
  assert.ok(!listNoncompliantEmployees.includes("cypress-mrn-foreign"), "cypress-mrn-foreign must be excluded from list_noncompliant on Maui");
  assert.ok(!listNoncompliantNames.includes("cypress-mrn-foreign"), "cypress-mrn-foreign must not appear as employeeName on Maui");

  assert.equal((output.getCaseForeign as Record<string, unknown>).code, "CASE_NOT_FOUND", "foreign get_case must use the not-found shape on Maui");
  assert.equal((output.explainForeign as Record<string, unknown>).code, "CASE_NOT_FOUND", "foreign explain_outcome must use the not-found shape on Maui");
  assert.equal((output.getCaseUnresolved as Record<string, unknown>).code, "CASE_NOT_FOUND", "unresolvable get_case must use the not-found shape on Maui");
  assert.equal((output.checkForeign as Record<string, unknown>).code, "EMPLOYEE_NOT_FOUND", "check_compliance must reject foreign subjects on Maui");
  assert.notEqual((output.getCaseLive as Record<string, unknown>).code, "CASE_NOT_FOUND", "live wc get_case must resolve through the injected directory");
  assert.notEqual((output.checkLive as Record<string, unknown>).code, "EMPLOYEE_NOT_FOUND", "live wc check_compliance must resolve through the injected directory");
  const measures = output.measures as string[];
  assert.ok(measures.includes("cms122"), "runnable cms122 must be listed on Maui");
  assert.ok(!measures.includes("audiogram"), "unrunnable audiogram must not be listed on Maui");
});

test("scoped profile (Maui) — MCP rejects invented wc ids but resolves persisted wc subjects", () => {
  const output = runProfileChild("maui", testScript);
  assert.equal((output.getEmpInvented as Record<string, unknown>).code, "EMPLOYEE_NOT_FOUND");
  assert.equal((output.checkInvented as Record<string, unknown>).code, "EMPLOYEE_NOT_FOUND");
  assert.equal((output.getEmpPersisted as Record<string, unknown>).employeeExternalId, "wc|persisted-mcp-subject");
  assert.equal((output.checkPersisted as Record<string, unknown>).status, "COMPLIANT");
});

test("default profile — MCP tools preserve unresolvable and foreign subjects", () => {
  const output = runProfileChild(undefined, testScript);
  assert.equal(output.patFound, true, "pat-001 found on default profile");
  assert.equal(output.foreignFound, true, "emp-001 found on default profile");

  const listCasesEmployees = output.listCasesEmployees as string[];
  assert.ok(listCasesEmployees.includes("pat-001"), "pat-001 present on default profile");
  assert.ok(listCasesEmployees.includes("emp-001"), "emp-001 present on default profile");
  assert.ok(listCasesEmployees.includes("cypress-mrn-foreign"), "cypress-mrn-foreign present on default profile");

  const listNoncompliantEmployees = output.listNoncompliantEmployees as string[];
  assert.ok(listNoncompliantEmployees.includes("pat-001"), "pat-001 present in list_noncompliant on default profile");
  assert.ok(listNoncompliantEmployees.includes("emp-001"), "emp-001 present in list_noncompliant on default profile");
  assert.ok(listNoncompliantEmployees.includes("cypress-mrn-foreign"), "cypress-mrn-foreign present in list_noncompliant on default profile");
});

test("default profile — MCP by-id tools preserve foreign subjects and list all runnable measures", () => {
  const output = runProfileChild(undefined, testScript);
  assert.equal((output.getCaseForeign as Record<string, unknown>).caseId != null, true);
  assert.equal((output.explainForeign as Record<string, unknown>).case_id != null, true);
  assert.equal((output.getCaseUnresolved as Record<string, unknown>).caseId != null, true);
  assert.notEqual((output.checkForeign as Record<string, unknown>).code, "EMPLOYEE_NOT_FOUND");
  assert.ok((output.measures as string[]).includes("audiogram"), "audiogram must remain listed on default profile");
});
