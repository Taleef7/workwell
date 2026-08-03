/**
 * The LIVE third-party path, evaluated through an official artifact — the gap
 * `devdb-official-eval.test.ts` names in its own header and deliberately leaves open.
 *   node --import tsx --test src/engine/ingress/webchart/live-official-parity.test.ts
 *
 * ## Why the existing gate could not see this
 *
 * That file runs the committed dev-DB fixture through the ingress path, and the fixture is produced by
 * `scripts/webchart-devdb-export.ts` — one of the two SQL→FHIR mappers ADR-042/ADR-044 fixed. So it
 * carries `us-core-sex` and (after ADR-044) a LOINC mammography Observation before normalization ever
 * runs. Both fixes sit **upstream of the live FHIR transport**, and `normalizeWebChartBundle` was
 * untouched by design — so a third-party WebChart server, which supplies only what its own FHIR API
 * emits, got neither. The measured consequences were recorded and left open in ADR-042/ADR-044 and in
 * `WEBCHART_FHIR_MAPPING.md` §3.1:
 *
 *   - no `us-core-sex` ⇒ official CMS125 puts the ENTIRE roster out of its initial population, silently,
 *     as 100% MISSING_DATA rather than an error;
 *   - a CPT/HCPCS mammography `Procedure` and no LOINC `Observation` ⇒ a woman who WAS screened reads
 *     OVERDUE, which `case-logic.ts` escalates to HIGH.
 *
 * ## What this file does
 *
 * It simulates a live server by taking the same fixture and **stripping exactly what our SQL mappers add
 * and a third party's FHIR API would not**: the `us-core-sex` extension, and the LOINC mammography
 * Observation. What is left is `Patient.gender` and a CPT Procedure — the live shape. Then it asserts
 * official CMS125 still admits the roster and still sees the screening.
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
import { parseEnrollmentRoster, stampEnrollment } from "../enrollment/roster.ts";
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

function resourcesOf(payload: unknown): Res[] {
  const entries = (payload as { entry?: Array<{ resource?: Res }> }).entry ?? [];
  return entries.map((e) => e.resource).filter((r): r is Res => !!r);
}

/**
 * What a third-party WebChart FHIR server sends: `Patient.gender` and a CPT Procedure, without the two
 * elements our own SQL mappers add. Everything else is the fixture untouched.
 */
function asLiveServerWouldSend(): unknown[] {
  return clone(payloads).map((payload) => {
    const p = payload as { entry?: Array<{ resource?: Res }> };
    p.entry = (p.entry ?? []).filter((e) => {
      const r = e.resource;
      if (!r) return true;
      if (r.resourceType === "Patient" && Array.isArray(r.extension)) {
        r.extension = (r.extension as Res[]).filter((x) => x.url !== US_CORE_SEX);
        if ((r.extension as Res[]).length === 0) delete r.extension;
      }
      // Drop the LOINC mammography Observation our crosswalk dual-stamps; the CPT Procedure stays.
      const coding = ((r.code as { coding?: Array<{ code?: string }> })?.coding ?? []) as Array<{ code?: string }>;
      return !(r.resourceType === "Observation" && coding.some((c) => c.code === ECQM_CANONICAL_CODES.mammogram.code));
    });
    return p;
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
    .map((b) => stampEnrollment(b as never, "cms125", roster, { evaluationDate: EVAL }));
}

/**
 * Undo ONE derivation after normalization, which is what makes the negative arm attributable.
 *
 * A first cut compared "normalized" against "not normalized at all" — which also disables terminology
 * reconciliation and the Observation→Procedure synthesis, so the 0 could have come from anywhere and a
 * future change that moved its cause would still read green (review, #390).
 */
function withoutDerived(kind: "sex" | "mammogram") {
  return (bundle: unknown) => {
    const b = clone(bundle) as { entry: Array<{ resource: Res }> };
    if (kind === "sex") {
      for (const { resource } of b.entry) {
        if (resource.resourceType !== "Patient" || !Array.isArray(resource.extension)) continue;
        const derived = ((resource.meta as { tag?: Array<{ code?: string }> })?.tag ?? []).some(
          (t) => t.code === "derived-from-gender",
        );
        if (derived) resource.extension = (resource.extension as Res[]).filter((x) => x.url !== US_CORE_SEX);
      }
      return b;
    }
    b.entry = b.entry.filter(
      (e) =>
        !((e.resource.meta as { tag?: Array<{ code?: string }> })?.tag ?? []).some(
          (t) => t.code === "derived-from-procedure",
        ),
    );
    return b;
  };
}

test("the fixture we strip really did carry both elements — otherwise this file proves nothing", () => {
  // The guard on the guard. If the fixture ever stops carrying `us-core-sex` or the LOINC mammogram,
  // every assertion below would pass trivially over data that never had them.
  const original = clone(payloads);
  const hasSex = original.some((p) =>
    resourcesOf(p).some(
      (r) => r.resourceType === "Patient" && ((r.extension as Res[]) ?? []).some((x) => x.url === US_CORE_SEX),
    ),
  );
  const hasMammogramObservation = original.some((p) =>
    resourcesOf(p).some(
      (r) =>
        r.resourceType === "Observation" &&
        (((r.code as { coding?: Array<{ code?: string }> })?.coding ?? []) as Array<{ code?: string }>).some(
          (c) => c.code === ECQM_CANONICAL_CODES.mammogram.code,
        ),
    ),
  );
  assert.ok(hasSex, "the committed fixture must carry us-core-sex for the strip to mean anything");
  assert.ok(hasMammogramObservation, "and the LOINC mammography Observation (ADR-044)");

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
  const without = await officialInIpp(liveBundles(withoutDerived("sex")));
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

test("a CPT mammography Procedure gains the LOINC imaging Observation the official numerator reads", () => {
  const bundle = normalizeWebChartBundle({
    resourceType: "Bundle",
    entry: [
      {
        resource: {
          resourceType: "Procedure",
          status: "completed",
          code: { coding: [{ system: MAMMOGRAPHY_PROCEDURE_CPT.system, code: MAMMOGRAPHY_PROCEDURE_CPT.code }] },
          performedDateTime: "2024-03-01T10:00:00Z",
        },
      },
    ],
  });
  const observations = (bundle.entry as Array<{ resource: Res }>)
    .map((e) => e.resource)
    .filter((r) => r.resourceType === "Observation");
  assert.equal(observations.length, 1);
  const [observation] = observations;
  assert.equal(
    ((observation!.code as { coding: Array<{ code: string }> }).coding[0]!).code,
    ECQM_CANONICAL_CODES.mammogram.code,
  );
  // `Status.isDiagnosticStudyPerformed` requires it; without the category the retrieve matches and the
  // predicate still rejects — the same invisible failure one step later.
  assert.equal(
    ((observation!.category as Array<{ coding: Array<{ code: string }> }>)[0]!.coding[0]!).code,
    "imaging",
  );
  assert.equal(observation!.status, "final");
  assert.equal(observation!.effectiveDateTime, "2024-03-01T10:00:00Z");
  assert.deepEqual((observation!.meta as { tag: Array<{ code: string }> }).tag[0]!.code, "derived-from-procedure");
});

test("a server that already sends the LOINC Observation gets no derived duplicate", () => {
  // Both numerators are `exists(...)`, so a duplicate cannot inflate them — but a COUNTING measure would
  // double-count, and the honest place to prevent that is here rather than in a warning nobody reads.
  const bundle = normalizeWebChartBundle({
    resourceType: "Bundle",
    entry: [
      {
        resource: {
          resourceType: "Procedure",
          status: "completed",
          code: { coding: [{ system: MAMMOGRAPHY_PROCEDURE_CPT.system, code: MAMMOGRAPHY_PROCEDURE_CPT.code }] },
          performedDateTime: "2024-03-01T10:00:00Z",
        },
      },
      {
        resource: {
          resourceType: "Observation",
          status: "final",
          category: [{ coding: [{ code: "imaging" }] }],
          code: { coding: [{ system: ECQM_CANONICAL_CODES.mammogram.system, code: ECQM_CANONICAL_CODES.mammogram.code }] },
          effectiveDateTime: "2024-03-01T10:00:00Z",
        },
      },
    ],
  });
  const observations = (bundle.entry as Array<{ resource: Res }>)
    .map((e) => e.resource)
    .filter((r) => r.resourceType === "Observation");
  assert.equal(observations.length, 1, "the server's own Observation is the only one");
  assert.equal(observations[0]!.meta, undefined, "and it is not tagged as derived");
});

test("a NON-final mammography Procedure derives nothing", () => {
  // `not-done` / `entered-in-error` means the screening did not happen. Deriving an Observation from it
  // would read as compliant — the failure `isFinalEvent` exists to prevent, one door along.
  for (const status of ["not-done", "entered-in-error", undefined]) {
    const bundle = normalizeWebChartBundle({
      resourceType: "Bundle",
      entry: [
        {
          resource: {
            resourceType: "Procedure",
            ...(status ? { status } : {}),
            code: { coding: [{ system: MAMMOGRAPHY_PROCEDURE_CPT.system, code: MAMMOGRAPHY_PROCEDURE_CPT.code }] },
            performedDateTime: "2024-03-01T10:00:00Z",
          },
        },
      ],
    });
    const observations = (bundle.entry as Array<{ resource: Res }>)
      .map((e) => e.resource)
      .filter((r) => r.resourceType === "Observation");
    assert.equal(observations.length, 0, `status '${status}' must derive nothing`);
  }
});

test("a Procedure that is not a mammogram derives nothing — this is an allowlist, not a sweep", () => {
  const bundle = normalizeWebChartBundle({
    resourceType: "Bundle",
    entry: [
      {
        resource: {
          resourceType: "Procedure",
          status: "completed",
          code: { coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "99213" }] },
          performedDateTime: "2024-03-01T10:00:00Z",
        },
      },
    ],
  });
  const observations = (bundle.entry as Array<{ resource: Res }>)
    .map((e) => e.resource)
    .filter((r) => r.resourceType === "Observation");
  assert.equal(observations.length, 0);
});

test("the mammography allowlist matches every coding the CROSSWALK matches", () => {
  // The two comparisons sat fifty lines apart and disagreed: the crosswalk normalizes system aliases and
  // upcases the code, an exact `system|code` match does neither. Measured in review (#390): a CPT-as-OID
  // mammogram reconciled to a cms125 event — so the AUTHORED engine read COMPLIANT — while the derivation
  // did not fire, so OFFICIAL read OVERDUE. The derivation created the divergence it exists to remove.
  const derivedCount = (system: string, code: string) => {
    const bundle = normalizeWebChartBundle({
      resourceType: "Bundle",
      entry: [
        {
          resource: {
            resourceType: "Procedure",
            status: "completed",
            code: { coding: [{ system, code }] },
            performedDateTime: "2024-03-01T10:00:00Z",
          },
        },
      ],
    });
    return (bundle.entry as Array<{ resource: Res }>).filter((e) => e.resource.resourceType === "Observation").length;
  };
  for (const [label, system, code] of [
    ["canonical CPT", "http://www.ama-assn.org/go/cpt", "77067"],
    ["CPT as OID", "urn:oid:2.16.840.1.113883.6.12", "77067"],
    ["CPT over https", "https://www.ama-assn.org/go/cpt", "77067"],
    ["CPT bare name", "cpt", "77067"],
    ["canonical HCPCS", "http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets", "G0202"],
    ["HCPCS as OID, lowercase code", "urn:oid:2.16.840.1.113883.6.285", "g0202"],
    ["code with surrounding space", "http://www.ama-assn.org/go/cpt", " 77067 "],
  ] as const) {
    assert.equal(derivedCount(system, code), 1, `${label} must derive the Observation`);
  }
  assert.equal(derivedCount("http://snomed.info/sct", "77067"), 0, "and a different SYSTEM must not");
});

test("the derived Observation actually satisfies the OFFICIAL NUMERATOR, not merely its shape", { skip }, async () => {
  // Every other mammography test here asserts the shape of a resource in a hand-built bundle. ADR-042
  // paid a measurement pass to learn that a retrieve can match while the predicate still rejects — so a
  // shape assertion is exactly the test that cannot see the failure it is written for (review, #390). The
  // fixture cannot close this either: its only mammogram belongs to wc-49, age 33 and dated 2015, so it
  // is outside both the age band and every measurement period. So inject one in-window screening into the
  // four subjects the IPP admits and read the numerator.
  const screened = (bundle: unknown) => {
    const b = clone(bundle) as { entry: Array<{ resource: Res }> };
    const patient = b.entry.find((e) => e.resource.resourceType === "Patient")?.resource;
    if (patient && CMS125_ACTIONABLE.includes(String(patient.id))) {
      b.entry.push({
        resource: {
          resourceType: "Procedure",
          status: "completed",
          code: { coding: [{ system: MAMMOGRAPHY_PROCEDURE_CPT.system, code: MAMMOGRAPHY_PROCEDURE_CPT.code }] },
          performedDateTime: "2024-03-01T10:00:00Z",
        },
      });
    }
    return b;
  };

  // Injected BEFORE normalization, so the derivation sees it exactly as a live server's Procedure.
  const withScreening = asLiveServerWouldSend()
    .map((p) => screened({ resourceType: "Bundle", type: "collection", entry: resourcesOf(p).map((resource) => ({ resource })) }))
    .map((b) => normalizeWebChartBundle(b))
    .map((b) => stampEnrollment(b as never, "cms125", roster, { evaluationDate: EVAL }));

  const numerator = async (bundles: readonly unknown[]) => {
    const executor = officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) });
    const subjects: OfficialBatchSubject[] = bundles.map((b) => ({ subjectId: patientIdOf(b), patientBundle: b }));
    const results = await executor.evaluateBatch("cms125", subjects, EVAL);
    return [...results.entries()]
      .filter(([, r]) => (r.evidence as { official?: { populationResults?: Array<{ populationType: string; result: boolean }> } })?.official?.populationResults?.some((p) => p.populationType === "numerator" && p.result))
      .map(([id]) => id)
      .sort();
  };

  assert.deepEqual(await numerator(withScreening), [...CMS125_ACTIONABLE].sort(), "the screening is SEEN");
  assert.deepEqual(
    await numerator(withScreening.map((b) => withoutDerived("mammogram")(b))),
    [],
    "and with only the CPT Procedure the official numerator sees nothing — the false OVERDUE this closes",
  );
});

test("an UNUSABLE mammography Observation does not suppress derivation from a valid Procedure", () => {
  // Presence of the code is not usability. An Observation the measure cannot count — preliminary,
  // entered-in-error, or missing `category ~ imaging` — would otherwise suppress the derivation and the
  // patient reads OVERDUE and is escalated HIGH (Codex, #390). Each unusable shape is pinned separately,
  // because each fails the official predicate for a different reason.
  const unusable: Array<[string, Res]> = [
    ["preliminary status", { status: "preliminary", category: [{ coding: [{ code: "imaging" }] }] }],
    ["entered-in-error", { status: "entered-in-error", category: [{ coding: [{ code: "imaging" }] }] }],
    ["no imaging category", { status: "final" }],
    ["wrong category", { status: "final", category: [{ coding: [{ code: "laboratory" }] }] }],
  ];
  for (const [label, shape] of unusable) {
    const bundle = normalizeWebChartBundle({
      resourceType: "Bundle",
      entry: [
        {
          resource: {
            resourceType: "Observation",
            ...shape,
            code: { coding: [{ system: ECQM_CANONICAL_CODES.mammogram.system, code: ECQM_CANONICAL_CODES.mammogram.code }] },
            effectiveDateTime: "2024-03-01T10:00:00Z",
          },
        },
        {
          resource: {
            resourceType: "Procedure",
            status: "completed",
            code: { coding: [{ system: MAMMOGRAPHY_PROCEDURE_CPT.system, code: MAMMOGRAPHY_PROCEDURE_CPT.code }] },
            performedDateTime: "2024-03-01T10:00:00Z",
          },
        },
      ],
    });
    const derived = (bundle.entry as Array<{ resource: Res }>).filter(
      (e) => ((e.resource.meta as { tag?: Array<{ code?: string }> })?.tag ?? []).some((t) => t.code === "derived-from-procedure"),
    );
    assert.equal(derived.length, 1, `an Observation with ${label} must not suppress a valid Procedure`);
  }
});

test("an OLD qualifying Observation does not suppress derivation from a RECENT Procedure", () => {
  // Suppression is per (subject, day). A screening from years ago is a real Observation the measure can
  // count — for its own date. Suppressing this year's Procedure because of it is how a currently-screened
  // woman reads OVERDUE.
  const bundle = normalizeWebChartBundle({
    resourceType: "Bundle",
    entry: [
      {
        resource: {
          resourceType: "Observation",
          status: "final",
          category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "imaging" }] }],
          code: { coding: [{ system: ECQM_CANONICAL_CODES.mammogram.system, code: ECQM_CANONICAL_CODES.mammogram.code }] },
          effectiveDateTime: "2015-07-05T10:00:00Z",
        },
      },
      {
        resource: {
          resourceType: "Procedure",
          status: "completed",
          code: { coding: [{ system: MAMMOGRAPHY_PROCEDURE_CPT.system, code: MAMMOGRAPHY_PROCEDURE_CPT.code }] },
          performedDateTime: "2024-03-01T10:00:00Z",
        },
      },
    ],
  });
  const derived = (bundle.entry as Array<{ resource: Res }>).filter(
    (e) => ((e.resource.meta as { tag?: Array<{ code?: string }> })?.tag ?? []).some((t) => t.code === "derived-from-procedure"),
  );
  assert.equal(derived.length, 1);
  assert.equal((derived[0]!.resource as Res).effectiveDateTime, "2024-03-01T10:00:00Z", "and it carries the RECENT date");
});

test("two patients in one payload do not suppress each other", () => {
  // `normalizeWebChartBundle` is exported and `extractResources` flattens arrays of bundles, so the
  // one-patient-per-payload invariant the HTTP transport happens to satisfy is not this function's to
  // assume. Bundle-wide, patient B's screening would vanish because patient A recorded theirs.
  const mammogramFor = (subject: string, kind: "observation" | "procedure") =>
    kind === "observation"
      ? {
          resourceType: "Observation",
          status: "final",
          subject: { reference: subject },
          category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "imaging" }] }],
          code: { coding: [{ system: ECQM_CANONICAL_CODES.mammogram.system, code: ECQM_CANONICAL_CODES.mammogram.code }] },
          effectiveDateTime: "2024-03-01T10:00:00Z",
        }
      : {
          resourceType: "Procedure",
          status: "completed",
          subject: { reference: subject },
          code: { coding: [{ system: MAMMOGRAPHY_PROCEDURE_CPT.system, code: MAMMOGRAPHY_PROCEDURE_CPT.code }] },
          performedDateTime: "2024-03-01T10:00:00Z",
        };
  const bundle = normalizeWebChartBundle({
    resourceType: "Bundle",
    entry: [
      { resource: mammogramFor("Patient/A", "observation") },
      { resource: mammogramFor("Patient/B", "procedure") },
    ],
  });
  const derived = (bundle.entry as Array<{ resource: Res }>).filter(
    (e) => ((e.resource.meta as { tag?: Array<{ code?: string }> })?.tag ?? []).some((t) => t.code === "derived-from-procedure"),
  );
  assert.equal(derived.length, 1, "B's Procedure must still derive");
  assert.deepEqual((derived[0]!.resource as Res).subject, { reference: "Patient/B" });
});
