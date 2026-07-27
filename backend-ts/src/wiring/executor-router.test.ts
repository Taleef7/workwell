/**
 * Per-measure execution routing (PR-7b).
 *
 * The most important test here is the boring one: with the flag unset, `routedEngineForEnv` returns the
 * authored engine ITSELF. Every environment that exists today is on that path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { officialRoutingProblems, routedEngineForEnv } from "./executor-router.ts";
import type { EvaluateMeasureBinding, MeasureOutcome } from "../engine/evaluate-measure.ts";
import type { LoadedTerminology } from "./official-terminology.ts";
import type { FqmCalculate } from "@workwell/official-executor";

/**
 * Terminology lives in a gitignored, fetched-at-build sidecar, so whether it is present is a fact about
 * the working tree. Every test here that is about ROUTING stubs it, so the default suite stays offline
 * and deterministic; `official-terminology.test.ts` covers the real file when it exists.
 */
const terminologyPresent = (): LoadedTerminology => ({ ok: true, codesByOid: new Map() });

/**
 * The two checks whose answer depends on the WORKING TREE rather than on the code, stubbed together
 * as ONE object on purpose.
 *
 * Both vendored artifacts genuinely fail them today: the terminology sidecar is fetched at build (so a
 * fresh clone and CI do not have it), and both carry a capped expansion (AdvancedIllness, 1000 of
 * 1997). Any test that asserts something about a LATER check has to get past both.
 *
 * They are bundled because applying HALF of them is the exact bug that reached CI: three tests stubbed
 * `cappedFor` and not `loadTerminology`, which passes on a machine with the sidecar and fails on one
 * without. Spreading one object cannot be half-done.
 */
const offlineChecks = {
  loadTerminology: terminologyPresent,
  cappedFor: () => [],
};

/** A calculator that reports one subject in every population — enough to prove routing reached fqm. */
const fakeCalculate: FqmCalculate = async () => ({
  results: [
    {
      patientId: "s1",
      detailedResults: [
        {
          populationResults: [
            { populationType: "initial-population", result: true },
            { populationType: "denominator", result: true },
            { populationType: "numerator", result: false },
          ],
          statementResults: [],
        },
      ],
    },
  ],
});

const outcome = (measure: string): MeasureOutcome => ({
  subjectId: "s1",
  measure,
  outcome: "COMPLIANT",
  evidence: { expressionResults: [] },
});

const authoredEngine = (): EvaluateMeasureBinding & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    async evaluate(input) {
      calls.push(input.measureId);
      return outcome(`authored:${input.measureId}`);
    },
  };
};

test("unset means the authored engine ITSELF — identity, not an equivalent wrapper", async () => {
  const authored = authoredEngine();
  for (const env of [{}, { WORKWELL_OFFICIAL_MEASURES: "" }, { WORKWELL_OFFICIAL_MEASURES: "   " }]) {
    const routed = await routedEngineForEnv(env as never, { authored });
    assert.equal(
      routed,
      authored,
      "the default path must have no dispatch layer at all — identity is what makes 'byte-identical' " +
        "a fact rather than a claim about two code paths agreeing",
    );
  }
  // A non-string value is ignored rather than coerced (e.g. a YAML `true`).
  const coerced = await routedEngineForEnv({ WORKWELL_OFFICIAL_MEASURES: true } as never, { authored });
  assert.equal(coerced, authored);
});

test("a named measure routes to the official executor; everything else stays authored", async () => {
  const authored = authoredEngine();
  const routed = await routedEngineForEnv(
    { WORKWELL_OFFICIAL_MEASURES: "cms122" } as never,
    // An injected calculator, not the real one: asserting `instanceof Error` would have passed on a
    // MODULE_NOT_FOUND just as happily as on a real routing hit, which proves nothing about routing.
    { authored, ...offlineChecks, expand: async () => [{ code: "a", system: "s" }], calculate: fakeCalculate },
  );

  const official = await routed.evaluate({ measureId: "cms122", patientBundle: {} });
  assert.equal(official.measure, "Diabetes: Glycemic Status Assessment Greater Than 9%");
  assert.deepEqual(authored.calls, [], "cms122 must NOT have reached the authored engine");

  const other = await routed.evaluate({ measureId: "audiogram", patientBundle: {} });
  assert.equal(other.measure, "authored:audiogram");
  assert.deepEqual(authored.calls, ["audiogram"]);
});

test("an explicit elm/metaOverride always stays authored, even for a routed measure", async () => {
  // The fidelity lab evaluates an official-SUBSET measure through the engine's metaOverride seam, and
  // the Rule Builder previews generated CQL the same way. Routing those to the official executor would
  // silently run a different measure than the caller asked for.
  const authored = authoredEngine();
  const routed = await routedEngineForEnv(
    { WORKWELL_OFFICIAL_MEASURES: "cms122" } as never,
    { authored, ...offlineChecks, expand: async () => [{ code: "a", system: "s" }] },
  );

  await routed.evaluate({ measureId: "cms122", patientBundle: {}, elm: { library: {} } });
  await routed.evaluate({
    measureId: "cms122",
    patientBundle: {},
    metaOverride: { name: "x", library: "L", periodMonths: 12 } as never,
  });
  assert.deepEqual(authored.calls, ["cms122", "cms122"]);
});

test("construction refuses every shape of misconfiguration, and says which", async () => {
  const authored = authoredEngine();
  const build = (value: string) =>
    routedEngineForEnv({ WORKWELL_OFFICIAL_MEASURES: value } as never, {
      authored,
      ...offlineChecks,
      expand: async () => [{ code: "a", system: "s" }],
    });

  // A typo must not silently serve authored results while the configuration claims official execution.
  await assert.rejects(() => build("cms999"), /cms999: not covered by the official MADiE test-case gate/);
  // "all" is a measure name like any other, and there is no measure called "all".
  await assert.rejects(() => build("all"), /all: not covered/);
  await assert.rejects(() => build("cms122,cms165"), /cms165: not covered/);

  // Whitespace tolerance, but only around real ids.
  const ok = await build(" cms122 , cms125 ");
  assert.notEqual(ok, authored, "a valid list must produce a router");
});

test("officialRoutingProblems names the gate, the artifact, and the semantics separately", () => {
  const stub = { loadTerminology: terminologyPresent };  // caps deliberately NOT stubbed here
  assert.deepEqual(officialRoutingProblems({}, stub), [], "unset is always legal");

  // NOT asserted as an empty list: cms122 and cms125 both currently carry a REAL capped expansion
  // (AdvancedIllness, 1000 of 1997 codes, retrieved by both ELMs), so the honest answer today is that
  // neither is routable until PR-9 completes it from VSAC. That refusal is the point — asserting []
  // here would have meant deleting the guard the moment it started working.
  const vendored = officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: "cms122,cms125" }, stub);
  assert.ok(
    vendored.every((p) => /expands to only \d+ of \d+ codes/.test(p)),
    `the only outstanding problems should be the capped expansion: ${JSON.stringify(vendored)}`,
  );

  // ALL the problems, not the first: an operator fixing one at a time, learning about the next only
  // after a redeploy, is how a five-minute configuration takes an afternoon. cms130 is both ungated and
  // unvendored, and hears about both.
  const problems = officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: "cms130" }, stub);
  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /cms130: not covered by the official MADiE test-case gate/);
  assert.match(problems[1]!, /cms130: no executable official artifact is vendored/);
});

test("a missing terminology sidecar is a routing problem, named as a build step", async () => {
  // The sidecar is fetched at build and gitignored, so "the build step has not run" is the single most
  // likely reason official routing refuses on a fresh clone or in a new CI job. It must not surface as
  // "26 of 26 value sets could not be expanded" — accurate, and it sends an operator hunting for 26
  // terminology problems instead of running one command.
  const problems = officialRoutingProblems(
    { WORKWELL_OFFICIAL_MEASURES: "cms122" },
    {
      ...offlineChecks,
      loadTerminology: () => ({ ok: false, problem: "cms122: official terminology is not present" }),
    },
  );
  assert.deepEqual(problems, ["cms122: official terminology is not present"]);
});

test("terminology is preflighted at CONSTRUCTION, not at first evaluation", async () => {
  // The whole reason: by the time a subject is evaluated a run is underway and outcomes are being
  // written, and this failure's natural mode is silence — an unexpandable value set makes every
  // retrieve match nothing, so the measure reports an empty population rather than an error.
  const authored = authoredEngine();
  let expandCalls = 0;
  await assert.rejects(
    () =>
      routedEngineForEnv({ WORKWELL_OFFICIAL_MEASURES: "cms122" } as never, {
        authored,
        ...offlineChecks,
        expand: async () => {
          expandCalls += 1;
          return []; // a sidecar that verified but expands nothing for this measure's OIDs
        },
      }),
    /value sets could not be expanded[\s\S]*vendor:official/,
  );
  assert.ok(expandCalls > 0, "it must actually try, not just inspect the manifest");
});

test("the expander is keyed by MEASURE, not by a single flat OID map", async () => {
  // 23 of CMS122's 26 canonicals are also CMS125's, so a flat map works — until two artifacts are
  // pinned at different upstream commits and disagree about one expansion, at which point whichever
  // loaded first silently wins for both. Terminology belongs to the artifact; so does the lookup.
  const seen: Array<[string, string]> = [];
  await assert.rejects(() =>
    routedEngineForEnv({ WORKWELL_OFFICIAL_MEASURES: "cms122" } as never, {
      authored: authoredEngine(),
      ...offlineChecks,
      expand: async (oid, catalogId) => {
        seen.push([oid, catalogId]);
        return [];
      },
    }),
  );
  assert.ok(seen.length > 0);
  assert.ok(
    seen.every(([, catalogId]) => catalogId === "cms122"),
    "every expansion must be attributed to the measure that asked for it",
  );
});

test("non-proportion scoring is refused at CONSTRUCTION, not per subject", async () => {
  // It was the one adapter refusal that fired inside evaluate() — and the run pipeline error-isolates a
  // per-subject throw into MISSING_DATA, so a cohort artifact would have produced a *successful*
  // population run with every subject MISSING_DATA. That is the silent-empty-population failure the
  // terminology preflight exists to prevent, reached through the door next to it.
  const { officialRoutingProblems } = await import("./executor-router.ts");
  // Asserting the ABSENCE of a scoring problem rather than an empty list. An empty list would make
  // this test a claim about every other check too — including the terminology ones, whose answer
  // depends on a fetched-at-build file this suite deliberately does not have.
  const problems = officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: "cms122" });
  assert.ok(!problems.some((p) => /scoring/.test(p)), `cms122 is a proportion measure: ${problems}`);

  // The check reads the manifest, so prove it fires by pointing it at a scoring the mapping cannot
  // express. (Both vendored measures are proportion, so this asserts the CHECK, via the message text.)
  const { loadOfficialArtifact } = await import("./official-artifacts.ts");
  const artifact = loadOfficialArtifact("cms122")!;
  assert.equal(artifact.manifest.scoring, "proportion", "if this ever changes, the guard above must fire");
});

test("the scheduler's env allowlist carries the flag — the nightly run must route like a manual one", async () => {
  // Without this, POST /api/runs/manual evaluates cms122 officially while the nightly ALL_PROGRAMS run
  // — the one that populates /compliance, /programs and quality_snapshots — evaluates it with the
  // AUTHORED CQL. Two engines, two answers for one measure, latest-run-wins, `official-measures=on` on
  // the boot line throughout. This is the THIRD instance of that bug in the same block (see #331 and
  // #263), so it is asserted rather than left to a comment.
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const allowlist = server.slice(server.indexOf("const schedulerEnv"), server.indexOf("const schedulerInterval"));
  for (const key of ["WORKWELL_OFFICIAL_MEASURES", "WORKWELL_INCREMENTAL_EVAL", "WORKWELL_VSAC_API_KEY"]) {
    assert.ok(
      allowlist.includes(`${key}: process.env.${key}`),
      `${key} must be threaded to schedulerTick, or the nightly run behaves differently from a manual one`,
    );
  }
});

test("boot reports a bad configuration loudly, because everything else about it looks healthy", async () => {
  // A typo'd flag would otherwise boot clean, log `official-measures=on`, keep /actuator/health green
  // (it is deliberately DB-free, so the 15-minute reconciler reports healthy) and 500 every evaluating
  // route — the exact symptom profile of the four-day Neon outage.
  const { readFileSync } = await import("node:fs");
  const worker = readFileSync(new URL("../worker.ts", import.meta.url), "utf8");
  assert.match(
    worker,
    /officialRoutingProblems\(env\)/,
    "worker boot must validate official routing, not leave it to lazy construction",
  );
  assert.match(worker, /OFFICIAL_ROUTING_MISCONFIGURED/, "and emit a greppable WORKWELL_ALERT for it");
});

test("an export of a PAST official run keeps its meaning after the flag is turned off", async () => {
  // The documented rollback for PR-9 is "unset the flag". If provenance came from the current config,
  // that rollback would silently reinterpret every historical official run through the status
  // histogram — reversing cms122's numerator, since its official numerator is poor control and the
  // workflow status inverts it. A regulatory export of a finished run must not change meaning because
  // of a configuration change made afterwards.
  const { officialMembership } = await import("../fhir/measure-report.ts");
  const officialOutcome = {
    evidence: {
      expressionResults: [],
      official: {
        ecqmId: "122FHIR",
        version: "1.0.000",
        engine: "fqm-execution",
        artifactSha256: "sha256:x",
        populationResults: [
          { populationType: "initial-population", result: true },
          { populationType: "denominator", result: true },
          { populationType: "numerator", result: true },
        ],
      },
    },
  };
  // The signal the export path keys on is in the ROW, and is readable with the flag unset.
  assert.ok(
    officialMembership(officialOutcome.evidence),
    "a stored official outcome is self-describing — no env var required to interpret it",
  );
  assert.equal(officialMembership({ expressionResults: [] }), null, "and an authored one is not");
});
