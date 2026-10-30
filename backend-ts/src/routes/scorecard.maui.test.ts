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

  const card = await (await handleScorecard(new Request("http://x/api/scorecard?measurementYear=" + year), env, actor, "ROLE_CASE_MANAGER", true)).json();
  const out = { year, card, perProvider: [] };

  // The clinician seat's card (#870), the refusals, and what each must not say.
  const ask = async (query, who, role, e = env, authEnforced = true) => {
    const res = await handleScorecard(new Request("http://x/api/scorecard?" + query), e, who, role, authEnforced);
    return { status: res.status, body: await res.json() };
  };
  const clinician = "clinician@maui.workwell.dev";
  out.mine = await ask("measurementYear=" + year, clinician, "ROLE_VIEWER");
  out.mineMe = await ask("measurementYear=" + year + "&panel=me", clinician, "ROLE_VIEWER");
  out.mineAll = await ask("measurementYear=" + year + "&panel=all", clinician, "ROLE_VIEWER");
  // Refused before any store is touched: every DB access throws, so reading one would fail the call.
  const noStores = { DB: new Proxy({}, { get() { throw new Error("a store was read"); } }) };
  out.unlinked = await ask("measurementYear=" + year, "quality-staff@maui.workwell.dev", "ROLE_VIEWER", noStores);
  out.unlinkedBadYear = await ask("measurementYear=20x6", "nobody@maui.workwell.dev", "ROLE_VIEWER", noStores);
  out.author = await ask("measurementYear=" + year, clinician, "ROLE_AUTHOR", noStores);
  // No role where sign-in is enforced is no one, never "auth is off".
  out.anonymous = await ask("measurementYear=" + year, "system", null, noStores);
  // Where auth is off there is no principal, and the card is the practice's, as before.
  out.authOff = await ask("measurementYear=" + year, "system", null, env, false);
  out.colleagues = providers().filter((p) => p.id !== "maui-prov-011").map((p) => ({ id: p.id, name: p.name }));
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

type Rate = { numer: number; denom: number; denex: number; denexcep: number; effectiveDenominator: number; score: number | null };
type Row = { providerId: string | null; name: string; cells: Record<string, { rates: Rate[] | null; openGaps: number | null }> };

// One child process for both tests: seeding a run of every patient is the slow part.
let fixture: Record<string, unknown> | undefined;
const seeded = () =>
  (fixture ??= runProfileChild("maui", script, {
    WORKWELL_MAUI_CORPUS_SIZE: "100",
    // Routed as the pilot stack routes it; no evaluation happens here, so no terminology is needed.
    WORKWELL_OFFICIAL_MEASURES: "cms122",
    WORKWELL_VSAC_API_KEY: undefined,
  }));

test("each provider's cell equals the list report's rate for that provider's patients, and its open gaps equal the work list's count", () => {
  const out = seeded();
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
  // The practice card carries no clinician scope.
  assert.equal("scope" in card, false);
});

test("a clinician seat reads its own provider's row and the practice total, and nothing of any colleague (#870)", () => {
  const out = seeded();
  type Card = {
    panel: { requested: string; ownsPanel: boolean };
    locations: unknown[];
    other: Row | null;
    total: Row;
    scope?: { providerId: string; name: string; location: string; row: Row };
  };
  type Answer = { status: number; body: Card & { error?: string; reason?: string } };
  const practice = out.card as Omit<Card, "locations"> & { locations: { providers: Row[] }[] };
  const mine = out.mine as Answer;
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.locations, [], "no location, so no subtotal of the colleagues");
  assert.equal(mine.body.other, null);
  assert.equal(mine.body.scope!.providerId, "maui-prov-011");
  assert.equal(mine.body.scope!.location, "Wailuku Clinic");

  // Their row is exactly the practice card's row for the same provider, and the total is the practice's.
  const theirs = practice.locations.flatMap((l) => l.providers).find((r) => r.providerId === "maui-prov-011");
  assert.ok(theirs, "the clinician's provider has patients in the fixture");
  assert.deepEqual(mine.body.scope!.row, theirs);
  assert.deepEqual(mine.body.total, practice.total);

  // `panel` is still a parameter, but neither value widens the card or trips the "both set" guard.
  const card = ({ body }: Answer) => ({ ...body, generatedAt: undefined });
  for (const variant of [out.mineMe, out.mineAll] as Answer[]) {
    assert.equal(variant.status, 200);
    assert.deepEqual(card(variant), card(mine));
  }

  // No colleague's id or name anywhere in the answer.
  const text = JSON.stringify(mine.body);
  for (const colleague of out.colleagues as { id: string; name: string }[]) {
    assert.equal(text.includes(colleague.id), false, `names ${colleague.id}`);
    assert.equal(text.includes(colleague.name), false, `names ${colleague.name}`);
  }

  // Refused before any store is read (the env's DB throws on access), whatever the parameters.
  for (const [label, refused] of [
    ["a viewer seat with no link", out.unlinked],
    ["an unknown account with a malformed year", out.unlinkedBadYear],
    ["a role that is neither practice nor viewer", out.author],
    ["no role at all where sign-in is enforced", out.anonymous],
  ] as const) {
    const answer = refused as Answer;
    assert.equal(answer.status, 403, label);
    assert.equal(answer.body.reason, "no_linked_provider", label);
  }
  const authOff = out.authOff as Answer;
  assert.equal(authOff.status, 200);
  assert.deepEqual({ ...authOff.body, generatedAt: undefined }, { ...practice, generatedAt: undefined }, "auth off reads the practice card");
});
