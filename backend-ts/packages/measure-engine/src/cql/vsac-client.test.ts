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

// --- httpVsacClient behavioral coverage via a fake global.fetch --------------------------------

const BASE = "https://cts.nlm.nih.gov/fhir";
const EXP_OID = "2.16.840.1.113883.3.464.1003.103.12.1001";

interface FakeCall {
  url: string;
  headers: Record<string, string>;
}

/**
 * Install a fake `globalThis.fetch` that returns `bodies[callIndex]` (last body reused past the end).
 * Returns the recorded calls + a restore fn; ALWAYS call restore() in a finally.
 */
function installFetch(
  bodies: unknown[],
  opts: { ok?: boolean; status?: number; statusText?: string } = {},
): { calls: FakeCall[]; restore: () => void } {
  const calls: FakeCall[] = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = ((url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    const body = bodies[Math.min(i, bodies.length - 1)];
    i++;
    return Promise.resolve({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      statusText: opts.statusText ?? "OK",
      json: () => Promise.resolve(body),
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("httpVsacClient sends Basic auth + fhir Accept and returns a single-page expansion", async () => {
  const { calls, restore } = installFetch([
    { resourceType: "ValueSet", expansion: { total: 1, contains: [{ code: "X", system: "S", display: "d" }] } },
  ]);
  try {
    const client = httpVsacClient({ baseUrl: BASE, apiKey: "test-key" });
    const got = await client.expand(EXP_OID);
    assert.equal(calls.length, 1);
    const expectedAuth = "Basic " + Buffer.from("apikey:test-key").toString("base64");
    assert.equal(calls[0]!.headers.Authorization, expectedAuth);
    assert.equal(calls[0]!.headers.Accept, "application/fhir+json");
    assert.deepEqual(got, {
      oid: EXP_OID,
      total: 1,
      contains: [{ code: "X", system: "S", display: "d" }],
    });
  } finally {
    restore();
  }
});

test("httpVsacClient accumulates across pages with advancing offset and stops at total", async () => {
  const { calls, restore } = installFetch([
    { expansion: { total: 2, contains: [{ code: "A", system: "S" }] } },
    { expansion: { contains: [{ code: "B", system: "S" }] } },
  ]);
  try {
    const client = httpVsacClient({ baseUrl: BASE, apiKey: "k" });
    const got = await client.expand(EXP_OID);
    assert.equal(calls.length, 2, "stops after 2 pages once contains.length >= total");
    assert.match(calls[0]!.url, /offset=0/);
    assert.match(calls[1]!.url, /offset=1/);
    assert.deepEqual(got.contains, [
      { code: "A", system: "S", display: undefined },
      { code: "B", system: "S", display: undefined },
    ]);
  } finally {
    restore();
  }
});

test("httpVsacClient throws on a non-2xx response", async () => {
  const { restore } = installFetch([{}], { ok: false, status: 500, statusText: "Server Error" });
  try {
    const client = httpVsacClient({ baseUrl: BASE, apiKey: "k" });
    await assert.rejects(() => client.expand(EXP_OID), /500/);
  } finally {
    restore();
  }
});

test("httpVsacClient throws when total>0 but contains is empty (claimed-but-empty)", async () => {
  const { restore } = installFetch([{ expansion: { total: 5, contains: [] } }]);
  try {
    const client = httpVsacClient({ baseUrl: BASE, apiKey: "k" });
    await assert.rejects(() => client.expand(EXP_OID), /total=5/);
  } finally {
    restore();
  }
});

test("httpVsacClient returns [] for a legitimately-empty value set (total 0, no members)", async () => {
  const { restore } = installFetch([{ expansion: { total: 0, contains: [] } }]);
  try {
    const client = httpVsacClient({ baseUrl: BASE, apiKey: "k" });
    const got = await client.expand(EXP_OID);
    assert.deepEqual(got.contains, []);
  } finally {
    restore();
  }
});

test("httpVsacClient throws on a malformed response with no expansion object", async () => {
  const { restore } = installFetch([{ resourceType: "OperationOutcome" }]);
  try {
    const client = httpVsacClient({ baseUrl: BASE, apiKey: "k" });
    await assert.rejects(() => client.expand(EXP_OID), /expansion/);
  } finally {
    restore();
  }
});

// --- #295: release pinning + expansion provenance ----------------------------------------------

test("httpVsacClient appends the manifest pin to every page request", async () => {
  const { calls, restore } = installFetch([
    { expansion: { total: 1, contains: [{ code: "X", system: "S" }] } },
  ]);
  try {
    const client = httpVsacClient({ baseUrl: BASE, apiKey: "k" });
    await client.expand(EXP_OID, { manifest: "Library/ecqm-update-2025-05-08" });
    assert.match(calls[0]!.url, /[?&]manifest=Library%2Fecqm-update-2025-05-08/);
  } finally {
    restore();
  }
});

test("httpVsacClient appends the expansion pin, and rejects both pins together", async () => {
  const { calls, restore } = installFetch([{ expansion: { total: 1, contains: [{ code: "X", system: "S" }] } }]);
  try {
    const client = httpVsacClient({ baseUrl: BASE, apiKey: "k" });
    await client.expand(EXP_OID, { expansion: "eCQM Update 2025" });
    assert.match(calls[0]!.url, /[?&]expansion=eCQM%20Update%202025/);
    await assert.rejects(
      () => client.expand(EXP_OID, { manifest: "a", expansion: "b" }),
      /mutually exclusive/,
    );
  } finally {
    restore();
  }
});

test("httpVsacClient omits the pin params entirely when unpinned (unchanged URL)", async () => {
  const { calls, restore } = installFetch([{ expansion: { total: 1, contains: [{ code: "X", system: "S" }] } }]);
  try {
    await httpVsacClient({ baseUrl: BASE, apiKey: "k" }).expand(EXP_OID);
    assert.doesNotMatch(calls[0]!.url, /manifest=|expansion=/);
  } finally {
    restore();
  }
});

test("httpVsacClient captures ValueSet.version + expansion identifier/timestamp from the first page", async () => {
  const { restore } = installFetch([
    {
      version: "20250508",
      expansion: {
        total: 2,
        identifier: "urn:uuid:5f1b",
        timestamp: "2025-05-08T12:00:00Z",
        contains: [{ code: "A", system: "S" }],
      },
    },
    // Second page repeats provenance; the first page's values must win (and not be clobbered).
    { version: "IGNORED", expansion: { total: 2, identifier: "urn:uuid:other", contains: [{ code: "B", system: "S" }] } },
  ]);
  try {
    const got = await httpVsacClient({ baseUrl: BASE, apiKey: "k" }).expand(EXP_OID);
    assert.equal(got.version, "20250508");
    assert.equal(got.expansionIdentifier, "urn:uuid:5f1b");
    assert.equal(got.expansionTimestamp, "2025-05-08T12:00:00Z");
    assert.equal(got.contains.length, 2, "paging still works");
  } finally {
    restore();
  }
});

test("httpVsacClient omits provenance keys when the server sends none (no undefined noise)", async () => {
  const { restore } = installFetch([{ expansion: { total: 1, contains: [{ code: "X", system: "S" }] } }]);
  try {
    const got = await httpVsacClient({ baseUrl: BASE, apiKey: "k" }).expand(EXP_OID);
    assert.deepEqual(Object.keys(got).sort(), ["contains", "oid", "total"]);
  } finally {
    restore();
  }
});
