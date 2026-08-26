/**
 * #476 — pin population-membership derivation to the CQM IG's published formulas.
 *
 * Ruler: HL7 Quality Measure IG (`hl7.fhir.uv.cqm`) v1.0.0 - STU 1 (published 2025-09-11),
 * measure-conformance.html § "Subject-based Calculation", proportion scoring:
 *
 *   Denominator Membership = "Initial Population" and "Denominator"
 *                            and not "Denominator Exclusion"
 *                            and not ("Denominator Exception" and not "Numerator")
 *   Numerator Membership   = "Initial Population" and "Denominator"
 *                            and not "Denominator Exclusion"
 *                            and "Numerator" and not "Numerator Exclusion"
 *   Performance Rate       = |Numerator Membership| / |Denominator Membership|
 *
 * A future revision of those formulas should fail THIS file — the quotes above are the pin, so a
 * spec change is a visible diff here rather than silent drift (#476 acceptance criterion 2).
 *
 * Why these interactions matter and cannot be repaired downstream: the exporters compute the score
 * from MARGINAL counts (`numer / (denom - denex - denexcep)`), and marginal counts can only equal
 * the membership formulas if the per-subject flags already encode the interactions —
 *   - NUMER∧DENEX: a denominator-excluded subject is not a numerator member (the behaviour we
 *     measured in fqm-execution during the Cypress work — this is the spec text it comes from);
 *   - DENEXCEP∧NUMER: an exception is a safety valve for subjects who MISSED the target; a subject
 *     who met the numerator stays in the denominator, so counting their exception would remove them
 *     from the effective denominator while keeping them in the numerator — a >1.0 score;
 *   - NUMEX: removes an achieved numerator ("numerator-exclusion" in the fqm/FHIR population
 *     vocabulary) — previously unrecognized by the code map entirely, so a NUMEX'd subject kept
 *     their numerator and the rate was overstated.
 *
 * These clamps are SPEC APPLICATION, not corruption repair, so they are silent; the loud
 * `WORKWELL_ALERT` stays reserved for subset violations (numer/denex ⊄ denom ⊆ ipp), which no
 * spec formula produces and which indicate an unreadable writer.
 *
 *   node --import tsx --test src/fhir/cqm-membership-formulas.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countPopulations,
  officialMembership,
  buildSummaryMeasureReportFromCounts,
  type PopulationMembership,
} from "./measure-report.ts";
import type { RunRecord } from "../stores/run-store.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";

const run: RunRecord = {
  id: "run-cqm", status: "COMPLETED", scopeType: "MEASURE", scopeId: "mv-1", triggeredBy: "manual", site: null,
  requestedScope: { measureId: "cms122" }, startedAt: "2026-06-12T00:00:00.000Z", completedAt: "2026-06-12T00:05:00.000Z",
  measurementPeriodStart: "2025-06-12T00:00:00.000Z", measurementPeriodEnd: "2026-06-12T00:00:00.000Z",
  totalEvaluated: 0, error: null,
} as unknown as RunRecord;

/** An official-routed outcome whose evidence carries the given fqm-native population results. */
function officialOutcome(
  id: string,
  results: Array<{ populationType: string; result: boolean }>,
): OutcomeRecord {
  return {
    id, runId: "run-cqm", subjectId: id, measureVersionId: "mv-1", status: "COMPLIANT",
    evidence: { official: { populationResults: results } }, evaluatedAt: "2026-06-12T00:01:00.000Z",
  } as unknown as OutcomeRecord;
}

const entry = (populationType: string, result: boolean) => ({ populationType, result });

/** The IG formulas, computed independently from RAW flags — the oracle this file exists for. */
function igMembership(raw: { ipp: boolean; denom: boolean; denex?: boolean; denexcep?: boolean; numer?: boolean; numex?: boolean }) {
  const { ipp, denom } = raw;
  const denex = raw.denex === true, denexcep = raw.denexcep === true, numer = raw.numer === true, numex = raw.numex === true;
  const denominatorMembership = ipp && denom && !denex && !(denexcep && !numer);
  const numeratorMembership = ipp && denom && !denex && numer && !numex;
  return { denominatorMembership, numeratorMembership };
}

// ---------------------------------------------------------------------------
// Per-subject interactions, read back through `officialMembership` (fqm-native array shape)
// ---------------------------------------------------------------------------

test("NUMER and DENEX: a denominator-excluded subject is not a numerator member", () => {
  const m = officialMembership({
    official: {
      populationResults: [
        entry("initial-population", true), entry("denominator", true),
        entry("denominator-exclusion", true), entry("numerator", true),
      ],
    },
  });
  assert.ok(m);
  assert.equal(m.denex, true);
  assert.equal(m.numer, false, "Numerator Membership requires `not Denominator Exclusion`");
});

test("DENEXCEP and NUMER: a subject who met the numerator keeps denominator membership — the exception is not counted", () => {
  const m = officialMembership({
    official: {
      populationResults: [
        entry("initial-population", true), entry("denominator", true),
        entry("denominator-exception", true), entry("numerator", true),
      ],
    },
  });
  assert.ok(m);
  assert.equal(m.numer, true);
  assert.equal(m.denom, true);
  assert.equal(
    m.denexcep, false,
    "Denominator Membership excludes only `Denominator Exception and not Numerator` — counting this exception would remove a numerator member from the effective denominator",
  );
});

test("DENEXCEP without NUMER: the exception counts and removes the subject from the effective denominator", () => {
  const m = officialMembership({
    official: {
      populationResults: [
        entry("initial-population", true), entry("denominator", true),
        entry("denominator-exception", true), entry("numerator", false),
      ],
    },
  });
  assert.ok(m);
  assert.equal(m.denexcep, true);
  assert.equal(m.numer, false);
});

test("NUMEX: `numerator-exclusion` is recognized and removes an achieved numerator", () => {
  const m = officialMembership({
    official: {
      populationResults: [
        entry("initial-population", true), entry("denominator", true),
        entry("numerator", true), entry("numerator-exclusion", true),
      ],
    },
  });
  assert.ok(m, "a results array containing numerator-exclusion must still be readable");
  assert.equal(m.numer, false, "Numerator Membership requires `not Numerator Exclusion`");
  assert.equal(m.denom, true, "NUMEX removes from the numerator only, never the denominator");
});

test("DENEXCEP and NUMER and NUMEX: the RAW numerator negates the exception — the subject stays a scored denominator failure", () => {
  // The IG's Denominator Membership negates the exception on the raw "Numerator" criteria result;
  // NUMEX applies only inside Numerator Membership. So a subject with all three flags is IN the
  // denominator (met the criteria, so the exception is void) and OUT of the numerator (excluded) —
  // a scored failure. Folding denexcep against the NUMEX-adjusted numerator instead would remove
  // them from the effective denominator, diverging from the pinned formula (#484 review, finding 1).
  const m = officialMembership({
    official: {
      populationResults: [
        entry("initial-population", true), entry("denominator", true),
        entry("denominator-exception", true), entry("numerator", true), entry("numerator-exclusion", true),
      ],
    },
  });
  assert.ok(m);
  assert.equal(m.numer, false, "NUMEX removes the numerator");
  assert.equal(m.denexcep, false, "the raw numerator voids the exception — Denominator Membership stays true");
  assert.equal(m.denom, true);
});

test("DENEX and DENEXCEP: exclusion wins; the exception is not also counted", () => {
  // Denominator Membership is already false via DENEX. The exception flag must not ALSO survive
  // into the marginal counts, or `denom - denex - denexcep` double-subtracts this subject.
  const m = officialMembership({
    official: {
      populationResults: [
        entry("initial-population", true), entry("denominator", true),
        entry("denominator-exclusion", true), entry("denominator-exception", true),
      ],
    },
  });
  assert.ok(m);
  assert.equal(m.denex, true);
  assert.equal(m.denexcep, false);
});

test("keyed-object evidence applies the same formulas (numex accepted as an optional key)", () => {
  const withNumex = officialMembership({
    official: { populationResults: { ipp: true, denom: true, denex: false, numer: true, numex: true } },
  });
  assert.ok(withNumex);
  assert.equal(withNumex.numer, false);

  const denexcepAndNumer = officialMembership({
    official: { populationResults: { ipp: true, denom: true, denex: false, numer: true, denexcep: true } },
  });
  assert.ok(denexcepAndNumer);
  assert.equal(denexcepAndNumer.numer, true);
  assert.equal(denexcepAndNumer.denexcep, false);
});

// ---------------------------------------------------------------------------
// The marginal-count arithmetic equals the membership formulas over a mixed cohort
// ---------------------------------------------------------------------------

test("performance rate over a mixed cohort equals |Numerator Membership| / |Denominator Membership| — including the case the old arithmetic scored above 1.0", () => {
  // One subject per interaction row. RAW flags — the writer (fqm) may or may not have applied the
  // interactions itself; the reader must not depend on it.
  const cohort: Array<{ id: string; raw: { ipp: boolean; denom: boolean; denex?: boolean; denexcep?: boolean; numer?: boolean; numex?: boolean } }> = [
    { id: "plain-numer", raw: { ipp: true, denom: true, numer: true } },
    { id: "plain-miss", raw: { ipp: true, denom: true } },
    { id: "denex", raw: { ipp: true, denom: true, denex: true } },
    { id: "denex-and-numer", raw: { ipp: true, denom: true, denex: true, numer: true } },
    { id: "denexcep-only", raw: { ipp: true, denom: true, denexcep: true } },
    { id: "denexcep-and-numer", raw: { ipp: true, denom: true, denexcep: true, numer: true } },
    { id: "numex", raw: { ipp: true, denom: true, numer: true, numex: true } },
    { id: "out-of-ipp", raw: { ipp: false, denom: false } },
  ];
  const outcomes = cohort.map(({ id, raw }) =>
    officialOutcome(id, [
      entry("initial-population", raw.ipp), entry("denominator", raw.denom),
      entry("denominator-exclusion", raw.denex === true), entry("denominator-exception", raw.denexcep === true),
      entry("numerator", raw.numer === true), entry("numerator-exclusion", raw.numex === true),
    ]),
  );

  // The oracle: the IG formulas applied per subject, independently of the production code path.
  const denomMembers = cohort.filter((s) => igMembership(s.raw).denominatorMembership).length;
  const numerMembers = cohort.filter((s) => igMembership(s.raw).numeratorMembership).length;
  assert.equal(denomMembers, 4, "self-check: plain-numer, plain-miss, denexcep-and-numer, numex");
  assert.equal(numerMembers, 2, "self-check: plain-numer, denexcep-and-numer");

  const counts = countPopulations(outcomes, "cms122");
  // Marginal counts still report the populations as evaluated (DENOM includes DENEX'd subjects —
  // the Cypress-verified reconciliation contract) …
  assert.equal(counts.ipp, 7);
  assert.equal(counts.denom, 7);
  assert.equal(counts.denex, 2);
  // … while the interaction-normalized flags make the score arithmetic EQUAL the membership rate:
  assert.equal(counts.denom - counts.denex - counts.denexcep, denomMembers);
  assert.equal(counts.numer, numerMembers);

  const report = buildSummaryMeasureReportFromCounts(run, "cms122", counts, "2026-06-12T00:06:00.000Z");
  const score = report.group[0]?.measureScore;
  assert.ok(score);
  assert.equal(score.value, numerMembers / denomMembers);
  assert.ok(score.value <= 1, "a proportion score can never exceed 1.0");
});

test("EXHAUSTIVE: every one of the 64 raw flag combinations reduces to the IG formulas exactly", () => {
  // The cohort above is readable; this is the proof. For every raw vector — subset-violating ones
  // included, which the clamps repair before the folds — the normalized flags must satisfy
  // `denom − denex − denexcep = Denominator Membership` and `numer = Numerator Membership`
  // per subject, which is what makes the exporters' marginal arithmetic exact by construction.
  const originalError = console.error;
  console.error = () => {}; // subset-violating vectors alert by design; not this test's subject
  try {
    for (let bits = 0; bits < 64; bits++) {
      const raw = {
        ipp: (bits & 1) !== 0, denom: (bits & 2) !== 0, denex: (bits & 4) !== 0,
        denexcep: (bits & 8) !== 0, numer: (bits & 16) !== 0, numex: (bits & 32) !== 0,
      };
      const m = officialMembership({
        official: {
          populationResults: [
            entry("initial-population", raw.ipp), entry("denominator", raw.denom),
            entry("denominator-exclusion", raw.denex), entry("denominator-exception", raw.denexcep),
            entry("numerator", raw.numer), entry("numerator-exclusion", raw.numex),
          ],
        },
      });
      assert.ok(m, `combo ${bits} must be readable`);
      // The oracle applies the formulas to the CLAMPED subset flags — the IG formulas presuppose a
      // writer whose populations nest; the clamps restore that before the folds apply.
      const clamped = {
        ipp: raw.ipp, denom: raw.denom && raw.ipp,
        denex: raw.denex && raw.denom && raw.ipp, denexcep: raw.denexcep && raw.denom && raw.ipp,
        numer: raw.numer && raw.denom && raw.ipp, numex: raw.numex,
      };
      const ig = igMembership(clamped);
      const effectiveDenominator = (m.denom ? 1 : 0) - (m.denex ? 1 : 0) - (m.denexcep ? 1 : 0);
      assert.equal(
        effectiveDenominator, ig.denominatorMembership ? 1 : 0,
        `combo ${bits} (${JSON.stringify(raw)}): denom − denex − denexcep must equal Denominator Membership`,
      );
      assert.equal(
        m.numer, ig.numeratorMembership,
        `combo ${bits} (${JSON.stringify(raw)}): numer must equal Numerator Membership`,
      );
    }
  } finally {
    console.error = originalError;
  }
});

test("a results array recognizing ONLY numerator-exclusion is an unreadable writer — alert and null, not a valid all-false vector", () => {
  // NUMEX is a modifier of the numerator, not a membership population. A vector naming it and none
  // of the required populations used to fall back to the status rule (recognized === 0) and must
  // keep doing so (#484 review, finding 4).
  const alerts: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { alerts.push(String(args[0])); };
  try {
    const m = officialMembership({
      official: { populationResults: [entry("numerator-exclusion", true)] },
    });
    assert.equal(m, null);
    assert.equal(alerts.filter((a) => a.includes("WORKWELL_ALERT")).length, 1);
  } finally {
    console.error = originalError;
  }
});

// ---------------------------------------------------------------------------
// The spec clamps are silent; the subset-violation alert still fires
// ---------------------------------------------------------------------------

test("interaction clamps are silent; subset violations still alert", () => {
  const alerts: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { alerts.push(String(args[0])); };
  try {
    // Spec application — not corruption: no alert.
    officialMembership({
      official: {
        populationResults: [
          entry("initial-population", true), entry("denominator", true),
          entry("denominator-exception", true), entry("numerator", true),
        ],
      },
    });
    assert.equal(alerts.filter((a) => a.includes("WORKWELL_ALERT")).length, 0, "spec clamps must not alert");

    // Corruption — numer outside denom: alert.
    officialMembership({
      official: {
        populationResults: [
          entry("initial-population", true), entry("denominator", false), entry("numerator", true),
        ],
      },
    });
    assert.equal(alerts.filter((a) => a.includes("WORKWELL_ALERT")).length, 1, "subset violations must still alert");
  } finally {
    console.error = originalError;
  }
});

// Keep the type import load-bearing so a rename of the membership shape shows up here.
// (Enforced by `pnpm typecheck`, not by the tsx test run — tsx strips types without checking.)
const _shape: PopulationMembership = { ipp: true, denom: true, denex: false, numer: false, denexcep: false };
void _shape;
