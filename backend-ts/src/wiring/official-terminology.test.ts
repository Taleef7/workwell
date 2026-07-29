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
import { readFileSync } from "node:fs";
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

test("a capped expansion the ELM RETRIEVES is surfaced; one it ignores is not", () => {
  // Driven by a SYNTHETIC manifest, not by the real artifact, and that is the point. This used to
  // assert `capped.length > 0` against cms122 — true only while AdvancedIllness was still capped, so
  // the guard was scheduled to be deleted by its own fix. The mechanism is what needs pinning: a cap
  // the ELM retrieves must surface, a cap it never touches must not, and nothing else may.
  const artifact = {
    manifest: {
      terminology: {
        truncated: [
          { oid: "2.16.retrieved", have: 1000, declaredTotal: 1997 },
          { oid: "2.16.ignored", have: 1000, declaredTotal: 1200 },
        ],
      },
    },
  } as never;

  assert.deepEqual(cappedExpansions(artifact, ["2.16.retrieved"]), [
    { oid: "2.16.retrieved", have: 1000, declaredTotal: 1997 },
  ]);
  assert.deepEqual(cappedExpansions(artifact, []), [], "a cap the measure never retrieves cannot block it");
  assert.deepEqual(cappedExpansions({ manifest: { terminology: { truncated: [] } } } as never, ["x"]), []);
});

test("the manifest's caps, the sidecar's own shortfalls, and the routing decision all agree", { skip }, () => {
  // Written to hold in BOTH states, because the artifact moves between them: capped as upstream ships
  // it (upstream limits every expansion to 1000 — its README says so), and complete once
  // `--complete-capped-expansions` has re-expanded the shortfall from VSAC at the pinned release.
  //
  // Asserting one state would mean the test tells the truth for exactly one of them. What must hold
  // either way is that the three things cannot disagree — and the dangerous disagreement is precise:
  // a manifest claiming `truncated: []` over a sidecar that is still short would clear the routing
  // refusal while the exclusion set stays half-expanded, which is the failure the refusal exists for.
  for (const catalogId of ["cms122", "cms125"]) {
    const artifact = loadOfficialArtifact(catalogId)!;
    const recorded = artifact.manifest.terminology?.truncated ?? [];

    // The sidecar carries each value set's own `declaredTotal`, so it can be checked against the
    // manifest rather than trusted alongside it.
    const raw = JSON.parse(
      readFileSync(new URL(`../../measures/official/${catalogId}/terminology.json`, import.meta.url), "utf8"),
    ) as { valueSets: Array<{ oid: string; declaredTotal: number; codes: unknown[] }> };
    const short = raw.valueSets
      .filter((v) => v.declaredTotal > v.codes.length)
      .map((v) => v.oid)
      .sort();

    assert.deepEqual(
      recorded.map((c) => c.oid).sort(),
      short,
      `${catalogId}: the manifest's caps must be exactly the sidecar's shortfalls — a manifest that ` +
        "claims complete over a short sidecar would clear the routing refusal on a lie",
    );
    assert.ok(
      recorded.every((c) => c.have < c.declaredTotal),
      "a surfaced cap must actually be short of its declared total",
    );

    // And the routing decision follows from that, in whichever state we are in.
    const retrieved = cappedExpansions(artifact, requiredOids(artifact));
    const problems = officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: catalogId }).filter((p) =>
      /expands to only \d+ of \d+ codes/.test(p),
    );
    assert.equal(
      problems.length,
      retrieved.length,
      `${catalogId}: one refusal per retrieved cap, no more and no fewer — got ${JSON.stringify(problems)}`,
    );

    // Completion is not silent: an artifact with no caps left must say where the codes came from.
    if (recorded.length === 0 && artifact.manifest.terminology?.completion) {
      assert.match(
        artifact.manifest.terminology.completion.manifest,
        /^http:\/\/cts\.nlm\.nih\.gov\/fhir\/Library\//,
        "an unpinned completion is not reproducible, so it is not provenance",
      );
    }
  }
});
