/**
 * M-E1 — OSHA Hearing Conservation Standard Threshold Shift (29 CFR 1910.95), ADR-065.
 *
 * ## What licenses these assertions, and what does not
 *
 * There is **no external oracle for this measure**. The official eCQMs are checked against the
 * measure stewards' own MADiE expected results (410/410) and the engine against `cqframework/cql-tests`;
 * nothing equivalent exists for any OSHA standard, because OSHA publishes regulations rather than
 * computable artifacts. These cases are derived by us from the regulation text, so they establish
 * that the measure computes **what we read the CFR to require** — not that our reading is right.
 * `docs/STANDARDS_CONFORMANCE.md` says so in those words; that distinction must not erode.
 *
 * What CAN be made rigorous without an oracle is the choice of cases. Two kinds are used:
 *
 *   1. **Boundary cases at the regulation's own numbers.** 1910.95(g)(10)(i) says "10 dB or more",
 *      so 9.99 must be negative and 10.0 positive. The threshold is not ours to soften.
 *   2. **Adversarially wrong-by-construction cases** — each one kills a specific plausible
 *      misimplementation. A suite that only tests the happy path would pass against several
 *      confidently wrong measures, which is the failure mode that matters here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkwellEngine } from "./workwell-engine.ts";
import elm from "./elm/OshaHearingStandardThresholdShift-1.0.0.elm.json" with { type: "json" };

/**
 * The measure is NOT in the registry (see measure-registry.ts), so it is evaluated the way an
 * external integrator would: by injecting its ELM and metadata. That is the same
 * `evaluate({ elm, metaOverride })` path ADR-059 built for consumer-supplied content, so these
 * tests exercise the published surface rather than a privileged internal one.
 */
const META = {
  id: "osha_hearing_sts",
  name: "OSHA Hearing Conservation — Standard Threshold Shift",
  library: "OshaHearingStandardThresholdShift-1.0.0",
  periodMonths: 12,
};
const MEASURE = "osha_hearing_sts";
const EVAL = "2026-06-30";

/** LOINC, Pure tone air conduction threshold audiometry panel (89015-2). */
const CODES: Record<"right" | "left", Record<number, string>> = {
  // 6000 Hz is included so the "only the three named frequencies count" test can emit real 6000 Hz
  // data. Without it that test would pass against a measure that DOES read 6000 Hz — vacuously.
  right: { 2000: "89019-4", 3000: "89021-0", 4000: "89023-6", 6000: "89027-7" },
  left: { 2000: "89018-6", 3000: "89020-2", 4000: "89022-8", 6000: "89026-9" },
};

type EarThresholds = Partial<Record<2000 | 3000 | 4000 | 6000, number>>;
interface Audiogram {
  date: string;
  right?: EarThresholds;
  left?: EarThresholds;
  /** FHIR Observation.status. Defaults to `final`; set to exercise the clinical-finality gate. */
  status?: string;
}

function bundle(audiograms: Audiogram[], opts: { enrolled?: boolean; notOccupational?: string | boolean } = {}): unknown {
  const entry: unknown[] = [{ resource: { resourceType: "Patient", id: "w1", birthDate: "1985-04-02" } }];
  if (opts.enrolled !== false) {
    entry.push({
      resource: {
        resourceType: "Condition", id: "noise-exposure", subject: { reference: "Patient/w1" },
        code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "Z57.0", display: "Occupational exposure to noise" }] },
      },
    });
  }
  if (opts.notOccupational) {
    // `recordedDate` is load-bearing: a determination predating the current audiogram cannot be a
    // determination about it. `true` means "recorded with the latest audiogram".
    const recordedDate =
      typeof opts.notOccupational === "string"
        ? opts.notOccupational
        : audiograms[audiograms.length - 1]!.date;
    entry.push({
      resource: {
        resourceType: "Condition", id: "not-occ", subject: { reference: "Patient/w1" },
        code: { coding: [{ system: "urn:workwell:vs:sts-not-occupational", code: "sts-not-occupational" }] },
        recordedDate,
      },
    });
  }
  let n = 0;
  for (const a of audiograms) {
    for (const ear of ["right", "left"] as const) {
      for (const [hz, db] of Object.entries(a[ear] ?? {})) {
        entry.push({
          resource: {
            resourceType: "Observation", id: `obs-${n++}`, status: a.status ?? "final",
            subject: { reference: "Patient/w1" },
            code: { coding: [{ system: "http://loinc.org", code: CODES[ear][Number(hz) as 2000] }] },
            effectiveDateTime: a.date,
            valueQuantity: { value: db, unit: "dB", system: "http://unitsofmeasure.org", code: "dB" },
          },
        });
      }
    }
  }
  return { resourceType: "Bundle", type: "collection", entry };
}

const run = async (b: unknown) =>
  createWorkwellEngine().evaluate({ measureId: MEASURE, patientBundle: b, evaluationDate: EVAL, elm, metaOverride: META });
const evaluate = async (b: unknown) => (await run(b)).outcome;

/** A full three-frequency ear at one level, for building shifts of a known size. */
const ear = (db: number): EarThresholds => ({ 2000: db, 3000: db, 4000: db });

test("1910.95(g)(10)(i): a 10 dB average shift IS a Standard Threshold Shift; 9.99 is not", async () => {
  // The regulation says "an average of 10 dB or more". The boundary is inclusive, and it is not ours
  // to move — a measure using `> 10` would miss every shift landing exactly on the definition.
  const at10 = await evaluate(bundle([
    { date: "2020-05-01", right: ear(10), left: ear(10) },
    { date: "2026-05-01", right: ear(20), left: ear(10) },
  ]));
  assert.equal(at10, "OVERDUE", "exactly 10 dB must be an STS — follow-up is owed");

  // 10 + 10 + 9.97 shifts => 29.97/3 = 9.99 dB average, one hundredth below the definition.
  const justUnder = await evaluate(bundle([
    { date: "2020-05-01", right: ear(10), left: ear(10) },
    { date: "2026-05-01", right: { 2000: 20, 3000: 20, 4000: 19.97 }, left: ear(10) },
  ]));
  assert.equal(justUnder, "COMPLIANT", "9.99 dB average is below the 10 dB definition");
});

test("the average is over 2000/3000/4000 Hz ONLY — a 6000 Hz shift is invisible", async () => {
  // 1910.95(h)(1) requires TESTING at 500-6000 Hz, but (g)(10)(i) names only three frequencies for
  // the STS calculation. Averaging the tested set instead of the named set is a documented failure
  // mode, and this is the case that catches it: a huge 6000 Hz shift must not produce an STS.
  const shifted6k = await evaluate(bundle([
    { date: "2020-05-01", right: { ...ear(10), 6000: 10 }, left: ear(10) },
    { date: "2026-05-01", right: { ...ear(10), 6000: 70 }, left: ear(10) },
  ]));
  assert.equal(shifted6k, "COMPLIANT", "a 60 dB shift at 6000 Hz is not an STS — that frequency is not named by (g)(10)(i)");
});

test("the ears are evaluated INDEPENDENTLY — an STS in either ear suffices", async () => {
  // (g)(10)(i) "in either ear"; 1904.10(a) "one or both ears". A measure requiring BOTH ears, or
  // averaging across ears, reports a genuinely shifted worker as fine.
  const rightOnly = await evaluate(bundle([
    { date: "2020-05-01", right: ear(5), left: ear(5) },
    { date: "2026-05-01", right: ear(25), left: ear(5) },
  ]));
  assert.equal(rightOnly, "OVERDUE", "right ear alone is enough");

  const leftOnly = await evaluate(bundle([
    { date: "2020-05-01", right: ear(5), left: ear(5) },
    { date: "2026-05-01", right: ear(5), left: ear(25) },
  ]));
  assert.equal(leftOnly, "OVERDUE", "left ear alone is enough — the ears must not be averaged together");
});

test("the shift is measured against the BASELINE, not against the previous audiogram", async () => {
  // A worker drifting 6 dB per test crosses 10 dB against baseline while never moving 10 dB between
  // consecutive tests. Comparing to the previous audiogram — the intuitive reading — misses exactly
  // the gradual occupational loss the hearing conservation program exists to catch.
  const gradual = await evaluate(bundle([
    { date: "2018-05-01", right: ear(0), left: ear(0) },
    { date: "2022-05-01", right: ear(6), left: ear(0) },
    { date: "2026-05-01", right: ear(12), left: ear(0) },
  ]));
  assert.equal(gradual, "OVERDUE", "12 dB against baseline is an STS even though no step exceeded 6 dB");
});

test("improvement is not a shift — a NEGATIVE change never triggers", async () => {
  const improved = await evaluate(bundle([
    { date: "2020-05-01", right: ear(30), left: ear(30) },
    { date: "2026-05-01", right: ear(5), left: ear(5) },
  ]));
  assert.equal(improved, "COMPLIANT", "hearing that improved by 25 dB is not a threshold shift");
});

test("it averages the SHIFTS, not the absolute thresholds", async () => {
  // A worker whose absolute average is high but unchanged has no STS. A measure comparing the
  // current average against a fixed dB number rather than against the baseline would flag them.
  const highButStable = await evaluate(bundle([
    { date: "2020-05-01", right: ear(45), left: ear(45) },
    { date: "2026-05-01", right: ear(45), left: ear(45) },
  ]));
  assert.equal(highButStable, "COMPLIANT", "45 dB absolute with zero shift is not an STS");
});

test("an incomplete frequency set REFUSES to conclude rather than averaging what is present", async () => {
  // Averaging over two of the three frequencies is not the regulation's average. Reporting such a
  // worker as COMPLIANT would improve the apparent rate by hiding the people nobody has enough
  // data about — the failure this measure's MISSING_DATA branch exists to prevent.
  const partial = await evaluate(bundle([
    { date: "2020-05-01", right: { 2000: 5, 3000: 5 }, left: ear(5) },
    { date: "2026-05-01", right: { 2000: 25, 3000: 25 }, left: ear(5) },
  ]));
  assert.equal(partial, "MISSING_DATA", "two of three frequencies cannot produce a 1910.95 average");
});

test("a single audiogram is MISSING_DATA, never 'no shift'", async () => {
  // There is nothing to compare against. Calling a baseline-only worker COMPLIANT is the single
  // easiest way to make a hearing conservation program look perfect on day one.
  const baselineOnly = await evaluate(bundle([{ date: "2026-05-01", right: ear(10), left: ear(10) }]));
  assert.equal(baselineOnly, "MISSING_DATA");
});

test("1910.95(g)(8)(ii): a professional non-occupational determination EXCLUDES the worker", async () => {
  // The chapeau switches off every follow-up action when a physician or audiologist determines the
  // shift is not work related. That is a genuine scope exclusion, not missing data — and it must
  // beat a present STS rather than being masked by it.
  const excluded = await evaluate(bundle([
    { date: "2020-05-01", right: ear(5), left: ear(5) },
    { date: "2026-05-01", right: ear(30), left: ear(5) },
  ], { notOccupational: true }));
  assert.equal(excluded, "EXCLUDED", "a determined non-occupational shift is out of scope");
});

test("a worker with no noise exposure is out of the initial population", async () => {
  // The denominator must not be "everyone with an audiogram" — that defines the cohort as the people
  // who already got tested, which is the population most likely to look compliant.
  const notExposed = await evaluate(bundle([
    { date: "2020-05-01", right: ear(5), left: ear(5) },
    { date: "2026-05-01", right: ear(30), left: ear(5) },
  ], { enrolled: false }));
  assert.equal(notExposed, "MISSING_DATA", "outside the hearing conservation cohort");
});

test("evidence carries the per-ear shifts, so a reviewer can audit the arithmetic", async () => {
  // A compliance product that reports a legal-sounding conclusion without the numbers behind it is
  // not auditable. The per-ear shift must be inspectable.
  const out = await run(bundle([
    { date: "2020-05-01", right: ear(5), left: ear(5) },
    { date: "2026-05-01", right: ear(20), left: ear(8) },
  ]));
  const defines = new Map(out.evidence.expressionResults.map((e) => [e.define, e.result]));
  assert.equal(defines.get("Right Ear Shift"), 15, "right ear shifted 15 dB");
  assert.equal(defines.get("Left Ear Shift"), 3, "left ear shifted 3 dB");
  assert.equal(defines.get("Standard Threshold Shift"), true);
  assert.equal(out.outcome, "OVERDUE");
});

test("a STALE non-occupational determination does not suppress a LATER shift (review, #408)", async () => {
  // The first cut asked only whether such a Condition existed, which made the exclusion permanent:
  // a worker excused for a 2019 shift had every later shift suppressed as EXCLUDED — including a
  // genuinely occupational one. That is silent UNDER-detection, which leaves a real hearing loss
  // unactioned. A determination recorded before the current audiogram cannot be about it.
  const stale = await evaluate(bundle([
    { date: "2018-05-01", right: ear(5), left: ear(5) },
    { date: "2026-05-01", right: ear(30), left: ear(5) },
  ], { notOccupational: "2019-01-01" }));
  assert.equal(stale, "OVERDUE", "a 2019 determination cannot excuse a 2026 shift");

  // The same determination dated WITH the current audiogram does exclude — proving the test above
  // fails for the date, not because exclusions stopped working altogether.
  const current = await evaluate(bundle([
    { date: "2018-05-01", right: ear(5), left: ear(5) },
    { date: "2026-05-01", right: ear(30), left: ear(5) },
  ], { notOccupational: "2026-05-01" }));
  assert.equal(current, "EXCLUDED");
});

test("an UNDATED determination does not exclude — it cannot be tied to a shift (review, #408)", async () => {
  // Treating an undated determination as applying would restore the permanence being fixed. The
  // worker reports OVERDUE and needs human review: the protective error rather than the silent one.
  const undated = await evaluate(bundle([
    { date: "2018-05-01", right: ear(5), left: ear(5) },
    { date: "2026-05-01", right: ear(30), left: ear(5) },
  ], { notOccupational: "" }));
  assert.equal(undated, "OVERDUE");
});

test("non-final threshold observations are ignored (review, #408)", async () => {
  // The baseline is the EARLIEST record, so one erroneous early row would silently re-anchor every
  // future shift for that worker. cms122.cql and the WebChart normalizer apply the same
  // final|amended|corrected gate.
  const erroneousBaseline = await evaluate(bundle([
    { date: "2015-01-01", right: ear(0), left: ear(0), status: "entered-in-error" },
    { date: "2020-05-01", right: ear(20), left: ear(20) },
    { date: "2026-05-01", right: ear(25), left: ear(20) },
  ]));
  assert.equal(
    erroneousBaseline,
    "COMPLIANT",
    "the entered-in-error row must not become the baseline — against the real 2020 baseline the shift is only 5 dB",
  );

  // Proof the case is not passing vacuously: the same row marked `final` DOES re-anchor the
  // baseline to 0 dB and produces a 25 dB shift.
  const ifItCounted = await evaluate(bundle([
    { date: "2015-01-01", right: ear(0), left: ear(0) },
    { date: "2020-05-01", right: ear(20), left: ear(20) },
    { date: "2026-05-01", right: ear(25), left: ear(20) },
  ]));
  assert.equal(ifItCounted, "OVERDUE", "with the early row counted, the same data is an STS");
});

test("an amended or corrected observation DOES count", async () => {
  for (const status of ["amended", "corrected"]) {
    const out = await evaluate(bundle([
      { date: "2020-05-01", right: ear(5), left: ear(5), status },
      { date: "2026-05-01", right: ear(25), left: ear(5) },
    ]));
    assert.equal(out, "OVERDUE", `${status} must be treated as clinically final`);
  }
});
