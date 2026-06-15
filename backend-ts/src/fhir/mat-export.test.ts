/**
 * MAT export builder test (#108): the JVM-free FHIR R4 Bundle XML — Library + Measure (+ ValueSet),
 * status mapping, base64 CQL round-trip, and code-system grouping.
 * node --import tsx --test src/fhir/mat-export.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { exportMatBundle, type ExportValueSet } from "./mat-export.ts";
import type { MeasureRecord } from "../stores/measure-store.ts";

const record = (over: Partial<MeasureRecord> = {}): MeasureRecord => ({
  measureId: "audiogram",
  name: "Annual Audiogram Completed",
  policyRef: "OSHA 29 CFR 1910.95",
  owner: "system",
  tags: ["surveillance"],
  versionId: "audiogram-v1.0",
  version: "v1.0",
  status: "Active",
  spec: {
    description: "Audiogram within 365 days for hearing-conservation enrollees.",
    eligibilityCriteria: { roleFilter: "", siteFilter: "", programEnrollmentText: "" },
    exclusions: [],
    complianceWindow: "Annual",
    requiredDataElements: [],
    testFixtures: [],
  },
  cqlText: "library Audiogram version '1.0.0'\n// café ≥ test\ndefine \"X\": true",
  compileStatus: "COMPILED",
  changeSummary: null,
  approvedBy: null,
  activatedAt: "2026-06-10T00:00:00.000Z",
  createdAt: "2026-06-10T00:00:00.000Z",
  updatedAt: "2026-06-10T00:00:00.000Z",
  ...over,
});

test("Bundle scaffold: xml decl, FHIR namespace, collection type, Library+Measure entries", () => {
  const xml = exportMatBundle(record());
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<Bundle xmlns="http:\/\/hl7\.org\/fhir">/);
  assert.match(xml, /<type value="collection"\/>/);
  assert.match(xml, /<Library>/);
  assert.match(xml, /<Measure>/);
  // two entries (Library + Measure) when there are no value sets
  assert.equal(xml.match(/<entry>/g)?.length, 2);
});

test("Library: name/title, active status, and base64 CQL that round-trips UTF-8", () => {
  const xml = exportMatBundle(record());
  assert.match(xml, /<name value="AnnualAudiogramCompletedCQL"\/>/);
  assert.match(xml, /<title value="Annual Audiogram Completed CQL Library"\/>/);
  assert.match(xml, /<Library>[\s\S]*?<status value="active"\/>/);
  assert.match(xml, /<contentType value="text\/cql"\/>/);
  const b64 = xml.match(/<data value="([^"]+)"\/>/)![1]!;
  assert.equal(Buffer.from(b64, "base64").toString("utf-8"), record().cqlText, "CQL bytes round-trip");
});

test("Measure references the Library by its urn:uuid + carries the spec description", () => {
  const xml = exportMatBundle(record());
  const libId = xml.match(/<Library>\s*<id value="([^"]+)"\/>/)![1]!;
  assert.match(xml, new RegExp(`<library value="urn:uuid:${libId}"/>`));
  assert.match(xml, /<description value="Audiogram within 365 days for hearing-conservation enrollees\."\/>/);
  assert.match(xml, /<name value="AnnualAudiogramCompleted"\/>/);
});

test("description falls back to policy ref, then a default; status maps Deprecated→retired, Draft→draft", () => {
  const noDesc = exportMatBundle(record({ spec: { ...record().spec, description: "" } }));
  assert.match(noDesc, /<description value="Policy reference: OSHA 29 CFR 1910\.95"\/>/);
  const noDescNoRef = exportMatBundle(record({ policyRef: "", spec: { ...record().spec, description: "" } }));
  assert.match(noDescNoRef, /<description value="Exported from WorkWell Measure Studio"\/>/);
  assert.match(exportMatBundle(record({ status: "Deprecated" })), /<Measure>[\s\S]*?<status value="retired"\/>/);
  assert.match(exportMatBundle(record({ status: "Draft" })), /<Measure>[\s\S]*?<status value="draft"\/>/);
});

test("no CQL → no content element; attribute escaping is applied", () => {
  const xml = exportMatBundle(record({ cqlText: "", name: 'A & B <"measure">' }));
  assert.doesNotMatch(xml, /<content>/);
  assert.match(xml, /<title value="A &amp; B &lt;&quot;measure&quot;&gt;"\/>/);
  // safeIdentifier strips non-alphanumerics, keeping the alphanumeric runs (A, B, measure)
  assert.match(xml, /<name value="ABmeasure"\/>/);
});

test("value sets: compose/include grouped by system, codes with display, blank-system fallback", () => {
  const vs: ExportValueSet[] = [
    {
      id: "vs-1",
      oid: "2.16.840.1.113883.3.464",
      name: "Audiometry Codes",
      version: "20260101",
      canonicalUrl: null,
      codes: [
        { system: "http://www.ama-assn.org/go/cpt", code: "92557", display: "Comprehensive audiometry" },
        { system: "http://www.ama-assn.org/go/cpt", code: "92552" },
        { code: "LOCAL-1", display: "local" }, // blank system → urn:workwell:local
        { code: "" }, // dropped (no code)
      ],
    },
  ];
  const xml = exportMatBundle(record(), vs);
  assert.equal(xml.match(/<entry>/g)?.length, 3, "Library + Measure + 1 ValueSet");
  assert.match(xml, /<ValueSet>[\s\S]*?<url value="urn:oid:2\.16\.840\.1\.113883\.3\.464"\/>/);
  assert.match(xml, /<version value="20260101"\/>/);
  assert.match(xml, /<system value="http:\/\/www\.ama-assn\.org\/go\/cpt"\/>/);
  assert.match(xml, /<system value="urn:workwell:local"\/>/);
  assert.match(xml, /<concept>\s*<code value="92557"\/>\s*<display value="Comprehensive audiometry"\/>\s*<\/concept>/);
  assert.doesNotMatch(xml, /<code value=""\/>/, "empty code dropped");
});
