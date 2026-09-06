import test from "node:test";
import assert from "node:assert/strict";
import { bundleForPatient, practitionerResources, organizationResources } from "./corpus-bundle.ts";
import { patientAt, corpusPatients } from "./corpus-patient.ts";
import { DEFAULT_CORPUS_SEED, PCPS, CLINICS, CORPUS_GENERATOR_VERSION } from "./corpus-parameters.ts";

const EVAL_DATE = "2027-12-31";

type Res = Record<string, unknown> & { resourceType: string; id: string };
const resourcesOf = (patient: Parameters<typeof bundleForPatient>[0]): Res[] =>
  bundleForPatient(patient, EVAL_DATE).entry.map((e) => e.resource as Res);

test("every clinical resource has exactly one Provenance whose target resolves inside the bundle", () => {
  for (const patient of corpusPatients(DEFAULT_CORPUS_SEED, 200)) {
    const entries = resourcesOf(patient);
    const ids = new Set(entries.map((r) => `${r.resourceType}/${r.id}`));
    const provenances = entries.filter((r) => r.resourceType === "Provenance");
    const clinical = entries.filter((r) => !["Patient", "Provenance"].includes(r.resourceType));
    assert.equal(provenances.length, clinical.length, `${patient.externalId}: one Provenance per clinical resource`);
    for (const prov of provenances) {
      const target = (prov.target as Array<{ reference: string }>)[0]!.reference;
      assert.ok(ids.has(target), `${patient.externalId}: Provenance targets ${target}, which is not in the bundle`);
    }
  }
});

test("Provenance names the patient's own PCP and clinic, and an external informant only when the event is external", () => {
  const patient = corpusPatients(DEFAULT_CORPUS_SEED, 400).find((p) => p.events.some((e) => e.external))!;
  const provenances = resourcesOf(patient).filter((r) => r.resourceType === "Provenance");
  for (const prov of provenances) {
    const agents = prov.agent as Array<{ type: { coding: Array<{ code: string }> }; who: { reference?: string; display?: string }; onBehalfOf?: { reference: string } }>;
    const author = agents.find((a) => a.type.coding[0]!.code === "author")!;
    assert.equal(author.who.reference, `Practitioner/${patient.providerId}`);
    assert.match(author.onBehalfOf!.reference, /^Organization\/maui-clinic-/);
    const entity = prov.entity as Array<{ what: { display: string } }>;
    assert.equal(entity[0]!.what.display, `WorkWell synthetic corpus ${DEFAULT_CORPUS_SEED} #${CORPUS_GENERATOR_VERSION}`);
  }
  assert.ok(
    provenances.some((p) => (p.agent as Array<{ type: { coding: Array<{ code: string }> } }>).some((a) => a.type.coding[0]!.code === "informant")),
    "an external event carries an informant agent",
  );
  // ...and the informant appears ONLY there. Without this the assertion above passes on an
  // implementation that stamps every resource as externally sourced, which is the opposite claim.
  const internalOnly = corpusPatients(DEFAULT_CORPUS_SEED, 400).find((p) => p.events.length > 0 && p.events.every((e) => !e.external))!;
  const internalProvenances = resourcesOf(internalOnly).filter((r) => r.resourceType === "Provenance");
  assert.ok(
    internalProvenances.every((p) => (p.agent as Array<{ type: { coding: Array<{ code: string }> } }>).every((a) => a.type.coding[0]!.code !== "informant")),
    `${internalOnly.externalId}: no event is external, so no Provenance may claim an outside informant`,
  );
});

test("a patient with no conditions still gets a Patient and their encounters, and no orphan Provenance", () => {
  const bare = corpusPatients(DEFAULT_CORPUS_SEED, 400).find((p) => p.conditions.length === 0)!;
  const types = resourcesOf(bare).map((r) => r.resourceType);
  assert.ok(types.includes("Patient"));
  assert.ok(types.includes("Encounter"));
  assert.equal(
    types.filter((t) => t === "Provenance").length,
    types.filter((t) => !["Patient", "Provenance"].includes(t)).length,
  );
});

test("bundleForPatient is pure — the same patient yields byte-identical JSON", () => {
  const p = patientAt(DEFAULT_CORPUS_SEED, 1234);
  assert.equal(JSON.stringify(bundleForPatient(p, EVAL_DATE)), JSON.stringify(bundleForPatient(p, EVAL_DATE)));
});

test("the 40 Practitioners and 5 Organizations are emitted once with the ids the bundles reference", () => {
  assert.deepEqual(practitionerResources().map((r) => r.id), PCPS.map((p) => p.id));
  assert.deepEqual(organizationResources().map((r) => r.id), CLINICS.map((c) => c.id));
  // The references in a patient bundle must resolve against those two sets, or the corpus is internally
  // broken in a way no single-bundle test would notice.
  const practitionerIds = new Set(practitionerResources().map((r) => r.id));
  const organizationIds = new Set(organizationResources().map((r) => r.id));
  for (const patient of corpusPatients(DEFAULT_CORPUS_SEED, 300)) {
    const person = resourcesOf(patient).find((r) => r.resourceType === "Patient")!;
    const gp = (person.generalPractitioner as Array<{ reference: string }>)[0]!.reference.split("/")[1]!;
    const org = (person.managingOrganization as { reference: string }).reference.split("/")[1]!;
    assert.ok(practitionerIds.has(gp), `${patient.externalId}: unknown Practitioner ${gp}`);
    assert.ok(organizationIds.has(org), `${patient.externalId}: unknown Organization ${org}`);
  }
});

/**
 * Profile stamping is what the official artifacts retrieve on, and a wrong stamp is SILENT — the
 * measure simply reports nobody. These pin the four that differ from the binding builder's generic
 * choices, because "it has an Observation" is exactly the assertion that would not have caught it.
 */
test("each resource carries the profile its artifact retrieves on, not a generic one", () => {
  const profileOf = (r: Res) => ((r.meta as { profile: string[] }).profile[0] ?? "");
  let sawBp = false;
  let sawScreening = false;
  let sawLab = false;

  for (const patient of corpusPatients(DEFAULT_CORPUS_SEED, 400)) {
    for (const r of resourcesOf(patient)) {
      const profile = profileOf(r);
      assert.ok(profile, `${patient.externalId}: ${r.resourceType} carries no meta.profile at all`);
      if (r.resourceType === "Patient") assert.match(profile, /qicore-patient$/);
      if (r.resourceType === "Encounter") assert.match(profile, /qicore-encounter$/);
      if (r.resourceType === "Condition") {
        assert.match(profile, /qicore-condition-problems-health-concerns$/,
          "a Condition must carry the problems-health-concerns profile, not the generic qicore-condition");
      }
      if (r.resourceType === "Observation") {
        const code = ((r.code as { coding: Array<{ code: string }> }).coding[0]!.code);
        if (code === "85354-9") {
          sawBp = true;
          // CMS165 identifies a blood pressure by PROFILE ALONE, with no code filter. This stamp is the
          // only thing that would make the reading retrievable once profiles are trusted.
          assert.match(profile, /us-core-blood-pressure$/, "a BP panel must carry the US Core BP profile");
        } else if (code === "73832-8" || code === "73831-0" || code === "720834000") {
          sawScreening = true;
          assert.match(profile, /qicore-observation-screening-assessment$/,
            "a depression screen must carry the screening-assessment profile, not clinical-result");
        } else {
          sawLab = true;
          assert.match(profile, /qicore-observation-lab$/);
        }
      }
    }
  }
  assert.ok(sawBp && sawScreening && sawLab, `the sample must exercise all three Observation shapes (bp=${sawBp} screening=${sawScreening} lab=${sawLab})`);
});

test("a mammogram is dual-stamped: the LOINC Observation and the CPT Procedure (ADR-044)", () => {
  const patient = corpusPatients(DEFAULT_CORPUS_SEED, 400).find((p) => p.events.some((e) => e.kind === "mammogram"))!;
  const resources = resourcesOf(patient);
  const observation = resources.find((r) => r.resourceType === "Observation" && ((r.code as { coding: Array<{ code: string }> }).coding[0]!.code === "24606-6"));
  const procedure = resources.find((r) => r.resourceType === "Procedure" && ((r.code as { coding: Array<{ code: string }> }).coding[0]!.code === "77067"));
  assert.ok(observation, "the official artifact retrieves the LOINC Observation");
  assert.ok(procedure, "the authored cms125 retrieves the CPT Procedure");
});

/**
 * CMS137 (MIPS 305). Its events were deliberately unrepresented until the measure was vendored and
 * gated; now the episode is the Condition its denominator keys on and the two treatment contacts are
 * the Procedures its two rates count. Every code comes from the artifact's own expansion.
 */
test("CMS137's SUD events become the Condition and Procedures the measure retrieves", () => {
  const patient = corpusPatients(DEFAULT_CORPUS_SEED, 600).find(
    (p) => p.events.some((e) => e.kind === "sudEpisode") && p.events.some((e) => e.kind === "sudInitiation"),
  )!;
  const resources = resourcesOf(patient);
  const codeOf = (r: Res) => (r.code as { coding: Array<{ code: string }> } | undefined)?.coding[0]?.code;

  const episode = resources.find((r) => r.resourceType === "Condition" && codeOf(r) === "10327003");
  assert.ok(episode, "the SUD episode is a Condition the denominator can key on");
  assert.equal((episode!.clinicalStatus as { coding: Array<{ system: string }> }).coding[0]!.system,
    "http://terminology.hl7.org/CodeSystem/condition-clinical", "clinicalStatus carries its system");

  const treatments = resources.filter((r) => r.resourceType === "Procedure" && codeOf(r) === "171047005");
  assert.ok(treatments.length >= 1, "initiation and engagement are treatment Procedures");

  // Still one Provenance per clinical resource — adding a resource type must not break that invariant.
  const clinical = resources.filter((r) => !["Patient", "Provenance"].includes(r.resourceType));
  const provenances = resources.filter((r) => r.resourceType === "Provenance");
  assert.equal(provenances.length, clinical.length);
});

/**
 * The exact-count invariant, restored. The version this replaces filtered the bundle to the two known
 * SUD constants and asserted the result was non-empty — which cannot detect an invented code, and had
 * displaced a count check that proved nothing EXTRA was emitted. Counting every clinical resource
 * against what the patient's own events imply catches both.
 */
test("the bundle emits exactly the resources the patient's events imply — nothing extra, nothing invented", () => {
  const CODED_CONDITIONS = ["diabetes", "hypertension", "bipolar", "colorectalCancer", "esrd"];
  for (const patient of corpusPatients(DEFAULT_CORPUS_SEED, 600)) {
    const emitted = resourcesOf(patient).filter((r) => !["Patient", "Provenance"].includes(r.resourceType));
    const expected =
      patient.visits.length
      + patient.conditions.filter((c) => CODED_CONDITIONS.includes(c)).length
      + patient.events.filter((e) => e.kind !== "sudEpisode").length
      + patient.events.filter((e) => e.kind === "sudEpisode").length     // episode → Condition
      + patient.events.filter((e) => e.kind === "mammogram").length      // dual-stamped, ADR-044
      + patient.exceptions.length;
    assert.equal(emitted.length, expected, `${patient.externalId}: resource count does not match its events`);
  }
});

/**
 * CMS137 rate 2 requires TWO OR MORE further services within 34 days of initiating. A generator that
 * emitted one engagement event could never put anybody in that numerator, so the Engagement rate would
 * read 0% across the whole corpus — the rate multi-rate support exists to surface.
 */
test("an engaged patient carries at least two engagement services, so rate 2's numerator is reachable", () => {
  const all = corpusPatients(DEFAULT_CORPUS_SEED, 5000);
  const engaged = all.filter((p) => p.events.filter((e) => e.kind === "sudEngagement").length > 0);
  assert.ok(engaged.length > 0, "the sample must contain engaged patients");
  for (const patient of engaged) {
    const services = patient.events.filter((e) => e.kind === "sudEngagement");
    assert.ok(services.length >= 2, `${patient.externalId}: ${services.length} engagement service(s) — rate 2 needs 2+`);
    // ...and both inside the 34-day window the measure counts.
    const initiation = patient.events.find((e) => e.kind === "sudInitiation")!;
    for (const service of services) {
      const days = (Date.parse(`${service.date}T00:00:00Z`) - Date.parse(`${initiation.date}T00:00:00Z`)) / 86400000;
      assert.ok(days > 0 && days <= 34, `${patient.externalId}: engagement ${days} days after initiation, outside the window`);
    }
  }
});
