/**
 * Which logics scored a run's rows, and when they conflict (#769): the aggregate the programs card reads,
 * and `scoringOfRows`, the rule the run reconciliation and the run packet apply to the same rows.
 *   node --import tsx --test src/fhir/run-aggregate.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateOfficialRun, scoringOfRows } from "./run-aggregate.ts";
import { formatScoringLogic } from "../measure/measure-identity.ts";

const POPULATIONS = { ipp: true, denom: true, numer: false, denex: false, denexcep: false };
const Y2026 = { start: "2026-01-01", end: "2026-12-31" };
const CMS125 = { ecqmId: "125FHIR", version: "1.0.000", engine: "fqm-execution", artifactSha256: "sha256:97f737fa5262fca1fbb4620e10ce286f612b87b7de4c3fc06fdfe38dfb666ac8" };
const TRANSLATION = { kind: "derived", label: "WorkWell translation of CMS137v15", url: "urn:workwell:measure:cms137:translation", derivedFrom: "CMS137v15", ecqmId: null, version: "ww-2027.1" };
const ERRORED = { evaluationError: "CQL engine failure", message: "x" };
const AUTHORED = { expressionResults: [{ define: "Outcome Status", result: "OVERDUE" }] };

const storeOf = (evidences: unknown[]) => ({
  listOutcomeMembershipsForRun: async () => evidences.map((evidence) => ({ status: "OVERDUE", evidence })),
});
const names = (logics: Parameters<typeof formatScoringLogic>[0][]) => logics.map(formatScoringLogic);

test("aggregateOfficialRun names each distinct identity once, not once per row", async () => {
  // A getter on a key only the naming step reads for a CMS row (`label`): every read is one naming of a
  // row. Thousands of rows that share one identity must be named once.
  let namings = 0;
  const row = () => {
    const official: Record<string, unknown> = { ...CMS125, measurementPeriod: Y2026, populationResults: POPULATIONS };
    Object.defineProperty(official, "label", { get: () => (namings++, undefined), enumerable: false });
    return { official };
  };
  const aggregate = await aggregateOfficialRun(storeOf(Array.from({ length: 2000 }, row)), "run-1", "cms125");
  assert.deepEqual(names(aggregate.scoringLogics), ["CMS125FHIR v1.0.000"]);
  // Once in the row walk, once more when the final sorted list is built from the kept evidence.
  assert.equal(namings, 2, "the 2,000 rows share one identity, so it is named once in the walk");
});

test("the naming memo is no coarser than the logic: two versions with no digest are still two logics", async () => {
  // The exporters' identity key (kind, digest, period) cannot tell these apart — rows recorded before the
  // digest was — so a memo keyed on it alone would name the second version with the first.
  const v1 = { official: { ecqmId: "125FHIR", version: "1.0.000", measurementPeriod: Y2026, populationResults: POPULATIONS } };
  const v0 = { official: { ecqmId: "125FHIR", version: "0.9.000", measurementPeriod: Y2026, populationResults: POPULATIONS } };
  const aggregate = await aggregateOfficialRun(storeOf([v1, v0, v1, v0]), "run-2", "cms125");
  assert.deepEqual(names(aggregate.scoringLogics), ["CMS125FHIR v0.9.000", "CMS125FHIR v1.0.000"]);
  assert.equal(aggregate.identityConflict, false, "the coarser key agrees, which is why the names have to be counted too");
});

test("scoringOfRows: one logic, two logics, authored beside named, errored rows skipped", () => {
  const one = scoringOfRows([{ official: CMS125 }, { official: CMS125 }, ERRORED]);
  assert.deepEqual(names(one.logics), ["CMS125FHIR v1.0.000"]);
  assert.equal(one.conflict, false, "an errored row was scored by nothing, so it is no second logic");

  const two = scoringOfRows([{ official: CMS125 }, { official: TRANSLATION }]);
  assert.deepEqual(names(two.logics), ["CMS125FHIR v1.0.000", "WorkWell translation of CMS137v15 (ww-2027.1)"]);
  assert.equal(two.conflict, true);

  const authoredBeside = scoringOfRows([{ official: CMS125 }, AUTHORED]);
  assert.deepEqual(names(authoredBeside.logics), ["CMS125FHIR v1.0.000"], "the authored row has no name to list");
  assert.equal(authoredBeside.conflict, true, "but it was scored by another logic");
  // The reconciliation's store rows spell an authored row as `official: null`.
  assert.equal(scoringOfRows([{ official: CMS125 }, { official: null }]).conflict, true);

  const authoredOnly = scoringOfRows([AUTHORED, AUTHORED, { official: null }]);
  assert.deepEqual(authoredOnly, { logics: [], conflict: false });

  const twoPeriods = scoringOfRows([{ official: { ...CMS125, measurementPeriod: Y2026 } }, { official: { ...CMS125, measurementPeriod: { start: "2027-01-01", end: "2027-12-31" } } }]);
  assert.equal(twoPeriods.conflict, true, "one artifact over two years is two answers");

  assert.deepEqual(scoringOfRows([]), { logics: [], conflict: false });
});
