/**
 * Which order codes are card-ready, and the clinic code a card adds (#640 item 2).
 *   node --import tsx --test src/order/approved-codes.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { approvedOrderCodesOf } from "./approved-codes.ts";
import type { TerminologyMappingRecord } from "../stores/value-set-store.ts";

const CPT = "http://www.ama-assn.org/go/cpt";
const m = (localSystem: string, localCode: string, standardCode: string, mappingStatus: string): TerminologyMappingRecord => ({
  id: `${localSystem}|${localCode}|${standardCode}`,
  localCode,
  localDisplay: null,
  localSystem,
  standardCode,
  standardDisplay: "Std",
  standardSystem: CPT,
  mappingStatus,
  mappingConfidence: null,
  reviewedBy: null,
  reviewedAt: null,
  notes: null,
});

test("only APPROVED rows make a code card-ready", () => {
  const a = approvedOrderCodesOf([m(CPT, "82274", "82274", "PROPOSED"), m(CPT, "45378", "45378", "APPROVED"), m(CPT, "81528", "81528", "REJECTED")]);
  assert.deepEqual([...a.approved], [`${CPT}|45378`]);
});

test("a clinic code rides along; the code's own row and a urn:workwell code never do", () => {
  const a = approvedOrderCodesOf([
    m(CPT, "82274", "82274", "APPROVED"),
    m("urn:workwell:demo", "AUD-1", "92557", "APPROVED"),
    m("urn:oid:1.2.3", "LAB-FIT", "82274", "APPROVED"),
  ]);
  assert.deepEqual(a.clinicCodes.get(`${CPT}|82274`)?.code, "LAB-FIT");
  assert.equal(a.clinicCodes.has(`${CPT}|92557`), false, "a WorkWell-internal system must not reach a real EHR");
  assert.equal(a.approved.has(`${CPT}|92557`), true, "the TWH demo row still approves its national code");
});

test("a PROPOSED clinic code is not added, even when the national code is approved", () => {
  const a = approvedOrderCodesOf([m(CPT, "82274", "82274", "APPROVED"), m("urn:oid:1.2.3", "LAB-FIT", "82274", "PROPOSED")]);
  assert.equal(a.clinicCodes.size, 0);
});
