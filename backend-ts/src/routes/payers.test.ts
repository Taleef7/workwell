import test from "node:test";
import assert from "node:assert/strict";
import { handlePayers, payerOptionsFor } from "./payers.ts";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const get = (url: string) => handlePayers(new Request(url));

test("payerOptionsFor counts the payers PRESENT in a roster and names them", () => {
  const options = payerOptionsFor([
    { payer: "5" }, { payer: "5" }, { payer: "11" }, { payer: "1" }, { payer: " 1 " }, {}, { payer: "" },
  ]);
  assert.deepEqual(options, [
    { code: "1", name: "Medicare", group: "1", groupName: "Medicare", subjectCount: 2 },
    { code: "11", name: "Medicare Advantage", group: "1", groupName: "Medicare", subjectCount: 1 },
    { code: "5", name: "Commercial", group: "5", groupName: "Commercial", subjectCount: 2 },
  ]);
  // Sorted by category then numerically within it, so Medicare's two codes render ADJACENT. A
  // lexicographic sort puts "11" before "2", which reads as an arbitrary order on the screen.
  assert.deepEqual(payerOptionsFor([{ payer: "2" }, { payer: "11" }]).map((o) => o.code), ["11", "2"]);
});

test("a roster that records no payer returns [] — so a UI hides the filter instead of offering an empty one", () => {
  assert.deepEqual(payerOptionsFor([{}, {}, { payer: "  " }]), []);
});

test("the route declines anything that is not GET /api/payers", async () => {
  assert.equal(await handlePayers(new Request("http://localhost/api/payers", { method: "POST" })), null);
  assert.equal(await get("http://localhost/api/payers/1"), null);
  assert.equal(await get("http://localhost/api/providers"), null);
});

test("GET /api/payers is 200 and profile-scoped: empty on the occupational directory", async () => {
  // The default profile's roster has never carried a payer, and the live WebChart directory still
  // discards Coverage (#533). Both must answer [] rather than inventing options that match nobody.
  const res = (await get("http://localhost/api/payers"))!;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test("on the Maui profile it returns the corpus's four payers, and the counts reconcile with the roster", () => {
  const out = runProfileChild("maui", `
    const { handlePayers } = await import("./src/routes/payers.ts");
    const { employees } = await import("./src/config/deployment-profile.ts");
    const rows = await (await handlePayers(new Request("http://localhost/api/payers"))).json();
    const roster = employees();
    console.log(JSON.stringify({
      rows,
      rosterSize: roster.length,
      withPayer: roster.filter((e) => e.payer).length,
    }));
  `);
  const rows = out.rows as Array<{ code: string; name: string; group: string; groupName: string; subjectCount: number }>;
  assert.deepEqual(rows.map((r) => r.code), ["1", "11", "2", "5"]);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["code", "group", "groupName", "name", "subjectCount"]);
    assert.notEqual(row.name, row.code, `payer ${row.code} rendered as a bare code`);
    assert.ok(row.subjectCount > 0, "an option nobody is on would filter to an empty list");
  }

  // The counts are over the DIRECTORY, so they must add up to every subject who has a payer — not to
  // cases, not to outcomes. An option's number and the list it produces have to describe each other.
  const total = rows.reduce((sum, r) => sum + r.subjectCount, 0);
  assert.equal(total, out.withPayer, "the facet counts do not partition the roster");
  assert.equal(out.withPayer, out.rosterSize, "every corpus patient carries a payer");

  // The finding this whole feature turns on: Medicare is `1` + `11`, and the group is strictly larger
  // than either code. A single-select filter would hand someone the smaller number under the larger
  // heading — the ADR-079 shape, inverted.
  const medicare = rows.filter((r) => r.group === "1");
  assert.equal(medicare.length, 2);
  assert.deepEqual(medicare.map((r) => r.groupName), ["Medicare", "Medicare"]);
  const medicareTotal = medicare.reduce((sum, r) => sum + r.subjectCount, 0);
  assert.ok(medicareTotal > Math.max(...medicare.map((r) => r.subjectCount)));
});
