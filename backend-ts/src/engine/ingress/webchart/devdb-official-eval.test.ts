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
 * ## Why a BASELINE test and not a passing one
 *
 * This records what official execution does over WebChart data TODAY, gaps included, and fails when that
 * changes. It is not asserting the gaps are acceptable — `EXPECTED` below names each one and points at
 * its fix. The reason to commit the gap rather than wait until it is closed is that the gap is currently
 * invisible: official CMS125 puts this entire roster out of its initial population, a run completes, 56
 * outcomes are written, and no check anywhere notices. PR-8f's batch retrieve refusal cannot see it
 * either — it catches "retrieved nothing at all", and these retrieves match plenty (236 LOINC
 * observations); they just do not match the conjunct that decides membership.
 *
 * So the property under test is *agreement with the authored engine, subject by subject*. Where the two
 * agree, the flip is a configuration change. Where they diverge, the divergence is written down here with
 * its measured cause, so closing it is a one-line edit to this file and not an investigation.
 *
 * ## What was measured (2026-07-30, EVAL 2024-06-01, official MP 2023-06-01 .. 2024-06-01)
 *
 * **cms125** — authored finds 4 actionable subjects (wc-8, wc-36, wc-45, wc-47, all OVERDUE); official
 * finds 0 and puts all 56 out of the initial population. The official IPP is
 * `AgeAt(end of MP) in [42..74] AND us-core-sex = SNOMED 248152002 AND exists Qualifying Encounters`.
 * Age passes (those four are 44–54) and the encounter passes (the OH roster stamps a CPT 99213 office
 * visit inside the period). The single failing conjunct is the extension: **0 of 56 patients carry
 * `us-core-sex`**, because both places that map WebChart's real `patients.sex` column into FHIR emit
 * `Patient.gender` and stop there — `wcdb-fhir-shim/src/fhir-mapping.ts` and the inline duplicate in
 * `scripts/webchart-devdb-export.ts`. `REMEDY` below proves that is the whole cause rather than the
 * first of several: stamping the extension makes official agree with authored on all four.
 *
 * Three other candidates were measured and changed **nothing** on this data, which is worth recording
 * because two of them are named as CMS125 blockers in the project notes: a LOINC mammography
 * `Observation` mirroring the one HCPCS G0202 procedure (real mapping gap — but all four actionable
 * subjects are OVERDUE, i.e. have no mammogram to find, and the single G0202 in the seed belongs to
 * someone outside the IPP), `Condition.onsetDateTime` (CMS125's IPP reads no Condition at all — only its
 * mastectomy exclusions do), and `Observation.category` (not read by this measure's retrieves).
 *
 * **cms122** — official and authored BOTH return MISSING_DATA for all 56, so there is no divergence to
 * gate. The seed carries zero Conditions and cms122 is deliberately absent from
 * `ROSTER_ELIGIBLE_MEASURES` (its "enrollment" is a diabetes *diagnosis*, a clinical fact the roster must
 * never fabricate), so neither engine can see a denominator. This is a data gap that blocks the measure
 * for both paths equally — an M-D ingest question, not a flip risk. Recorded here so that when the
 * WebChart path starts supplying diagnoses, whichever engine starts producing outcomes first does so
 * against a written expectation.
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
 * The measured baseline: official outcome distribution, and the subjects where authored disagrees.
 *
 * `divergence` is the load-bearing field. An empty map would mean official and authored agree
 * subject-for-subject and the flip is inert for this data; a populated one names every subject whose
 * roster row would change the day the measure is routed, with what it changes from and to.
 */
const EXPECTED: Record<string, { official: Record<string, number>; divergence: Record<string, string> }> = {
  cms122: {
    official: { MISSING_DATA: 56 },
    // No divergence: authored is equally blind (0 Conditions in the seed, and the roster may not
    // fabricate a diabetes diagnosis). Routing cms122 officially over this data changes nothing.
    divergence: {},
  },
  cms125: {
    official: { MISSING_DATA: 56 },
    // Every one of these is `authored OVERDUE → official MISSING_DATA`, caused solely by the absent
    // `us-core-sex` extension. Closing it (see REMEDY) turns this map empty and the distribution into
    // { MISSING_DATA: 52, OVERDUE: 4 }.
    divergence: {
      "wc-8": "OVERDUE→MISSING_DATA",
      "wc-36": "OVERDUE→MISSING_DATA",
      "wc-45": "OVERDUE→MISSING_DATA",
      "wc-47": "OVERDUE→MISSING_DATA",
    },
  },
};

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
    // The whole point of the file. A CHANGE here is either progress (a gap closed) or a regression, and
    // both must be deliberate — never discovered from a roster that quietly reads differently.
    assert.deepEqual(
      divergence,
      expected.divergence,
      `official/authored divergence for ${measureId} changed — update EXPECTED deliberately, with the cause`,
    );
  });
}

/**
 * The remedy, proven rather than asserted.
 *
 * A gap recorded without its cause invites the wrong fix. This runs the SAME live path with one change —
 * `us-core-sex` stamped from the `Patient.gender` the WebChart mapping already derives from
 * `patients.sex` — and shows official then agreeing with authored subject-for-subject. When the two
 * mappings are corrected at the source, `EXPECTED.cms125` becomes this and this test collapses into the
 * loop above.
 *
 * Note the SNOMED code matters: the ELM compares the extension's value against `248152002`, so an
 * extension present with the wrong value (`"F"`, say) is indistinguishable from one absent. That cost a
 * measurement pass to discover and is the reason this asserts an outcome rather than the field's
 * presence.
 */
test("cms125: stamping us-core-sex is the WHOLE cause — official then matches authored", { skip }, async () => {
  const bundles = (await liveBundles("cms125")).map((bundle) => {
    const b = clone(bundle);
    for (const r of resources(b)) {
      if (r["resourceType"] !== "Patient") continue;
      const gender = r["gender"];
      if (gender !== "female" && gender !== "male") continue;
      r["extension"] = [
        ...((r["extension"] as unknown[]) ?? []),
        {
          url: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-sex",
          valueCode: gender === "female" ? "248152002" : "248153007",
        },
      ];
    }
    return b;
  });

  const official = await officialOutcomes("cms125", bundles);
  const authored = await authoredOutcomes("cms125", bundles);

  assert.deepEqual(
    distribution(official),
    { MISSING_DATA: 52, OVERDUE: 4 },
    "with us-core-sex present, official cms125 should find the same 4 actionable subjects",
  );
  // Non-degeneracy first: a distribution of one bucket would satisfy a subject-wise comparison against
  // an equally collapsed authored run, and "they agree that nobody is in the population" is the failure
  // this file exists to catch, not a pass.
  assert.ok(new Set(official.values()).size > 1, "official cms125 collapsed to one bucket");

  for (const [subjectId, officialOutcome] of official) {
    assert.equal(
      officialOutcome,
      authored.get(subjectId),
      `${subjectId}: official ${officialOutcome} vs authored ${authored.get(subjectId)}`,
    );
  }
  for (const subjectId of Object.keys(EXPECTED["cms125"]!.divergence)) {
    assert.equal(official.get(subjectId), "OVERDUE", `${subjectId} should be recovered by the remedy`);
  }
});
