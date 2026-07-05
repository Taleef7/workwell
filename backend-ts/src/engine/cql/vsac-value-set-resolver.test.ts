import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureVsacClient, type VsacClient, type VsacExpansion } from "./vsac-client.ts";
import { VsacValueSetResolver } from "./vsac-value-set-resolver.ts";

const OID = "2.16.840.1.113883.3.464.1003.103.12.1001";
const exp: VsacExpansion = {
  oid: OID,
  total: 1,
  contains: [{ code: "44054006", system: "http://snomed.info/sct", display: "T2DM" }],
};

test("expand maps VSAC contains → CqlCode[] (code + system only)", async () => {
  const resolver = new VsacValueSetResolver(fixtureVsacClient({ [OID]: exp }));
  const codes = await resolver.expand(OID);
  assert.deepEqual(codes, [{ code: "44054006", system: "http://snomed.info/sct" }]);
});

test("expand memoizes per-oid — one client call for repeated expands", async () => {
  let calls = 0;
  const counting: VsacClient = {
    kind: "counting",
    expand(oid) {
      calls++;
      return Promise.resolve({ ...exp, oid });
    },
  };
  const resolver = new VsacValueSetResolver(counting);
  await resolver.expand(OID);
  await resolver.expand(OID);
  assert.equal(calls, 1);
});

test("expand THROWS on a client/transport error (never a silent empty set)", async () => {
  const failing: VsacClient = { kind: "failing", expand: () => Promise.reject(new Error("boom 500")) };
  const resolver = new VsacValueSetResolver(failing);
  await assert.rejects(() => resolver.expand(OID), /boom 500/);
});

test("expand does not cache a rejection — a retry after a failure succeeds", async () => {
  let calls = 0;
  const flaky: VsacClient = {
    kind: "flaky",
    expand(oid) {
      calls++;
      if (calls === 1) return Promise.reject(new Error("transient boom"));
      return Promise.resolve({ ...exp, oid });
    },
  };
  const resolver = new VsacValueSetResolver(flaky);
  await assert.rejects(() => resolver.expand(OID), /transient boom/);
  const codes = await resolver.expand(OID);
  assert.deepEqual(codes, [{ code: "44054006", system: "http://snomed.info/sct" }]);
  assert.equal(calls, 2, "the rejected first expand was evicted, so the retry re-called the client");
});
