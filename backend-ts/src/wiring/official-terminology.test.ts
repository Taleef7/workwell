/**
 * The official terminology sidecar (PR-8a).
 *
 * Two halves, tested differently on purpose. The verification logic is pure and always runs. The real
 * sidecar is a fetched-at-build artifact, so the tests that read it SELF-SKIP when it is absent — a
 * fresh clone has no `terminology.json` by design, and a suite that failed there would be reporting the
 * absence of a build step as a broken repository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cappedExpansions,
  loadOfficialTerminology,
  officialTerminologyExpander,
  verifyTerminology,
  __clearOfficialTerminologyCache,
} from "./official-terminology.ts";
import { loadOfficialArtifact } from "./official-artifacts.ts";
import { requiredOids } from "./official-executor-adapter.ts";
import { officialRoutingProblems } from "./executor-router.ts";

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

const sidecar = JSON.stringify({
  catalogId: "cms122",
  source: { repo: "cqframework/dqm-content-qicore-2025", ref: "a".repeat(40), measure: "M" },
  valueSets: [
    { oid: "2.16.1", url: "http://x/ValueSet/2.16.1", declaredTotal: 2, codes: [
      { system: "s", code: "a" },
      { system: "s", code: "b" },
    ] },
  ],
});

test("a sidecar matching its pin loads, indexed by bare OID", () => {
  const loaded = verifyTerminology("cms122", sha(sidecar), sidecar);
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.codesByOid.get("2.16.1"), [
    { system: "s", code: "a" },
    { system: "s", code: "b" },
  ]);
});

test("bytes that do not match the manifest pin are REFUSED, not used", () => {
  // This is the whole reason a gitignored file can be trusted at all. Without the pin, "fetched at
  // build" would mean "whatever happened to be on disk", and the MADiE gate would again be evidence
  // about terminology nobody could identify.
  const tampered = sidecar.replace('"code":"a"', '"code":"ZZZ"');
  const loaded = verifyTerminology("cms122", sha(sidecar), tampered);
  assert.equal(loaded.ok, false);
  assert.match((loaded as { problem: string }).problem, /does not match the pin[\s\S]*vendor:official/);
});

test("a malformed sidecar is a sentence, never a throw", () => {
  // Every caller here is `officialRoutingProblems`, which reports ALL misconfigurations in one pass.
  // An exception from the middle of that loop hides the rest of them.
  for (const raw of ["{not json", JSON.stringify({ catalogId: "cms122" })]) {
    const loaded = verifyTerminology("cms122", sha(raw), raw);
    assert.equal(loaded.ok, false, raw);
  }
});

test("a manifest with no terminology pin refuses — an artifact vendored before PR-8a", () => {
  // A catalog id no real artifact uses, deliberately: the loader caches by catalog id, so reusing
  // "cms122" here would read the entry the real-artifact probe below already warmed. (In production the
  // id-to-artifact mapping is 1:1, which is what makes that cache key sound.)
  __clearOfficialTerminologyCache();
  const loaded = loadOfficialTerminology({ manifest: { catalogId: "cmsunpinned" } } as never);
  assert.equal(loaded.ok, false);
  assert.match((loaded as { problem: string }).problem, /records no terminology pin/);
});

test("the expander returns nothing for a measure it has no artifact for", async () => {
  const expand = officialTerminologyExpander(() => null);
  assert.deepEqual(await expand("2.16.1", "cms999"), []);
});

// ---------------------------------------------------------------------------------------------------
// Below here: the REAL fetched artifact. Self-skipping — `pnpm vendor:official` produces it.
// ---------------------------------------------------------------------------------------------------

const cms122 = loadOfficialArtifact("cms122");
const realSidecarPresent = !!cms122 && loadOfficialTerminology(cms122).ok;
const skip = realSidecarPresent ? false : "run 'pnpm vendor:official' to fetch the terminology sidecar";

test("the fetched sidecar covers EVERY value set the artifact's ELM retrieves", { skip }, () => {
  // The property that matters. fqm treats an unexpandable value set as empty rather than missing, so a
  // sidecar missing even one canonical would produce a complete-looking run with nobody in any
  // population — indistinguishable downstream from a genuinely ineligible roster.
  for (const catalogId of ["cms122", "cms125"]) {
    const artifact = loadOfficialArtifact(catalogId)!;
    const loaded = loadOfficialTerminology(artifact);
    assert.ok(loaded.ok, `${catalogId}: ${JSON.stringify(loaded)}`);
    const missing = requiredOids(artifact).filter((oid) => (loaded.codesByOid.get(oid) ?? []).length === 0);
    assert.deepEqual(missing, [], `${catalogId} has unexpandable value sets`);
  }
});

test("a capped expansion the ELM RETRIEVES is surfaced; one it ignores is not", { skip }, () => {
  // VSAC caps an expansion at 1000 codes. Advanced Illness is 1997 upstream and is capped in both
  // measures' bundles, where it feeds a denominator exclusion — so `officialRoutingProblems` refuses
  // on it. An under-expanded set cannot invent membership, but it can quietly omit a subject who
  // belongs, and preflight cannot catch it: it refuses on EMPTY, and half-expanded is not empty.
  const artifact = loadOfficialArtifact("cms122")!;
  const capped = cappedExpansions(artifact, requiredOids(artifact));
  assert.ok(capped.length > 0, "AdvancedIllness is capped and retrieved — if this changes, so did upstream");
  assert.ok(
    capped.every((c) => c.have < c.declaredTotal),
    "a surfaced cap must actually be short of its declared total",
  );

  // Filtered by what the ELM references, so a capped set the measure never retrieves cannot block it.
  assert.deepEqual(cappedExpansions(artifact, []), []);
});

test("the routing check REFUSES a measure whose retrieved value set is capped", { skip }, () => {
  // The finding this replaces: `cappedExpansions` existed, documented "reported at boot so a shortfall
  // is never silent", and had zero production callers. Recording is not guarding.
  const problems = officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: "cms122" });
  assert.ok(
    problems.some((p) => /expands to only \d+ of \d+ codes/.test(p)),
    `expected a capped-expansion refusal, got: ${JSON.stringify(problems)}`,
  );
});
