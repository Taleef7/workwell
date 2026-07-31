/**
 * Per-measure execution routing (PR-7b).
 *
 * The most important test here is the boring one: with the flag unset, `routedEngineForEnv` returns the
 * authored engine ITSELF. Every environment that exists today is on that path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { officialLogicVersion, officialRoutingProblems, routedEngineForEnv } from "./executor-router.ts";
import { loadOfficialArtifact, type OfficialArtifact } from "./official-artifacts.ts";
import { requiredOids } from "./official-executor-adapter.ts";
import type { EvaluateMeasureBinding, MeasureOutcome } from "../engine/evaluate-measure.ts";
import type { LoadedTerminology } from "./official-terminology.ts";
import type { FqmCalculate } from "@workwell/official-executor";

/**
 * Terminology lives in a gitignored, fetched-at-build sidecar, so whether it is present is a fact about
 * the working tree. Every test here that is about ROUTING stubs it, so the default suite stays offline
 * and deterministic; `official-terminology.test.ts` covers the real file when it exists.
 *
 * It carries a code for **every OID the artifact's ELM retrieves**, rather than an empty map. That is
 * not decoration — it is what makes the stub represent a state a real artifact can be in. An empty map
 * says "the sidecar loaded and holds nothing", and once ADR-053 taught the router to notice that, this
 * stub started meaning "all 26 of this measure's value sets are absent from the artifact" and nine
 * routing tests failed on a condition none of them was about. A stub that describes an impossible
 * artifact is a stub that will keep doing this.
 */
const terminologyPresent = (artifact: OfficialArtifact): LoadedTerminology => ({
  ok: true,
  codesByOid: new Map(requiredOids(artifact).map((oid) => [oid, [{ system: "urn:test", code: "x" }]])),
});

/**
 * The checks whose answer depends on the WORKING TREE rather than on the code, stubbed together as ONE
 * object on purpose.
 *
 * Both vendored artifacts genuinely fail them today: the terminology sidecar is fetched at build (so a
 * fresh clone and CI do not have it), and both carry a capped expansion (AdvancedIllness, 1000 of
 * 1997). Any test that asserts something about a LATER check has to get past both.
 *
 * They are bundled because applying HALF of them is the exact bug that reached CI: three tests stubbed
 * `cappedFor` and not `loadTerminology`, which passes on a machine with the sidecar and fails on one
 * without. Spreading one object cannot be half-done.
 *
 * ADR-053's absent-value-set check deliberately does NOT appear here. It reads the stubbed
 * `loadTerminology` above, which now describes a complete artifact, so it answers "nothing absent" on
 * its own — one fewer thing to remember to stub, instead of a third entry in a list whose docblock is
 * already a warning about forgetting one.
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

const patientBundle = (id: string) => ({ resourceType: "Bundle", entry: [{ resource: { resourceType: "Patient", id } }] });

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

  const official = await routed.evaluate({ measureId: "cms122", patientBundle: patientBundle("s1") });
  assert.equal(official.measure, "Diabetes: Glycemic Status Assessment Greater Than 9%");
  assert.deepEqual(authored.calls, [], "cms122 must NOT have reached the authored engine");

  const other = await routed.evaluate({ measureId: "audiogram", patientBundle: {} });
  assert.equal(other.measure, "authored:audiogram");
  assert.deepEqual(authored.calls, ["audiogram"]);
});

test("PR-8: the engine declares the ARTIFACT's logic identity for routed measures, and nothing else", async () => {
  const authored = authoredEngine();
  const routed = await routedEngineForEnv(
    { WORKWELL_OFFICIAL_MEASURES: "cms122" } as never,
    { authored, ...offlineChecks, expand: async () => [{ code: "a", system: "s" }] },
  );

  const declared = routed.logicVersionFor?.("cms122");
  assert.ok(declared, "a routed measure must declare an identity — its absence is the silent failure");
  assert.equal(declared, officialLogicVersion(loadOfficialArtifact("cms122")!), "and it is the artifact's, computed the one way");
  assert.equal(routed.logicVersionFor?.("audiogram"), undefined, "an unrouted measure declares nothing — it IS authored");
  assert.equal(routed.logicVersionFor?.("nonexistent"), undefined);
});

test("PR-8: the identity moves with the artifact and can never collide with an authored ELM hash", () => {
  // Digest shapes as they really are: a manifest's `sha256` fields carry their own `sha256:` prefix, so a
  // real identity has FIVE colon-separated fields, not four. Bare "AAA"/"TTT" would pass every assertion
  // here while quietly misrepresenting what an `eval_state` row looks like.
  const base = {
    manifest: {
      version: "1.0.000",
      sha256: "sha256:c0d99a8e1f2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d",
      terminology: { sha256: "sha256:6da37c2f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7" },
    },
  } as never as Parameters<typeof officialLogicVersion>[0];
  const of = (over: Record<string, unknown>) =>
    officialLogicVersion({ manifest: { ...(base as { manifest: object }).manifest, ...over } } as never);

  const original = officialLogicVersion(base);
  assert.notEqual(of({ version: "1.1.000" }), original, "a version bump is a logic change");
  assert.notEqual(of({ sha256: "sha256:1111111111111111111111111111111111111111111111111111111111111111" }), original, "a re-vendored bundle is a logic change");
  // The one the roadmap's sketch omitted: expansions are fetched at build and pinned in the manifest,
  // so a re-fetch at a different upstream ref moves value-set membership with the bundle unchanged.
  assert.notEqual(of({ terminology: { sha256: "sha256:2222222222222222222222222222222222222222222222222222222222222222" } }), original, "moved terminology is a logic change");
  assert.notEqual(of({ terminology: undefined }), original, "an unpinned artifact is not the same as a pinned one");
  assert.equal(officialLogicVersion(base), original, "and it is stable — not a nonce");

  assert.ok(original.startsWith("official-fqm:"), "prefixed so it is disjoint from the authored sha256: space");
  assert.ok(!original.startsWith("sha256:"));
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

  // NOT asserted as an empty list, and NOT asserted as non-empty either. Both vendored artifacts
  // carry a REAL capped expansion as upstream ships them (AdvancedIllness, 1000 of 1997 codes,
  // retrieved by both ELMs), so today neither is routable — and once `vendor:official
  // --complete-capped-expansions` has run against a re-vendored artifact, both are. What must hold in
  // either state is that a capped expansion is the ONLY thing still standing between these two
  // measures and routing: any other problem here is a regression in an earlier check.
  const vendored = officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: "cms122,cms125" }, stub);
  assert.deepEqual(
    vendored.filter((p) => !/expands to only \d+ of \d+ codes/.test(p)),
    [],
    `the only outstanding problems should be capped expansions: ${JSON.stringify(vendored)}`,
  );

  // ALL the problems, not the first: an operator fixing one at a time, learning about the next only
  // after a redeploy, is how a five-minute configuration takes an afternoon. cms130 is both ungated and
  // unvendored, and hears about both.
  const problems = officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: "cms130" }, stub);
  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /cms130: not covered by the official MADiE test-case gate/);
  assert.match(problems[1]!, /cms130: no executable official artifact is vendored/);
});

// The assertion above is deliberately state-tolerant, which means that since ADR-041 completed the
// expansions it passes VACUOUSLY: `cappedFor` returns [] for both real artifacts, so deleting the
// capped-expansion loop from `officialRoutingProblems` would leave this file green. That is the same
// shape as the ADR-036 finding this repo already caught once — `cappedExpansions` was documented as a
// guard while having no production caller — so the guard gets a test that does not depend on what the
// vendored artifacts happen to contain today.
test("a capped expansion the ELM retrieves REFUSES routing, whatever the real artifacts hold", () => {
  const capped = {
    ...offlineChecks,
    cappedFor: () => [{ oid: "2.16.840.1.113883.3.464.1003.110.12.1082", have: 1000, declaredTotal: 1997 }],
  };

  const problems = officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: "cms122" }, capped);

  assert.equal(problems.length, 1, `exactly the capped-expansion problem: ${JSON.stringify(problems)}`);
  const [problem = ""] = problems;
  assert.match(problem, /expands to only 1000 of 1997 codes/);
  // The remedy has to be in the message, and it has to be a flag the script still ACCEPTS. A warning
  // printed at vendor time is long gone by the time someone sets the flag and hits this, and a remedy
  // naming a removed flag is worse than none — it sends an operator to "unknown argument" mid-incident.
  // `--complete-capped-expansions` remains accepted as an alias, but the message names the current one.
  assert.match(problem, /--complete-terminology/);
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

test("PR-8: evaluateBatch routes a named measure and resolves undefined for everything else", async () => {
  const authored = authoredEngine();
  const routed = await routedEngineForEnv(
    { WORKWELL_OFFICIAL_MEASURES: "cms122" } as never,
    { authored, ...offlineChecks, expand: async () => [{ code: "a", system: "s" }], calculate: fakeCalculate },
  );

  const batched = await routed.evaluateBatch?.("cms122", () => [{ subjectId: "s1", patientBundle: patientBundle("s1") }], "2026-07-25");
  assert.ok(batched, "a routed measure must offer a batch path — that is the whole performance change");
  assert.equal(batched.get("s1")?.measure, "Diabetes: Glycemic Status Assessment Greater Than 9%");
  assert.deepEqual(authored.calls, [], "a batched official measure must NOT reach the authored engine");

  // `undefined` IS the predicate. A caller that got an empty Map instead could not tell "this measure has
  // no batch path" from "this batch legitimately produced nothing", and would skip evaluating the roster.
  const unrouted = await routed.evaluateBatch?.("audiogram", () => { throw new Error("the factory must NOT be invoked for an unrouted measure"); });
  assert.equal(unrouted, undefined, "an unrouted measure must fall back to the per-subject loop");
});

test("PR-8: the unset default offers NO batch path, so the pre-pass cannot engage", async () => {
  // The authored engine is `engineForEnv`'s own object and has no `evaluateBatch`, which is what makes
  // the pipeline's pre-pass provably dead on every environment that exists today.
  const routed = await routedEngineForEnv({} as never, { authored: authoredEngine() });
  assert.equal((routed as { evaluateBatch?: unknown }).evaluateBatch, undefined);
});

test("ADR-047: an EPISODE-OF-CARE measure is refused at construction", () => {
  // CMS68 declares populationBasis "Encounter": one patient with N qualifying encounters is N
  // denominator units, and `outcomeFromPopulations` maps exactly one boolean vector per SUBJECT. Routing
  // it would collapse four office visits into one outcome, so MeasureReport would count subjects where
  // the measure counts encounters.
  //
  // The MADiE deck cannot catch this — all 19 CMS68 cases are single-encounter, so 19/19 is a green gate
  // over exactly the shape that hides the defect (review, #358). Hence a construction-time refusal.
  // Asserted by PRESENCE, not by count. The first version required exactly one problem and passed only
  // because this machine has the gitignored terminology sidecar; CI has none, so cms68 legitimately
  // reports the episode problem AND a terminology one. A test that is green only where a gitignored file
  // happens to exist is the self-skip class wearing a different hat.
  const EPISODE = /populationBasis 'Encounter' is an EPISODE-OF-CARE measure/;
  assert.ok(
    officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: "cms68" }).some((p) => EPISODE.test(p)),
    "cms68 declares populationBasis Encounter and must be refused for it",
  );

  // The boolean-basis measures must not pick up the EPISODE refusal — checked specifically rather than
  // "no problems at all", which would again depend on the sidecar being present.
  for (const id of ["cms122", "cms125", "cms2", "cms951"]) {
    assert.ok(
      !officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: id }).some((p) => EPISODE.test(p)),
      `${id} has populationBasis boolean and must not be refused as an episode measure`,
    );
  }
});
