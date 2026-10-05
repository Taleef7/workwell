/**
 * The terminology-equivalence oracle on synthetic sidecars and a synthetic CSV (no VSAC content): it
 * passes only when the CSV is a release that changed something, the translation changed exactly those
 * value sets, and holds Cypress's codes for every declared one — and it refuses to skip a code it cannot
 * place rather than pass without it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compareSidecarToCypressCsv, CSV_SYSTEM_FOR_OID, cypressCodesByOid, normaliseRelease, type ExpandedCodeLike } from "./terminology-equivalence.ts";

const SNOMED_OID = "2.16.840.1.113883.6.96";
const ICD10_OID = "2.16.840.1.113883.6.90";
const RELEASE = "eCQM Update 2026-05-14";
const OIDS = ["1.2.3.1", "1.2.3.2", "1.2.3.3"];

type Sidecar = Map<string, ExpandedCodeLike[]>;
const sidecar = (entries: Record<string, string[]>): Sidecar =>
  new Map(Object.entries(entries).map(([oid, codes]) => [oid, codes.map((c) => ({ system: c.startsWith("I") ? "http://hl7.org/fhir/sid/icd-10-cm" : "http://snomed.info/sct", code: c }))]));

const HEADER = "OID|ValueSetName|ExpansionVersion|Code|Descriptor|CodeSystemName|CodeSystemVersion|CodeSystemOID|Purpose";
const row = (oid: string, code: string, release = RELEASE) =>
  `${oid}|Set ${oid}|${release}|${code}|desc|${code.startsWith("I") ? "ICD10CM" : "SNOMEDCT"}|v|${code.startsWith("I") ? ICD10_OID : SNOMED_OID}|""`;
const csv = (rows: string[]) => [HEADER, ...rows].join("\n") + "\n";

// CMS's 2026 sets; the 2027 release adds S9 to set 1 and drops I2 from set 2; set 3 is unchanged.
const OFFICIAL = sidecar({ "1.2.3.1": ["S1", "S2"], "1.2.3.2": ["I1", "I2"], "1.2.3.3": ["S3"] });
const RELEASE_2027 = { "1.2.3.1": ["S1", "S2", "S9"], "1.2.3.2": ["I1"], "1.2.3.3": ["S3"] };
const CSV_2027 = csv(Object.entries(RELEASE_2027).flatMap(([oid, codes]) => codes.map((c) => row(oid, c))));

const compare = (translation: Sidecar, csvText = CSV_2027, requiredOids = OIDS) =>
  compareSidecarToCypressCsv({ translation, official: OFFICIAL, csvText, requiredOids, release: RELEASE, systemForOid: CSV_SYSTEM_FOR_OID });

test("a translation holding the release's codes, changed exactly where the release changed, passes", () => {
  const result = compare(sidecar(RELEASE_2027));
  assert.equal(result.result, "pass", result.problems.join("; "));
  assert.equal(`${result.agree}/${result.total}`, "3/3");
  assert.deepEqual(result.changedByRelease, ["1.2.3.1", "1.2.3.2"]);
  assert.deepEqual(result.changedByTranslation, ["1.2.3.1", "1.2.3.2"]);
  const first = result.oids[0]!;
  assert.deepEqual(
    [first.cypress, first.official, first.translation, first.addedByRelease, first.removedByRelease, first.missingFromTranslation, first.extraInTranslation],
    [3, 2, 3, 1, 0, 0, 0],
  );
  assert.equal(result.oids[1]!.removedByRelease, 1);
});

test("identical sidecars fail: a CSV equal to CMS's 2026 sets everywhere is not the release", () => {
  const csv2026 = csv([...OFFICIAL].flatMap(([oid, codes]) => codes.map((c) => row(oid, c.code))));
  const result = compare(OFFICIAL, csv2026);
  assert.equal(result.result, "fail");
  assert.deepEqual(result.changedByRelease, []);
  assert.equal(result.agree, 3, "every set equals the CSV, and it still fails");
  assert.match(result.problems.join(), /not the release the translation was built for/);
});

test("one value set differing from Cypress fails, naming it", () => {
  // Set 1 re-expanded without the code the release added: it still differs from CMS's, so only the
  // equality check can see it.
  const result = compare(sidecar({ ...RELEASE_2027, "1.2.3.1": ["S1", "S9"] }));
  assert.equal(result.result, "fail");
  assert.equal(`${result.agree}/${result.total}`, "2/3");
  assert.deepEqual(result.changedByTranslation, ["1.2.3.1", "1.2.3.2"], "it changed the right sets");
  assert.match(result.problems.join(), /1 declared value set\(s\) differ from the CSV: 1\.2\.3\.1/);
  assert.equal(result.oids[0]!.missingFromTranslation, 1);
});

test("changing a set the release did not change is reported as the wrong set of changes", () => {
  const result = compare(sidecar({ ...RELEASE_2027, "1.2.3.3": ["S3", "S4"] }));
  assert.equal(result.result, "fail");
  assert.match(result.problems.join(), /the translation changed 3 value set\(s\) relative to CMS's artifact; the release changed 2/);
});

test("Release:-prefixed rows are the same release", () => {
  const mixed = csv(Object.entries(RELEASE_2027).flatMap(([oid, codes]) => codes.map((c, i) => row(oid, c, i % 2 ? `Release:${RELEASE}` : RELEASE))));
  assert.equal(compare(sidecar(RELEASE_2027), mixed).result, "pass");
  assert.equal(normaliseRelease(`Release:${RELEASE}`), RELEASE);
  assert.equal(
    compareSidecarToCypressCsv({ translation: sidecar(RELEASE_2027), official: OFFICIAL, csvText: CSV_2027, requiredOids: OIDS, release: `Release:${RELEASE}`, systemForOid: CSV_SYSTEM_FOR_OID }).result,
    "pass",
    "the release argument is normalised the same way",
  );
});

test("a code system with no mapping throws rather than dropping its codes", () => {
  const unmapped = CSV_2027 + `1.2.3.3|Set|${RELEASE}|X1|d|ODD|v|9.9.9.9|""\n`;
  assert.throws(() => compare(sidecar(RELEASE_2027), unmapped), /code system 9\.9\.9\.9 has no FHIR system mapping/);
  // A row for a value set nobody declares is never read, so its system cannot block the check.
  assert.equal(compare(sidecar(RELEASE_2027), CSV_2027 + `7.7.7|Set|${RELEASE}|X1|d|ODD|v|9.9.9.9|""\n`).result, "pass");
});

test("a declared value set absent at the release fails naming it, and says where it is instead", () => {
  const withoutSet3 = csv(Object.entries(RELEASE_2027).flatMap(([oid, codes]) => codes.map((c) => row(oid, c, oid === "1.2.3.3" ? "eCQM Update 2025-05-08" : RELEASE))));
  const elsewhere = compare(sidecar(RELEASE_2027), withoutSet3);
  assert.equal(elsewhere.result, "fail");
  assert.match(elsewhere.problems.join(), /1\.2\.3\.3: the CSV lists it only at eCQM Update 2025-05-08, not at eCQM Update 2026-05-14/);
  assert.equal(elsewhere.oids[2]!.equalToCypress, false, "an empty Cypress side is never equality");

  const absent = compare(sidecar(RELEASE_2027), CSV_2027, [...OIDS, "1.2.3.4"]);
  assert.equal(absent.result, "fail");
  assert.match(absent.problems.join(), /1\.2\.3\.4: declared by the translation but absent from the CSV/);
  // Neither side holds the set: two empty sets are equal, and must still not count as agreement.
  assert.equal(absent.oids[3]!.equalToCypress, false);
  assert.equal(`${absent.agree}/${absent.total}`, "3/4");
});

test("a malformed row or a missing column refuses the file", () => {
  assert.throws(() => cypressCodesByOid(CSV_2027 + `1.2.3.1|a|b\n`, OIDS, RELEASE, CSV_SYSTEM_FOR_OID), /line 7 has 3 fields, the header 9/);
  assert.throws(() => cypressCodesByOid("OID|Code\n1|2\n", OIDS, RELEASE, CSV_SYSTEM_FOR_OID), /no ExpansionVersion column/);
  const crlf = CSV_2027.replace(/\n/g, "\r\n");
  assert.equal(compare(sidecar(RELEASE_2027), crlf).result, "pass", "CRLF line endings read the same");
});

test("the CSV map extends the importer's, and keeps every system the importer reads", () => {
  assert.equal(CSV_SYSTEM_FOR_OID[SNOMED_OID], "http://snomed.info/sct");
  assert.equal(CSV_SYSTEM_FOR_OID["2.16.840.1.113883.3.221.5"], "https://nahdo.org/sopt");
  assert.equal(CSV_SYSTEM_FOR_OID["2.16.840.1.113883.6.238"], "urn:oid:2.16.840.1.113883.6.238");
});
