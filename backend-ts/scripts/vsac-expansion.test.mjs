/**
 * The vendor-time VSAC completion (roadmap §7.3, PR-9).
 *
 * This is build tooling, so it lives beside the script rather than under `src/` — but it is tested for
 * the same reason everything else here is: the thing it decides is whether a measure whose exclusion
 * set is half-expanded gets routed. Every assertion below is about a failure direction, not a feature.
 *
 * `globalThis.fetch` is stubbed rather than injected: the retry/paging loop is the part worth testing,
 * and injecting a transport would test a seam instead of the loop.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { completeCappedExpansions, expandFromVsac } from "./vsac-expansion.mjs";

const OID = "2.16.840.1.113883.3.464.1003.110.12.1082";
const ARGS = {
  completeCappedExpansions: true,
  vsacBase: "https://cts.nlm.nih.gov/fhir",
  vsacManifest: "http://cts.nlm.nih.gov/fhir/Library/ecqm-fhir-update-2025",
};
const KEYED = { WORKWELL_VSAC_API_KEY: "test-key" };

/** A capped value set in the shape `collectTerminology` produces: 2 of 5 codes present. */
function cappedTerminology() {
  return {
    valueSets: [
      {
        oid: OID,
        url: `http://cts.nlm.nih.gov/fhir/ValueSet/${OID}`,
        declaredTotal: 5,
        codes: [
          { system: "http://snomed.info/sct", code: "upstream-1" },
          { system: "http://snomed.info/sct", code: "upstream-2" },
        ],
      },
      // Complete already — must never be touched, and must never cost a request.
      {
        oid: "2.16.840.1.113883.3.464.1003.108.12.1018",
        url: "http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.464.1003.108.12.1018",
        declaredTotal: 1,
        codes: [{ system: "http://loinc.org", code: "24606-6" }],
      },
    ],
  };
}

function expansionPage(codes, total) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        resourceType: "ValueSet",
        expansion: { total, contains: codes.map((code) => ({ system: "http://snomed.info/sct", code })) },
      }),
  };
}

let calls;
let realFetch;
let warnings;
let realWarn;

beforeEach(() => {
  calls = [];
  warnings = [];
  realFetch = globalThis.fetch;
  realWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});

describe("expandFromVsac", () => {
  it("pages until the declared total is reached, advancing offset by the page's own length", async () => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const offset = Number(new URL(String(url)).searchParams.get("offset"));
      // Deliberately a SHORT first page (3 of a page size of 1000): offset must advance by what the
      // server actually returned, not by `count`, or page two starts past the codes it skipped.
      return offset === 0 ? expansionPage(["a", "b", "c"], 5) : expansionPage(["d", "e"], 5);
    };

    const { codes, total } = await expandFromVsac(OID, { ...ARGS, apiKey: "test-key" });

    assert.equal(total, 5);
    assert.deepEqual(codes.map((c) => c.code), ["a", "b", "c", "d", "e"]);
    assert.equal(calls.length, 2, "stops once the declared total is reached");
    assert.equal(new URL(calls[1].url).searchParams.get("offset"), "3", "offset advanced by the short page");
  });

  it("sends the release pin and the api-key basic auth on every page", async () => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return expansionPage(["a"], 1);
    };

    await expandFromVsac(OID, { ...ARGS, apiKey: "test-key" });

    const params = new URL(calls[0].url).searchParams;
    assert.equal(params.get("manifest"), ARGS.vsacManifest, "unpinned would serve latest-active");
    assert.equal(params.get("count"), "1000");
    assert.equal(
      calls[0].init.headers.Authorization,
      `Basic ${Buffer.from("apikey:test-key").toString("base64")}`,
    );
  });

  it("refuses a response that carries no expansion rather than reading it as zero codes", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ resourceType: "OperationOutcome" }),
    });

    await assert.rejects(
      () => expandFromVsac(OID, { ...ARGS, apiKey: "test-key" }),
      /carries no expansion/,
    );
  });

  it("refuses a claimed-but-empty expansion", async () => {
    globalThis.fetch = async () => expansionPage([], 1997);

    await assert.rejects(
      () => expandFromVsac(OID, { ...ARGS, apiKey: "test-key" }),
      /claimed 1997 codes and returned none/,
    );
  });

  it("does not retry a 4xx — a bad key cannot be fixed by asking again", async () => {
    globalThis.fetch = async (url) => {
      calls.push({ url: String(url) });
      return { ok: false, status: 401, text: async () => "" };
    };

    await assert.rejects(() => expandFromVsac(OID, { ...ARGS, apiKey: "bad" }), /HTTP 401/);
    assert.equal(calls.length, 1);
  });
});

describe("completeCappedExpansions", () => {
  it("replaces a capped set with the full expansion and reports it", async () => {
    globalThis.fetch = async (url) => {
      calls.push({ url: String(url) });
      // A real full expansion is a SUPERSET of the truncated sample upstream shipped.
      return expansionPage(["c", "upstream-2", "a", "b", "upstream-1"], 5);
    };
    const terminology = cappedTerminology();

    const completed = await completeCappedExpansions(terminology, ARGS, KEYED);

    assert.deepEqual(completed, [{ oid: OID, had: 2, now: 5, declaredTotal: 5 }]);
    assert.equal(terminology.valueSets[0].codes.length, 5);
    assert.equal(calls.length, 1, "only the capped set is re-expanded");
  });

  it("writes codes sorted by system|code and deduped, because the sidecar is pinned by hash", async () => {
    globalThis.fetch = async () =>
      expansionPage(["c", "upstream-2", "a", "upstream-1", "b", "a"], 5);
    const terminology = cappedTerminology();

    await completeCappedExpansions(terminology, ARGS, KEYED);

    assert.deepEqual(
      terminology.valueSets[0].codes.map((c) => c.code),
      ["a", "b", "c", "upstream-1", "upstream-2"],
      "VSAC page order is not a contract; the artifact's byte order is",
    );
  });

  it("REJECTS a short expansion rather than swapping in a differently-incomplete set", async () => {
    globalThis.fetch = async () => expansionPage(["a", "b", "c"], 3);
    const terminology = cappedTerminology();

    const completed = await completeCappedExpansions(terminology, ARGS, KEYED);

    assert.deepEqual(completed, [], "nothing is reported as completed");
    assert.deepEqual(
      terminology.valueSets[0].codes.map((c) => c.code),
      ["upstream-1", "upstream-2"],
      "upstream's codes survive, so `truncated` survives, so routing still refuses",
    );
    assert.match(warnings.join("\n"), /short of the 5 the bundle declares/);
  });

  it("REJECTS an expansion padded with duplicates to the declared total", async () => {
    // Raw length clears the bar; distinct length does not. Comparing before dedupe would write a set
    // that is short after all — the exact outcome the short-expansion guard exists to prevent.
    globalThis.fetch = async () =>
      expansionPage(["upstream-1", "upstream-2", "a", "b", "a"], 5);
    const terminology = cappedTerminology();

    const completed = await completeCappedExpansions(terminology, ARGS, KEYED);

    assert.deepEqual(completed, [], "nothing is reported as completed");
    assert.deepEqual(
      terminology.valueSets[0].codes.map((c) => c.code),
      ["upstream-1", "upstream-2"],
      "upstream's codes survive, so `truncated` survives, so routing still refuses",
    );
    assert.match(warnings.join("\n"), /4 distinct codes .* short of the 5/);
  });

  it("REJECTS an expansion of the right size that does not contain upstream's codes", async () => {
    // A count cannot distinguish "the full version of this set" from "a different set that happens to
    // be bigger" — which is what a wrong release pin looks like from here.
    globalThis.fetch = async () => expansionPage(["a", "b", "c", "d", "e"], 5);
    const terminology = cappedTerminology();

    const completed = await completeCappedExpansions(terminology, ARGS, KEYED);

    assert.deepEqual(completed, [], "nothing is reported as completed");
    assert.deepEqual(
      terminology.valueSets[0].codes.map((c) => c.code),
      ["upstream-1", "upstream-2"],
      "upstream's codes survive, so `truncated` survives, so routing still refuses",
    );
    assert.match(warnings.join("\n"), /missing 2 of the 2 codes upstream shipped/);
  });

  it("leaves everything alone and warns when the key is absent", async () => {
    globalThis.fetch = async () => assert.fail("must not dial VSAC without a key");
    const terminology = cappedTerminology();

    const completed = await completeCappedExpansions(terminology, ARGS, {});

    assert.deepEqual(completed, []);
    assert.equal(terminology.valueSets[0].codes.length, 2);
    assert.match(warnings.join("\n"), /WORKWELL_VSAC_API_KEY is unset/);
  });

  it("leaves everything alone and stays silent when the flag is not passed", async () => {
    globalThis.fetch = async () => assert.fail("must not dial VSAC without the flag");
    const terminology = cappedTerminology();

    const completed = await completeCappedExpansions(
      terminology,
      { ...ARGS, completeCappedExpansions: false },
      KEYED,
    );

    assert.deepEqual(completed, []);
    assert.equal(terminology.valueSets[0].codes.length, 2);
    assert.deepEqual(warnings, [], "the default path is not a warning");
  });

  it("keeps upstream's codes when VSAC fails outright", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => "" });
    const terminology = cappedTerminology();

    const completed = await completeCappedExpansions(terminology, ARGS, KEYED);

    assert.deepEqual(completed, []);
    assert.equal(terminology.valueSets[0].codes.length, 2);
    assert.match(warnings.join("\n"), /could not complete .* from VSAC/);
  });
});
