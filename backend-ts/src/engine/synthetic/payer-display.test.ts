/**
 * The payer display table — names, the typology's prefix hierarchy, and the ordering a person reads.
 *
 * The thing under test that is not obvious: `payerGroupOf` is a PREFIX read, and the filter predicate
 * is an EQUALITY read. Keeping those apart is the whole point — grouping is something a caller opts
 * into by selecting several codes, never something the predicate does behind their back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  comparePayerCodes, payerCodesInGroup, payerDisplayOf, payerGroupNameOf, payerGroupOf, payerNameOf,
} from "./payer-display.ts";
import { corpusDirectory } from "./corpus/corpus-directory.ts";
import { DEFAULT_CORPUS_SEED } from "./corpus/corpus-parameters.ts";

test("a known code gets its name; an unknown one is its OWN name, never blank and never guessed", () => {
  assert.equal(payerNameOf("1"), "Medicare");
  assert.equal(payerNameOf("11"), "Medicare Advantage");
  assert.equal(payerNameOf("2"), "Medicaid");
  assert.equal(payerNameOf("5"), "Commercial");
  assert.equal(payerNameOf(" 5 "), "Commercial", "trimmed");
  // A live Coverage can carry a typology member we have not enumerated. Showing the code is honest;
  // showing a name we did not check would be indistinguishable from showing a right one.
  assert.equal(payerNameOf("37"), "37");
  assert.equal(payerNameOf("BCBS-HI"), "BCBS-HI");
});

test("the group is the typology's one-digit PREFIX — so `1` and `11` are one category", () => {
  assert.equal(payerGroupOf("1"), "1");
  assert.equal(payerGroupOf("11"), "1");
  assert.equal(payerGroupOf("14"), "1");
  assert.equal(payerGroupOf("21"), "2");
  assert.equal(payerGroupOf("5"), "5");
  assert.equal(payerGroupNameOf(payerGroupOf("11")), "Medicare", "Medicare Advantage IS Medicare");

  // A value that is not typology-shaped is its own group, rather than being folded into whatever
  // category its first character happens to spell. `"1st Choice"` is not Medicare.
  assert.equal(payerGroupOf("1st Choice"), "1st Choice");
  assert.equal(payerGroupOf("BCBS-HI"), "BCBS-HI");

  assert.deepEqual(payerDisplayOf("11"), { code: "11", name: "Medicare Advantage", group: "1", groupName: "Medicare" });
  assert.deepEqual(payerDisplayOf("zz"), { code: "zz", name: "zz", group: "zz", groupName: "zz" });
});

test("payerCodesInGroup expands to codes PRESENT in the directory, not to the whole typology", () => {
  const present = ["1", "11", "2", "5"];
  assert.deepEqual(payerCodesInGroup("1", present), ["1", "11"], "asking for Medicare gets both");
  assert.deepEqual(payerCodesInGroup("11", present), ["1", "11"], "from either member");
  assert.deepEqual(payerCodesInGroup("5", present), ["5"]);
  // Only what the filter can actually return rows for: on a roster carrying only `11`, Medicare is
  // `["11"]` — never `["1","11","12","13","14"]`, whose first four match nobody.
  assert.deepEqual(payerCodesInGroup("1", ["11", "5"]), ["11"]);
  assert.deepEqual(payerCodesInGroup("1", []), [], "and nothing present means nothing selected");
  assert.deepEqual(payerCodesInGroup("1", ["1", " 1 ", "11"]), ["1", "11"], "trimmed and de-duplicated");
});

test("codes sort NUMERICALLY within a category, so Medicare Advantage does not land between Medicare and Medicaid", () => {
  // Lexicographically `"11" < "2"`, which would order the list Medicare, Medicare Advantage, Medicaid —
  // arbitrary-looking to the one person the ordering exists for. Numeric keeps the categories whole.
  assert.deepEqual(["2", "11", "5", "1"].sort(comparePayerCodes), ["1", "11", "2", "5"]);
  assert.deepEqual(["5", "21", "2"].sort(comparePayerCodes), ["2", "21", "5"]);
  // A non-typology value sorts LAST rather than into the middle of the categories.
  assert.deepEqual(["BCBS-HI", "5", "1"].sort(comparePayerCodes), ["1", "5", "BCBS-HI"]);
});

test("every payer the corpus actually emits has a name, and Medicare is two of them", () => {
  // The table is only useful if it covers what the pilot's own roster carries. If the corpus gains a
  // code this will fail here rather than rendering a bare number on the practice's work list.
  const roster = corpusDirectory(DEFAULT_CORPUS_SEED, 4000).EMPLOYEES;
  const codes = [...new Set(roster.map((e) => e.payer).filter((p): p is string => Boolean(p)))].sort(comparePayerCodes);
  assert.deepEqual(codes, ["1", "11", "2", "5"], "the four the generator draws from");
  for (const code of codes) assert.notEqual(payerNameOf(code), code, `payer ${code} has no name`);

  const medicare = payerCodesInGroup("1", codes);
  assert.deepEqual(medicare, ["1", "11"]);
  const medicareRows = roster.filter((e) => e.payer && medicare.includes(e.payer)).length;
  const ffsRows = roster.filter((e) => e.payer === "1").length;
  assert.ok(medicareRows > ffsRows, "which is the point: the group is strictly larger than either code");
});
