/**
 * The scorecard on a deployment that shows the live WebChart tenant (#852, Codex on #859).
 *
 *   node --import tsx --test src/routes/scorecard.webchart.test.ts
 *
 * A live patient's PCP is the live tenant's provider, which the static provider list does not hold. Read
 * through the deployment's scoped lookup, the live practice is a provider row of its own under its location;
 * read through the static list, every live patient fell into "Other".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const script = `
  import { createSqliteD1 } from "@mieweb/cloud-local";
  import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
  import { getStores } from "./src/stores/factory.ts";
  import { handleScorecard } from "./src/routes/scorecard.ts";

  const db = await createSqliteD1(":memory:");
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
  const env = { DB: db, WORKWELL_WEBCHART_BASE_URL: "http://webchart.test", WORKWELL_WEBCHART_API_KEY: "fixture-key" };
  const stores = await getStores(env);
  const year = new Date().getUTCFullYear();
  const run = await stores.runs.createRun({
    scopeType: "ALL_PROGRAMS", triggeredBy: "test", requestedScope: {}, status: "COMPLETED",
    measurementPeriodStart: year + "-01-01T00:00:00.000Z", measurementPeriodEnd: year + "-12-31T23:59:59.999Z",
  });
  const evidence = (numer) => ({ official: { populationResults: { ipp: true, denom: true, denex: false, numer, denexcep: false } } });
  await stores.outcomes.recordOutcomes([
    { runId: run.id, subjectId: "wc|101", measureId: "cms122", status: "OVERDUE", evidence: evidence(true) },
    { runId: run.id, subjectId: "wc|102", measureId: "cms122", status: "COMPLIANT", evidence: evidence(false) },
  ]);
  const card = await (await handleScorecard(new Request("http://x/api/scorecard?measurementYear=" + year), env, "admin@workwell.dev")).json();
  console.log(JSON.stringify({ card }));
`;

test("live WebChart patients get the live provider's own row under its location, not Other", () => {
  const out = runProfileChild(undefined, script, { WORKWELL_OFFICIAL_MEASURES: "cms122", WORKWELL_VSAC_API_KEY: undefined });
  const card = out.card as {
    measures: { measureId: string; state: string }[];
    locations: { location: string; providers: { providerId: string; cells: Record<string, { rates: { denom: number }[] | null }> }[] }[];
    other: unknown;
  };
  assert.equal(card.measures.find((m) => m.measureId === "cms122")?.state, "complete");
  assert.equal(card.other, null, "no live patient falls into Other");
  const live = card.locations.find((l) => l.location === "WebChart");
  assert.ok(live, "the live tenant's location is a group of its own");
  assert.deepEqual(live!.providers.map((p) => p.providerId), ["wc-provider-1"]);
  assert.equal(live!.providers[0]!.cells.cms122!.rates![0]!.denom, 2);
});
