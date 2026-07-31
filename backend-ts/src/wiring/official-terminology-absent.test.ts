/**
 * A value set the ELM RETRIEVES that the artifact holds no codes for at all (ADR-053).
 *
 * ## The condition, and why it needed a name
 *
 * Three different terminology failures look similar from a distance and are not:
 *
 *   - **capped** — some of the codes. Recorded in the manifest by the vendor step, refused by
 *     `cappedExpansions`.
 *   - **empty** — none of the codes, for a set the artifact knows about. Refused by
 *     `expandArtifactTerminology`.
 *   - **absent** — no entry for the OID at all, because upstream's bundle ships no ValueSet resource
 *     for it. THIS file.
 *
 * Absent was invisible at vendor time (`collectTerminology` enumerates what a bundle SHIPS) and
 * mis-diagnosed at runtime: the expansion refusal says "N of M value sets could not be expanded", which
 * sends an operator at our sidecar, our pin and our fetch — none of which is the cause, and none of
 * which re-vendoring at the same pin can change. That misdiagnosis is on the record as ADR-047's
 * "value set …3.526.3.1278 will not expand", and it is the whole reason this exists: it changes no
 * routing DECISION, only what the operator is told.
 *
 * Measured: CMS138's libraries declare 32 value sets and its bundle carries 31.
 * `pnpm official:terminology-audit` reproduces that in one line, and all five VENDORED measures are
 * clean — which is exactly why the refusal must be tested against a stub. See the note on
 * `RoutingCheckDeps.absentFor`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { absentValueSets } from "./official-terminology.ts";
import { officialRoutingProblems } from "./executor-router.ts";
import type { OfficialArtifact } from "./official-artifacts.ts";
import { OFFICIAL_GATED_MEASURES } from "../standards/official-cases.ts";

const artifactStub = { manifest: { catalogId: "cmsX" } } as unknown as OfficialArtifact;
const loaded = (oids: string[]) =>
  () => ({ ok: true as const, codesByOid: new Map(oids.map((o) => [o, [{ system: "s", code: "c" }]])) });

test("absentValueSets: an OID the sidecar has no entry for is absent", () => {
  assert.deepEqual(absentValueSets(artifactStub, ["a", "b", "c"], loaded(["a", "c"])), ["b"]);
});

test("absentValueSets: an OID the sidecar HAS is not absent, however few codes it holds", () => {
  // The empty-expansion case belongs to `expandArtifactTerminology`, not here. Claiming it too would
  // produce two refusals for one problem and bury the one that names the real cause.
  const one = () => ({ ok: true as const, codesByOid: new Map([["a", []]]) });
  assert.deepEqual(absentValueSets(artifactStub, ["a"], one), []);
});

test("absentValueSets: de-duplicates, because two canonicals can collapse to one OID", () => {
  // `requiredOids` maps canonical URLs to bare OIDs, and a versioned and unversioned canonical for the
  // same set both land on the same OID. Reporting it twice makes a one-value-set problem read as two.
  assert.deepEqual(absentValueSets(artifactStub, ["b", "b", "b"], loaded([])), ["b"]);
});

test("absentValueSets: reports NOTHING when the terminology will not load", () => {
  // A missing sidecar is a different problem with its own sentence, already emitted by
  // `loadOfficialTerminology`. Listing every referenced OID as "absent" on top of it would bury the one
  // line an operator can act on under 26 lines they cannot.
  const broken = () => ({ ok: false as const, problem: "no sidecar" });
  assert.deepEqual(absentValueSets(artifactStub, ["a", "b"], broken), []);
});

test("officialRoutingProblems REFUSES a measure with an absent value set, and names the real cause", () => {
  // Stubbed non-empty deliberately: no vendored artifact has an absent value set (the one measure that
  // does is not vendored, precisely because it cannot run), so a test reading only `measures/official/`
  // would compare an empty list to an empty list forever and read as covering this.
  const id = [...OFFICIAL_GATED_MEASURES][0]!;
  const problems = officialRoutingProblems(
    { WORKWELL_OFFICIAL_MEASURES: id },
    {
      loadTerminology: () => ({ ok: true, codesByOid: new Map() }),
      cappedFor: () => [],
      absentFor: () => ["2.16.840.1.113883.3.526.3.1278"],
    },
  );
  const absent = problems.filter((p) => p.includes("2.16.840.1.113883.3.526.3.1278"));
  assert.equal(absent.length, 1, `expected exactly one absent-value-set problem, got: ${problems.join(" | ")}`);
  // The diagnosis is the entire point of this check existing, so it is asserted rather than assumed:
  // an operator must learn that re-vendoring at this pin cannot help.
  assert.match(absent[0]!, /upstream bundle ships no ValueSet resource/);
  assert.match(absent[0]!, /re-pinning will not fix it/);
  assert.match(absent[0]!, /--complete-terminology/);
});

test("officialRoutingProblems is CLEAN when nothing is absent — the refusal is not unconditional", () => {
  // The other half of the mutation. Without this, a check that always fired would pass the test above.
  const id = [...OFFICIAL_GATED_MEASURES][0]!;
  const problems = officialRoutingProblems(
    { WORKWELL_OFFICIAL_MEASURES: id },
    {
      loadTerminology: () => ({ ok: true, codesByOid: new Map() }),
      cappedFor: () => [],
      absentFor: () => [],
    },
  );
  assert.deepEqual(problems, []);
});
