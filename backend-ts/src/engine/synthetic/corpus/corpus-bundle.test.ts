import test from "node:test";
import assert from "node:assert/strict";
import { bundleForPatient, practitionerResources, organizationResources, payerAndSourceOrganizationResources } from "./corpus-bundle.ts";
import { patientAt, corpusPatients } from "./corpus-patient.ts";
import { ETHNICITY_CODES, PAYER_TYPE_CODES, RACE_CODES, SUD_CONDITION_CODES } from "../../cql/bundled-ecqm-expansions.ts";
import { DEFAULT_CORPUS_SEED, PCPS, CLINICS, CORPUS_GENERATOR_VERSION } from "./corpus-parameters.ts";

const EVAL_DATE = "2027-12-31";

/**
 * The resources that are ABOUT the patient rather than facts somebody recorded: the Patient, its
 * Coverage (administrative context, read by `SDE Payer`), and the Provenance records themselves. Every
 * other resource is a clinical fact and carries exactly one Provenance.
 */
const ADMINISTRATIVE = new Set(["Patient", "Coverage", "Provenance"]);

type Res = Record<string, unknown> & { resourceType: string; id: string };
const resourcesOf = (patient: Parameters<typeof bundleForPatient>[0]): Res[] =>
  bundleForPatient(patient, EVAL_DATE).entry.map((e) => e.resource as Res);

test("every clinical resource has exactly one Provenance whose target resolves inside the bundle", () => {
  for (const patient of corpusPatients(DEFAULT_CORPUS_SEED, 200)) {
    const entries = resourcesOf(patient);
    const ids = new Set(entries.map((r) => `${r.resourceType}/${r.id}`));
    const provenances = entries.filter((r) => r.resourceType === "Provenance");
    const clinical = entries.filter((r) => !ADMINISTRATIVE.has(r.resourceType));
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
    types.filter((t) => !ADMINISTRATIVE.has(t)).length,
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
  let sawImaging = false;
  let sawEncounterDiagnosis = false;
  let sawCancelled = false;

  for (const patient of corpusPatients(DEFAULT_CORPUS_SEED, 400)) {
    for (const r of resourcesOf(patient)) {
      const profile = profileOf(r);
      assert.ok(profile, `${patient.externalId}: ${r.resourceType} carries no meta.profile at all`);
      if (r.resourceType === "Patient") assert.match(profile, /qicore-patient$/);
      if (r.resourceType === "Encounter") assert.match(profile, /qicore-encounter$/);
      if (r.resourceType === "Condition") {
        const code = ((r.code as { coding: Array<{ code: string }> }).coding[0]!.code);
        if (SUD_CONDITION_CODES.some((c) => c.code === code)) {
          // CMS137 retrieves the SUD diagnosis through the ENCOUNTER-DIAGNOSIS profile only, and its
          // denominator is an encounter the diagnosis starts during — so it is that profile, with the
          // encounter it belongs to, or the measure never sees it.
          sawEncounterDiagnosis = true;
          assert.match(profile, /qicore-condition-encounter-diagnosis$/, "a SUD episode diagnosis is an encounter diagnosis");
          assert.ok(typeof (r.encounter as { reference?: string } | undefined)?.reference === "string", "and it references the encounter it was made in");
        } else {
          assert.match(profile, /qicore-condition-problems-health-concerns$/,
            "a problem-list Condition must carry the problems-health-concerns profile, not the generic qicore-condition");
        }
      }
      if (r.resourceType === "Observation") {
        const code = ((r.code as { coding: Array<{ code: string }> }).coding[0]!.code);
        if (code === "85354-9") {
          sawBp = true;
          // CMS165 identifies a blood pressure by PROFILE ALONE, with no code filter. This stamp is the
          // only thing that would make the reading retrievable once profiles are trusted.
          assert.match(profile, /us-core-blood-pressure$/, "a BP panel must carry the US Core BP profile");
        } else if ((code === "73832-8" || code === "73831-0") && r.status === "cancelled") {
          // A documented REFUSAL is the screening instrument, cancelled, with the refusal as its
          // notDoneReason — the only shape CMS2's denominator exception retrieves. A final Observation
          // coded with the refusal itself (what the corpus emitted before) matched nothing and left every
          // refusing patient OVERDUE.
          sawCancelled = true;
          assert.match(profile, /qicore-observationcancelled$/, "a refusal is a cancelled screening observation");
          const reason = (r.extension as Array<{ url: string; valueCodeableConcept?: { coding: Array<{ code: string }> } }>)
            .find((e) => e.url.endsWith("qicore-notDoneReason"))?.valueCodeableConcept?.coding[0]?.code;
          assert.equal(reason, "720834000", "the refusal reason is the artifact's own direct-reference code, in the notDoneReason extension");
          assert.ok(typeof r.issued === "string", "the exception join reads `issued`");
        } else if (code === "73832-8" || code === "73831-0") {
          sawScreening = true;
          assert.match(profile, /qicore-observation-screening-assessment$/,
            "a depression screen must carry the screening-assessment profile, not clinical-result");
        } else if (code === "24606-6") {
          // A mammogram is an IMAGING result: `qicore-observation-clinical-result`, which is the profile
          // CMS125's `[Observation: "Mammography"]` retrieve names. It carried the LAB profile with an
          // `imaging` category until 2026-09-06 — a resource contradicting itself.
          sawImaging = true;
          assert.match(profile, /qicore-observation-clinical-result$/, "a mammogram is a clinical (imaging) result, not a lab");
          const category = (r.category as Array<{ coding: Array<{ code: string }> }>)[0]!.coding[0]!.code;
          assert.equal(category, "imaging");
        } else {
          sawLab = true;
          assert.match(profile, /qicore-observation-lab$/);
        }
      }
      if (r.resourceType === "Coverage") assert.match(profile, /qicore-coverage$/);
      if (r.resourceType === "MedicationRequest") assert.match(profile, /qicore-medicationrequest$/);
    }
  }
  assert.ok(
    sawBp && sawScreening && sawLab && sawImaging && sawEncounterDiagnosis && sawCancelled,
    `the sample must exercise every shape (bp=${sawBp} screening=${sawScreening} lab=${sawLab} imaging=${sawImaging} encounterDx=${sawEncounterDiagnosis} cancelled=${sawCancelled})`,
  );
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

  // Either SUD diagnosis: alcohol abuse for most patients, cocaine-induced mood disorder for the rest.
  // Pinning one code made the test a check on the code rather than on the resource being emitted at all.
  const episode = resources.find((r) => r.resourceType === "Condition" && SUD_CONDITION_CODES.some((c) => c.code === codeOf(r)));
  assert.ok(episode, "the SUD episode is a Condition the denominator can key on");
  assert.equal((episode!.clinicalStatus as { coding: Array<{ system: string }> }).coding[0]!.system,
    "http://terminology.hl7.org/CodeSystem/condition-clinical", "clinicalStatus carries its system");

  // THE JOIN the measure actually performs: `First SUD Episode During Measurement Period` is a qualifying
  // ENCOUNTER with an encounter-diagnosis Condition whose prevalence interval STARTS INSIDE the encounter's
  // period. A Condition on its own — which is what the corpus emitted until 2026-09-06, onset at midnight
  // on a day with no visit — matches nothing, and the credentialed CI job measured inIPP=0 for cms137.
  const encounterRef = (episode!.encounter as { reference: string }).reference;
  const encounter = resources.find((r) => `${r.resourceType}/${r.id}` === encounterRef);
  assert.ok(encounter, `the episode's encounter ${encounterRef} is in the bundle`);
  const period = encounter!.period as { start: string; end: string };
  const onset = episode!.onsetDateTime as string;
  assert.ok(period.start <= onset && onset <= period.end, `onset ${onset} must fall inside the encounter ${period.start}..${period.end}`);
  const encounterType = ((encounter!.type as Array<{ coding: Array<{ code: string }> }>)[0]!.coding[0]!.code);
  assert.equal(encounterType, "99213", "the episode encounter is an office visit — a member of the artifact's qualifying set");
  assert.equal(((episode!.category as Array<{ coding: Array<{ code: string }> }>)[0]!.coding[0]!.code), "encounter-diagnosis");

  const treatments = resources.filter((r) => r.resourceType === "Procedure" && codeOf(r) === "171047005");
  assert.ok(treatments.length >= 1, "initiation and engagement are treatment Procedures");

  // Still one Provenance per clinical resource — adding a resource type must not break that invariant.
  const clinical = resources.filter((r) => !ADMINISTRATIVE.has(r.resourceType));
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
  // `hospice` joined this list in the review pass: it was drawn and counted but never emitted, so the
  // exclusion it exists for could never fire on any measure. `frailty` joined in 4.0.0 for the same
  // reason. `palliativeCare`, `bilateralMastectomy` and `totalColectomy` are drawn as conditions but
  // emitted as PROCEDURES through their events, so they are counted there and not here — which is why
  // this list is explicit rather than derived from `patient.conditions`.
  const CODED_CONDITIONS = ["diabetes", "hypertension", "bipolar", "colorectalCancer", "esrd", "hospice", "frailty"];
  for (const patient of corpusPatients(DEFAULT_CORPUS_SEED, 600)) {
    const emitted = resourcesOf(patient).filter((r) => !ADMINISTRATIVE.has(r.resourceType));
    const expected =
      patient.visits.length
      + patient.conditions.filter((c) => CODED_CONDITIONS.includes(c)).length
      + patient.events.length                                              // one resource per event...
      + patient.events.filter((e) => e.kind === "sudEpisode").length     // ...plus the episode's Encounter
      + patient.events.filter((e) => e.kind === "mammogram").length      // ...plus the dual-stamped Procedure, ADR-044
      + patient.exceptions.length;
    assert.equal(emitted.length, expected, `${patient.externalId}: resource count does not match its events`);
  }
});

/**
 * What the Patient carries is what the artifacts READ. CMS125's initial population compares the
 * `us-core-sex` extension to SNOMED 248152002 — not `gender` — and the credentialed CI job measured
 * inIPP=0 for cms125 over 200 subjects when the corpus Patient carried gender alone. Race and ethnicity
 * are what `SDE Race` / `SDE Ethnicity` read; the Coverage is what `SDE Payer` reads.
 */
test("the Patient carries us-core-sex, us-core-race and us-core-ethnicity, and one active Coverage with a verified payer", () => {
  const payerOrganizations = new Set(payerAndSourceOrganizationResources().map((r) => r.id as string));
  const payerCodes = new Set(PAYER_TYPE_CODES.map((c) => c.code));
  const raceCodes = new Set(RACE_CODES.map((c) => c.code));
  const ethnicityCodes = new Set(ETHNICITY_CODES.map((c) => c.code));
  for (const patient of corpusPatients(DEFAULT_CORPUS_SEED, 300)) {
    const resources = resourcesOf(patient);
    const person = resources.find((r) => r.resourceType === "Patient")!;
    const extensions = person.extension as Array<{ url: string; valueCode?: string; extension?: Array<{ url: string; valueCoding?: { system: string; code: string } }> }>;
    const byUrl = (suffix: string) => extensions.find((e) => e.url.endsWith(suffix));
    const sex = byUrl("us-core-sex");
    assert.equal(sex?.valueCode, patient.sex === "F" ? "248152002" : "248153007", `${patient.externalId}: us-core-sex`);
    const race = byUrl("us-core-race")?.extension?.find((e) => e.url === "ombCategory")?.valueCoding;
    assert.ok(race && raceCodes.has(race.code) && race.system === "urn:oid:2.16.840.1.113883.6.238", `${patient.externalId}: us-core-race ombCategory`);
    const ethnicity = byUrl("us-core-ethnicity")?.extension?.find((e) => e.url === "ombCategory")?.valueCoding;
    assert.ok(ethnicity && ethnicityCodes.has(ethnicity.code), `${patient.externalId}: us-core-ethnicity ombCategory`);

    const coverages = resources.filter((r) => r.resourceType === "Coverage");
    assert.equal(coverages.length, 1, `${patient.externalId}: exactly one Coverage`);
    const coverage = coverages[0]!;
    assert.equal(coverage.status, "active");
    const type = (coverage.type as { coding: Array<{ system: string; code: string }> }).coding[0]!;
    assert.equal(type.system, "https://nahdo.org/sopt", "Coverage.type is Source of Payment Typology — the system of every Payer Type member");
    assert.ok(payerCodes.has(type.code), `${patient.externalId}: payer ${type.code} is not one of the verified codes`);
    assert.equal((coverage.beneficiary as { reference: string }).reference, `Patient/${patient.externalId}`);
    const payor = (coverage.payor as Array<{ reference: string }>)[0]!.reference.split("/")[1]!;
    assert.ok(payerOrganizations.has(payor), `${patient.externalId}: Coverage.payor ${payor} does not resolve to an emitted Organization`);
    const period = coverage.period as { start: string; end: string };
    assert.equal(period.start, `${patient.measurementYear}-01-01`);
    assert.equal(period.end, `${patient.measurementYear}-12-31`);
  }
});

/**
 * The denominator EXCLUSIONS the ACO's measures share must have data that can fire them. Before 4.0.0
 * frailty was drawn and never emitted, and palliative care, a bilateral mastectomy and a total colectomy
 * were not drawn at all — so on the whole corpus a regression in exclusion handling was undetectable.
 */
test("the exclusion cohorts are emitted: frailty with its dementia medication or advanced-illness diagnosis, palliative care, mastectomy, colectomy", () => {
  const all = corpusPatients(DEFAULT_CORPUS_SEED, 20000);
  const codeOf = (r: Res) => (r.code as { coding: Array<{ code: string }> } | undefined)?.coding[0]?.code
    ?? (r.medicationCodeableConcept as { coding: Array<{ code: string }> } | undefined)?.coding[0]?.code;

  const frail = all.filter((p) => p.conditions.includes("frailty"));
  assert.ok(frail.length > 100, `${frail.length} frail patients — the 65+ prevalence should yield hundreds at 20,000`);
  assert.ok(frail.every((p) => p.age >= 66), "frailty is drawn only from 66 — the exclusion's own floor");
  let withDementiaMed = 0;
  let withAdvancedIllness = 0;
  for (const patient of frail.slice(0, 120)) {
    const resources = resourcesOf(patient);
    assert.ok(resources.some((r) => r.resourceType === "Condition" && codeOf(r) === "129588001"), `${patient.externalId}: the frailty diagnosis is emitted`);
    if (resources.some((r) => r.resourceType === "MedicationRequest" && codeOf(r) === "1100184")) withDementiaMed += 1;
    if (resources.some((r) => r.resourceType === "Condition" && codeOf(r) === "42343007")) withAdvancedIllness += 1;
  }
  assert.ok(withDementiaMed > 0 && withAdvancedIllness > 0, `frail sample: dementia med ${withDementiaMed}, advanced illness ${withAdvancedIllness} — both halves of the exclusion must be reachable`);
  assert.ok(withDementiaMed < 120 || withAdvancedIllness < 120, "and not every frail patient carries both — some stay in the denominator, as the logic says");

  const byEvent = (kind: string, code: string, type = "Procedure") => {
    const carriers = all.filter((p) => p.events.some((e) => e.kind === kind));
    assert.ok(carriers.length > 5, `${kind}: ${carriers.length} carriers at 20,000`);
    for (const patient of carriers.slice(0, 20)) {
      assert.ok(resourcesOf(patient).some((r) => r.resourceType === type && codeOf(r) === code), `${patient.externalId}: ${kind} emitted as ${type} ${code}`);
    }
    return carriers;
  };
  byEvent("palliativeCare", "103735009");
  const mastectomy = byEvent("bilateralMastectomy", "1268980002");
  assert.ok(mastectomy.every((p) => p.sex === "F"), "a bilateral mastectomy history is drawn for women only");
  byEvent("totalColectomy", "26390003");
  // Surgical HISTORY is dated before the period; palliative care is dated inside it.
  for (const p of mastectomy.slice(0, 20)) {
    for (const e of p.events.filter((e) => e.kind === "bilateralMastectomy")) assert.ok(e.date < `${p.measurementYear}-01-01`, `${p.externalId}: mastectomy ${e.date} is history`);
  }
});

/**
 * Identity is the same in every year; only the clinical facts move. This is what lets a deployment
 * evaluated in 2026 and again in 2027 show the same roster with a year's worth of different data, and
 * what keeps `corpusBundleSource`'s identity cross-check (DOB / site / PCP / sex) valid across years.
 */
test("a patient is the same PERSON in every measurement year, and their age follows the year", () => {
  for (const index of [3, 47, 48, 1234, 19999]) {
    const in2026 = patientAt(DEFAULT_CORPUS_SEED, index, new Set(), 2026);
    const in2027 = patientAt(DEFAULT_CORPUS_SEED, index, new Set(), 2027);
    for (const key of ["externalId", "name", "sex", "dateOfBirth", "site", "providerId", "payer", "race", "ethnicity"] as const) {
      assert.equal(in2026[key], in2027[key], `${in2027.externalId}: ${key} must not depend on the year`);
    }
    assert.equal(in2027.age, in2026.age + 1, `${in2027.externalId}: one year older in 2027`);
    assert.equal(in2026.measurementYear, 2026);
    assert.equal(in2027.measurementYear, 2027);
    for (const visit of in2026.visits) assert.ok(visit.startsWith("2026-"), `${in2026.externalId}: visit ${visit} is in 2026`);
    for (const visit of in2027.visits) assert.ok(visit.startsWith("2027-"), `${in2027.externalId}: visit ${visit} is in 2027`);
    // The bundle follows the record: a 2026 evaluation date builds 2026 encounters and a 2026 Coverage.
    const bundle2026 = bundleForPatient(in2026, "2026-09-06").entry.map((e) => e.resource as Res);
    for (const enc of bundle2026.filter((r) => r.resourceType === "Encounter")) {
      assert.ok(((enc.period as { start: string }).start).startsWith("2026-"), `${in2026.externalId}: encounter in 2026`);
    }
    assert.equal(((bundle2026.find((r) => r.resourceType === "Coverage")!.period as { start: string }).start), "2026-01-01");
  }
});

test("the informant Organization every external event's Provenance names is emitted and resolvable", () => {
  const ids = new Set(payerAndSourceOrganizationResources().map((r) => r.id as string));
  const patient = corpusPatients(DEFAULT_CORPUS_SEED, 400).find((p) => p.events.some((e) => e.external))!;
  const informants = resourcesOf(patient)
    .filter((r) => r.resourceType === "Provenance")
    .flatMap((p) => (p.agent as Array<{ type: { coding: Array<{ code: string }> }; who: { reference?: string } }>).filter((a) => a.type.coding[0]!.code === "informant"));
  assert.ok(informants.length > 0);
  for (const agent of informants) {
    const ref = agent.who.reference;
    assert.ok(ref, "an informant is a RESOLVABLE reference, not a display-only string");
    assert.ok(ids.has(ref!.split("/")[1]!), `${ref} does not resolve to an emitted Organization`);
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
