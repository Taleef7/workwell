/**
 * The scorecard agrees with the two surfaces it summarises, through the real routes (#852).
 *
 *   node --import tsx --test src/routes/scorecard.maui.test.ts
 *
 * Each provider's cell must give the rate the attributed-list report gives for a list of exactly that
 * provider's patients on the same run, and its open-gap count must be what the work list totals for
 * `status=open&measureId&providerId&period=current`. Both are asserted on the pilot profile, over the
 * SQLite floor, with one population run of the current year.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const script = `
  import { createSqliteD1 } from "@mieweb/cloud-local";
  import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
  import { getStores } from "./src/stores/factory.ts";
  import { handleScorecard } from "./src/routes/scorecard.ts";
  import { handleSubjectLists } from "./src/routes/subject-lists.ts";
  import { handleCases } from "./src/routes/cases.ts";
  import { employees, providers } from "./src/config/deployment-profile.ts";
  import { bucketPeriodForMeasure } from "./src/run/compliance-period.ts";

  const db = await createSqliteD1(":memory:");
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
  const env = { DB: db };
  const stores = await getStores(env);
  const actor = "quality-lead@workwell.dev";
  const today = new Date().toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const measureId = "cms122";
  const period = bucketPeriodForMeasure(measureId, today);

  const run = await stores.runs.createRun({
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "test",
    requestedScope: {},
    measurementPeriodStart: year + "-01-01T00:00:00.000Z",
    measurementPeriodEnd: year + "-12-31T23:59:59.999Z",
    startedAt: today + "T00:00:00.000Z",
  });
  // A seeded scale run of the same year, NEWER and with different numbers: never selected.
  const scale = await stores.runs.createRun({
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "seed:scale",
    requestedScope: {},
    measurementPeriodStart: year + "-01-01T00:00:00.000Z",
    measurementPeriodEnd: year + "-12-31T23:59:59.999Z",
    startedAt: today + "T00:00:01.000Z",
  });

  const known = new Set(providers().map((p) => p.id));
  const byProvider = new Map();
  for (const e of employees()) {
    if (!known.has(e.providerId)) continue;
    byProvider.set(e.providerId, [...(byProvider.get(e.providerId) ?? []), e.externalId]);
  }
  // Every patient with a listed PCP is evaluated, so the open gaps run past the case store's default page
  // of 50; three providers are then compared one by one against a list of exactly their patients.
  const chosen = [...byProvider.entries()].filter(([, ids]) => ids.length >= 4).slice(0, 3);
  let n = 0;
  for (const [, ids] of byProvider) {
    for (const subjectId of ids) {
      n += 1;
      // CMS122 is inverse: in the numerator is the gap. One in seven is excluded, two in three a gap.
      const denex = n % 7 === 0;
      const numer = !denex && n % 3 !== 0;
      const evidence = {
        official: {
          populationResults: { ipp: true, denom: true, denex, numer, denexcep: false },
          measurementPeriod: { start: year + "-01-01T00:00:00.000Z", end: year + "-12-31T23:59:59.999Z" },
        },
      };
      const status = denex ? "EXCLUDED" : numer ? "OVERDUE" : "COMPLIANT";
      await stores.outcomes.recordOutcome({ runId: run.id, subjectId, measureId, evaluationPeriod: period, status, evidence });
      await stores.outcomes.recordOutcome({ runId: scale.id, subjectId, measureId, evaluationPeriod: period, status: "COMPLIANT",
        evidence: { official: { populationResults: { ipp: true, denom: true, denex: false, numer: false, denexcep: false } } } });
      await stores.cases.upsertFromOutcome({ runId: run.id, subjectId, measureId, evaluationPeriod: period, outcomeStatus: status, evidence });
      // Last cycle's gap, still open: the work list's current cycle leaves it out, so the scorecard must.
      if (n % 5 === 0) {
        await stores.cases.upsertFromOutcome({ runId: run.id, subjectId, measureId,
          evaluationPeriod: bucketPeriodForMeasure(measureId, (year - 1) + "-06-01"), outcomeStatus: "OVERDUE", evidence });
      }
    }
  }
  await stores.runs.finalizeRun(run.id, "COMPLETED");
  await stores.runs.finalizeRun(scale.id, "COMPLETED");

  const card = await (await handleScorecard(new Request("http://x/api/scorecard?measurementYear=" + year), env, actor)).json();
  const out = { year, card, perProvider: [] };
  for (const [providerId, ids] of chosen) {
    const created = await (await handleSubjectLists(new Request("http://x/api/subject-lists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "only " + providerId, identifiers: ids }),
    }), env, actor)).json();
    const report = await (await handleSubjectLists(
      new Request("http://x/api/subject-lists/" + created.list.id + "/report?measurementYear=" + year), env, actor)).json();
    const cases = await handleCases(new Request(
      "http://x/api/cases?status=open&measureId=" + measureId + "&providerId=" + providerId + "&period=current&limit=1"), env, actor);
    out.perProvider.push({
      providerId,
      listRates: report.measures.find((m) => m.measureId === measureId).rates,
      openTotal: Number(cases.headers.get("x-total-count")),
    });
  }
  const practice = await handleCases(new Request(
    "http://x/api/cases?status=open&measureId=" + measureId + "&period=current&limit=1"), env, actor);
  out.practiceOpen = Number(practice.headers.get("x-total-count"));
  console.log(JSON.stringify(out));
`;

test("each provider's cell equals the list report's rate for that provider's patients, and its open gaps equal the work list's count", () => {
  const out = runProfileChild("maui", script, {
    WORKWELL_MAUI_CORPUS_SIZE: "100",
    // Routed as the pilot stack routes it; no evaluation happens here, so no terminology is needed.
    WORKWELL_OFFICIAL_MEASURES: "cms122",
    WORKWELL_VSAC_API_KEY: undefined,
  });
  type Rate = { numer: number; denom: number; denex: number; denexcep: number; effectiveDenominator: number; score: number | null };
  type Row = { providerId: string | null; cells: Record<string, { rates: Rate[] | null; openGaps: number | null }> };
  const card = out.card as {
    measures: { measureId: string; state: string; runId: string }[];
    locations: { providers: Row[]; subtotal: Row }[];
    total: Row;
  };
  const perProvider = out.perProvider as { providerId: string; listRates: Rate[]; openTotal: number }[];
  assert.equal(perProvider.length, 3, "three providers with patients in the corpus");

  const column = card.measures.find((m) => m.measureId === "cms122")!;
  assert.equal(column.state, "complete");
  const rows = card.locations.flatMap((l) => l.providers);
  let gaps = 0;
  for (const p of perProvider) {
    const cell = rows.find((r) => r.providerId === p.providerId)!.cells.cms122!;
    const [mine] = cell.rates!;
    const [theirs] = p.listRates;
    for (const field of ["numer", "denom", "denex", "denexcep", "effectiveDenominator", "score"] as const) {
      assert.equal(mine![field], theirs![field], `${p.providerId} ${field}`);
    }
    assert.ok(p.openTotal > 0, "the fixture leaves each provider some open gaps");
    assert.equal(cell.openGaps, p.openTotal, `${p.providerId} open gaps`);
    gaps += p.openTotal;
  }
  // The practice total is the providers' patients counted again, and the seeded scale run (all compliant,
  // so a numerator of 0) was never the one read.
  const total = card.total.cells.cms122!;
  assert.ok((out.practiceOpen as number) > 50, "more open gaps than the case store's default page");
  assert.equal(total.openGaps, out.practiceOpen, "the practice's open gaps equal the work list's total");
  assert.ok(gaps < (out.practiceOpen as number));
  assert.ok(total.rates![0]!.numer > 0, "the seeded scale run (numerator 0) was never the one read");
});
