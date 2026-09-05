import { test } from "node:test";
import assert from "node:assert/strict";
import { officialDisplayFor } from "./official-display.ts";

const IDS = ["cms122", "cms125", "cms2", "cms130", "cms165"] as const;
const STATUSES = ["COMPLIANT", "OVERDUE", "EXCLUDED", "MISSING_DATA"] as const;

test("every (measure, status) pair has status wording, a why line and a next action", () => {
  for (const id of IDS) for (const s of STATUSES) {
    const d = officialDisplayFor(id, s)!;
    assert.ok(d.method && d.whyFlagged && d.nextAction, `${id}/${s}`);
    assert.doesNotMatch(d.method, /on file/i); // official wording never claims a record's absence for OVERDUE
  }
});
test("cms122 OVERDUE says what the numerator means, not 'no record'", () => {
  assert.match(officialDisplayFor("cms122", "OVERDUE")!.method, /above 9%/);
});
test("EXCLUDED is a denominator exclusion or exception, never an 'exemption on file'", () => {
  for (const id of IDS) assert.match(officialDisplayFor(id, "EXCLUDED")!.method, /excluded by measure logic/i);
});
