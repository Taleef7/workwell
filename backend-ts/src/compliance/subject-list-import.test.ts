/**
 * The attributed-list import's rules, tested where each one can actually fail.
 *
 *   node --import tsx --test src/compliance/subject-list-import.test.ts
 *
 * Two of these are invisible from a route test on the Maui profile — the fabricating-lookup guard and
 * the alias collapse — and one (the namespace gate admitting `pat-001`) is the kind of off-by-a-digit
 * that a fixture built from generated ids alone would never reach. That is why the logic is pure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SANDBOX_IDENTIFIER_PATTERNS,
  MAX_IDENTIFIERS,
  countMembers,
  countOutsideSandboxNamespace,
  parseIdentifierArray,
  parseIdentifierText,
  payerBreakdown,
  resolveMembers,
  sandboxIdentifierPattern,
} from "./subject-list-import.ts";

const ok = <T,>(r: { ok: true; value: T } | { ok: false; failure: unknown }): T => {
  assert.equal(r.ok, true, `expected a parse, got ${JSON.stringify(r)}`);
  return (r as { ok: true; value: T }).value;
};
const failure = (r: { ok: boolean; failure?: unknown }): { message?: string; parameter?: string; error?: string } => {
  assert.equal(r.ok, false, "expected a refusal");
  return (r as { failure: { message?: string; parameter?: string; error?: string } }).failure;
};

test("the sandbox namespace admits BOTH corpus spellings — the 48 fixtures and the generated rest", () => {
  // The fixture prefix is three digits (pat-001) and the generated corpus is five (pat-00049). A gate
  // written for the generated form alone would refuse the first 48 real patients in the sandbox: a
  // control that rejects exactly the data it exists to admit.
  const maui = sandboxIdentifierPattern("maui");
  assert.ok(maui.test("pat-001"), "the first fixture patient conforms");
  assert.ok(maui.test("pat-048"), "the last fixture patient conforms");
  assert.ok(maui.test("pat-00049"), "the first generated patient conforms");
  assert.ok(maui.test("pat-20000"), "the last generated patient conforms");
  // A namespace test, not an existence test: a conforming id that nobody has is NOT_FOUND, so the
  // review queue is exercised with synthetic-shaped identifiers rather than being unreachable.
  assert.ok(maui.test("pat-99999"));
});

test("the DEFAULT profile has its own namespace — the occupational roster is emp-NNN, not pat-", () => {
  // One hardcoded pattern would have refused every legitimate identifier on the TWH deployment while
  // reading as a working gate. The two profiles are different synthetic rosters; the gate's job on
  // each is the same one.
  const dflt = sandboxIdentifierPattern("default");
  assert.ok(dflt.test("emp-001"));
  assert.ok(dflt.test("emp-00150"));
  assert.equal(dflt.test("pat-001"), false, "a corpus id is outside the occupational namespace");
  assert.equal(sandboxIdentifierPattern("twh"), SANDBOX_IDENTIFIER_PATTERNS.default, "an unknown profile is not Maui");
});

test("the sandbox namespace refuses the shapes a REAL attribution file carries", () => {
  const maui = sandboxIdentifierPattern("maui");
  const outside = ["emp-001", "MRN-40182", "1EG4-TE5-MK73", "Ari Wren", "pat-", "pat-abcde", "wc|991", "PAT-00001"];
  for (const id of outside) assert.equal(maui.test(id), false, `${id} must not conform`);
  assert.equal(countOutsideSandboxNamespace(["pat-001", ...outside], maui), outside.length);
  assert.equal(countOutsideSandboxNamespace(["pat-001", "pat-00049"], maui), 0);
});

test("one identifier per line: CRLF and a BOM are the operator's file, not the operator's mistake", () => {
  const parsed = ok(parseIdentifierText("\uFEFFpat-001\r\npat-002\r\n\r\n  pat-003  \r\n"));
  assert.deepEqual(parsed.identifiers, ["pat-001", "pat-002", "pat-003"]);
  assert.equal(parsed.duplicatesDropped, 0);
});

test("a line with a comma is REFUSED with its line number, rather than parsed as a column", () => {
  // A file with columns needs a column choice, and getting it wrong imports the wrong field silently:
  // 50,000 NOT_FOUND rows that read as a matching failure when they are a parsing one.
  const f = failure(parseIdentifierText("pat-001\npat-002,Ari Wren\n"));
  assert.equal(f.parameter, "identifiers");
  assert.match(f.message!, /line 2/);
});

test("duplicates are dropped and COUNTED, because the operator's file said something", () => {
  // The count is reported back: a file with 200 duplicates is a fact about the ACO's export, and
  // silently collapsing it would leave the operator wondering why 4,800 became 4,600.
  const parsed = ok(parseIdentifierText("pat-001\npat-002\npat-001\n pat-002 \n"));
  assert.deepEqual(parsed.identifiers, ["pat-001", "pat-002"]);
  assert.equal(parsed.duplicatesDropped, 2);
});

test("an empty upload and an over-cap upload are both refused", () => {
  assert.match(failure(parseIdentifierText("\n  \n\n")).message!, /at least one/);
  const tooMany = Array.from({ length: MAX_IDENTIFIERS + 1 }, (_, i) => `pat-${String(i).padStart(5, "0")}`);
  assert.match(failure(parseIdentifierArray(tooMany)).message!, /at most 50000/);
});

test("a non-string identifier is refused, never coerced", () => {
  // `String(12345)` would invent an identifier the file never carried — and a bare number in an
  // attribution column is exactly where a leading zero has already been lost.
  assert.match(failure(parseIdentifierArray(["pat-001", 12345])).message!, /must be a string/);
  assert.match(failure(parseIdentifierArray("pat-001")).message!, /must be an array/);
});

test("an over-long identifier is refused by the validator, matching the column's own CHECK", () => {
  assert.match(failure(parseIdentifierText(`${"x".repeat(129)}\n`)).message!, /128 characters/);
  assert.equal(ok(parseIdentifierText(`${"x".repeat(128)}\n`)).identifiers.length, 1);
});

test("resolution never consults a lookup that FABRICATES a profile for anything it is asked", () => {
  // The live directory's employeeById returns a minimal profile for any `wc|`-prefixed string, so a
  // resolver built on it would auto-match identifiers that exist nowhere — every row MATCHED, every
  // denominator wrong, and nothing to see. The caller passes a lookup over the enumerated members;
  // this pins that the function uses what it is given and nothing else.
  const fabricating = (raw: string) => `${raw}-invented`;
  let consulted = 0;
  const enumeratedOnly = (raw: string) => {
    consulted += 1;
    return raw === "pat-001" ? "pat-001" : null;
  };
  const members = resolveMembers(["pat-001", "wc|991"], enumeratedOnly);
  assert.equal(consulted, 2);
  assert.deepEqual(members.map((m) => m.resolution), ["MATCHED", "NOT_FOUND"]);
  assert.notEqual(members[1]!.subjectId, fabricating("wc|991"));
  assert.equal(members[1]!.subjectId, null);
});

test("two identifiers for ONE subject land MATCHED + AMBIGUOUS, never twice-matched", () => {
  // Unreachable under today's exact-id matching, and written anyway: this is the seam the identifier
  // format changes at (name+DOB, MBI), and a collapse discovered later would silently double a
  // patient in every denominator the list feeds. The partial unique index is the second line.
  const members = resolveMembers(["pat-001", "MRN-1", "MRN-2"], () => "pat-001");
  assert.deepEqual(members.map((m) => m.resolution), ["MATCHED", "AMBIGUOUS", "AMBIGUOUS"]);
  assert.deepEqual(members.map((m) => m.subjectId), ["pat-001", null, null]);
  // AMBIGUOUS is not an error and not a drop: the raw identifier survives for the review queue.
  assert.deepEqual(members.map((m) => m.rawIdentifier), ["pat-001", "MRN-1", "MRN-2"]);
});

test("the counts reconcile with the members, and carry the duplicates the parse dropped", () => {
  const members = resolveMembers(["a", "b", "c", "d"], (raw) => (raw === "a" ? "s1" : raw === "b" ? "s1" : null));
  const counts = countMembers(members, 3);
  assert.deepEqual(counts, { total: 4, matched: 1, notFound: 2, ambiguous: 1, duplicatesDropped: 3 });
  assert.equal(counts.matched + counts.notFound + counts.ambiguous, counts.total);
});

test("the payer breakdown counts MATCHED members only, and omits subjects with no payer", () => {
  // A deployment whose roster records no payer must show an EMPTY breakdown rather than one bucket
  // holding everybody — the same rule the payer filter follows (it matches nobody, not everyone).
  const members = resolveMembers(["a", "b", "c", "d"], (raw) => (raw === "d" ? null : raw));
  const payers: Record<string, string | undefined> = { a: "1", b: "11", c: undefined };
  assert.deepEqual(payerBreakdown(members, (id) => payers[id]), { "1": 1, "11": 1 });
  assert.deepEqual(payerBreakdown(members, () => undefined), {});
});
