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

import {
  completeTerminology,
  declaredValueSets,
  expandFromVsac,
  sortValueSets,
} from "./vsac-expansion.mjs";

const OID = "2.16.840.1.113883.3.464.1003.110.12.1082";
const ARGS = {
  completeTerminology: true,
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

describe("completeTerminology — capped sets (ADR-041)", () => {
  it("replaces a capped set with the full expansion and reports it", async () => {
    globalThis.fetch = async (url) => {
      calls.push({ url: String(url) });
      // A real full expansion is a SUPERSET of the truncated sample upstream shipped.
      return expansionPage(["c", "upstream-2", "a", "b", "upstream-1"], 5);
    };
    const terminology = cappedTerminology();

    const completed = await completeTerminology(terminology, ARGS, KEYED);

    assert.deepEqual(completed, [{ oid: OID, reason: "capped", had: 2, now: 5, declaredTotal: 5 }]);
    assert.equal(terminology.valueSets[0].codes.length, 5);
    assert.equal(calls.length, 1, "only the capped set is re-expanded");
  });

  it("writes codes sorted by system|code and deduped, because the sidecar is pinned by hash", async () => {
    globalThis.fetch = async () =>
      expansionPage(["c", "upstream-2", "a", "upstream-1", "b", "a"], 5);
    const terminology = cappedTerminology();

    await completeTerminology(terminology, ARGS, KEYED);

    assert.deepEqual(
      terminology.valueSets[0].codes.map((c) => c.code),
      ["a", "b", "c", "upstream-1", "upstream-2"],
      "VSAC page order is not a contract; the artifact's byte order is",
    );
  });

  it("REJECTS a short expansion rather than swapping in a differently-incomplete set", async () => {
    globalThis.fetch = async () => expansionPage(["a", "b", "c"], 3);
    const terminology = cappedTerminology();

    const completed = await completeTerminology(terminology, ARGS, KEYED);

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

    const completed = await completeTerminology(terminology, ARGS, KEYED);

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

    const completed = await completeTerminology(terminology, ARGS, KEYED);

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

    const completed = await completeTerminology(terminology, ARGS, {});

    assert.deepEqual(completed, []);
    assert.equal(terminology.valueSets[0].codes.length, 2);
    assert.match(warnings.join("\n"), /WORKWELL_VSAC_API_KEY is unset/);
  });

  it("leaves everything alone and stays silent when the flag is not passed", async () => {
    globalThis.fetch = async () => assert.fail("must not dial VSAC without the flag");
    const terminology = cappedTerminology();

    const completed = await completeTerminology(
      terminology,
      { ...ARGS, completeTerminology: false },
      KEYED,
    );

    assert.deepEqual(completed, []);
    assert.equal(terminology.valueSets[0].codes.length, 2);
    assert.deepEqual(warnings, [], "the default path is not a warning");
  });

  it("keeps upstream's codes when VSAC fails outright", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => "" });
    const terminology = cappedTerminology();

    const completed = await completeTerminology(terminology, ARGS, KEYED);

    assert.deepEqual(completed, []);
    assert.equal(terminology.valueSets[0].codes.length, 2);
    assert.match(warnings.join("\n"), /could not complete .* from VSAC/);
  });
});

/**
 * ADR-053. A value set the ELM RETRIEVES that the bundle does not ship at all.
 *
 * Every assertion here is about a failure direction. The dangerous outcome is not "we failed to source
 * it" — routing refuses that, loudly, by design. It is "we sourced something and it was empty or
 * short", because an empty value set matches nothing and fqm then reports the whole roster
 * out-of-population (ADR-043), which reads downstream exactly like a genuinely ineligible cohort.
 */
const ABSENT_OID = "2.16.840.1.113883.3.526.3.1278";

/** Terminology as `collectTerminology` produces it for a bundle with one retrieved-but-unshipped set. */
function absentTerminology() {
  return {
    valueSets: [
      {
        oid: "2.16.840.1.113883.3.464.1003.108.12.1018",
        url: "http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.464.1003.108.12.1018",
        declaredTotal: 1,
        codes: [{ system: "http://loinc.org", code: "24606-6" }],
      },
    ],
    absent: [
      {
        oid: ABSENT_OID,
        url: `http://cts.nlm.nih.gov/fhir/ValueSet/${ABSENT_OID}`,
        name: "Tobacco Use Screening",
      },
    ],
  };
}

describe("completeTerminology — absent sets (ADR-053)", () => {
  it("sources an absent value set whole and records it under a DISTINCT reason", async () => {
    globalThis.fetch = async () => expansionPage(["b", "a", "c"], 3);
    const terminology = absentTerminology();

    const completed = await completeTerminology(terminology, ARGS, KEYED);

    // `reason` is the point. A completed cap was checked against upstream's declared total AND against
    // containment of upstream's own codes; this had neither check available, so it must never be read
    // as evidence of the same strength.
    assert.deepEqual(completed, [
      { oid: ABSENT_OID, reason: "absent-upstream", had: 0, now: 3, declaredTotal: null },
    ]);
    assert.deepEqual(terminology.absent, [], "nothing is left absent once it is sourced");
    const sourced = terminology.valueSets.find((v) => v.oid === ABSENT_OID);
    assert.deepEqual(sourced.codes.map((c) => c.code), ["a", "b", "c"], "sorted, because the sidecar is hashed");
    // Must equal what we hold, or `buildManifest` derives a phantom `truncated` row from a set that is
    // in fact complete — and routing would then refuse an artifact that is fine.
    assert.equal(sourced.declaredTotal, 3);
  });

  it("declaredTotal is null in the RECORD and VSAC's total in the value set — two different questions", async () => {
    globalThis.fetch = async () => expansionPage(["a", "b"], 2);
    const terminology = absentTerminology();

    const [record] = await completeTerminology(terminology, ARGS, KEYED);

    assert.equal(record.declaredTotal, null, "the bundle declared nothing; VSAC's number is not upstream's");
    assert.equal(terminology.valueSets.find((v) => v.oid === ABSENT_OID).declaredTotal, 2);
  });

  it("REFUSES an empty expansion — an empty set is the ADR-043 silence, not a completion", async () => {
    globalThis.fetch = async () => expansionPage([], 0);
    const terminology = absentTerminology();

    const completed = await completeTerminology(terminology, ARGS, KEYED);

    assert.deepEqual(completed, []);
    assert.deepEqual(terminology.absent.map((v) => v.oid), [ABSENT_OID], "still absent, so routing refuses");
    assert.equal(terminology.valueSets.length, 1, "nothing was appended");
    assert.match(warnings.join("\n"), /returned no codes for absent value set/);
  });

  it("REFUSES a short read — VSAC's own total is the only baseline an absent set has", async () => {
    // The `expandFromVsac` loop stops when a page comes back empty. A server that claims 9 and serves 2
    // therefore terminates cleanly with 2 codes, and without this check they would be written as though
    // they were the whole set.
    let page = 0;
    globalThis.fetch = async () => (page++ === 0 ? expansionPage(["a", "b"], 9) : expansionPage([], 9));
    const terminology = absentTerminology();

    const completed = await completeTerminology(terminology, ARGS, KEYED);

    assert.deepEqual(completed, []);
    assert.deepEqual(terminology.absent.map((v) => v.oid), [ABSENT_OID]);
    assert.match(warnings.join("\n"), /claimed 9 codes .* and returned 2 distinct/);
  });

  it("keeps it absent when VSAC fails outright", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => "" });
    const terminology = absentTerminology();

    const completed = await completeTerminology(terminology, ARGS, KEYED);

    assert.deepEqual(completed, []);
    assert.deepEqual(terminology.absent.map((v) => v.oid), [ABSENT_OID]);
    assert.match(warnings.join("\n"), /could not source absent value set .* from VSAC/);
  });

  it("runs for an absent set even when NOTHING is capped — the two are independent conditions", async () => {
    // Before ADR-053 this function short-circuited on `capped.length === 0`. A measure whose only
    // problem is an absent value set would have returned immediately and silently, with the flag passed
    // and the key present.
    globalThis.fetch = async () => expansionPage(["a"], 1);
    const terminology = absentTerminology();
    assert.equal(
      terminology.valueSets.filter((v) => v.declaredTotal > v.codes.length).length,
      0,
      "precondition: nothing here is capped",
    );

    const completed = await completeTerminology(terminology, ARGS, KEYED);

    assert.equal(completed.length, 1);
  });

  it("does not dial VSAC without the key, and says so naming BOTH counts", async () => {
    globalThis.fetch = async () => assert.fail("must not dial VSAC without a key");
    const terminology = absentTerminology();

    assert.deepEqual(await completeTerminology(terminology, ARGS, {}), []);
    assert.deepEqual(terminology.absent.map((v) => v.oid), [ABSENT_OID]);
    assert.match(warnings.join("\n"), /0 capped and 1 absent value set/);
  });
});

describe("declaredValueSets", () => {
  const elmLibrary = (defs) => ({
    resource: {
      resourceType: "Library",
      content: [
        {
          contentType: "application/elm+json",
          data: Buffer.from(JSON.stringify({ library: { valueSets: { def: defs } } }), "utf8").toString(
            "base64",
          ),
        },
      ],
    },
  });

  it("reads the canonicals the ELM retrieves, across libraries, de-duplicated", () => {
    const bundle = {
      entry: [
        elmLibrary([{ id: "vs://a", name: "A" }, { id: "vs://b" }]),
        elmLibrary([{ id: "vs://b", name: "B-again" }, { id: "vs://c" }]),
        { resource: { resourceType: "Measure" } },
      ],
    };
    assert.deepEqual(declaredValueSets(bundle).map((v) => v.url), ["vs://a", "vs://b", "vs://c"]);
    assert.equal(
      declaredValueSets(bundle)[1].name,
      undefined,
      "first declaration wins, exactly as the executor package does",
    );
  });

  it("ignores libraries with no elm+json content, and non-Library resources", () => {
    const bundle = {
      entry: [
        { resource: { resourceType: "Library", content: [{ contentType: "text/cql", data: "eA==" }] } },
        { resource: { resourceType: "ValueSet", url: "vs://shipped" } },
        elmLibrary([{ id: "vs://a" }]),
      ],
    };
    assert.deepEqual(declaredValueSets(bundle).map((v) => v.url), ["vs://a"]);
  });

  it("THROWS on ELM that will not parse, matching the executor package deliberately", () => {
    // Swallowing it would trade a precise parse error for an opaque failure deep inside fqm at
    // evaluation time — and, worse, would report a bundle whose ELM is unreadable as having NO absent
    // value sets, which is the vacuous-guard shape.
    const bundle = {
      entry: [
        {
          resource: {
            resourceType: "Library",
            content: [
              {
                contentType: "application/elm+json",
                data: Buffer.from("{not json", "utf8").toString("base64"),
              },
            ],
          },
        },
      ],
    };
    assert.throws(() => declaredValueSets(bundle));
  });

  it("survives an empty / entry-less bundle", () => {
    assert.deepEqual(declaredValueSets({}), []);
    assert.deepEqual(declaredValueSets({ entry: [] }), []);
    assert.deepEqual(declaredValueSets({ entry: [null, undefined] }), []);
  });
});

/**
 * The flag rename, asserted against the real CLI rather than claimed in a comment.
 *
 * `--complete-capped-expansions` is printed in DEPLOY.md, in three deploy workflows and in
 * `officialRoutingProblems`' remedy text as it shipped before ADR-053. Keeping it accepted is only
 * worth anything if it IS accepted, and "we kept the alias" is precisely the kind of sentence that
 * survives in a docblock after the code stopped being true.
 *
 * Both cases stop inside `parseArgs`, before any fetch or write, so this costs milliseconds.
 */
describe("vendor-official-measure argument parsing", () => {
  const run = async (args) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { fileURLToPath } = await import("node:url");
    // `fileURLToPath`, not `URL.pathname`: the repo lives under "OneDrive - Higher Education
    // Commission", and a pathname percent-encodes every space into a path node cannot resolve. The
    // first cut did exactly that and all three assertions failed on MODULE_NOT_FOUND.
    const script = fileURLToPath(new URL("./vendor-official-measure.mjs", import.meta.url));
    try {
      await promisify(execFile)(process.execPath, [script, ...args]);
      return "";
    } catch (err) {
      return String(err.stderr ?? err.message);
    }
  };

  it("still accepts the OLD --complete-capped-expansions name", async () => {
    const stderr = await run(["--complete-capped-expansions"]);
    // It must fail on the MISSING --measure, not on the flag: that is the difference between an
    // operator on a stale runbook getting a usage message and getting "unknown argument" mid-incident.
    assert.doesNotMatch(stderr, /unknown argument/, stderr);
    assert.match(stderr, /usage: --measure/);
  });

  it("accepts the new --complete-terminology name", async () => {
    const stderr = await run(["--complete-terminology"]);
    assert.doesNotMatch(stderr, /unknown argument/, stderr);
    assert.match(stderr, /usage: --measure/);
  });

  it("still REFUSES a genuinely unknown flag — the alias did not open the door to everything", async () => {
    const stderr = await run(["--complete-capped-expansion"]); // singular typo
    assert.match(stderr, /unknown argument: --complete-capped-expansion/);
  });
});

describe("sortValueSets", () => {
  it("orders by OID and is idempotent — the sidecar's bytes ARE the artifact", () => {
    const t = { valueSets: [{ oid: "2.16.9" }, { oid: "2.16.10" }, { oid: "2.16.1" }] };
    const once = sortValueSets(t).valueSets.map((v) => v.oid);
    // Code-point order, so "2.16.10" sorts before "2.16.9". Deliberately NOT numeric and NOT
    // locale-aware: this decides bytes hashed on a dev box and re-hashed on a CI runner.
    assert.deepEqual(once, ["2.16.1", "2.16.10", "2.16.9"]);
    assert.deepEqual(sortValueSets(t).valueSets.map((v) => v.oid), once);
  });
});
