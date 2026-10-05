/**
 * A WorkWell translation is chosen only for the year it covers, runs on its OWN terminology, names itself
 * in its evidence, and is refused by the router unless it is fit to stand in for CMS's artifact
 * (decision 3, C2). Nothing here writes into `measures/`: the translation is a fixture built from the
 * committed official cms137 bundle (`test-support/derived-fixture.ts`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { EvaluateMeasureBinding } from "@work-well/measure-engine";
import type { FqmCalculate } from "@work-well/official-executor";
import { derivedCms137, FIXTURE_LABEL, FIXTURE_SHA, FIXTURE_URL } from "../test-support/derived-fixture.ts";
import { isFqmScored, officialRoutingProblems, routedEngineForEnv } from "./executor-router.ts";
import {
  artifactKey,
  loadOfficialArtifact,
  readArtifactDir,
  selectArtifactForPeriod,
  type OfficialArtifact,
} from "./official-artifacts.ts";
import { officialMeasureExecutor, requiredOids } from "./official-executor-adapter.ts";
import type { LoadedTerminology } from "./official-terminology.ts";

const official = loadOfficialArtifact("cms137")!;
const derived = derivedCms137();
const year = (y: number) => ({ start: `${y}-01-01`, end: `${y}-12-31` });

// ---- selection --------------------------------------------------------------------------------------

test("the translation scores only the year it covers; CMS's artifact scores every other year", () => {
  const pick = (period: { start: string; end: string }, d: OfficialArtifact | null = derived) =>
    selectArtifactForPeriod({ official, derived: d }, period);
  assert.equal(pick({ start: "2026-01-01", end: "2026-12-31" }), official, "2026 → CMS's draft");
  assert.equal(pick(year(2027)), derived, "2027 → the translation");
  assert.equal(pick(year(2027), null), official, "2027 with no translation → CMS's draft (with its prior-year warning)");
  assert.equal(pick(year(2025)), official, "a year before the translation's → CMS's");
  assert.equal(pick(year(2028)), official, "a year after it → CMS's, never the translation");
  const noPeriod = { ...derived, manifest: { ...derived.manifest, effectivePeriod: null } };
  assert.equal(pick(year(2027), noPeriod), official, "a translation that declares no period is never chosen");
  const cms2027 = { ...official, manifest: { ...official.manifest, effectivePeriod: { start: "2027-01-01", end: "2027-12-31" } } };
  assert.equal(selectArtifactForPeriod({ official: cms2027, derived }, year(2027)), cms2027, "CMS's logic wins wherever it covers the year");
  const wide = { ...derived, manifest: { ...derived.manifest, effectivePeriod: { start: "2026-01-01", end: "2027-12-31" } } };
  assert.equal(pick({ start: "2026-01-01", end: "2026-12-31" }, wide), official, "even a translation wrongly declaring 2026 loses to CMS's 2026 draft");
  assert.equal(selectArtifactForPeriod({ official: null, derived }, year(2027)), null, "no translation without the measure it translates");
});

test("a translation and CMS's artifact never share a cache key", () => {
  assert.notEqual(artifactKey(official), artifactKey(derived));
  assert.match(artifactKey(derived), /^derived:cms137:/);
  assert.match(artifactKey(official), /^official:cms137:/);
});

test("each loader refuses the other kind's manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "derived-kind-"));
  const write = (id: string, manifest: object) => {
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(root, id, "bundle.json"), JSON.stringify(official.bundle));
  };
  write("translation", derived.manifest);
  write("cms", official.manifest);
  const url = pathToFileURL(`${root}/`);
  assert.equal(readArtifactDir("official", "translation", url).artifact, null, "a translation under measures/official/ is refused");
  assert.equal(readArtifactDir("derived", "cms", url).artifact, null, "CMS's manifest under measures/derived/ is refused");
  assert.equal(readArtifactDir("derived", "translation", url).artifact?.kind, "derived");
  assert.equal(readArtifactDir("official", "cms", url).artifact?.kind, undefined, "an official artifact carries no kind field");
});

// ---- the executor -----------------------------------------------------------------------------------

const patient = (id: string) => ({ resourceType: "Bundle", entry: [{ resource: { resourceType: "Patient", id } }] });

test("one executor scores 2026 with CMS's artifact and 2027 with the translation, each on its own terminology", async () => {
  const seen: Array<{ measureUrl: unknown; codes: number }> = [];
  const calculate: FqmCalculate = async (bundle, patients, _options, valueSetCache) => {
    const measure = (bundle as { entry: Array<{ resource: Record<string, unknown> }> }).entry.find((e) => e.resource["resourceType"] === "Measure")!.resource;
    const codes = ((valueSetCache ?? []) as Array<{ compose?: unknown; expansion?: { contains?: unknown[] } }>).reduce(
      (n, vs) => n + (vs.expansion?.contains?.length ?? 0),
      0,
    );
    seen.push({ measureUrl: measure["url"], codes });
    return {
      results: (patients as Array<{ entry: Array<{ resource: { id: string } }> }>).map((p) => ({
        patientId: p.entry[0]!.resource.id,
        evaluatedResource: [{ resourceType: "Encounter" }],
        detailedResults: [
          { populationResults: [{ populationType: "initial-population", result: true }, { populationType: "denominator", result: true }, { populationType: "numerator", result: true }], statementResults: [] },
          { populationResults: [{ populationType: "initial-population", result: true }, { populationType: "denominator", result: true }, { populationType: "numerator", result: true }], statementResults: [] },
        ],
      })),
    };
  };
  // The translation's terminology has one more code per value set, so the cache it receives says which
  // terminology it ran on. Preflight warms CMS's first — the order that would poison a cache keyed by id.
  const executor = officialMeasureExecutor({
    expand: async (oid, artifact) => (artifact.kind === "derived" ? [{ system: "s", code: oid }, { system: "s", code: "2027" }] : [{ system: "s", code: oid }]),
    selectArtifact: (_id, period) => selectArtifactForPeriod({ official, derived }, period),
    candidateArtifacts: () => [official, derived],
    calculate,
  });
  await executor.preflight("cms137");
  const r2026 = await executor.evaluateBatch("cms137", [{ subjectId: "a", patientBundle: patient("a") }], "2026-06-01");
  const r2027 = await executor.evaluateBatch("cms137", [{ subjectId: "a", patientBundle: patient("a") }], "2027-06-01");

  const oids = new Set(requiredOids(official)).size;
  assert.equal(seen[0]!.measureUrl, official.manifest.url, "2026 runs CMS's bundle");
  assert.equal(seen[1]!.measureUrl, FIXTURE_URL, "2027 runs the translation's bundle");
  assert.ok(seen[1]!.codes > seen[0]!.codes, "and the translation's own expansions, not the 2026 ones cached first");
  assert.ok(seen[0]!.codes >= oids);

  const e2026 = r2026.get("a")!.evidence.official!;
  const e2027 = r2027.get("a")!.evidence.official!;
  assert.deepEqual(Object.keys(e2026).slice(0, 4), ["ecqmId", "version", "engine", "artifactSha256"], "CMS-scored evidence keeps its keys, in order");
  assert.equal(e2026.kind, undefined);
  assert.equal(e2026.ecqmId, official.manifest.cmsId);
  assert.equal(e2027.kind, "derived");
  assert.equal(e2027.ecqmId, null, "a translation never carries CMS's measure id");
  assert.equal(e2027.label, FIXTURE_LABEL);
  assert.equal(e2027.url, FIXTURE_URL);
  assert.equal(e2027.derivedFrom, "CMS137v15");
  assert.equal(e2027.artifactSha256, FIXTURE_SHA, "the evidence names the artifact that actually ran");
  assert.deepEqual(e2027.measurementPeriod?.start, "2027-01-01");
});

// ---- the router -------------------------------------------------------------------------------------

const terminologyOk = (artifact: OfficialArtifact): LoadedTerminology => ({
  ok: true,
  codesByOid: new Map(requiredOids(artifact).map((oid) => [oid, [{ system: "s", code: "x" }]])),
});
const checks = { loadTerminology: terminologyOk, cappedFor: () => [], absentFor: () => [] };
const ENV = { WORKWELL_OFFICIAL_MEASURES: "cms137", WORKWELL_DERIVED_MEASURES: "cms137" };
const problemsWith = (translation: OfficialArtifact | null, env: Record<string, string> = ENV) =>
  officialRoutingProblems(env as never, { ...checks, loadDerived: () => translation });
const withManifest = (over: Partial<OfficialArtifact["manifest"]>) => ({ ...derived, manifest: { ...derived.manifest, ...over } });

test("a fit translation passes every construction check", () => {
  assert.deepEqual(problemsWith(derived), []);
  // Non-vacuous for D7's periods: the fit fixture's deck record is the deck's 2025, not the translation's
  // 2027 — a different year is accepted for the logic check, and only for it.
  const periods = Object.fromEntries(derived.manifest.derived!.oracles.map((o) => [o.name, o.period]));
  assert.deepEqual(periods, { "cypress-deck": year(2025), "terminology-equivalence": year(2027) });
});

test("D1–D8: each unfit translation is refused with its own sentence", () => {
  const expect = (problems: string[], pattern: RegExp) => assert.ok(problems.some((p) => pattern.test(p)), `expected ${pattern} in ${JSON.stringify(problems)}`);
  expect(problemsWith(derived, { WORKWELL_DERIVED_MEASURES: "cms137" }), /not in WORKWELL_OFFICIAL_MEASURES/);
  expect(problemsWith(null), /no executable translation is committed/);
  expect(problemsWith(withManifest({ catalogId: "cms130" })), /declares catalogId 'cms130'/);
  expect(problemsWith(withManifest({ url: "https://madie.cms.gov/Measure/CMS137FHIR" })), /manifest url/);
  expect(problemsWith(withManifest({ effectivePeriod: { start: "2027-01-01", end: "2028-12-31" } })), /exactly one calendar year/);
  // A complete calendar year that is not the year the translated Measure was built for.
  expect(problemsWith(withManifest({ effectivePeriod: { start: "2028-01-01", end: "2028-12-31" } })), /manifest declares 2028-01-01\.\.2028-12-31 but the translated Measure's effectivePeriod is 2027-01-01\.\.2027-12-31/);
  expect(problemsWith(withManifest({ terminology: { ...derived.manifest.terminology!, completion: undefined } })), /does not name the VSAC release/);
  expect(problemsWith(withManifest({ scoring: "cohort" })), /scoring 'cohort' differs/);
  expect(problemsWith(withManifest({ populations: ["initial-population"] })), /declares populations/);
  expect(problemsWith(withManifest({ improvementNotation: "decrease" })), /improvementNotation 'decrease' differs/);
  expect(problemsWith(withManifest({ populationBasis: "Encounter" })), /populationBasis 'Encounter' differs/);
  const regrouped = structuredClone(derived);
  const groups = ((regrouped.bundle as { entry: Array<{ resource?: Record<string, unknown> }> }).entry.find((e) => e.resource?.["resourceType"] === "Measure")!.resource!["group"]) as Array<{ id?: string }>;
  groups[0]!.id = "renamed-group";
  expect(problemsWith(regrouped), /group and stratifier ids differ/);
  const withValueSet = structuredClone(derived);
  (withValueSet.bundle as { entry: unknown[] }).entry.push({ resource: { resourceType: "ValueSet", url: "http://cts.nlm.nih.gov/fhir/ValueSet/2.16.1", version: "20250419" } });
  expect(problemsWith(withValueSet), /carries ValueSet resources; only a Measure and its Libraries/);
  const oracles = derived.manifest.derived!.oracles;
  expect(problemsWith(withManifest({ derived: { ...derived.manifest.derived!, oracles: oracles.filter((o) => o.name !== "terminology-equivalence") } })), /no passing 'terminology-equivalence' check/);
  expect(problemsWith(withManifest({ derived: { ...derived.manifest.derived!, oracles: oracles.map((o) => (o.name === "cypress-deck" ? { ...o, agree: 35 } : o)) } })), /no passing 'cypress-deck' check/);
  expect(problemsWith(withManifest({ derived: { ...derived.manifest.derived!, oracles: oracles.map((o) => ({ ...o, ranAgainst: { ...o.ranAgainst, artifactSha256: "sha256:other" } })) } })), /ran against a different artifact/);
  expect(problemsWith(withManifest({ derived: { ...derived.manifest.derived!, oracles: oracles.map((o) => ({ ...o, ranAgainst: { ...o.ranAgainst, terminologySha256: "sha256:other" } })) } })), /different artifact or terminology/);
  // D7's periods: each record covers one calendar year, and the codes are proven for the translation's own.
  const withPeriod = (name: string, period: { start: string; end: string }) =>
    withManifest({ derived: { ...derived.manifest.derived!, oracles: oracles.map((o) => (o.name === name ? { ...o, period } : o)) } });
  expect(problemsWith(withPeriod("terminology-equivalence", year(2025))), /'terminology-equivalence' check ran over 2025-01-01\.\.2025-12-31, not the translation's own 2027-01-01\.\.2027-12-31: unlike the deck's logic check, it proves value sets/);
  expect(problemsWith(withPeriod("cypress-deck", { start: "2025-01-01", end: "2026-12-31" })), /'cypress-deck' check ran over 2025-01-01\.\.2026-12-31, which is not one calendar year \(a deck's year may differ from the translation's, but it is one measurement year\)/);
  expect(problemsWith(withPeriod("cypress-deck", { start: "2025-03-01", end: "2025-12-31" })), /'cypress-deck' check ran over 2025-03-01\.\.2025-12-31, which is not one calendar year/);
  expect(problemsWith(withPeriod("terminology-equivalence", { start: "2027-01-01T00:00:00Z", end: "2027-12-31" })), /'terminology-equivalence' check ran over 2027-01-01T00:00:00Z\.\.2027-12-31, which is not one calendar year/);
  const noPeriod = withManifest({ derived: { ...derived.manifest.derived!, oracles: oracles.map((o) => (o.name === "cypress-deck" ? { ...o, period: undefined as never } : o)) } });
  let refusal: string[] = [];
  assert.doesNotThrow(() => (refusal = problemsWith(noPeriod)), "a record missing its period is a sentence, not an exception");
  expect(refusal, /'cypress-deck' check ran over \?\.\.\?, which is not one calendar year/);
  expect(officialRoutingProblems(ENV as never, { ...checks, loadDerived: () => derived, loadTerminology: (a) => (a.kind === "derived" ? { ok: false, problem: "sidecar missing" } : terminologyOk(a)) }), /\(translation\): sidecar missing/);
  expect(officialRoutingProblems(ENV as never, { ...checks, loadDerived: () => derived, absentFor: (a) => (a.kind === "derived" ? ["2.16.9"] : []) }), /\(translation\): value set 2\.16\.9/);
  expect(officialRoutingProblems(ENV as never, { ...checks, loadDerived: () => derived, cappedFor: (a) => (a.kind === "derived" ? [{ oid: "2.16.8", have: 1000, declaredTotal: 1997 }] : []) }), /\(translation\): value set 2\.16\.8 expands to only 1000/);
});

test("with the translation allowlist unset, nothing about the routed engine changes", async () => {
  assert.deepEqual(officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: "cms137" } as never, { ...checks, loadDerived: () => { throw new Error("must not be asked"); } }), []);
});

const authored: EvaluateMeasureBinding = { async evaluate() { throw new Error("authored must not run"); } };

test("logicFor names the logic that scores each date, and execution agrees with it", async () => {
  const calculated: unknown[] = [];
  const calculate: FqmCalculate = async (bundle, patients) => {
    calculated.push((bundle as { entry: Array<{ resource: Record<string, unknown> }> }).entry.find((e) => e.resource["resourceType"] === "Measure")!.resource["url"]);
    return { results: (patients as Array<{ entry: Array<{ resource: { id: string } }> }>).map((p) => ({ patientId: p.entry[0]!.resource.id, evaluatedResource: [{ resourceType: "Encounter" }], detailedResults: [{ populationResults: [{ populationType: "initial-population", result: false }], statementResults: [] }] })) };
  };
  const engine = await routedEngineForEnv(ENV as never, { authored, ...checks, loadDerived: () => derived, expand: async () => [{ system: "s", code: "x" }], calculate });

  const l2026 = engine.logicFor?.("cms137", "2026-06-01");
  const l2027 = engine.logicFor?.("cms137", "2027-06-01");
  assert.equal(l2026?.kind, "official");
  assert.match(l2026?.version ?? "", /^official-fqm:/);
  assert.equal(l2027?.kind, "derived");
  assert.match(l2027?.version ?? "", new RegExp(`^derived-fqm:ww-2027\\.1:${FIXTURE_SHA}:`));
  assert.equal(l2027?.label, FIXTURE_LABEL);
  assert.equal(l2027?.warning, null, "a translation covering the year carries no prior-year warning");
  assert.ok(isFqmScored(l2027), "a translation is fqm-scored: the out-of-population rule applies to it");
  assert.equal(engine.logicFor?.("cms125", "2027-06-01"), undefined, "an unrouted measure declares nothing");
  assert.match(engine.logicFor?.("cms137", "2028-06-01")?.version ?? "", /^official-fqm:/, "a year the translation does not cover falls back to CMS's");

  await engine.evaluate({ measureId: "cms137", patientBundle: patient("p"), evaluationDate: "2027-06-01" });
  await engine.evaluate({ measureId: "cms137", patientBundle: patient("p"), evaluationDate: "2026-06-01" });
  assert.deepEqual(calculated, [FIXTURE_URL, official.manifest.url], "what ran is what logicFor reported, date by date");
});

test("a translation allowlist with no official one is refused at construction, never quietly authored", async () => {
  await assert.rejects(
    routedEngineForEnv({ WORKWELL_DERIVED_MEASURES: "cms137" } as never, { authored, ...checks, loadDerived: () => derived }),
    /cms137: .*not in WORKWELL_OFFICIAL_MEASURES/,
  );
  // Neither allowlist set: the default path, the authored engine itself.
  assert.equal(await routedEngineForEnv({} as never, { authored, ...checks, loadDerived: () => derived }), authored);
});

test("a translation the allowlist does not name is never a candidate, whatever is committed", async () => {
  const engine = await routedEngineForEnv({ WORKWELL_OFFICIAL_MEASURES: "cms137" } as never, {
    authored,
    ...checks,
    loadDerived: () => derived,
    expand: async () => [{ system: "s", code: "x" }],
    calculate: async () => ({ results: [] }),
  });
  assert.equal(engine.logicFor?.("cms137", "2027-06-01")?.kind, "official", "2027 stays on CMS's draft, with its warning");
});

test("the real sidecar loader and expander key by ARTIFACT: a translation never reads CMS's cached codes", async (t) => {
  const { loadOfficialTerminology, officialTerminologyExpander } = await import("./official-terminology.ts");
  const cmsTerminology = loadOfficialTerminology(official);
  if (!cmsTerminology.ok) {
    // The official-cases CI job vendors the sidecar and runs this file with the flag set, so there a
    // missing sidecar is a failure, never a skip that reads as coverage.
    if (process.env.WORKWELL_REQUIRE_OFFICIAL_TERMINOLOGY === "true") assert.fail(cmsTerminology.problem);
    t.skip("cms137's terminology sidecar is fetched at build (pnpm vendor:official)");
    return;
  }
  // The same pin as CMS's, so the ONLY thing keeping them apart is where the sidecar is read from and
  // what the cache keys it by: the sidecar under measures/derived/cms137/ is the translation's own, pinned
  // by a different sha, so CMS's pin cannot verify there.
  const samePin = { ...derived, manifest: { ...derived.manifest, terminology: { ...official.manifest.terminology! } } };
  assert.equal(loadOfficialTerminology(samePin).ok, false, "read from measures/derived/, never from CMS's cache or CMS's directory");
  const [oid] = requiredOids(official);
  const expand = officialTerminologyExpander();
  assert.ok((await expand(oid!, official)).length > 0);
  assert.deepEqual(await expand(oid!, samePin), [], "the expander expands the artifact it is given, not the measure id");
});

test("QRDA's measure reference refuses a translation even if a route forgot to", async () => {
  const { qrdaMeasureReference } = await import("../fhir/qrda-common.ts");
  assert.throws(() => qrdaMeasureReference("cms137", { kind: "derived", version: "ww-2027.1" }, null, () => ({}), ""), /no QRDA measure identity/);
});

test("isFqmScored is the one test for 'official or translated', and authored is neither", () => {
  assert.equal(isFqmScored(undefined), false);
  assert.equal(isFqmScored({ version: "official-fqm:x", kind: "official", warning: null }), true);
  assert.equal(isFqmScored({ version: "derived-fqm:x", kind: "derived", warning: null }), true);
});
