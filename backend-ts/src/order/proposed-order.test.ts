// backend-ts/src/order/proposed-order.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeKeyFor, toServiceRequest, bundleOf, type ProposedOrder } from "./proposed-order.ts";

const sample: ProposedOrder = {
  subjectId: "emp-006",
  measureId: "audiogram",
  order: { code: "92557", system: "http://www.ama-assn.org/go/cpt", display: "Comprehensive audiometry evaluation" },
  reasonOutcome: "OVERDUE",
  priority: "urgent",
  status: "PROPOSED",
  dedupeKey: dedupeKeyFor("emp-006", { code: "92557", system: "http://www.ama-assn.org/go/cpt", display: "x" }),
  authoredOn: "2026-06-19",
};

test("dedupeKeyFor is subject + system|code", () => {
  assert.equal(sample.dedupeKey, "emp-006:http://www.ama-assn.org/go/cpt|92557");
});

test("toServiceRequest emits a FHIR proposal ServiceRequest", () => {
  const sr = toServiceRequest(sample) as Record<string, unknown>;
  assert.equal(sr.resourceType, "ServiceRequest");
  assert.equal(sr.intent, "proposal");
  assert.equal(sr.status, "draft");
  assert.equal(sr.priority, "urgent");
  assert.deepEqual((sr.subject as Record<string, unknown>).reference, "Patient/emp-006");
  const codeable = sr.code as { coding?: Array<Record<string, unknown>>; text?: string };
  const coding = (codeable.coding ?? [])[0];
  assert.equal(coding?.code, "92557");
  assert.equal(coding?.system, "http://www.ama-assn.org/go/cpt");
  assert.equal(codeable.text, "Comprehensive audiometry evaluation"); // CodeableConcept.text for strict validators
  assert.equal(sr.authoredOn, "2026-06-19");
  // reason carries the measure + outcome for traceability
  const reason = ((sr.reasonCode as Array<{ text?: string }>) ?? [])[0]?.text ?? "";
  assert.ok(reason.includes("audiogram") && reason.includes("OVERDUE"));
});

test("bundleOf wraps proposals in a FHIR collection Bundle of ServiceRequest", () => {
  const b = bundleOf([sample]) as Record<string, unknown>;
  assert.equal(b.resourceType, "Bundle");
  assert.equal(b.type, "collection");
  const entries = b.entry as Array<{ resource: Record<string, unknown> }>;
  assert.equal(entries.length, 1);
  const entry0 = entries[0];
  assert.ok(entry0);
  assert.equal(entry0.resource.resourceType, "ServiceRequest");
});
