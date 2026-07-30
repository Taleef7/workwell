/**
 * What the OFFICIAL artifacts make of REAL WebChart data — the gate that did not exist (PR-9b).
 *   node --import tsx --test src/engine/ingress/webchart/devdb-official-eval.test.ts
 *
 * `devdb-eval.test.ts` runs MIE's real WebChart dev-DB sample through the AUTHORED engine and asserts
 * real outcomes. Nothing did the same through an official artifact. Every piece of evidence that official
 * execution works — the 121/121 MADiE gate, `official-corpus-outcomes.test.ts`, the literal diff — runs
 * over CMS's own test patients or over our synthetic corpus. Both are bundles built to be evaluated.
 * WebChart data is not: it is what a real EHR happens to hold, and the difference between those two is
 * where the flip's risk actually lives.
 *
 * ## The property under test
 *
 * **Agreement with the authored engine, subject by subject.** Where the two agree, routing a measure
 * officially is a configuration change. Where they diverge, the divergence is written into `EXPECTED`
 * with its measured cause — so a shift is either progress or a regression, and both are deliberate rather
 * than discovered later from a roster that quietly reads differently.
 *
 * That framing matters because the failure this guards WAS invisible everywhere else. When official CMS125
 * put this entire roster out of its initial population, a run completed, 56 outcomes were written, and no
 * check anywhere noticed. PR-8f's batch retrieve refusal cannot see it — it catches "retrieved nothing at
 * all", and these retrieves match plenty (236 LOINC observations); they simply did not match the conjunct
 * that decides membership.
 *
 * **This file is the AUTOMATED HALF of the enforcement (ADR-043)** — and the half it is not deserves
 * stating, since a runtime check was traded for this. It pins the committed 56-patient fixture; it cannot
 * see a tenant. Confirming a non-zero initial population against a tenant's OWN data is DEPLOY.md
 * §"Flipping a measure to official execution" step 2, which is a prose instruction with no command and no
 * tooling behind it. So "enforcement" here means: one automated test over frozen data, plus one
 * unautomated human step. At runtime a whole-roster-out-of-IPP is only *surfaced* — the
 * run pipeline emits a `WARN` and reports the outcomes as computed — because a legitimately all-ineligible
 * cohort produces the identical shape, cohort composition varies by run, and refusing would replace valid
 * `official.populationResults` evidence with an engine error. The two causes can only be told apart by
 * comparing against the authored engine over KNOWN data, which is what happens here: when authored finds
 * four actionable women in bundles official finds nobody in, "this cohort is ineligible" is demonstrably
 * false. That comparison is impossible at runtime, since it would mean evaluating both engines for a
 * measure whose purpose is to replace one.
 *
 * ## What was measured (2026-07-30, EVAL 2024-06-01, official MP 2023-06-01 .. 2024-06-01)
 *
 * **cms125 — official and authored now agree on all 56 subjects** (52 MISSING_DATA, 4 OVERDUE: wc-8,
 * wc-36, wc-45, wc-47). They did not before this commit: official found 0 actionable and put everyone
 * out of the initial population, whose official definition is
 * `AgeAt(end of MP) in [42..74] AND us-core-sex = SNOMED 248152002 AND exists Qualifying Encounters`.
 * Age passed (those four are 44–54) and the encounter passed (the OH roster stamps a CPT 99213 office
 * visit inside the period). The single failing conjunct was the extension: **0 of 56 patients carried
 * `us-core-sex`**, because both places mapping WebChart's real `patients.sex` column into FHIR emitted
 * `Patient.gender` and stopped there. Both now emit both, and the fixture was regenerated from the dev DB
 * — byte-identical but for 28 added extensions, so nothing else about the sample moved.
 *
 * Three other candidates changed nothing **for IPP membership on this fixture**, and the reason matters
 * for two of them: `Condition.onsetDateTime` genuinely does not apply (CMS125's IPP reads no Condition at
 * all — only its mastectomy exclusions do), but the LOINC mammography `Observation` and
 * `Observation.category` moved no outcome only because **no in-IPP subject here has a mammogram to find**.
 * Both are live NUMERATOR blockers, and the tests at the bottom of this file demonstrate that they produce
 * a **false OVERDUE on the first real screening**. Read "one fix, not four" as scoped to the initial
 * population; it is not a statement that the other gaps are retired.
 *
 * **cms122 — official puts all 56 out of the IPP, and authored returns MISSING_DATA for all 56.** The seed
 * carries zero Conditions and cms122 is deliberately absent from `ROSTER_ELIGIBLE_MEASURES` (its
 * "enrollment" is a diabetes *diagnosis*, a clinical fact the roster must never fabricate), so neither
 * engine can see a denominator. **This changes the flip plan:** the roadmap's PR-9 flips "cms122+cms125"
 * together — but that flip targets the demo/production stack, which has NO WebChart seam and runs the
 * synthetic roster where official cms122 scores normally. So this constrains STAGING (WebChart-configured),
 * not the flip: routing official cms122 there yields 56 MISSING_DATA rows while appearing to run. The
 * authored AGREEMENT is what makes it a data gap rather than a divergence, and that agreement is also the
 * discrimination a runtime check cannot make (ADR-043).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { MeasureOutcome, OutcomeStatus } from "../../evaluate-measure.ts";
import { webChartDataSource } from "../data-source.ts";
import { fixtureWebChartClient } from "./webchart-client.ts";
import { parseEnrollmentRoster, stampEnrollment } from "../enrollment/roster.ts";
import { officialMeasureExecutor, type OfficialBatchSubject } from "../../../wiring/official-executor-adapter.ts";
import { officialTerminologyExpander, loadOfficialTerminology } from "../../../wiring/official-terminology.ts";
import { loadOfficialArtifact } from "../../../wiring/official-artifacts.ts";
import { CqlExecutionEngine } from "../../cql/cql-execution-engine.ts";
import { bundledEcqmValueSetResolver } from "../../cql/bundled-ecqm-expansions.ts";

const DIR = fileURLToPath(new URL("../../../../spike/webchart/", import.meta.url));
const payloads = JSON.parse(readFileSync(path.join(DIR, "devdb-patients.json"), "utf8")) as unknown[];
const roster = parseEnrollmentRoster(JSON.parse(readFileSync(path.join(DIR, "enrollment-roster.json"), "utf8")));

/** Data-contemporaneous, matching `devdb-eval.test.ts` — the sample spans 2015–2024. */
const EVAL = "2024-06-01";

/**
 * The measured baseline: official outcome distribution, and every subject where authored disagrees.
 *
 * `divergence` is the load-bearing field. Empty means official and authored agree subject-for-subject, so
 * routing the measure is inert for this data; a populated one names each subject whose roster row would
 * change the day the measure is routed, and what it changes from and to.
 */
const EXPECTED: Record<string, { official: Record<string, number>; divergence: Record<string, string> }> = {
  cms125: { official: { MISSING_DATA: 52, OVERDUE: 4 }, divergence: {} },
};

/** The subjects the authored engine finds actionable — official must find exactly these. */
const CMS125_ACTIONABLE = ["wc-8", "wc-36", "wc-45", "wc-47"];

const US_CORE_SEX_URL = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-sex";
const OBSERVATION_CATEGORY = "http://terminology.hl7.org/CodeSystem/observation-category";

const sidecarsPresent = ["cms122", "cms125"].every((id) => {
  const artifact = loadOfficialArtifact(id);
  return !!artifact && loadOfficialTerminology(artifact).ok;
});
const skip = sidecarsPresent ? false : "run 'pnpm vendor:official' to fetch the terminology sidecars";

type Bundle = { entry?: Array<{ resource?: Record<string, unknown> }> };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function resources(bundle: unknown): Array<Record<string, unknown>> {
  return ((bundle as Bundle).entry ?? []).map((e) => e.resource).filter((r): r is Record<string, unknown> => !!r);
}

function patientId(bundle: unknown): string {
  for (const r of resources(bundle)) if (r["resourceType"] === "Patient" && typeof r["id"] === "string") return r["id"];
  throw new Error("fixture bundle carries no Patient.id");
}

/**
 * The run path's INGRESS CODE, reproduced exactly: WebChart normalization, then roster stamping.
 *
 * Scope worth being precise about — the transport is `fixtureWebChartClient`, not HTTP. This exercises
 * every transformation a routed run applies to a WebChart payload, and none of the request shaping.
 * `hapi-live.test.ts` / `hapi-app-live.test.ts` cover the live HTTP path and remain authored-only, so
 * "no test evaluates the live HTTP path through an official artifact" is still true after this file.
 */
async function liveBundles(measureId: string): Promise<unknown[]> {
  const source = webChartDataSource({ baseUrl: "x", apiKey: "k" }, fixtureWebChartClient(payloads));
  const bundles = await source.loadBundles();
  return bundles.map((b) => stampEnrollment(b as never, measureId, roster, { evaluationDate: EVAL }));
}

const officialExecutor = () => officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) });

/** Full outcomes — needed where a test must distinguish "out of the IPP" from "non-compliant". */
async function officialFull(measureId: string, bundles: readonly unknown[]): Promise<Map<string, MeasureOutcome>> {
  const subjects: OfficialBatchSubject[] = bundles.map((b) => ({ subjectId: patientId(b), patientBundle: b }));
  return officialExecutor().evaluateBatch(measureId, subjects, EVAL);
}

async function officialOutcomes(measureId: string, bundles: readonly unknown[]): Promise<Map<string, OutcomeStatus>> {
  return new Map([...(await officialFull(measureId, bundles))].map(([id, r]) => [id, r.outcome]));
}

/** How many subjects the official artifact actually admitted to the initial population. */
const inIppCount = (outcomes: ReadonlyMap<string, MeasureOutcome>): number =>
  [...outcomes.values()].filter((o) => o.inInitialPopulation).length;

async function authoredOutcomes(measureId: string, bundles: readonly unknown[]): Promise<Map<string, OutcomeStatus>> {
  const authored = new CqlExecutionEngine({ valueSetResolver: bundledEcqmValueSetResolver });
  const out = new Map<string, OutcomeStatus>();
  for (const bundle of bundles) {
    const r = await authored.evaluate({ measureId, patientBundle: clone(bundle), evaluationDate: EVAL });
    out.set(patientId(bundle), r.outcome);
  }
  return out;
}

function distribution(outcomes: ReadonlyMap<string, OutcomeStatus>): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const o of outcomes.values()) dist[o] = (dist[o] ?? 0) + 1;
  return dist;
}

test("official-eval fixtures loaded: the full 56-patient dev-DB corpus + a roster", () => {
  assert.equal(payloads.length, 56, `expected every is_patient=1 dev-DB row, got ${payloads.length}`);
});

test("the fixture carries us-core-sex — the element official CMS125's IPP reads", () => {
  const codes = new Map<string, number>();
  let genderWithoutExt = 0;
  let extWithoutGender = 0;
  for (const bundle of payloads) {
    for (const r of resources(bundle)) {
      if (r["resourceType"] !== "Patient") continue;
      const exts = ((r["extension"] as Array<Record<string, unknown>>) ?? []).filter(
        // The EXACT url, not a suffix match: `http://example.org/us-core-sex` would satisfy `endsWith`
        // and satisfies nothing the ELM asks for.
        (e) => e["url"] === US_CORE_SEX_URL,
      );
      for (const ext of exts) {
        const code = String(ext["valueCode"]);
        codes.set(code, (codes.get(code) ?? 0) + 1);
      }
      // The invariant that matters is the PAIRING, not the aggregate: both elements come from the same
      // `patients.sex` column, so one present without the other means a mapping site drifted.
      const gender = r["gender"];
      const hasGender = gender === "female" || gender === "male";
      if (hasGender && exts.length !== 1) genderWithoutExt++;
      if (!hasGender && exts.length !== 0) extWithoutGender++;
      if (hasGender && exts.length === 1) {
        assert.equal(exts[0]!["valueCode"], gender === "female" ? "248152002" : "248153007", `${r["id"]}`);
      }
    }
  }
  assert.equal(genderWithoutExt, 0, "a Patient with gender is missing its us-core-sex extension");
  assert.equal(extWithoutGender, 0, "a Patient without gender carries a us-core-sex extension");
  // SNOMED concept ids, not "F"/"M": the ELM compares against the id, so the wrong value is
  // indistinguishable from an absent extension. Asserted on the FIXTURE so a regeneration from a mapping
  // that dropped or mis-coded it fails here, naming the field, rather than as an outcome shift below.
  assert.deepEqual(Object.fromEntries(codes), { "248152002": 12, "248153007": 16 });
});

for (const [measureId, expected] of Object.entries(EXPECTED)) {
  test(`official ${measureId} over real WebChart data: the measured baseline`, { skip }, async () => {
    const bundles = await liveBundles(measureId);
    const official = await officialOutcomes(measureId, bundles);
    const authored = await authoredOutcomes(measureId, bundles);

    // Every subject must come back. `evaluateBatch` omits a subject fqm returned nothing for, and an
    // omission read as "no outcome" is how a mis-keyed batch degrades silently (adapter docs, PR-8f).
    assert.equal(official.size, 56, `official returned ${official.size} of 56 subjects`);
    assert.equal(authored.size, 56, `authored returned ${authored.size} of 56 subjects`);

    assert.deepEqual(distribution(official), expected.official, `official ${measureId} distribution moved`);

    const divergence: Record<string, string> = {};
    for (const [subjectId, officialOutcome] of official) {
      const authoredOutcome = authored.get(subjectId);
      if (authoredOutcome !== officialOutcome) divergence[subjectId] = `${authoredOutcome}→${officialOutcome}`;
    }
    assert.deepEqual(
      divergence,
      expected.divergence,
      `official/authored divergence for ${measureId} changed — update EXPECTED deliberately, with the cause`,
    );
  });
}

test("official cms125 finds the same four actionable subjects the authored engine does", { skip }, async () => {
  const official = await officialOutcomes("cms125", await liveBundles("cms125"));
  // Non-degeneracy, kept as insurance rather than claimed as the guard: the `deepEqual` below already
  // implies it (four non-MISSING_DATA ids out of 56 forces two distinct values), so this line cannot fail
  // alone. It earns its place only if that comparison is ever loosened. The docs should not cite it as
  // what protects against collapse — the id-set comparison is.
  assert.ok(new Set(official.values()).size > 1, "official cms125 collapsed to a single bucket");
  const actionable = [...official].filter(([, o]) => o !== "MISSING_DATA").map(([id]) => id);
  assert.deepEqual(actionable.sort(), [...CMS125_ACTIONABLE].sort());
  for (const id of CMS125_ACTIONABLE) assert.equal(official.get(id), "OVERDUE", `${id} should be OVERDUE`);
});

/**
 * The cause, pinned by removing it.
 *
 * The agreement above rests entirely on one element. Asserting that the element is *present* (as the
 * fixture test does) proves the mapping emits it; it does not prove that is what holds the agreement up.
 * Stripping it and watching official collapse does — and it is the assertion that survives the next
 * change to this pipeline, because a future mapping that drops `us-core-sex` would otherwise surface as
 * an unexplained distribution shift in a table of numbers.
 *
 * This is also the historical record: 56 MISSING_DATA is exactly what official CMS125 produced over this
 * fixture before the mapping was fixed.
 */
/** The same live path with `us-core-sex` removed — the pre-fix state, and the third-party-server state. */
async function strippedOfSex(): Promise<unknown[]> {
  return (await liveBundles("cms125")).map((bundle) => {
    const b = clone(bundle);
    for (const r of resources(b)) {
      if (r["resourceType"] !== "Patient") continue;
      const exts = (r["extension"] as Array<Record<string, unknown>>) ?? [];
      r["extension"] = exts.filter((e) => e["url"] !== US_CORE_SEX_URL);
    }
    return b;
  });
}

test("cms125: strip us-core-sex and the whole roster leaves the IPP — the cause, pinned", { skip }, async () => {
  // This is the third-party-WebChart-server state (ADR-042 consequence 5): 56 subjects, every one out of
  // the initial population, a run that completes, and a roster indistinguishable from a legitimately
  // ineligible cohort. The run pipeline WARNs on it (ADR-043) rather than failing, because that shape is
  // also what a genuinely ineligible cohort produces — see `run-pipeline.test.ts`.
  //
  // THIS test is the enforcement: a human comparison against the authored engine over known data, which
  // is the only place the two causes can be told apart. It is why the flip gate is a gate and not a
  // runtime check.
  const stripped = await strippedOfSex();
  const official = await officialFull("cms125", stripped);
  assert.deepEqual(
    distribution(new Map([...official].map(([id, o]) => [id, o.outcome]))),
    { MISSING_DATA: 56 },
    "without us-core-sex, official cms125 puts the whole roster out of its initial population",
  );
  assert.equal(inIppCount(official), 0, "and the reason is IPP membership, not a non-compliance verdict");

  // The authored engine is UNAFFECTED — it reads `Patient.gender`. That asymmetry is the whole signal:
  // authored finds four actionable women in the same bundles, so "nobody is eligible" is demonstrably
  // false here and the divergence is a mapping gap, not a cohort.
  const authored = await authoredOutcomes("cms125", stripped);
  assert.deepEqual(distribution(authored), { MISSING_DATA: 52, OVERDUE: 4 });
});

test("cms122 over real WebChart data: nobody in the IPP — a DATA gap, not a flip blocker", { skip }, async () => {
  // Scoped carefully, because a first draft of ADR-043 over-read this into removing cms122 from the PR-9c
  // flip list. It is a statement about WEBCHART data only: the seed carries zero Conditions and cms122 is
  // deliberately outside `ROSTER_ELIGIBLE_MEASURES`, since its "enrollment" is a diabetes *diagnosis* the
  // roster must never fabricate. The demo/production stack PR-9c flips has NO WebChart seam
  // (`deploy-twh-mieweb.yml` carries zero `WORKWELL_WEBCHART_*`) and runs the synthetic roster, where
  // `official-corpus-outcomes.test.ts` has official cms122 scoring across all five targets. So this
  // constrains STAGING, not the flip.
  //
  // Unlike the cms125 case above, the authored engine agrees there is nobody to score — so this is a DATA
  // gap (M-D ingest), not an official-vs-authored divergence, and routing cms122 would change no roster
  // row. That agreement is precisely what distinguishes "genuinely ineligible" from "mapping gap", and
  // why a runtime refusal keyed on zero-in-IPP would have been wrong: it cannot see this comparison.
  const official = await officialFull("cms122", await liveBundles("cms122"));
  assert.deepEqual(distribution(new Map([...official].map(([id, o]) => [id, o.outcome]))), { MISSING_DATA: 56 });
  assert.equal(inIppCount(official), 0);

  const authored = await authoredOutcomes("cms122", await liveBundles("cms122"));
  assert.deepEqual(distribution(authored), { MISSING_DATA: 56 }, "authored is equally blind — nothing is lost");
});

/**
 * ## The NUMERATOR gap — still open, and it fails in the dangerous direction
 *
 * Everything above is a statement about **initial-population membership only**. All four discriminating
 * subjects are OVERDUE for the same reason — none has a mammogram — and the seed's single mammography
 * code (HCPCS `G0202` on a `Procedure`) belongs to `wc-49`, who is 33 and outside the `[42..74]` IPP. So
 * the fixture as committed *cannot* exercise either engine's numerator, and the agreement above must not
 * be read as numerator parity.
 *
 * It is not. The two engines read different resource types:
 *   - authored `cms125.cql`: `exists([Procedure: "Mammography"] where status = 'completed' …)`
 *   - official CMS125 ELM: `isDiagnosticStudyPerformed([Observation: "Mammography"])`, where
 *     `Status.isDiagnosticStudyPerformed` requires `status in {final, amended, corrected}` **AND**
 *     `exists(category ~ imaging)`
 *   - the WebChart crosswalk (`webchart/terminology.ts`) emits mammography as CPT `77067` / HCPCS
 *     `G0202` on a **`Procedure`**
 *
 * And the official `Mammography` value set (OID …108.12.1018) is **92 LOINC codes and nothing else** — no
 * CPT, no HCPCS. So the shape WebChart actually produces is invisible to the official numerator.
 *
 * The consequence is worse than an out-of-population read, which is why it is worth a test rather than a
 * doc line: official reports a **screened woman as OVERDUE**. That is a confident wrong answer on the
 * ordinary case, and via `case-logic.ts` it becomes a HIGH-priority case telling an operator to "escalate
 * mammogram follow-up immediately" for a mammogram she already had.
 *
 * These are recorded as KNOWN divergences so the flip's real risk is a tracked expectation instead of an
 * argument. Closing them is a crosswalk change (M-D), not an edit here.
 */
const MAMMO_DATE = "2023-09-15"; // inside the official MP (2023-06-01 .. 2024-06-01) for EVAL 2024-06-01

/** Exactly what `webchart/terminology.ts` emits today for one real screening mammogram. */
const crosswalkProcedure = (subjectId: string) => ({
  resourceType: "Procedure",
  id: `${subjectId}-Procedure-mammo`,
  status: "completed",
  subject: { reference: `Patient/${subjectId}` },
  code: { coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "77067" }] },
  performedDateTime: MAMMO_DATE,
});

/** The shape the OFFICIAL numerator retrieves. `category` is not decoration — see the note above. */
const officialObservation = (subjectId: string, withCategory: boolean) => ({
  resourceType: "Observation",
  id: `${subjectId}-Observation-mammo`,
  status: "final",
  subject: { reference: `Patient/${subjectId}` },
  code: { coding: [{ system: "http://loinc.org", code: "24606-6" }] },
  ...(withCategory ? { category: [{ coding: [{ system: OBSERVATION_CATEGORY, code: "imaging" }] }] } : {}),
  effectiveDateTime: MAMMO_DATE,
});

async function withResourcesOn(subjectId: string, extra: readonly unknown[]): Promise<unknown[]> {
  return (await liveBundles("cms125")).map((bundle) => {
    if (patientId(bundle) !== subjectId) return bundle;
    const b = clone(bundle) as { entry: Array<{ resource: unknown }> };
    for (const resource of extra) b.entry.push({ resource: clone(resource) });
    return b;
  });
}

test("KNOWN GAP — a crosswalk-shaped mammogram makes official report a screened woman OVERDUE", { skip }, async () => {
  const bundles = await withResourcesOn("wc-8", [crosswalkProcedure("wc-8")]);
  const official = await officialOutcomes("cms125", bundles);
  const authored = await authoredOutcomes("cms125", bundles);

  assert.equal(authored.get("wc-8"), "COMPLIANT", "authored reads the Procedure and clears her");
  assert.equal(official.get("wc-8"), "OVERDUE", "official cannot see a CPT Procedure — a FALSE overdue");
  assert.deepEqual(distribution(authored), { MISSING_DATA: 52, COMPLIANT: 1, OVERDUE: 3 });
  assert.deepEqual(distribution(official), { MISSING_DATA: 52, OVERDUE: 4 });
});

test("KNOWN GAP — a LOINC Observation WITHOUT category=imaging leaves official still blind", { skip }, async () => {
  // The trap in the obvious fix. `isDiagnosticStudyPerformed` gates on `category ~ imaging`, so emitting
  // a correctly-coded LOINC Observation and stopping there changes nothing — and looks like it should.
  const bundles = await withResourcesOn("wc-8", [officialObservation("wc-8", false)]);
  const official = await officialOutcomes("cms125", bundles);
  assert.equal(official.get("wc-8"), "OVERDUE", "a LOINC mammogram with no category is not a diagnostic study");
});

test("the remedy is DUAL-STAMPING: both representations, and both engines agree COMPLIANT", { skip }, async () => {
  // Neither representation alone is enough, and they fail in opposite directions: the Procedure alone
  // clears authored and not official; the Observation alone clears official and not authored. Emitting
  // both is what the synthetic corpus already does (ADR-038) and what the crosswalk must do.
  const bundles = await withResourcesOn("wc-8", [crosswalkProcedure("wc-8"), officialObservation("wc-8", true)]);
  const official = await officialOutcomes("cms125", bundles);
  const authored = await authoredOutcomes("cms125", bundles);

  assert.equal(official.get("wc-8"), "COMPLIANT");
  assert.equal(authored.get("wc-8"), "COMPLIANT");
  for (const [subjectId, officialOutcome] of official) {
    assert.equal(officialOutcome, authored.get(subjectId), `${subjectId} diverged under the remedy`);
  }
});

test("KNOWN GAP — the Observation alone clears official while authored still reports OVERDUE", { skip }, async () => {
  // The mirror image, recorded so a future crosswalk change that emits only the official shape is caught
  // as a divergence rather than celebrated as a fix.
  const bundles = await withResourcesOn("wc-8", [officialObservation("wc-8", true)]);
  const official = await officialOutcomes("cms125", bundles);
  const authored = await authoredOutcomes("cms125", bundles);
  assert.equal(official.get("wc-8"), "COMPLIANT");
  assert.equal(authored.get("wc-8"), "OVERDUE");
});
