import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildCdsInputXml,
  buildDssRequest,
  parseDssResponse,
  parseCdsOutputProposals,
  parseIceTimestamp,
} from "./ice-vmr.ts";

// Golden fixture: a real DSS response captured live from hlnconsulting/ice:latest (2026-07-13)
// against the canonical ICE test payload. See docs/superpowers/specs/2026-07-13-ice-sidecar-spike.md.
const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../spike/ice/dss-response.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

test("buildCdsInputXml renders dob, gender, and one event per dose", () => {
  const xml = buildCdsInputXml({
    patientId: "emp-006",
    dob: "1980-05-01",
    gender: "F",
    doses: [
      { cvx: "115", date: "2016-01-15" },
      { cvx: "141", date: "2025-10-01" },
    ],
  });
  assert.match(xml, /<birthTime value="1980-05-01"\/>/);
  assert.match(xml, /<gender code="F" codeSystem="2\.16\.840\.1\.113883\.5\.1"\/>/);
  const events = xml.match(/<substanceAdministrationEvent>/g) ?? [];
  assert.equal(events.length, 2);
  assert.match(xml, /substanceCode code="115"[^>]*codeSystem="2\.16\.840\.1\.113883\.12\.292"/);
  assert.match(xml, /<administrationTimeInterval high="2025-10-01" low="2025-10-01"\/>/);
  // vMR envelope essentials the engine requires
  assert.match(xml, /<ns3:cdsInput /);
  assert.match(xml, /<templateId root="2\.16\.840\.1\.113883\.3\.795\.11\.1\.1"\/>/);
});

test("buildCdsInputXml escapes XML metacharacters in ids", () => {
  const xml = buildCdsInputXml({ patientId: `x"<&>'y`, dob: "1980-01-01", gender: "M", doses: [] });
  assert.doesNotMatch(xml, /x"<&>'y/);
  assert.match(xml, /x&quot;&lt;&amp;&gt;&apos;y/);
});

test("buildCdsInputXml renders no substanceAdministrationEvents block when doses are empty", () => {
  const xml = buildCdsInputXml({ patientId: "p", dob: "1980-01-01", gender: "M", doses: [] });
  assert.doesNotMatch(xml, /<substanceAdministrationEvents>/);
});

test("buildDssRequest wraps a base64 CDSInput in the DSS envelope; payload round-trips", () => {
  const cdsInputXml = buildCdsInputXml({ patientId: "p1", dob: "1990-06-10", gender: "M", doses: [] });
  const req = buildDssRequest({ cdsInputXml, submissionTimeMs: 1579330800000 });
  assert.equal(req.interactionId.scopingEntityId, "org.nyc.cir");
  assert.equal(req.interactionId.submissionTime, 1579330800000);
  const km = req.evaluationRequest.kmEvaluationRequest[0]?.kmId;
  assert.deepEqual(km, { scopingEntityId: "org.nyc.cir", businessId: "ICE", version: "1.0.0" });
  const dri = req.evaluationRequest.dataRequirementItemData[0];
  assert.ok(dri);
  assert.equal(dri.data.informationModelSSId.businessId, "VMR");
  // The payload field is an ARRAY — the live ICE engine rejects a bare string with 400 (2026-07-13).
  assert.ok(Array.isArray(dri.data.base64EncodedPayload), "base64EncodedPayload must be an array");
  assert.equal(dri.data.base64EncodedPayload.length, 1);
  assert.equal(atob(String(dri.data.base64EncodedPayload[0])), cdsInputXml);
});

test("parseDssResponse extracts the base64EncodedPayload ARRAY form from the golden fixture", () => {
  const xml = parseDssResponse(GOLDEN);
  assert.match(xml, /<ns3:cdsOutput/);
  assert.match(xml, /<substanceAdministrationProposal>/);
});

test("parseDssResponse throws a descriptive error on an envelope with no payload", () => {
  assert.throws(() => parseDssResponse({ finalKMEvaluationResponse: [] }), /payload/i);
});

test("parseCdsOutputProposals finds all 17 proposals in the golden response", () => {
  const proposals = parseCdsOutputProposals(parseDssResponse(GOLDEN));
  assert.equal(proposals.length, 17);
});

test("golden: influenza group 800 is RECOMMENDED due 2026-07-01", () => {
  const proposals = parseCdsOutputProposals(parseDssResponse(GOLDEN));
  const flu = proposals.find((p) => p.groupCode === "800");
  assert.ok(flu);
  assert.equal(flu.recommendation, "RECOMMENDED");
  assert.equal(flu.proposedDate, "2026-07-01");
  assert.equal(flu.earliestDate, "2026-07-01");
  assert.deepEqual(flu.interpretations, ["DUE_NOW"]);
});

test("golden: DTP group 200 is RECOMMENDED due 2026-03-15 with earliest 2021-03-15", () => {
  const proposals = parseCdsOutputProposals(parseDssResponse(GOLDEN));
  const dtp = proposals.find((p) => p.groupCode === "200");
  assert.ok(dtp);
  assert.equal(dtp.recommendation, "RECOMMENDED");
  assert.equal(dtp.proposedDate, "2026-03-15");
  assert.equal(dtp.earliestDate, "2021-03-15");
  assert.ok(dtp.interpretations.includes("ADMINISTER_TDAP_OR_TD"));
});

test("golden: HepB group 100 is NOT_RECOMMENDED (COMPLETE) with no dates", () => {
  const proposals = parseCdsOutputProposals(parseDssResponse(GOLDEN));
  const hepb = proposals.find((p) => p.groupCode === "100");
  assert.ok(hepb);
  assert.equal(hepb.recommendation, "NOT_RECOMMENDED");
  assert.equal(hepb.proposedDate, null);
  assert.equal(hepb.earliestDate, null);
  assert.deepEqual(hepb.interpretations, ["COMPLETE"]);
});

// Regression (found live 2026-07-13): ICE proposes a concrete PRODUCT for some groups — a patient
// with no DTP history gets <substanceCode code="115"> (CVX Tdap) with <observationFocus code="200">
// (DTP Vaccine Group). Keying the proposal off substanceCode silently loses the DTP group and the
// whole forecast degrades. The group must come from observationFocus.
test("a product-coded proposal (CVX substance) still resolves to its vaccine GROUP", () => {
  const xml = `<ns3:cdsOutput><substanceAdministrationProposal>
<substance><substanceCode code="115" codeSystem="2.16.840.1.113883.12.292"/></substance>
<relatedClinicalStatement><observationResult>
<observationFocus code="200" codeSystem="2.16.840.1.113883.3.795.12.100.1" displayName="DTP Vaccine Group"/>
<observationValue><concept code="RECOMMENDED" codeSystem="2.16.840.1.113883.3.795.12.100.5"/></observationValue>
<interpretation code="DUE_NOW" codeSystem="2.16.840.1.113883.3.795.12.100.6"/>
</observationResult></relatedClinicalStatement>
<proposedAdministrationTimeInterval low="19870202000000.000+0000"/>
</substanceAdministrationProposal></ns3:cdsOutput>`;
  const [p] = parseCdsOutputProposals(xml);
  assert.ok(p);
  assert.equal(p.groupCode, "200", "group must come from observationFocus, not the CVX substance");
  assert.equal(p.groupName, "DTP Vaccine Group");
  assert.equal(p.proposedSubstanceCode, "115", "the concrete product ICE proposes is kept");
  assert.equal(p.proposedSubstanceSystem, "2.16.840.1.113883.12.292");
  assert.equal(p.recommendation, "RECOMMENDED");
  assert.equal(p.proposedDate, "1987-02-02");
});

test("parseIceTimestamp handles YYYYMMDDhhmmss.SSS±ZZZZ and rejects garbage", () => {
  assert.equal(parseIceTimestamp("20260701000000.000+0000"), "2026-07-01");
  assert.equal(parseIceTimestamp("20210315000000.000+0000"), "2021-03-15");
  assert.equal(parseIceTimestamp(""), null);
  assert.equal(parseIceTimestamp("not-a-date"), null);
});
