/**
 * What the DEPLOY WORKFLOW actually ships in `WORKWELL_OFFICIAL_MEASURES` — PR-9c / ADR-045.
 *
 * ## Why this file exists
 *
 * Every other check in this area validates a configuration someone *passes in*. Nothing validated the
 * one that actually reaches production. `officialRoutingProblems` is exercised with stubs and with
 * hand-written env objects; the string in `deploy-twh-mieweb.yml` was unexamined by any test.
 *
 * That gap matters precisely because of how the refusal behaves. Official routing validates at ENGINE
 * CONSTRUCTION, which is per request — `worker.ts` logs `OFFICIAL_ROUTING_MISCONFIGURED` on the first
 * request while the deliberately DB-free `/actuator/health` keeps answering **200**. So a workflow edit
 * naming a measure that is not vendored, not MADiE-gated, or whose terminology is capped would deploy
 * green, pass the health probe, satisfy the self-heal reconciler, and 500 every evaluating route. The
 * failure is loud in the logs and silent everywhere an operator looks first.
 *
 * ## The split, and why it is not one test
 *
 * The full check reads the artifact's terminology sidecar, which is gitignored and fetched at build — so
 * a single test would self-skip in `pnpm test` and read as covered. That is the exact defect class this
 * branch has been pulled up on four times (#350, #352, #354, #355). So:
 *
 *   - the **structural** half is pure and ALWAYS runs: every shipped id must be MADiE-gated and have a
 *     committed artifact. This catches the realistic edit — adding `cms999` before it is vendored;
 *   - the **terminology** half self-skips without the sidecar and is wired into CI's `official-cases`
 *     job, where the sidecar exists.
 *
 * Neither half asserts *which* measures are flipped. Pinning the value would make every future flip a
 * two-file change with a test that only ever says "you changed what you changed" — the property that
 * matters is that whatever is shipped is ROUTABLE.
 */
import { test } from "node:test";
import { RUN_STORE_PG_DDL } from "../stores/postgres/schema-pg.ts";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { officialRoutingProblems } from "./executor-router.ts";
import { loadDerivedArtifact, loadOfficialArtifact } from "./official-artifacts.ts";
import { absentValueSets, loadOfficialTerminology } from "./official-terminology.ts";
import { requiredOids } from "./official-executor-adapter.ts";
import { OFFICIAL_GATED_MEASURES } from "../standards/official-cases.ts";
import { OFFICIAL_MEASURE_SEMANTICS } from "./official-measure-semantics.ts";
import { buildSummaryMeasureReport } from "../fhir/measure-report.ts";

/**
 * DERIVED, not listed. The previous hardcoded three-name array was the #380/#400 guard-scope shape:
 * the test read as "the string that actually ships" while a NEW deploy workflow was invisible to it.
 *
 * A workflow is in scope when it (a) deploys a container through the shared deploy script and
 * (b) runs a WorkWell APP instance — the second half keyed on `WORKWELL_INSTANCE`, which every app
 * deployment sets. Both conditions are needed: a container that is not the app (a redirect, say)
 * ships no measure routing at all, so including it would pass vacuously and dilute what this guard
 * claims to check. Keyed on semantics rather than on an image variable name, which a future
 * workflow could rename.
 */
const WORKFLOW_DIR = fileURLToPath(new URL("../../../.github/workflows/", import.meta.url));
const WORKFLOWS = readdirSync(WORKFLOW_DIR)
  .filter((filename) => filename.endsWith(".yml") || filename.endsWith(".yaml"))
  .filter((filename) => {
    const yaml = readFileSync(join(WORKFLOW_DIR, filename), "utf8");
    return /\.github\/scripts\/deploy-mieweb-container\.sh/.test(yaml) && /WORKWELL_INSTANCE/.test(yaml);
  })
  .sort();

test("workflow discovery finds every WorkWell app deployment", () => {
  assert.deepEqual(WORKFLOWS, [
    "deploy-maui-mieweb.yml",
    "deploy-staging-mieweb.yml",
    "deploy-twh-mieweb.yml",
    "reconcile-maui-mieweb.yml",
    "reconcile-twh-mieweb.yml",
  ]);
});


/**
 * Workflows that recreate the SAME container and must therefore ship the same routing configuration.
 *
 * `reconcile-twh-mieweb.yml` rebuilds twh-api-ts from `:latest` during a self-heal using its own mirrored
 * env array. A key present in the deploy and missing here is **silently dropped** the first time the
 * reconciler fires: the container returns healthy, the image is unchanged, and the routed measures revert
 * to authored CQL with no signal at any layer. Codex caught exactly that on #356.
 */
const MUST_AGREE: ReadonlyArray<readonly [string, string]> = [
  ["deploy-twh-mieweb.yml", "reconcile-twh-mieweb.yml"],
  ["deploy-maui-mieweb.yml", "reconcile-maui-mieweb.yml"],
];

/**
 * The value each deploy workflow ships, or `null` where the seam is deliberately unset.
 *
 * Parsed out of the `jq` env array rather than imported, because the workflow IS the source of truth —
 * a constant in TypeScript that the workflow was supposed to match would be exactly the kind of
 * second copy that drifts.
 */
function shippedMeasures(workflow: string): string[] | null {
  return shippedIdList(workflow, "WORKWELL_OFFICIAL_MEASURES");
}

/**
 * The translations a workflow lets score the year they cover (`WORKWELL_DERIVED_MEASURES`, decision 3),
 * read by the SAME pattern as the official list — one parser, so the two lists cannot be read two ways.
 */
function shippedDerived(workflow: string): string[] | null {
  return shippedIdList(workflow, "WORKWELL_DERIVED_MEASURES");
}

function shippedIdList(workflow: string, key: string): string[] | null {
  const path = fileURLToPath(new URL(`../../../.github/workflows/${workflow}`, import.meta.url));
  return idListIn(readFileSync(path, "utf8"), key, workflow);
}

/** `shippedIdList` over workflow TEXT, so its stale-pattern refusal can be proved on a fixture. */
function idListIn(yaml: string, key: string, workflow: string): string[] | null {
  const match = yaml.match(new RegExp(String.raw`\{key:\s*"` + key + String.raw`",\s*value:\s*"([^"]*)"\}`));
  if (match) return match[1]!.split(",").map((s) => s.trim()).filter(Boolean);

  // `null` means "this workflow does not route officially" (or ships no translation), which every test
  // below treats as legal — so a regex that MISSED a present flag would make all of them pass
  // vacuously. Review (#356) measured that hole: `{ key: … }` with inner spaces, jq single-quoted
  // strings, `value: $official_measures` (the `--arg` style every secret in these files uses), or a
  // swapped key/value order all returned null and sailed through. The literal appears exactly once per
  // workflow when the flag is set, so its presence is a cheap, reliable discriminator between "absent"
  // and "my pattern is stale".
  //
  // `\bkey:` excludes this very sentence and the surrounding prose comments, which mention the name
  // without setting it.
  if (new RegExp(String.raw`\bkey:\s*"` + key + `"`).test(yaml)) {
    throw new Error(
      `${workflow} sets ${key} but this test's pattern did not match it. The guard ` +
        `is stale, not the workflow — fix the pattern rather than letting every assertion below pass ` +
        `vacuously.`,
    );
  }
  return null;
}

test("PR-9c: every officially-routed measure a deploy workflow ships is gated and vendored", () => {
  for (const workflow of WORKFLOWS) {
    const shipped = shippedMeasures(workflow);
    if (shipped === null) continue; // unset is always legal — the pre-PR-9c state of every stack

    assert.ok(shipped.length > 0, `${workflow}: WORKWELL_OFFICIAL_MEASURES is present but empty`);
    assert.ok(!shipped.includes("all"), `${workflow}: "all" is refused — it is a measure name like any other`);

    for (const id of shipped) {
      // The MADiE gate first: no measure may be routed without external known-answer validation
      // (roadmap §7.4 PR-6). This is the conjunct a well-meaning "just add the next measure" edit
      // forgets, because a vendored artifact looks complete on its own.
      assert.ok(
        (OFFICIAL_GATED_MEASURES as readonly string[]).includes(id),
        `${workflow} ships '${id}', which is NOT covered by the official MADiE test-case gate`,
      );
      const artifact = loadOfficialArtifact(id);
      assert.ok(artifact, `${workflow} ships '${id}', which has no vendored artifact under measures/official/`);
      assert.equal(artifact!.manifest.catalogId, id, `${id}: the vendored artifact declares a different catalogId`);
      assert.equal(
        artifact!.manifest.scoring,
        "proportion",
        `${id}: the population mapping assumes a proportion measure`,
      );
    }
  }
});

test("PR-9c/ADR-046: a routed measure's REPORT declares the notation its official numerator implies", () => {
  // The obligation `measure-report.ts` carried since PR-3: canonical, improvementNotation and membership
  // must switch TOGETHER or the report contradicts itself. cms122's official numerator is poor glycemic
  // control, so a report declaring `increase` over it says higher-is-better about a numerator counting
  // harm (~120 → ~27 on the 150-employee directory), and QRDA III has no notation element at all.
  //
  // This asserts the BUILT REPORT rather than the binding table, because ADR-046 moved the source: the
  // authored binding still says `increase` for cms122 and correctly so — that is the authored measure's
  // orientation. What matters is what a routed report emits.
  const run = {
    id: "run-flip-guard",
    measurementPeriodStart: "2025-01-01",
    measurementPeriodEnd: "2025-12-31",
  } as never;
  for (const workflow of WORKFLOWS) {
    for (const id of shippedMeasures(workflow) ?? []) {
      const semantics = OFFICIAL_MEASURE_SEMANTICS[id];
      assert.ok(semantics, `${id}: no recorded official numerator semantics — it cannot be routed`);
      const outcome = {
        id: "o1", runId: "run-flip-guard", subjectId: "s1", measureId: id,
        evaluationPeriod: "2025-12-31", status: "COMPLIANT",
        evidence: {
          official: {
            version: loadOfficialArtifact(id)?.manifest.version,
            artifactSha256: loadOfficialArtifact(id)?.manifest.sha256,
            populationResults: [
              { populationType: "initial-population", result: true },
              { populationType: "denominator", result: true },
              { populationType: "numerator", result: true },
            ],
          },
        },
        evaluatedAt: "2025-12-31T00:00:00.000Z",
      } as never;
      const report = buildSummaryMeasureReport(run, id, [outcome], "2025-12-31T00:00:00.000Z");
      const expected = semantics!.numeratorMeansCompliant ? "increase" : "decrease";
      assert.equal(
        report.improvementNotation?.coding[0]?.code,
        expected,
        `${workflow} routes '${id}', whose OFFICIAL numerator means ` +
          `${semantics!.numeratorMeansCompliant ? "compliance" : "FAILURE"} — its MeasureReport must declare ` +
          `improvementNotation '${expected}'. Discharge the canonical/notation/membership trio before routing it.`,
      );
      assert.ok(
        !report.measure.startsWith("urn:workwell:measure:" + id) || report.measure.includes(":official:"),
        `${id}: a routed report must not claim the plain WorkWell canonical over an official numerator`,
      );
    }
  }
});

/**
 * Any workflow env key, by the same "the workflow IS the source of truth" rule `shippedMeasures` uses.
 * `null` means the key is absent, which is legal and is what a profile that has not opted in looks like.
 */
function shippedValue(workflow: string, key: string): string | null {
  const path = fileURLToPath(new URL(`../../../.github/workflows/${workflow}`, import.meta.url));
  const yaml = readFileSync(path, "utf8");
  const match = yaml.match(new RegExp(String.raw`\{\s*key:\s*"` + key + String.raw`"\s*,\s*value:\s*"([^"]*)"\s*\}`));
  return match ? match[1]! : null;
}

/**
 * Keys whose value decides how much work a deployment does or how much history it keeps. Each is
 * checked for AGREEMENT between a deploy workflow and its reconciler, for the same reason the routed
 * measure list is: the reconciler recreates the same container on a health event, so a mismatch
 * silently changes the deployment nobody asked to change — a self-heal that quietly drops the roster
 * from 20,000 patients back to the 48-row fixture, or turns retention off, would look like a
 * successful recovery.
 */
const MUST_AGREE_KEYS = [
  "WORKWELL_MAUI_CORPUS_SIZE",
  "WORKWELL_MAUI_CORPUS_SEED",
  "WORKWELL_RUN_CHUNK_SIZE",
  "WORKWELL_SCHEDULER_ANCHOR_HOUR_UTC",
  "WORKWELL_SCHEDULER_DAYS",
  "WORKWELL_OUTCOME_RETENTION_DAYS",
] as const;

test("PR-9c: a self-healed container carries the same corpus size, chunking, anchor and retention", () => {
  for (const [a, b] of MUST_AGREE) {
    for (const key of MUST_AGREE_KEYS) {
      assert.equal(
        shippedValue(b, key),
        shippedValue(a, key),
        `${b} must ship the same ${key} as ${a} — it recreates the same container, so a mismatch ` +
          `silently changes the deployment on a self-heal`,
      );
    }
  }
});

test("the Maui deployment actually ships the corpus size, and it is the 20,000-patient one", () => {
  // Agreement alone is satisfied by BOTH workflows omitting the key, which is the vacuous reading of
  // the test above — and would leave the pilot on the 48-row fixture while every doc said 20,000.
  assert.equal(shippedValue("deploy-maui-mieweb.yml", "WORKWELL_MAUI_CORPUS_SIZE"), "20000");
  // Retention is ON since 2026-09-07 (issue #535). It was pinned ABSENT here until then, precisely so
  // that turning it on had to be a deliberate edit of this line rather than a value that slipped in —
  // which is what this now is. 400 days until 2026-09-30, then 90 to stop the sandbox's storage growing
  // on metered Neon (ADR-073: calibrated for a sandbox, revisited before a real performance year).
  assert.equal(shippedValue("deploy-maui-mieweb.yml", "WORKWELL_OUTCOME_RETENTION_DAYS"), "90");
  // Weekdays only since 2026-09-30: each nightly is 20,000 synthetic patients on metered compute.
  assert.equal(shippedValue("deploy-maui-mieweb.yml", "WORKWELL_SCHEDULER_DAYS"), "1-5");
  // ADR-073 d1's condition, enforced instead of remembered: Maui turns retention on ONLY alongside the
  // indexes compaction needs. Without the keep-set one the nightly DELETE sorts the whole outcomes
  // table inline during the tick (measured: an external merge sort, 19 MB to disk, at 300,000 rows).
  // Deleting an index while the window stays set is the dangerous direction, and it now fails here.
  //
  // Stated as an implication with the window READ, not with the literal `null` disjunct the first
  // version had — that disjunct was statically false given the assertion above, so the test reduced to
  // its right-hand side and would not have failed if the window were removed (review finding).
  // BOTH indexes are named, because d4 names both and checking one lets the other be deleted freely.
  const retentionOn = shippedValue("deploy-maui-mieweb.yml", "WORKWELL_OUTCOME_RETENTION_DAYS") !== null;
  for (const index of ["spike_outcomes_keepset_idx", "spike_cases_cited_outcome_idx"]) {
    assert.ok(
      !retentionOn || RUN_STORE_PG_DDL.includes(index),
      `a retention window on Maui requires ${index} (ADR-073 d1 / ADR-076 d4)`,
    );
  }
  // TWH is unchanged: no corpus, and no retention window — its history stays whole.
  assert.equal(shippedValue("deploy-twh-mieweb.yml", "WORKWELL_MAUI_CORPUS_SIZE"), null);
  assert.equal(shippedValue("deploy-twh-mieweb.yml", "WORKWELL_OUTCOME_RETENTION_DAYS"), null);
});

test("PR-9c: a container recreated by SELF-HEAL routes exactly what the deploy routes", () => {
  // The silent-revert case. Not "both files mention the flag" — the same VALUE, because a reconciler
  // shipping a different subset would flip measures on or off on a health event nobody initiated.
  for (const [a, b] of MUST_AGREE) {
    assert.deepEqual(
      shippedMeasures(b),
      shippedMeasures(a),
      `${b} must ship the same WORKWELL_OFFICIAL_MEASURES as ${a} — it recreates the same container, ` +
        `so a mismatch silently changes which measures are officially routed on a self-heal`,
    );
  }
});

/**
 * The full construction-time check against the REAL artifacts — the thing production runs.
 *
 * Self-skips without the terminology sidecar, and is therefore listed explicitly in CI's
 * `official-cases` job. **If you add a sidecar-reading test here, add it there too**, or it is
 * permanently skipped while reading as covered.
 */
/** Every measure ANY in-scope workflow ships — TWH's list alone left a Maui-only measure unexamined. */
const ALL_SHIPPED = [...new Set(WORKFLOWS.flatMap((workflow) => shippedMeasures(workflow) ?? []))];
const sidecarPresent = ALL_SHIPPED.every((id) => {
  const artifact = loadOfficialArtifact(id);
  return artifact ? loadOfficialTerminology(artifact).ok : false;
});
const skip = sidecarPresent ? false : "needs the vendored terminology sidecar (run `pnpm vendor:official`)";

/**
 * The two problem classes that are properties of how the artifact was VENDORED, not of the flag.
 *
 * Both are "the VSAC credential was not available when this tree's artifacts were produced", so both
 * are excused by the same condition below. `ABSENT` was added with ADR-053: before it, an artifact
 * missing a whole value set would have been asserted unconditionally, going red on exactly the
 * uncredentialed fork PRs the `CAPPED` excuse exists to protect.
 */
const CAPPED = /expands to only \d+ of \d+ codes/;
const ABSENT = /the upstream bundle ships no ValueSet resource for it/;

test("PR-9c: the shipped configuration constructs cleanly — no routing problems", { skip }, () => {
  // Uncredentialed contexts (fork PRs, Dependabot) deliberately re-vendor WITHOUT
  // `--complete-terminology`, because GitHub withholds the VSAC secret there. That leaves the
  // working-tree artifacts capped — and `officialRoutingProblems` refuses a capped expansion by design
  // (ADR-041), so asserting a clean result unconditionally would fail every outside contributor's PR for
  // a reason unrelated to their change. Codex caught this on #356 before it went red.
  //
  // So: the two VENDOR-time classes are EXCUSED only when the artifacts in the tree are actually
  // incomplete, and every other class is asserted always. The credentialed run on merge covers them.
  //
  // `complete` must read BOTH conditions. Reading `truncated` alone was true-but-narrow: it means "the
  // sidecar holds every code the bundle DECLARED", which says nothing about a value set the bundle
  // never declared at all (ADR-053). No shipped measure has one today — every vendored artifact
  // ships every value set its ELM retrieves — so this changes no verdict now; it stops the predicate
  // silently meaning less than its name the first time one does.
  const complete = ALL_SHIPPED.every((id) => {
    const artifact = loadOfficialArtifact(id);
    if (!artifact) return false;
    return (
      (artifact.manifest.terminology?.truncated ?? []).length === 0 &&
      absentValueSets(artifact, requiredOids(artifact)).length === 0
    );
  });

  for (const workflow of WORKFLOWS) {
    const shipped = shippedMeasures(workflow);
    if (shipped === null) continue;
    // Exactly what `routedEngineForEnv` throws on at engine construction. An empty array here is the
    // difference between a deploy that serves and one that answers 500 from every evaluating route
    // while /actuator/health stays green.
    const problems = officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: shipped.join(",") });
    const asserted = complete ? problems : problems.filter((p) => !CAPPED.test(p) && !ABSENT.test(p));
    assert.deepEqual(
      asserted,
      [],
      `${workflow} ships a configuration that official routing would REFUSE at construction` +
        (complete ? "" : " (capped-expansion problems excused: this context vendored without a VSAC key)"),
    );
  }
});

// ---------------------------------------------------------------------------
// WORKWELL_DERIVED_MEASURES — a WorkWell translation scoring the year it covers (decision 3).
//
// The same "the workflow IS the source of truth" rule as the official list, for the same reason: the
// router refuses an unfit translation at ENGINE construction, per request, while /actuator/health stays
// 200. No workflow ships a translation yet, so the checks on real workflows hold vacuously today; each is
// written to fail the moment one names a translation it cannot route, and the fixture tests prove that.
// ---------------------------------------------------------------------------

const DERIVED_KEY = "WORKWELL_DERIVED_MEASURES";
const OFFICIAL_KEY = "WORKWELL_OFFICIAL_MEASURES";
const DERIVED_DIR = fileURLToPath(new URL("../../measures/derived/", import.meta.url));

/** D2 as review can decide it: a manifest committed under the id that loads as a translation of that measure. */
const translationCommitted = (id: string): boolean =>
  existsSync(join(DERIVED_DIR, id, "manifest.json")) && loadDerivedArtifact(id)?.manifest.catalogId === id;

/**
 * What a workflow's two lists must satisfy to ship: the router's D1 and D2, the two refusals the committed
 * files alone decide. Pure over the parsed lists, so a fixture can prove each one fires.
 */
function derivedShippingProblems(
  workflow: string,
  official: string[] | null,
  derived: string[] | null,
  committed: (id: string) => boolean,
): string[] {
  if (derived === null) return []; // unset is always legal: CMS's artifact scores every year
  const problems: string[] = [];
  if (derived.length === 0) problems.push(`${workflow}: ${DERIVED_KEY} is present but empty`);
  for (const id of derived) {
    // D1: a translation stands in for a routed measure's CMS artifact for one year, never for the measure.
    if (!(official ?? []).includes(id)) {
      problems.push(`${workflow} ships translation '${id}' but does not route '${id}' in ${OFFICIAL_KEY} (D1)`);
    }
    // D2: the deploy would otherwise construct an engine that refuses every evaluating request.
    if (!committed(id)) {
      problems.push(`${workflow} ships translation '${id}', but no translation of '${id}' is committed under measures/derived/ (D2)`);
    }
  }
  return problems;
}

test(`${DERIVED_KEY}: a self-healed container scores with the same translations as a deployed one`, () => {
  // The silent-revert case again: a reconciler that dropped the key would put 2027 back on CMS's 2026
  // draft on a health event nobody initiated, and one that added it would turn a translation on.
  for (const [a, b] of MUST_AGREE) {
    assert.deepEqual(
      shippedDerived(b),
      shippedDerived(a),
      `${b} must ship the same ${DERIVED_KEY} as ${a} — it recreates the same container on a self-heal`,
    );
  }
});

test(`${DERIVED_KEY}: every translation a workflow ships is officially routed and committed (D1, D2)`, () => {
  for (const workflow of WORKFLOWS) {
    assert.deepEqual(derivedShippingProblems(workflow, shippedMeasures(workflow), shippedDerived(workflow), translationCommitted), []);
  }
});

test(`${DERIVED_KEY}: the shipping rule and its parser refuse a fixture workflow that breaks them`, () => {
  const fixture = (official: string | null, derived: string | null) =>
    [
      "            jq -nc \\",
      "              '[",
      ...(official === null ? [] : [`                {key: "${OFFICIAL_KEY}", value: "${official}"},`]),
      ...(derived === null ? [] : [`                {key: "${DERIVED_KEY}", value: "${derived}"},`]),
      `                {key: "WORKWELL_INSTANCE", value: "maui"}`,
      "              ]'",
    ].join("\n");
  const problemsFor = (yaml: string, committed: (id: string) => boolean = () => true) =>
    derivedShippingProblems("fixture.yml", idListIn(yaml, OFFICIAL_KEY, "fixture.yml"), idListIn(yaml, DERIVED_KEY, "fixture.yml"), committed);

  assert.deepEqual(problemsFor(fixture("cms137", "cms137")), []);
  assert.deepEqual(problemsFor(fixture("cms137", null)), [], "no translation shipped is legal");
  assert.deepEqual(idListIn(fixture("cms137", null), DERIVED_KEY, "fixture.yml"), null, "the two keys are never read for each other");
  // D1 alone: cms2's translation is committed, but cms2 is not routed.
  assert.deepEqual(problemsFor(fixture("cms137", "cms137,cms2")), [
    "fixture.yml ships translation 'cms2' but does not route 'cms2' in WORKWELL_OFFICIAL_MEASURES (D1)",
  ]);
  assert.match(problemsFor(fixture(null, "cms137")).join("\n"), /does not route 'cms137'/, "no official list at all");
  // D2 alone: routed, but nothing committed.
  assert.deepEqual(problemsFor(fixture("cms137,cms2", "cms2"), (id) => id === "cms137"), [
    "fixture.yml ships translation 'cms2', but no translation of 'cms2' is committed under measures/derived/ (D2)",
  ]);
  assert.match(problemsFor(fixture("cms137", "")).join("\n"), /present but empty/);
  // A spelling the pattern does not read must throw, never read as "absent".
  assert.throws(
    () => idListIn(`{ key: "${DERIVED_KEY}", value: "cms137" }`, DERIVED_KEY, "fixture.yml"),
    /sets WORKWELL_DERIVED_MEASURES but this test's pattern did not match it/,
  );
});

test(`${DERIVED_KEY}: TWH and staging ship no translation`, () => {
  // Translations exist for the pilot's performance year (decision 3). Turning one on for the occupational
  // stack or for staging is its own decision, so it must fail here rather than ride along with a Maui change.
  for (const workflow of ["deploy-twh-mieweb.yml", "reconcile-twh-mieweb.yml", "deploy-staging-mieweb.yml"]) {
    assert.equal(shippedDerived(workflow), null, `${workflow} ships ${DERIVED_KEY}`);
  }
});

/**
 * One key of a ci.yml job, from the plain YAML `env:` form the jobs use (`KEY: value`, at job or step
 * level), with a `${{ env.X }}` value resolved to the job's own `X`. `null` when the job binds no such key.
 */
function ciJobEnv(job: string, key: string): string | null {
  const path = fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url));
  return jobEnvIn(readFileSync(path, "utf8"), job, key);
}

/** `ciJobEnv` over workflow TEXT, so its scoping and its refusals can be proved on a fixture. */
function jobEnvIn(yaml: string, job: string, key: string, depth = 0): string | null {
  const lines = yaml.split(/\r?\n/);
  // A job is a two-space key under `jobs:`; its block runs to the next one, or to a top-level key. A job
  // that is not found THROWS: a renamed job would otherwise read as "key absent" and every comparison
  // against it would pass.
  const start = lines.findIndex((line) => line.trimEnd() === `  ${job}:`);
  if (start < 0) throw new Error(`no job '${job}' in the workflow — the guard is stale, not the workflow`);
  let end = start + 1;
  while (end < lines.length && !/^ {0,2}[A-Za-z0-9_-]+:/.test(lines[end]!)) end++;

  const binding = new RegExp(String.raw`^\s+` + key + String.raw`:[ \t]*(.*?)[ \t]*$`);
  // Any OTHER way of setting the key — a shell `KEY=…` prefix in a run block, a flow mapping — would
  // reach the process while this reader saw nothing, so it throws, like `shippedMeasures` on a stale pattern.
  const setting = new RegExp(String.raw`\b` + key + String.raw`\s*[:=]`);
  const values = new Set<string>();
  for (const line of lines.slice(start + 1, end)) {
    if (line.trimStart().startsWith("#")) continue;
    const match = line.match(binding);
    if (match) values.add(match[1]!.replace(/\s+#.*$/, "").replace(/^(["'])(.*)\1$/, "$2"));
    else if (setting.test(line)) {
      throw new Error(`job '${job}' sets ${key} in a form this reader does not parse: "${line.trim()}" — fix the reader`);
    }
  }
  if (values.size > 1) throw new Error(`job '${job}' binds ${key} to ${[...values].join(" and ")}; which a step sees depends on the step`);
  const value = [...values][0];
  if (value === undefined) return null;
  const ref = value.match(/^\$\{\{\s*env\.(\w+)\s*\}\}$/);
  if (!ref) return value;
  if (depth > 3) throw new Error(`job '${job}': ${key} is a chain of env references this reader will not follow`);
  const resolved = jobEnvIn(yaml, job, ref[1]!, depth + 1);
  if (resolved === null) throw new Error(`job '${job}': ${key} reads env.${ref[1]}, which the job does not bind`);
  return resolved;
}

test("ciJobEnv reads one job's env, follows ${{ env.X }}, and refuses what it cannot read", () => {
  const ci = [
    "jobs:",
    "  first:",
    "    env:",
    "      ROUTED: cms137 # the pilot",
    "    steps:",
    "      - name: boot",
    "        env:",
    "          WORKWELL_OFFICIAL_MEASURES: ${{ env.ROUTED }}",
    "        # WORKWELL_DERIVED_MEASURES: a comment is not a binding",
    "        run: echo",
    "  second:",
    "    env:",
    `      ${DERIVED_KEY}: "cms2"`,
  ].join("\n");
  assert.equal(jobEnvIn(ci, "first", OFFICIAL_KEY), "cms137", "a step binding through env. resolves to the job's value, comment stripped");
  assert.equal(jobEnvIn(ci, "first", DERIVED_KEY), null, "another job's binding is not this job's");
  assert.equal(jobEnvIn(ci, "second", DERIVED_KEY), "cms2", "quotes are YAML, not part of the value");
  assert.throws(() => jobEnvIn(ci, "third", DERIVED_KEY), /no job 'third'/);
  const shellSet = ci.replace("        run: echo", `        run: ${DERIVED_KEY}=cms137 pnpm dev`);
  assert.throws(() => jobEnvIn(shellSet, "first", DERIVED_KEY), /in a form this reader does not parse/);
  const dangling = ci.replace("      ROUTED: cms137 # the pilot\n", "");
  assert.throws(() => jobEnvIn(dangling, "first", OFFICIAL_KEY), /reads env\.ROUTED, which the job does not bind/);
});

test("e2e-maui boots with the translations the Maui sandbox ships", () => {
  // The e2e job is meant to run the configuration the pilot deploys. Compared as SETS: the order of an
  // allowlist routes nothing.
  const asSet = (list: string[] | null) => (list === null ? null : [...list].sort());
  const parse = (raw: string | null) => (raw === null ? null : raw.split(",").map((s) => s.trim()).filter(Boolean));
  // The anchor that keeps the line below from passing vacuously: the reader must find the official list
  // the job actually boots with, through its `${{ env.ROUTED_MEASURES }}` indirection.
  const official = ciJobEnv("e2e-maui", OFFICIAL_KEY);
  assert.ok(official, "the e2e-maui job binds WORKWELL_OFFICIAL_MEASURES; the reader is not finding it");
  assert.deepEqual(asSet(parse(official)), asSet(shippedMeasures("deploy-maui-mieweb.yml")));
  assert.deepEqual(
    asSet(parse(ciJobEnv("e2e-maui", DERIVED_KEY))),
    asSet(shippedDerived("deploy-maui-mieweb.yml")),
    `ci.yml's e2e-maui job must boot with the ${DERIVED_KEY} deploy-maui-mieweb.yml ships`,
  );
});

/**
 * The construction-time check with BOTH lists, against the real artifacts and sidecars — `sidecarPresent`
 * extended to the translations' own sidecars. Scoped to the workflows that ship a translation, since those
 * are the only sidecars the check reads, so the vacuous case below needs none.
 */
const DERIVED_SHIPPING = WORKFLOWS.filter((workflow) => shippedDerived(workflow) !== null);
const derivedSidecarsPresent =
  DERIVED_SHIPPING.flatMap((workflow) => shippedMeasures(workflow) ?? []).every((id) => {
    const artifact = loadOfficialArtifact(id);
    return artifact ? loadOfficialTerminology(artifact).ok : false;
  }) &&
  DERIVED_SHIPPING.flatMap((workflow) => shippedDerived(workflow) ?? []).every((id) => {
    const translation = loadDerivedArtifact(id);
    return translation ? loadOfficialTerminology(translation).ok : false;
  });

test(
  `${DERIVED_KEY}: the shipped configuration, translations included, constructs cleanly` +
    (DERIVED_SHIPPING.length === 0 ? " — VACUOUS until a workflow ships a translation" : ""),
  (t) => {
    if (!derivedSidecarsPresent) {
      const why = "needs the shipped translations' sidecars and their measures' (node scripts/vendor-derived-terminology.mjs, pnpm vendor:official)";
      // CI's official-cases job vendors them and sets the flag: there a missing sidecar is a failure.
      if (process.env.WORKWELL_REQUIRE_OFFICIAL_TERMINOLOGY === "true") assert.fail(why);
      t.skip(why);
      return;
    }
    // No capped-expansion excuse here, unlike the official-only test above. That excuse exists for
    // contexts without the VSAC credential, and those have no translation sidecar, so they skip above. In
    // CI's credentialed run the same key completes CMS's sidecars, so any problem left is real.
    for (const workflow of DERIVED_SHIPPING) {
      const env = { [OFFICIAL_KEY]: (shippedMeasures(workflow) ?? []).join(","), [DERIVED_KEY]: shippedDerived(workflow)!.join(",") };
      assert.deepEqual(
        officialRoutingProblems(env),
        [],
        `${workflow} ships translations that official routing would REFUSE at construction`,
      );
    }
  },
);

/**
 * Each single-quoted jq program in a workflow: the lines between the opening `'` of a multi-line
 * `jq -nc \` invocation and its closing `]'`, with the line number each starts at. Delimited by the
 * closing BRACKET-and-quote rather than by the next quote, because the next quote is exactly the
 * apostrophe being looked for.
 */
function jqPrograms(yaml: string): Array<{ line: number; body: string[] }> {
  const lines = yaml.split(/\r?\n/);
  const programs: Array<{ line: number; body: string[] }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*jq\s+-nc\b/.test(lines[i]!)) continue;
    // The program follows the invocation's `--arg` continuation lines.
    let open = i + 1;
    while (open < lines.length && /\\\s*$/.test(lines[open - 1]!) && !lines[open]!.trimStart().startsWith("'")) open++;
    let close = open + 1;
    while (close < lines.length && !/^\s*[\]}]'/.test(lines[close]!)) close++;
    if (open >= lines.length || !lines[open]!.trimStart().startsWith("'") || close >= lines.length) {
      throw new Error(`line ${i + 1}: a jq invocation whose program this scan cannot delimit — extend the scan rather than skip it`);
    }
    const first = lines[open]!;
    const last = lines[close]!;
    programs.push({
      line: open + 1,
      body: [first.slice(first.indexOf("'") + 1), ...lines.slice(open + 1, close), last.slice(0, last.indexOf("'"))],
    });
    i = close;
  }
  return programs;
}

/** Every apostrophe inside a jq program, as `line N: <text>` — each one closes the quote around it. */
const apostrophesIn = (programs: Array<{ line: number; body: string[] }>): string[] =>
  programs.flatMap((program) =>
    program.body.flatMap((text, offset) => (text.includes("'") ? [`line ${program.line + offset}: ${text.trim()}`] : [])),
  );

test("no jq env program in a deploy or reconcile workflow contains an apostrophe", () => {
  // #356: one apostrophe in a comment inside the single-quoted program closed the quote and turned the
  // production deploy step into a parse error. The run-block parse check in CI catches an ODD count; an
  // even count parses and hands jq a broken program, and only a scan of the program itself sees both.
  // The translation key will be added inside these programs, which is why it is checked here now.
  for (const workflow of WORKFLOWS) {
    const path = fileURLToPath(new URL(`../../../.github/workflows/${workflow}`, import.meta.url));
    const programs = jqPrograms(readFileSync(path, "utf8"));
    assert.ok(
      programs.some((program) => program.body.join("\n").includes('{key: "WORKWELL_INSTANCE"')),
      `${workflow}: the scan found no container env program, so it is not looking at what it guards`,
    );
    assert.deepEqual(apostrophesIn(programs), [], `${workflow}: an apostrophe inside a single-quoted jq program closes the quote`);
  }
});

test("the apostrophe scan finds one inside a program, and none outside it", () => {
  const workflow = [
    "          # an apostrophe out here is shell's business, not the program's",
    "            jq -nc \\",
    '              --arg a "$A" \\',
    "              '[",
    '                {key: "WORKWELL_INSTANCE", value: "maui"},',
    "                # CMS's measure",
    "                # the 'flip'",
    '                {key: "X", value: $a}',
    "              ]'",
  ].join("\n");
  assert.deepEqual(apostrophesIn(jqPrograms(workflow)), ["line 6: # CMS's measure", "line 7: # the 'flip'"]);
  assert.deepEqual(apostrophesIn(jqPrograms(workflow.replace("CMS's", "CMS").replace("'flip'", "flip"))), []);
  assert.throws(() => jqPrograms("            jq -nc \\\n              --arg a \"$A\""), /cannot delimit/);
});

// ---------------------------------------------------------------------------
// The evidence bucket's env block (#473).
//
// `shippedValue` above cannot see these: the bucket entries reach the container as jq `--arg`
// variables (`value: $bucket_name`), not as string literals, so their values live in the job-level
// `env:` block instead. That is why they escaped the parity guard until now — and DEPLOY.md's
// "keep-in-sync" note was the only thing holding them together, which is precisely the kind of
// control this PR exists because it failed.
// ---------------------------------------------------------------------------

/**
 * The job-level `env:` binding for a key, e.g. `WORKWELL_BUCKET_S3_REGION: auto`.
 *
 * An inline `# comment` is stripped, so `auto # R2 ignores this` compares equal to `auto`. Otherwise
 * a clarifying comment added to one file of a pair reads as a configuration divergence and fails a
 * parity test for no reason — which is how a guard earns a reputation for crying wolf.
 */
function jobEnvValue(workflow: string, key: string): string | null {
  const path = fileURLToPath(new URL(`../../../.github/workflows/${workflow}`, import.meta.url));
  const yaml = readFileSync(path, "utf8");
  const match = yaml.match(new RegExp(String.raw`^\s+` + key + String.raw`:[ \t]*(\S.*?)[ \t]*$`, "m"));
  if (!match) return null;
  return match[1]!.replace(/\s+#.*$/, "").trim();
}

/**
 * The ENV VAR a `jq --arg <name> "$VAR"` declaration reads, or null when that --arg is absent.
 *
 * `shippedFromArg` below proves only that the jq PROGRAM names a variable. It cannot see whether the
 * variable was ever declared — jq would fail at deploy time on an undeclared one — nor whether the
 * declaration reads the right env var: `--arg bucket_name "$SOMETHING_ELSE"` ships the wrong value
 * and fails nothing. Review demonstrated exactly that hole in the first version of these tests.
 */
function argDeclaration(workflow: string, argName: string): string | null {
  const path = fileURLToPath(new URL(`../../../.github/workflows/${workflow}`, import.meta.url));
  const yaml = readFileSync(path, "utf8");
  const match = yaml.match(new RegExp(String.raw`--arg\s+` + argName + String.raw`\s+"\$\{?(\w+)\}?"`));
  return match ? match[1]! : null;
}

/**
 * The jq variable the container env array carries this key's value FROM, e.g. `$bucket_endpoint`,
 * or null where the key never reaches the array.
 *
 * Returning the VARIABLE rather than a boolean is the point: the first version of this helper only
 * asserted the key appeared, and review demonstrated the hole by cross-wiring
 * `{key: "WORKWELL_BUCKET_S3_ENDPOINT", value: $bucket_region}` in the reconciler — all three tests
 * passed. A key present but wired to the wrong value is exactly the silent repoint these guard.
 */
function shippedFromArg(workflow: string, key: string): string | null {
  const path = fileURLToPath(new URL(`../../../.github/workflows/${workflow}`, import.meta.url));
  const yaml = readFileSync(path, "utf8");
  const match = yaml.match(new RegExp(String.raw`\{\s*key:\s*"` + key + String.raw`",\s*value:\s*(\$\w+)`));
  return match ? match[1]! : null;
}

const BUCKET_KEYS = [
  "WORKWELL_BUCKET_S3_BUCKET",
  "WORKWELL_BUCKET_S3_REGION",
  "WORKWELL_BUCKET_S3_ENDPOINT",
  "WORKWELL_BUCKET_S3_ACCESS_KEY_ID",
  "WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY",
] as const;

test("#473: a self-healed container reaches the SAME evidence bucket as a deployed one", () => {
  for (const key of BUCKET_KEYS) {
    for (const [deploy, reconcile] of MUST_AGREE) {
      assert.equal(
        jobEnvValue(reconcile, key),
        jobEnvValue(deploy, key),
        `${reconcile} must bind the same ${key} as ${deploy} — it recreates the same container on a ` +
          `health event, so a mismatch silently repoints (or unsets) evidence storage on a self-heal, ` +
          `and the seam only fails on the first evidence op`,
      );
      // ...and carry it from the same jq --arg. Equal env bindings wired to different variables ship
      // different values, which the assertion above cannot see.
      assert.equal(
        shippedFromArg(reconcile, key),
        shippedFromArg(deploy, key),
        `${reconcile} wires ${key} from a different jq --arg than ${deploy}`,
      );
    }
  }
});

test("#473: and every one of them actually reaches the container", () => {
  // Agreement alone is satisfied by BOTH files omitting a key — the vacuous reading that the corpus
  // -size test above exists to close. An unset endpoint is not inert here: it silently reverts the
  // seam to virtual-hosted AWS addressing against an R2 bucket, which fails on the first evidence op.
  for (const workflow of MUST_AGREE.flat()) {
    for (const key of BUCKET_KEYS) {
      assert.ok(
        jobEnvValue(workflow, key),
        `${workflow} binds no ${key}; the parity test above would pass vacuously`,
      );
      const argName = shippedFromArg(workflow, key);
      assert.ok(argName, `${workflow} binds ${key} but never puts it in the container env array`);
      // ...and the jq --arg it comes from must be DECLARED, and declared from this very key.
      // Without this, the assertion above proves only that the program mentions a variable name.
      assert.equal(
        argDeclaration(workflow, argName!.slice(1)),
        key,
        `${workflow} ships ${key} from jq ${argName}, which is not declared from $${key} — jq fails ` +
          `on an undeclared arg, and a cross-wired declaration ships the wrong value silently`,
      );
    }
  }
});

test("#623: the pilot's failed-run alerts reach the webhook, from a deploy and from a self-heal", () => {
  // The alert fired on every failed nightly and reached nobody, because no stack set the URL. Both
  // Maui files carry it: a self-heal that recreated the container without it would silence the alerts
  // right after the stack had been unwell.
  const key = "WORKWELL_ALERT_WEBHOOK_URL";
  for (const workflow of ["deploy-maui-mieweb.yml", "reconcile-maui-mieweb.yml"]) {
    assert.match(jobEnvValue(workflow, key) ?? "", /secrets\.WORKWELL_ALERT_WEBHOOK_URL\b/, `${workflow} binds no ${key}`);
    const argName = shippedFromArg(workflow, key);
    assert.ok(argName, `${workflow} binds ${key} but never puts it in the container env array`);
    assert.equal(argDeclaration(workflow, argName!.slice(1)), key, `${workflow} ships ${key} from a jq arg not declared from $${key}`);
  }
});

test("the pilot stack's own password hash reaches the container, from a deploy and from a self-heal", () => {
  // The demo password is printed in this public repo. A container recreated without this key would fail
  // closed (pilot sign-in disabled), so both Maui files must bind it from the secret and ship it.
  const key = "WORKWELL_PILOT_PASSWORD_HASH";
  for (const workflow of ["deploy-maui-mieweb.yml", "reconcile-maui-mieweb.yml"]) {
    assert.match(jobEnvValue(workflow, key) ?? "", /secrets\.WORKWELL_PILOT_PASSWORD_HASH_MAUI\b/, `${workflow} binds no ${key}`);
    const argName = shippedFromArg(workflow, key);
    assert.ok(argName, `${workflow} binds ${key} but never puts it in the container env array`);
    assert.equal(argDeclaration(workflow, argName!.slice(1)), key, `${workflow} ships ${key} from a jq arg not declared from $${key}`);
  }
});

test("#473: the TWH evidence bucket is the R2 one, addressed path-style", () => {
  // The AWS bucket these replaced was on an account that expired 2026-08-24; S3 answers
  // `AllAccessDisabled` for it and every key it ever issued is dead. Naming the live values here
  // means a revert to them fails a test rather than eighteen silent days of lost evidence.
  assert.equal(jobEnvValue("deploy-twh-mieweb.yml", "WORKWELL_BUCKET_S3_BUCKET"), "workwell-evidence-twh");
  // R2 ignores the region, but SigV4 will not sign without one.
  assert.equal(jobEnvValue("deploy-twh-mieweb.yml", "WORKWELL_BUCKET_S3_REGION"), "auto");
  // A NON-EMPTY endpoint is what switches resolve-bucket.ts to path-style addressing. Asserted as
  // "reads the secret" rather than as a literal, because the endpoint embeds the Cloudflare account
  // id and this repository is public.
  assert.match(
    jobEnvValue("deploy-twh-mieweb.yml", "WORKWELL_BUCKET_S3_ENDPOINT") ?? "",
    /secrets\.WORKWELL_R2_S3_ENDPOINT/,
  );
});

test("#473: the pilot has its OWN evidence bucket, and it is not the demo stack's", () => {
  // Until 2026-09-11 Maui shipped no bucket at all, so evidence on the deployment carrying 20,000
  // patients was lost on every deploy and self-heal. Its own bucket rather than a shared one because
  // an R2 token is scoped per bucket: one bucket would mean one token both stacks hold.
  assert.equal(jobEnvValue("deploy-maui-mieweb.yml", "WORKWELL_BUCKET_S3_BUCKET"), "workwell-evidence-maui");
  assert.notEqual(
    jobEnvValue("deploy-maui-mieweb.yml", "WORKWELL_BUCKET_S3_BUCKET"),
    jobEnvValue("deploy-twh-mieweb.yml", "WORKWELL_BUCKET_S3_BUCKET"),
    "the pilot and the demo stack must not share an evidence bucket",
  );
  // Separate credentials too — a shared token would defeat the separate buckets entirely.
  assert.match(
    jobEnvValue("deploy-maui-mieweb.yml", "WORKWELL_BUCKET_S3_ACCESS_KEY_ID") ?? "",
    /secrets\.WORKWELL_BUCKET_S3_ACCESS_KEY_ID_MAUI/,
  );
});
