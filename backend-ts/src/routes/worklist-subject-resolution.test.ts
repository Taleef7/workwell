/**
 * The roster form's subject→case resolution, tested where its two rules can actually fail.
 *
 * Both were found in review, and neither is reachable from a route test on the default deployment
 * profile: `profileSubjectMatcher` passes every subject there, so a guard that drops foreign subjects
 * cannot be observed, and the fixture has one evaluation period so a collapse cannot be observed
 * either. A control nothing can fail is this repository's most common defect, so the rules live in a
 * pure function and are exercised directly.
 *
 *   node --import tsx --test src/routes/worklist-subject-resolution.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSubjectCaseIds } from "./worklist.ts";

const c = (id: string, employeeId: string, evaluationPeriod: string) => ({ id, employeeId, evaluationPeriod });
const all = () => true;

test("one case per subject — the NEWEST evaluation period, whatever order the store returned", () => {
  // The roster cell describes ONE period: the winning run's. The resolution query is not
  // period-scoped, so a surviving prior-cycle case would otherwise be assigned alongside it — and
  // `assignCases(…, "OPERATOR")` stamps it operator-owned permanently (ADR-080 d3), so a row nobody
  // chose would never be moved by a panel change again.
  const ids = resolveSubjectCaseIds(
    [c("old", "emp-006", "2025-01-01"), c("new", "emp-006", "2026-01-01")],
    all,
  );
  assert.deepEqual(ids, ["new"]);

  // Order-independent: the store sorts by `updated_at DESC, id DESC`, which is not period order.
  assert.deepEqual(
    resolveSubjectCaseIds([c("new", "emp-006", "2026-01-01"), c("old", "emp-006", "2025-01-01")], all),
    ["new"],
  );
});

test("each subject keeps its own newest — collapsing is per subject, not across the set", () => {
  const ids = resolveSubjectCaseIds(
    [
      c("a-old", "emp-001", "2025-01-01"),
      c("a-new", "emp-001", "2026-01-01"),
      c("b-only", "emp-002", "2024-01-01"),
    ],
    all,
  );
  assert.deepEqual(ids.sort(), ["a-new", "b-only"]);
});

test("a subject the deployment profile hides is dropped, even though the caller named it", () => {
  // Every READ surface applies this scoping and neither write path did. Not a new hole — but a wider
  // one, because a subject external id is guessable where a case UUID is not, so without it a case
  // manager on a scoped deployment could assign (and thereby confirm the existence of) a case for a
  // subject that deployment hides from every list.
  const mauiOnly = (subjectId: string) => subjectId.startsWith("pat-");
  const ids = resolveSubjectCaseIds(
    [c("mine", "pat-00123", "2026-01-01"), c("foreign", "emp-001", "2026-01-01")],
    mauiOnly,
  );
  assert.deepEqual(ids, ["mine"]);
});

test("a hidden subject's OLDER case cannot be revived by the collapse", () => {
  // The filter runs before the collapse, so a foreign subject never reaches the map at all.
  const ids = resolveSubjectCaseIds(
    [c("foreign-new", "emp-001", "2026-01-01"), c("foreign-old", "emp-001", "2025-01-01")],
    (subjectId) => subjectId.startsWith("pat-"),
  );
  assert.deepEqual(ids, []);
});

test("an empty input, and a fully-hidden input, both resolve to nothing", () => {
  assert.deepEqual(resolveSubjectCaseIds([], all), []);
  assert.deepEqual(resolveSubjectCaseIds([c("x", "emp-001", "2026-01-01")], () => false), []);
});
