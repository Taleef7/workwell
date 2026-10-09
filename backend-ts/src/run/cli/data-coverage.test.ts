/**
 * `pnpm data-coverage` (#776): arguments, the text a reader sees, and the exit codes.
 *   node --import tsx --test src/run/cli/data-coverage.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { main, parseArgs, renderText } from "./data-coverage.ts";
import { dataCoverage } from "../../wiring/data-coverage.ts";

test("parseArgs: repeatable --measure, --json, and a refusal for anything else", () => {
  assert.deepEqual(parseArgs([]), { measures: [], json: false });
  assert.deepEqual(parseArgs(["--measure", "cms165", "--measure", "cms2", "--json"]), { measures: ["cms165", "cms2"], json: true });
  assert.match((parseArgs(["--measure"]) as { error: string }).error, /needs a catalog id/);
  assert.match((parseArgs(["--measure", "--json"]) as { error: string }).error, /needs a catalog id/);
  assert.match((parseArgs(["cms165"]) as { error: string }).error, /unknown argument cms165/);
});

test("the text report names the source it describes, each logic, and why a type is not served", () => {
  const text = renderText(dataCoverage(["cms165", "cms137"]));
  assert.match(text, /This is the WebChart live-tenant path/);
  assert.match(text, /^Ingest also derives Observation: a LOINC 24606-6 imaging Observation/m, "derivations print once, in the header");
  assert.match(text, /^cms165 · CMS165FHIR v1\.0\.000 \(CMS's artifact\)$/m);
  assert.match(text, /^cms137 · WorkWell translation of CMS137v15 \(ww-2027\.1\) \(a WorkWell translation\)$/m);
  assert.match(text, /^ {2}Retrieves by profile: every profile-typed retrieve is filtered on meta\.profile/m);
  assert.match(text, /^ {2}Observation +score +PARTLY: us-core-blood-pressure stamped; not qicore-observation-screening-assessment, qicore-simple-observation\./m);
  assert.match(text, /^ {2}MedicationRequest +score +NOT SERVED: WebChart ingest does not compose it yet \(#713\)/m);
  assert.match(text, /^ {2}Coverage +SDE only +NOT SERVED:/m);
  assert.match(text, /^ {2}5 of the 8 types it scores with are served\.$/m, "cms137: Condition, Encounter, Observation, Patient, Procedure");
  assert.doesNotMatch(text, /no reason recorded/);
});

test("main: 0 with the report, 2 on a usage error or a measure with no CMS artifact", async () => {
  const printed: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (line: string) => printed.push(line);
  console.error = (line: string) => printed.push(line);
  try {
    assert.equal(await main(["--measure", "cms2", "--json"]), 0);
    const tables = JSON.parse(printed.at(-1)!) as Array<{ measureId: string; kind: string }>;
    assert.deepEqual(tables.map((table) => `${table.measureId} ${table.kind}`), ["cms2 cms-artifact"]);
    assert.equal(await main(["--bogus"]), 2);
    assert.equal(await main(["--measure", "cms999"]), 2);
    assert.match(printed.at(-1)!, /^cms999: no committed CMS artifact under measures\/official\//);
  } finally {
    console.log = log;
    console.error = error;
  }
});
