/**
 * The panel filters (spec §5). One predicate, four surfaces — so these test the predicate directly and
 * the surfaces test that they call it.
 *
 * The failure mode worth naming: a filter that silently matches EVERYONE looks exactly like a working
 * filter. The roster still renders, the count is plausible, and the only way to notice is to know how
 * many patients that PCP actually has. Every test below therefore checks both that the right rows come
 * back and that the wrong ones do not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ageAsOf, ageBandOf, matchesSubjectFilters, subjectFiltersFromQuery, subjectFilterErrorBody, AGE_BANDS, SubjectFilterError,
} from "./subject-filters.ts";
import { corpusDirectory } from "../engine/synthetic/corpus/corpus-directory.ts";
import { DEFAULT_CORPUS_SEED } from "../engine/synthetic/corpus/corpus-parameters.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";

const ROSTER = corpusDirectory(DEFAULT_CORPUS_SEED, 2000).EMPLOYEES;
const NOW = Date.parse("2027-06-15T00:00:00.000Z");

test("ageAsOf is whole years in UTC, and the birthday boundary is exact", () => {
  assert.equal(ageAsOf("1970-06-15", Date.parse("2027-06-15T00:00:00Z")), 57, "on the birthday");
  assert.equal(ageAsOf("1970-06-16", Date.parse("2027-06-15T23:59:59Z")), 56, "the day before");
  assert.equal(ageAsOf("1970-01-01", Date.parse("2027-12-31T23:59:59Z")), 57);
  assert.equal(ageAsOf("not-a-date", NOW), null);
});

test("the age bands partition every age with no gap and no overlap", () => {
  // A band table is the kind of thing that acquires an off-by-one at a boundary and loses exactly the
  // patients on it — 17/18, 44/45, 64/65 are where a measure's eligibility usually turns.
  const seen = new Map<string, number[]>();
  for (let age = 0; age <= 120; age += 1) {
    const band = ageBandOf(age);
    assert.ok((AGE_BANDS as readonly string[]).includes(band), `age ${age} produced ${band}`);
    (seen.get(band) ?? seen.set(band, []).get(band)!).push(age);
  }
  assert.deepEqual([...seen.keys()].sort(), [...AGE_BANDS].sort(), "every band is reachable");
  assert.equal(ageBandOf(17), "0-17");
  assert.equal(ageBandOf(18), "18-44");
  assert.equal(ageBandOf(44), "18-44");
  assert.equal(ageBandOf(45), "45-64");
  assert.equal(ageBandOf(64), "45-64");
  assert.equal(ageBandOf(65), "65+");
});

test("no active filter matches everyone; an unresolvable subject matches nothing", () => {
  const someone = ROSTER[0]!;
  assert.equal(matchesSubjectFilters(someone, {}, NOW), true);
  assert.equal(matchesSubjectFilters(null, {}, NOW), true, "no filter is not a constraint, even with no subject");
  // An id the directory cannot resolve must not read as "matches everything" the moment a filter is on.
  assert.equal(matchesSubjectFilters(null, { providerId: "maui-prov-001" }, NOW), false);
});

test("providerId matches the PCP external id and NOT a display name", () => {
  const target = ROSTER.find((e) => e.providerId === "maui-prov-012")!;
  assert.ok(target, "the fixture roster must contain this PCP's panel");
  assert.equal(matchesSubjectFilters(target, { providerId: "maui-prov-012" }, NOW), true);
  assert.equal(matchesSubjectFilters(target, { providerId: "Dr. Aven Stone" }, NOW), false, "a display name matches nothing");

  const matched = ROSTER.filter((e) => matchesSubjectFilters(e, { providerId: "maui-prov-012" }, NOW));
  assert.ok(matched.length > 0);
  assert.ok(matched.length < ROSTER.length, "a filter that matches the whole roster is not a filter");
  assert.ok(matched.every((e) => e.providerId === "maui-prov-012"));
});

test("an unknown providerId returns nothing, not everything", () => {
  // The leak direction. Returning the unfiltered roster for an id that does not exist is the failure
  // that looks like success — a full page of patients under somebody else's name.
  assert.deepEqual(ROSTER.filter((e) => matchesSubjectFilters(e, { providerId: "maui-prov-999" }, NOW)), []);
});

test("ageBand is derived from dateOfBirth, and the bands partition the roster exactly", () => {
  const counted = new Map<string, number>();
  for (const band of AGE_BANDS) {
    const rows = ROSTER.filter((e) => matchesSubjectFilters(e, { ageBand: band }, NOW));
    assert.ok(rows.every((e) => ageBandOf(ageAsOf(e.dateOfBirth!, NOW)!) === band), band);
    counted.set(band, rows.length);
  }
  // The parts sum to the whole: a band that silently dropped patients, or one that double-counted
  // them, is invisible in any single band's assertion.
  assert.equal([...counted.values()].reduce((a, b) => a + b, 0), ROSTER.length, `bands: ${JSON.stringify([...counted])}`);
  assert.ok((counted.get("65+") ?? 0) > 0 && (counted.get("45-64") ?? 0) > 0, "the corpus reaches the bands the ACO measures use");
});

test("sex filters F and M, and a roster that records none matches NOTHING", () => {
  const females = ROSTER.filter((e) => matchesSubjectFilters(e, { sex: "F" }, NOW));
  const males = ROSTER.filter((e) => matchesSubjectFilters(e, { sex: "M" }, NOW));
  assert.equal(females.length + males.length, ROSTER.length, "F and M partition the corpus");
  assert.ok(females.length > 0 && males.length > 0);
  assert.ok(females.every((e) => e.sex === "F"));

  // The occupational directory carries no `sex`. Matching everybody there would be a filter that reads
  // as working and silently is not.
  const noSex: EmployeeProfile = { ...ROSTER[0]!, sex: undefined };
  assert.equal(matchesSubjectFilters(noSex, { sex: "F" }, NOW), false);
  assert.equal(matchesSubjectFilters(noSex, { sex: "M" }, NOW), false);
});

test("the filters COMPOSE — each one narrows further, and together they are the intersection", () => {
  const provider = ROSTER[500]!.providerId;
  const combined = { providerId: provider, ageBand: "65+" as const, sex: "F" as const };
  const rows = ROSTER.filter((e) => matchesSubjectFilters(e, combined, NOW));
  for (const e of rows) {
    assert.equal(e.providerId, provider);
    assert.equal(e.sex, "F");
    assert.equal(ageBandOf(ageAsOf(e.dateOfBirth!, NOW)!), "65+");
  }
  const byProviderOnly = ROSTER.filter((e) => matchesSubjectFilters(e, { providerId: provider }, NOW));
  assert.ok(rows.length <= byProviderOnly.length, "adding filters can only narrow");
  assert.ok(rows.length < byProviderOnly.length, "and here it does — otherwise this test proves nothing");
});

test("an unrecognised filter token is REFUSED — never dropped into the unfiltered roster", () => {
  // The first version dropped `?ageBand=old` and served everybody, reasoning that an empty page was the
  // worse failure. It is the other way round: a work list that silently ignored its filter looks exactly
  // like one that applied it, and a staff member asking for the 65+ panel would have called the whole
  // practice. A 400 naming the accepted values is a visible failure; the whole roster is an invisible
  // wrong answer.
  assert.throws(
    () => subjectFiltersFromQuery(new URLSearchParams("ageBand=old")),
    (error: unknown) => error instanceof SubjectFilterError && error.parameter === "ageBand" && /0-17, 18-44, 45-64, 65\+/.test(error.message) && /"old"/.test(error.message),
  );
  assert.throws(
    () => subjectFiltersFromQuery(new URLSearchParams("sex=yes")),
    (error: unknown) => error instanceof SubjectFilterError && error.parameter === "sex" && /F, M/.test(error.message),
  );
  // A blank token is an ABSENT filter, not a bad one — a cleared select sends `ageBand=`.
  assert.deepEqual(subjectFiltersFromQuery(new URLSearchParams("ageBand=&sex=&providerId=")), { providerId: null, ageBand: null, sex: null });

  const good = subjectFiltersFromQuery(new URLSearchParams("ageBand=65%2B&sex=f&providerId=%20maui-prov-003%20"));
  assert.deepEqual(good, { providerId: "maui-prov-003", ageBand: "65+", sex: "F" }, "trimmed, and sex is case-insensitive");

  // The predicate is the backstop for a caller that bypasses the parser: a junk token matches NOBODY
  // (an empty list, visible) rather than everybody (the whole roster, invisible).
  assert.equal(ROSTER.filter((e) => matchesSubjectFilters(e, { ageBand: "old" }, NOW)).length, 0);
  assert.equal(ROSTER.filter((e) => matchesSubjectFilters(e, { sex: "yes" }, NOW)).length, 0);
  const body = subjectFilterErrorBody(new SubjectFilterError("ageBand", "old"));
  assert.equal(body.error, "invalid_request");
  assert.equal(body.parameter, "ageBand");
});
