/**
 * The LIVE third-party path, evaluated through an official artifact — the gap
 * `devdb-official-eval.test.ts` names in its own header and deliberately leaves open.
 *   node --import tsx --test src/engine/ingress/webchart/live-official-parity.test.ts
 *
 * ## Why the existing gate could not see this
 *
 * That file runs the committed dev-DB fixture through the ingress path, and the fixture is produced by
 * `scripts/webchart-devdb-export.ts` — one of the two SQL→FHIR mappers ADR-042 fixed. So it carries
 * `us-core-sex` before normalization ever runs. That fix sits **upstream of the live FHIR transport**:
 * a third-party WebChart server, which supplies only what its own FHIR API emits, would not carry it,
 * and official CMS125 then puts the ENTIRE roster out of its initial population, silently, as 100%
 * MISSING_DATA rather than an error (`WEBCHART_FHIR_MAPPING.md` §3.1).
 *
 * It also pins the opposite rule for a billed mammogram: ingest derives nothing from a CPT/HCPCS
 * `Procedure`, because official CMS125 counts only a charted LOINC result (owner decision 2026-11-05).
 *
 * ## What this file does
 *
 * It simulates a live server by taking the same fixture and **stripping exactly what our SQL mappers add
 * and a third party's FHIR API would not**: the `us-core-sex` extension. What is left is
 * `Patient.gender` — the live shape. Then it asserts official CMS125 still admits the roster.
 *
 * The stripping is the point: without it every assertion here would pass on the fixture's own data and
 * prove nothing about a tenant. Each test therefore also pins the NEGATIVE — normalization disabled, the
 * failure returns — so none of them can quietly stop discriminating.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeWebChartBundle } from "./normalize.ts";
import { officialMeasureExecutor, type OfficialBatchSubject } from "../../../wiring/official-executor-adapter.ts";
import { officialTerminologyExpander, loadOfficialTerminology } from "../../../wiring/official-terminology.ts";
import { loadOfficialArtifact } from "../../../wiring/official-artifacts.ts";
import { parseEnrollmentRoster, isEnrolled } from "../enrollment/roster.ts";
import { withTestQualifyingVisit } from "../../../test-support/qualifying-visit.ts";
import { ECQM_CANONICAL_CODES, MAMMOGRAPHY_PROCEDURE_CPT } from "../../cql/bundled-ecqm-expansions.ts";

const DIR = fileURLToPath(new URL("../../../../spike/webchart/", import.meta.url));
const payloads = JSON.parse(readFileSync(path.join(DIR, "devdb-patients.json"), "utf8")) as unknown[];
const roster = parseEnrollmentRoster(JSON.parse(readFileSync(path.join(DIR, "enrollment-roster.json"), "utf8")));
const EVAL = "2024-06-01";
const US_CORE_SEX = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-sex";
/** The four subjects `devdb-official-eval.test.ts` finds actionable — the ones the IPP admits. */
const CMS125_ACTIONABLE = ["wc-8", "wc-36", "wc-45", "wc-47"];

const sidecarsPresent = ["cms125"].every((id) => {
  const artifact = loadOfficialArtifact(id);
  return !!artifact && loadOfficialTerminology(artifact).ok;
});
const skip = sidecarsPresent ? false : "run 'pnpm vendor:official' to fetch the terminology sidecars";

type Res = Record<string, unknown>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * A qualifying visit added as TEST DATA (`test-support/qualifying-visit.ts`) for each patient the
 * committed roster lists. The sample carries no Encounter and ingest no longer invents one; this file's
 * subject is how normalization treats sex and screenings, so it supplies the visit itself.
 */
function withQualifyingVisit(bundle: unknown): unknown {
  const patient = ((bundle as { entry?: Array<{ resource?: Res }> }).entry ?? []).find((e) => e.resource?.["resourceType"] === "Patient")?.resource;
  const id = typeof patient?.["id"] === "string" ? (patient["id"] as string) : undefined;
  return id && isEnrolled(roster, id, "cms125") ? withTestQualifyingVisit(bundle) : bundle;
}

function resourcesOf(payload: unknown): Res[] {
  const entries = (payload as { entry?: Array<{ resource?: Res }> }).entry ?? [];
  return entries.map((e) => e.resource).filter((r): r is Res => !!r);
}

/**
 * What a third-party WebChart FHIR server sends: `Patient.gender`, without the `us-core-sex` our own SQL
 * mappers add. Everything else is the fixture untouched.
 */
function asLiveServerWouldSend(): unknown[] {
  return clone(payloads).map((payload) => {
    for (const r of resourcesOf(payload)) {
      if (r.resourceType === "Patient" && Array.isArray(r.extension)) {
        r.extension = (r.extension as Res[]).filter((x) => x.url !== US_CORE_SEX);
        if ((r.extension as Res[]).length === 0) delete r.extension;
      }
    }
    return payload;
  });
}

const patientIdOf = (bundle: unknown) => {
  for (const r of resourcesOf(bundle)) if (r.resourceType === "Patient" && typeof r.id === "string") return r.id;
  throw new Error("bundle carries no Patient.id");
};

async function officialInIpp(bundles: readonly unknown[]): Promise<number> {
  const executor = officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) });
  const subjects: OfficialBatchSubject[] = bundles.map((b) => ({ subjectId: patientIdOf(b), patientBundle: b }));
  const results = await executor.evaluateBatch("cms125", subjects, EVAL);
  return [...results.values()].filter((r) => r.inInitialPopulation).length;
}

/** The ingress path a routed run applies, over payloads shaped as a live server would send them. */
function liveBundles(mutate: (bundle: unknown) => unknown = (b) => b): unknown[] {
  return asLiveServerWouldSend()
    .map((p) => normalizeWebChartBundle(p))
    .map((b) => mutate(b))
    .map((b) => withQualifyingVisit(b));
}

/**
 * Undo ONLY the derived `us-core-sex` after normalization, which is what makes the negative arm attributable.
 *
 * A first cut compared "normalized" against "not normalized at all" — which also disables terminology
 * reconciliation and the Observation→Procedure synthesis, so the 0 could have come from anywhere and a
 * future change that moved its cause would still read green (review, #390).
 */
function withoutDerivedSex(bundle: unknown): unknown {
  const b = clone(bundle) as { entry: Array<{ resource: Res }> };
  for (const { resource } of b.entry) {
    if (resource.resourceType !== "Patient" || !Array.isArray(resource.extension)) continue;
    const derived = ((resource.meta as { tag?: Array<{ code?: string }> })?.tag ?? []).some(
      (t) => t.code === "derived-from-gender",
    );
    if (derived) resource.extension = (resource.extension as Res[]).filter((x) => x.url !== US_CORE_SEX);
  }
  return b;
}

test("the fixture we strip really did carry us-core-sex — otherwise this file proves nothing", () => {
  // The guard on the guard. If the fixture ever stops carrying `us-core-sex`, every assertion below
  // would pass trivially over data that never had it.
  const original = clone(payloads);
  const hasSex = original.some((p) =>
    resourcesOf(p).some(
      (r) => r.resourceType === "Patient" && ((r.extension as Res[]) ?? []).some((x) => x.url === US_CORE_SEX),
    ),
  );
  assert.ok(hasSex, "the committed fixture must carry us-core-sex for the strip to mean anything");

  const stripped = asLiveServerWouldSend();
  assert.ok(
    !stripped.some((p) => resourcesOf(p).some((r) => ((r.extension as Res[]) ?? []).some((x) => x.url === US_CORE_SEX))),
    "and the strip must actually remove it",
  );
});

test("us-core-sex is derived from gender, so a live roster is not silently emptied", { skip }, async () => {
  // ADR-042 measured this exact failure on the fixture BEFORE the mappers were fixed: 0 of 56 carried the
  // extension and official CMS125 put every one of them out of the initial population. That fix never
  // reached the live transport.
  const withNormalization = await officialInIpp(liveBundles());
  const without = await officialInIpp(liveBundles(withoutDerivedSex));
  assert.equal(without, 0, "removing ONLY the derived extension empties the initial population again");
  // The measured number, pinned: 4 of 56 — the same four `devdb-official-eval.test.ts` finds actionable
  // (wc-8, wc-36, wc-45, wc-47), reached from the LIVE shape rather than from our own SQL mapper's output.
  assert.equal(withNormalization, 4, "normalization must admit exactly the roster the fixture path admits");
});

test("the derived extension carries the SNOMED concept id, not the FHIR gender string", { skip: false }, () => {
  // "An extension carrying 'F' is indistinguishable from one absent, which cost a measurement pass"
  // (ADR-042). The value must be the SNOMED concept the official IPP compares against.
  const bundle = normalizeWebChartBundle({
    resourceType: "Bundle",
    entry: [{ resource: { resourceType: "Patient", id: "p1", gender: "female" } }],
  });
  const patient = (bundle.entry as Array<{ resource: Res }>)[0]!.resource;
  const extension = ((patient.extension as Res[]) ?? []).find((x) => x.url === US_CORE_SEX);
  assert.equal(extension?.valueCode, "248152002");
  // `{ url, valueCode }` and NOTHING else: FHIR's ext-1 is "either extensions or value[x], not both", so
  // provenance rides on `meta.tag` rather than inside the extension (review, #390).
  assert.deepEqual(Object.keys(extension!).sort(), ["url", "valueCode"]);
  assert.deepEqual(
    ((patient.meta as { tag: Res[] }).tag ?? []).at(-1),
    { system: "urn:workwell:webchart", code: "derived-from-gender" },
    "tagged, so an asserted sex is distinguishable from a recorded one",
  );
});

test("a gender the allowlist does not cover asserts NOTHING", () => {
  // There is no SNOMED concept to assert for `other`/`unknown`, and guessing is the thing this must not
  // do. Absent beats wrong: absent reads as MISSING_DATA, wrong reads as a confident answer.
  // The prototype keys are the point: `SEX_CONCEPT` is indexed by a string a third-party server sent, and
  // a plain object literal answers `["constructor"]` with a function — measured in review (#390) emitting
  // a malformed extension for a gender this allowlist supposedly rejects.
  for (const gender of ["other", "unknown", "", "FEMALE", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const bundle = normalizeWebChartBundle({
      resourceType: "Bundle",
      entry: [{ resource: { resourceType: "Patient", id: "p1", gender } }],
    });
    const patient = (bundle.entry as Array<{ resource: Res }>)[0]!.resource;
    assert.equal(patient.extension, undefined, `gender '${gender}' must assert nothing`);
  }
});

test("a server that already supplies us-core-sex is left exactly as it is", () => {
  const supplied = { url: US_CORE_SEX, valueCode: "248153007" };
  const bundle = normalizeWebChartBundle({
    resourceType: "Bundle",
    entry: [{ resource: { resourceType: "Patient", id: "p1", gender: "female", extension: [supplied] } }],
  });
  const patient = (bundle.entry as Array<{ resource: Res }>)[0]!.resource;
  assert.deepEqual(patient.extension, [supplied], "never overwrite what the source stated");
});

// A billed mammogram is not a result (owner decision 2026-11-05). Official CMS125's Mammography value set is
// 92 LOINC codes with no CPT and no HCPCS, so ingest derives nothing from a billed Procedure: the gap stays
// open until the result is charted, as WebChart's own report reads it. These replace the derivation's
// tests (ADR-057), which pinned the opposite.

const billedMammogram = (system: string, code: string): Res => ({
  resourceType: "Procedure",
  status: "completed",
  code: { coding: [{ system, code }] },
  performedDateTime: "2024-03-01T10:00:00Z",
});

/** A mammogram result as a server that charts it sends it: final, LOINC 24606-6, category imaging. */
const chartedMammogramResult = (): Res => ({
  resourceType: "Observation",
  status: "final",
  category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "imaging" }] }],
  code: { coding: [{ system: "http://loinc.org", code: ECQM_CANONICAL_CODES.mammogram.code }] },
  effectiveDateTime: "2024-03-01T10:00:00Z",
});

test("a billed mammogram (CPT 77067 or HCPCS G0202) derives no Observation; the Procedure passes through", () => {
  for (const [label, system, code] of [
    ["canonical CPT", MAMMOGRAPHY_PROCEDURE_CPT.system, MAMMOGRAPHY_PROCEDURE_CPT.code],
    ["CPT as OID", "urn:oid:2.16.840.1.113883.6.12", "77067"],
    ["canonical HCPCS", "http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets", "G0202"],
    ["HCPCS as OID, lowercase code", "urn:oid:2.16.840.1.113883.6.285", "g0202"],
  ] as const) {
    const bundle = normalizeWebChartBundle({ resourceType: "Bundle", entry: [{ resource: billedMammogram(system, code) }] });
    const resources = (bundle.entry as Array<{ resource: Res }>).map((e) => e.resource);
    assert.equal(resources.filter((r) => r.resourceType === "Observation").length, 0, `${label}: no Observation`);
    const procedures = resources.filter((r) => r.resourceType === "Procedure");
    assert.equal(procedures.length, 1, `${label}: the Procedure stays, and only it`);
    assert.equal(procedures[0]!.performedDateTime, "2024-03-01T10:00:00Z");
    assert.ok(
      ((procedures[0]!.code as { coding: Array<{ system?: string; code?: string }> }).coding).some((c) => c.system === system && c.code === code),
      `${label}: its own coding is kept`,
    );
  }
});

test("a charted mammogram result passes through untouched", () => {
  const sent = chartedMammogramResult();
  const bundle = normalizeWebChartBundle({ resourceType: "Bundle", entry: [{ resource: clone(sent) }] });
  const observations = (bundle.entry as Array<{ resource: Res }>).map((e) => e.resource).filter((r) => r.resourceType === "Observation");
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0]!.category, sent.category, "its category is the server's own");
  assert.equal(observations[0]!.meta, undefined, "nothing is tagged as derived");
});

test("official CMS125: a billed screening leaves the numerator unmet; a charted result meets it", { skip }, async () => {
  // Injected BEFORE normalization, into the four subjects the IPP admits, exactly as a live server's
  // resources would arrive. wc-49's 2015 mammogram is outside every age band and period, so the fixture
  // alone cannot show this.
  const withExtra = (extra: () => Res) =>
    asLiveServerWouldSend()
      .map((p) => {
        const resources = resourcesOf(p);
        const patient = resources.find((r) => r.resourceType === "Patient");
        const add = patient && CMS125_ACTIONABLE.includes(String(patient.id)) ? [{ ...extra(), subject: { reference: `Patient/${String(patient.id)}` } }] : [];
        return { resourceType: "Bundle", type: "collection", entry: [...resources, ...add].map((resource) => ({ resource })) };
      })
      .map((b) => normalizeWebChartBundle(b))
      .map((b) => withQualifyingVisit(b));

  const populations = async (bundles: readonly unknown[]) => {
    const executor = officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) });
    const subjects: OfficialBatchSubject[] = bundles.map((b) => ({ subjectId: patientIdOf(b), patientBundle: b }));
    const results = await executor.evaluateBatch("cms125", subjects, EVAL);
    const met = (type: string) =>
      [...results.entries()]
        .filter(([, r]) => (r.evidence as { official?: { populationResults?: Array<{ populationType: string; result: boolean }> } })?.official?.populationResults?.some((p) => p.populationType === type && p.result))
        .map(([id]) => id)
        .sort();
    return { ipp: met("initial-population"), numerator: met("numerator") };
  };

  const billed = await populations(withExtra(() => billedMammogram(MAMMOGRAPHY_PROCEDURE_CPT.system, MAMMOGRAPHY_PROCEDURE_CPT.code)));
  assert.deepEqual(billed.ipp, [...CMS125_ACTIONABLE].sort(), "the four stay in the initial population");
  assert.deepEqual(billed.numerator, [], "a bill is not a result: none of them meets the numerator");

  const charted = await populations(withExtra(chartedMammogramResult));
  assert.deepEqual(charted.numerator, [...CMS125_ACTIONABLE].sort(), "a charted LOINC result is SEEN");
});
