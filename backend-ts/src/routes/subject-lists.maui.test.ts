/**
 * The sandbox data boundary on the PILOT profile (MM-2 PR 3, ADR-082).
 *
 * The mirror of `subject-lists.test.ts`'s gate test: there the corpus id is the outsider, here the
 * occupational id is. A gate tested on one profile only would read as working while refusing every
 * legitimate identifier on the other — which is what a single hardcoded namespace pattern did before
 * this pair existed.
 *
 * The three cases that matter are the three different answers a conforming-looking identifier gets:
 * a real corpus patient MATCHES, a conforming id nobody has is NOT_FOUND (so the review queue is
 * exercised with synthetic-shaped ids rather than being unreachable), and an identifier from another
 * deployment's namespace is REFUSED before anything is written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const testScript = `
  import { createSqliteD1 } from "@mieweb/cloud-local";
  import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
  import { handleSubjectLists } from "./src/routes/subject-lists.ts";

  const db = await createSqliteD1(":memory:");
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
  const env = { DB: db };
  const post = async (body) => {
    const res = await handleSubjectLists(
      new Request("http://x/api/subject-lists", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
      "quality-lead@workwell.dev",
    );
    return { status: res.status, body: await res.json() };
  };

  // A fixture patient (three digits), a generated one (five), and one nobody has.
  const accepted = await post({ name: "ACO attribution", identifiers: ["pat-001", "pat-00060", "pat-99999"] });
  // An identifier from the OTHER deployment's namespace.
  const refused = await post({ name: "wrong namespace", identifiers: ["pat-001", "emp-001"] });
  const listed = await handleSubjectLists(new Request("http://x/api/subject-lists"), env, "quality-lead@workwell.dev");

  console.log(JSON.stringify({ accepted, refused, lists: await listed.json() }));
`;

test("Maui profile — the corpus namespace is admitted in BOTH spellings, and a missing id is NOT_FOUND", () => {
  const out = runProfileChild("maui", testScript, { WORKWELL_MAUI_CORPUS_SIZE: "100" });
  const accepted = out.accepted as { status: number; body: { counts: Record<string, number> } };
  assert.equal(accepted.status, 201);
  // pat-001 is a hand-written fixture patient and pat-00060 a generated one (the child composes a
  // 100-patient corpus so both exist): a gate written for the generated five-digit form alone would
  // refuse the first 48 real patients in the sandbox.
  assert.equal(accepted.body.counts.matched, 2);
  // Conforming but absent — the review queue is reachable with synthetic-shaped identifiers, which is
  // what makes this a NAMESPACE gate rather than an existence gate.
  assert.equal(accepted.body.counts.notFound, 1);
});

test("Maui profile — an occupational identifier is REFUSED before persistence, and nothing is written", () => {
  const out = runProfileChild("maui", testScript, { WORKWELL_MAUI_CORPUS_SIZE: "100" });
  const refused = out.refused as { status: number; body: { error: string; outsideNamespace: number } };
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "identifier_outside_sandbox_namespace");
  assert.equal(refused.body.outsideNamespace, 1);
  // Exactly one list exists: the accepted one. The refusal wrote nothing, not even a header row.
  const lists = out.lists as { name: string }[];
  assert.deepEqual(lists.map((l) => l.name), ["ACO attribution"]);
});

// #853/#852: the CSV has no status column, so its two headers are a CSV client's only way to learn that a
// measure was refused and why. Three measures, one per state, through the real route on the pilot profile.
const refusalScript = `
  import { createSqliteD1 } from "@mieweb/cloud-local";
  import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
  import { getStores } from "./src/stores/factory.ts";
  import { handleSubjectLists } from "./src/routes/subject-lists.ts";
  import { COMPACTION_INTENT_EVENT } from "./src/run/compaction-evidence.ts";

  const db = await createSqliteD1(":memory:");
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
  const env = { DB: db };
  const stores = await getStores(env);
  const actor = "quality-lead@workwell.dev";
  const period = { start: "2027-01-01T00:00:00.000Z", end: "2027-12-31T23:59:59.999Z" };
  const evidence = (extra = {}) => ({
    official: { ecqmId: "122FHIR", version: "1.0.000", measurementPeriod: period,
      populationResults: { ipp: true, denom: true, denex: false, numer: true, denexcep: false } },
    ...extra,
  });
  const mkRun = (startedAt) => stores.runs.createRun({
    scopeType: "ALL_PROGRAMS", triggeredBy: "test", requestedScope: {}, status: "COMPLETED", startedAt,
    measurementPeriodStart: period.start, measurementPeriodEnd: period.end,
  });
  const older = await mkRun("2027-03-01T00:00:00.000Z");
  const newer = await mkRun("2027-06-01T00:00:00.000Z");
  await stores.outcomes.recordOutcomes([
    { runId: older.id, subjectId: "pat-001", measureId: "cms125", status: "COMPLIANT", evidence: evidence() },
    { runId: newer.id, subjectId: "pat-001", measureId: "cms122", status: "COMPLIANT",
      evidence: evidence({ dataInsufficient: { checks: ["encounterTypeCoded"] } }) },
    { runId: newer.id, subjectId: "pat-001", measureId: "cms130", status: "COMPLIANT",
      evidence: evidence({ cqlFacts: { spec: 1, values: [{ define: "Colonoscopy Performed", value: "Procedure/col-1" }] } }) },
  ]);
  // A compaction pass whose cutoff falls between the two runs: the older run's rows may be incomplete.
  await stores.events.appendAudit({ eventType: COMPACTION_INTENT_EVENT, entityType: "outcomes", entityId: "pass-1",
    actor: "system", refRunId: null, refCaseId: null, refMeasureVersionId: null, payload: { cutoff: "2027-04-01T00:00:00.000Z" } });

  const created = await (await handleSubjectLists(new Request("http://x/api/subject-lists", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "refusals", identifiers: ["pat-001"] }),
  }), env, actor)).json();
  const res = await handleSubjectLists(
    new Request("http://x/api/subject-lists/" + created.list.id + "/report?measurementYear=2027&format=csv"), env, actor);
  console.log(JSON.stringify({
    status: res.status,
    compacted: res.headers.get("x-workwell-compacted-measures"),
    thin: res.headers.get("x-workwell-data-insufficient-measures"),
    csv: await res.text(),
  }));
`;

test("Maui profile — the report CSV names its compacted and its thin measures in headers, and has rows only for the rest", () => {
  const out = runProfileChild("maui", refusalScript, {
    WORKWELL_MAUI_CORPUS_SIZE: "100",
    WORKWELL_OFFICIAL_MEASURES: "cms122,cms125,cms130",
    WORKWELL_VSAC_API_KEY: undefined,
  });
  assert.equal(out.status, 200);
  assert.equal(out.compacted, "cms125");
  assert.equal(out.thin, "cms122");
  const lines = (out.csv as string).split("\r\n").filter(Boolean);
  const measureCol = lines[0]!.split(",").indexOf("measureId");
  const measures = new Set(lines.slice(1).map((l) => l.split(",")[measureCol]));
  assert.deepEqual([...measures], ["cms130"], "no rows for a refused measure");
  // #875: the route asks its read for the recorded define values on a CSV, so the row reads what CQL found.
  const header = lines[0]!.split(",");
  const row = lines[1]!.split(",");
  assert.equal(row[header.indexOf("evidenceStatus")], "NUMERATOR_EVIDENCE");
  assert.equal(row[header.indexOf("evidenceDetail")], "Colonoscopy Performed: Procedure/col-1");
});
