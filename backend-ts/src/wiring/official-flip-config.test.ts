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
 *     committed artifact. This catches the realistic edit — adding `cms130` before it is vendored;
 *   - the **terminology** half self-skips without the sidecar and is wired into CI's `official-cases`
 *     job, where the sidecar exists.
 *
 * Neither half asserts *which* measures are flipped. Pinning the value would make every future flip a
 * two-file change with a test that only ever says "you changed what you changed" — the property that
 * matters is that whatever is shipped is ROUTABLE.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { officialRoutingProblems } from "./executor-router.ts";
import { loadOfficialArtifact } from "./official-artifacts.ts";
import { loadOfficialTerminology } from "./official-terminology.ts";
import { OFFICIAL_GATED_MEASURES } from "../standards/official-cases.ts";

const WORKFLOWS = ["deploy-twh-mieweb.yml", "deploy-staging-mieweb.yml", "reconcile-twh-mieweb.yml"] as const;

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
];

/**
 * The value each deploy workflow ships, or `null` where the seam is deliberately unset.
 *
 * Parsed out of the `jq` env array rather than imported, because the workflow IS the source of truth —
 * a constant in TypeScript that the workflow was supposed to match would be exactly the kind of
 * second copy that drifts.
 */
function shippedMeasures(workflow: string): string[] | null {
  const path = fileURLToPath(new URL(`../../../.github/workflows/${workflow}`, import.meta.url));
  const yaml = readFileSync(path, "utf8");
  const match = yaml.match(/\{key:\s*"WORKWELL_OFFICIAL_MEASURES",\s*value:\s*"([^"]*)"\}/);
  if (!match) return null;
  return match[1]!.split(",").map((s) => s.trim()).filter(Boolean);
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
const sidecarPresent = (shippedMeasures("deploy-twh-mieweb.yml") ?? []).every((id) => {
  const artifact = loadOfficialArtifact(id);
  return artifact ? loadOfficialTerminology(artifact).ok : false;
});
const skip = sidecarPresent ? false : "needs the vendored terminology sidecar (run `pnpm vendor:official`)";

/** A capped-expansion problem, which is a property of how the artifact was VENDORED, not of the flag. */
const CAPPED = /expands to only \d+ of \d+ codes/;

test("PR-9c: the shipped configuration constructs cleanly — no routing problems", { skip }, () => {
  // Uncredentialed contexts (fork PRs, Dependabot) deliberately re-vendor WITHOUT
  // `--complete-capped-expansions`, because GitHub withholds the VSAC secret there. That leaves the
  // working-tree artifacts capped — and `officialRoutingProblems` refuses a capped expansion by design
  // (ADR-041), so asserting a clean result unconditionally would fail every outside contributor's PR for
  // a reason unrelated to their change. Codex caught this on #356 before it went red.
  //
  // So: the capped class is EXCUSED only when the artifacts in the tree are actually capped, and every
  // other class is asserted always. The credentialed run on merge covers the capped class for real.
  const complete = (shippedMeasures("deploy-twh-mieweb.yml") ?? []).every(
    (id) => (loadOfficialArtifact(id)?.manifest.terminology?.truncated ?? []).length === 0,
  );

  for (const workflow of WORKFLOWS) {
    const shipped = shippedMeasures(workflow);
    if (shipped === null) continue;
    // Exactly what `routedEngineForEnv` throws on at engine construction. An empty array here is the
    // difference between a deploy that serves and one that answers 500 from every evaluating route
    // while /actuator/health stays green.
    const problems = officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: shipped.join(",") });
    const asserted = complete ? problems : problems.filter((p) => !CAPPED.test(p));
    assert.deepEqual(
      asserted,
      [],
      `${workflow} ships a configuration that official routing would REFUSE at construction` +
        (complete ? "" : " (capped-expansion problems excused: this context vendored without a VSAC key)"),
    );
  }
});
