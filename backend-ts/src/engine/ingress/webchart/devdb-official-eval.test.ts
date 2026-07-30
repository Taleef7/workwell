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
 * That framing matters because the failure this guards is invisible everywhere else. When official CMS125
 * put this entire roster out of its initial population, a run completed, 56 outcomes were written, and no
 * check anywhere noticed. PR-8f's batch retrieve refusal cannot see it either — it catches "retrieved
 * nothing at all", and these retrieves match plenty (236 LOINC observations); they simply did not match
 * the conjunct that decides membership. Confirmed here by the batch returning all 56 subjects.
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
 * Three other candidates were measured and changed **nothing**, worth recording because two were named as
 * CMS125 blockers in the project notes: a LOINC mammography `Observation` mirroring the one HCPCS G0202
 * procedure (a real mapping gap — but all four actionable subjects are OVERDUE, i.e. have no mammogram to
 * find, and the single G0202 in the seed belongs to someone outside the IPP), `Condition.onsetDateTime`
 * (CMS125's IPP reads no Condition at all — only its mastectomy exclusions do), and
 * `Observation.category`. It was one fix, not four; counting absent fields overestimates a gap, which is
 * why the last test below pins the cause by removing it rather than by listing what is present.
 *
 * **cms122 — official and authored BOTH return MISSING_DATA for all 56**, so there is no divergence to
 * gate and routing it changes nothing over this data. The seed carries zero Conditions and cms122 is
 * deliberately absent from `ROSTER_ELIGIBLE_MEASURES` (its "enrollment" is a diabetes *diagnosis*, a
 * clinical fact the roster must never fabricate), so neither engine can see a denominator. A data gap
 * that blocks both paths equally — an M-D ingest question, not a flip risk. Recorded so that when the
 * WebChart path starts supplying diagnoses, whichever engine produces outcomes first does so against a
 * written expectation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { OutcomeStatus } from "../../evaluate-measure.ts";
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
  // Both engines blind for the same reason — no Conditions in the seed, and the roster may not invent a
  // diabetes diagnosis. When ingest starts supplying diagnoses this is the expectation to revisit.
  cms122: { official: { MISSING_DATA: 56 }, divergence: {} },
  cms125: { official: { MISSING_DATA: 52, OVERDUE: 4 }, divergence: {} },
};

/** The subjects the authored engine finds actionable — official must find exactly these. */
const CMS125_ACTIONABLE = ["wc-8", "wc-36", "wc-45", "wc-47"];

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

/** The live run path, reproduced exactly: WebChart normalization, then roster stamping. */
async function liveBundles(measureId: string): Promise<unknown[]> {
  const source = webChartDataSource({ baseUrl: "x", apiKey: "k" }, fixtureWebChartClient(payloads));
  const bundles = await source.loadBundles();
  return bundles.map((b) => stampEnrollment(b as never, measureId, roster, { evaluationDate: EVAL }));
}

const officialExecutor = () => officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) });

async function officialOutcomes(measureId: string, bundles: readonly unknown[]): Promise<Map<string, OutcomeStatus>> {
  const subjects: OfficialBatchSubject[] = bundles.map((b) => ({ subjectId: patientId(b), patientBundle: b }));
  const results = await officialExecutor().evaluateBatch(measureId, subjects, EVAL);
  return new Map([...results].map(([id, r]) => [id, r.outcome]));
}

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

test("fixtures loaded: the full 56-patient dev-DB corpus + a roster", () => {
  assert.equal(payloads.length, 56, `expected every is_patient=1 dev-DB row, got ${payloads.length}`);
});

test("the fixture carries us-core-sex — the element official CMS125's IPP reads", () => {
  const codes = new Map<string, number>();
  for (const bundle of payloads) {
    for (const r of resources(bundle)) {
      if (r["resourceType"] !== "Patient") continue;
      for (const ext of (r["extension"] as Array<Record<string, unknown>>) ?? []) {
        if (String(ext["url"]).endsWith("/us-core-sex")) {
          const code = String(ext["valueCode"]);
          codes.set(code, (codes.get(code) ?? 0) + 1);
        }
      }
    }
  }
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
  // Non-degeneracy before the per-subject check: "both engines agree nobody is in the population" would
  // satisfy a subject-wise comparison, and is the failure this file exists to catch rather than a pass.
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
test("cms125: strip us-core-sex and official collapses out-of-population — the whole cause", { skip }, async () => {
  const stripped = (await liveBundles("cms125")).map((bundle) => {
    const b = clone(bundle);
    for (const r of resources(b)) {
      if (r["resourceType"] !== "Patient") continue;
      const exts = (r["extension"] as Array<Record<string, unknown>>) ?? [];
      r["extension"] = exts.filter((e) => !String(e["url"]).endsWith("/us-core-sex"));
    }
    return b;
  });

  const official = await officialOutcomes("cms125", stripped);
  assert.deepEqual(
    distribution(official),
    { MISSING_DATA: 56 },
    "without us-core-sex, official cms125 should put the whole roster out of its initial population",
  );

  // And the authored engine is UNAFFECTED — it reads `Patient.gender`. This is what makes the two
  // elements worth emitting separately rather than treating one as a substitute for the other.
  const authored = await authoredOutcomes("cms125", stripped);
  assert.deepEqual(distribution(authored), { MISSING_DATA: 52, OVERDUE: 4 });
});
