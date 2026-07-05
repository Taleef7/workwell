import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureVsacClient, httpVsacClient, type VsacExpansion } from "./vsac-client.ts";

test("fixtureVsacClient returns the mapped expansion for a known oid", async () => {
  const exp: VsacExpansion = {
    oid: "2.16.840.1.113883.3.464.1003.103.12.1001",
    total: 2,
    contains: [
      { code: "44054006", system: "http://snomed.info/sct", display: "Diabetes mellitus type 2" },
      { code: "E11.9", system: "http://hl7.org/fhir/sid/icd-10-cm", display: "Type 2 diabetes" },
    ],
  };
  const client = fixtureVsacClient({ [exp.oid]: exp });
  const got = await client.expand("2.16.840.1.113883.3.464.1003.103.12.1001");
  assert.equal(got.total, 2);
  assert.equal(got.contains.length, 2);
  assert.equal(got.contains[0]!.code, "44054006");
});

test("fixtureVsacClient rejects for an unknown oid (simulates a 404/not-configured set)", async () => {
  const client = fixtureVsacClient({});
  await assert.rejects(() => client.expand("9.9.9"), /no fixture/i);
});

test("httpVsacClient is a client with kind 'http' (no network in this test)", () => {
  const client = httpVsacClient({ baseUrl: "https://cts.nlm.nih.gov/fhir", apiKey: "x" });
  assert.equal(client.kind, "http");
});
