// backend-ts/src/order/order-proposal.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { proposeOrders, type AtRiskOutcome } from "./order-proposal.ts";
import type { StandingOrderProvider } from "./standing-order-provider.ts";

const noStanding: StandingOrderProvider = { activeOrdersFor: () => [] };

test("Panel=Risk: only OVERDUE/DUE_SOON/MISSING_DATA propose; COMPLIANT/EXCLUDED do not", () => {
  const rows: AtRiskOutcome[] = [
    { subjectId: "e1", measureId: "audiogram", status: "OVERDUE" },
    { subjectId: "e2", measureId: "audiogram", status: "DUE_SOON" },
    { subjectId: "e3", measureId: "audiogram", status: "MISSING_DATA" },
    { subjectId: "e4", measureId: "audiogram", status: "COMPLIANT" },
    { subjectId: "e5", measureId: "audiogram", status: "EXCLUDED" },
  ];
  const { proposed } = proposeOrders(rows, noStanding);
  assert.deepEqual(proposed.map((p) => p.subjectId).sort(), ["e1", "e2", "e3"]);
});

test("risk tier → priority (OVERDUE urgent; DUE_SOON/MISSING_DATA routine)", () => {
  const rows: AtRiskOutcome[] = [
    { subjectId: "e1", measureId: "audiogram", status: "OVERDUE" },
    { subjectId: "e2", measureId: "audiogram", status: "DUE_SOON" },
    { subjectId: "e3", measureId: "audiogram", status: "MISSING_DATA" },
  ];
  const { proposed } = proposeOrders(rows, noStanding);
  const byId = Object.fromEntries(proposed.map((p) => [p.subjectId, p.priority]));
  assert.equal(byId.e1, "urgent");
  assert.equal(byId.e2, "routine");
  assert.equal(byId.e3, "routine");
});

test("in-batch dedupe: same subject+order proposed once", () => {
  const rows: AtRiskOutcome[] = [
    { subjectId: "e1", measureId: "diabetes_hba1c", status: "OVERDUE" }, // 83036
    { subjectId: "e1", measureId: "cms122", status: "OVERDUE" },         // also 83036 → same dedupeKey
  ];
  const { proposed, suppressed } = proposeOrders(rows, noStanding);
  assert.equal(proposed.filter((p) => p.subjectId === "e1").length, 1);
  assert.equal(suppressed.length, 0); // dedupe-only path: nothing standing-order-suppressed
});

test("standing-order suppression moves a proposal to suppressed[]", () => {
  const standing: StandingOrderProvider = {
    activeOrdersFor: (id) => (id === "e1" ? [{ subjectId: "e1", order: { code: "92557", system: "http://www.ama-assn.org/go/cpt", display: "x" } }] : []),
  };
  const rows: AtRiskOutcome[] = [{ subjectId: "e1", measureId: "audiogram", status: "OVERDUE" }];
  const { proposed, suppressed } = proposeOrders(rows, standing);
  assert.equal(proposed.length, 0);
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0]!.suppressedByStandingOrder, true);
  assert.equal(suppressed[0]!.priority, "urgent"); // priority still derived from the OVERDUE risk tier
});

test("measure with no catalog entry yields no proposal", () => {
  const rows: AtRiskOutcome[] = [{ subjectId: "e1", measureId: "respirator_fit_test", status: "OVERDUE" }];
  assert.equal(proposeOrders(rows, noStanding).proposed.length, 0);
});
