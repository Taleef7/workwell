/**
 * WebChart FHIR bundle normalization (E12 PR-2).
 *
 * The chosen integration path is WebChart's HTTP/FHIR API (ADR decision 2026-07-03; details firming
 * up with Dave Carlson). This module coerces whatever the API yields per patient into the exact
 * `Bundle` (type `collection`) shape the unchanged `CqlExecutionEngine` consumes (mirrors
 * `engine/synthetic/fhir-bundle-builder.ts`), and applies the terminology reconciliation so real
 * LOINC/CVX/CPT codings gain the synthetic measure-event coding the CQL inline filters match.
 *
 * Robust to shape drift (a FHIR searchset/collection Bundle, a bare resource array, or a single
 * resource) so a first-cut against the real API doesn't hard-fail on an unexpected envelope. No I/O,
 * no new deps (the transport lives in `webchart-client.ts`), and it does NOT mutate the input — it
 * builds new resource objects. Descriptive only (ADR-008).
 */
import type { FhirBundle } from "../../synthetic/fhir-bundle-builder.ts";
import { codingKey, holderHasCoding, reconcileCodings, targetEventType, type Coding } from "./terminology.ts";
import { ECQM_CANONICAL_CODES, MAMMOGRAPHY_PROCEDURE_CODES } from "../../cql/bundled-ecqm-expansions.ts";

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pull the resource list out of whatever envelope the API returned. */
function extractResources(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw.flatMap(extractResources);
  if (!isObject(raw)) return [];
  // A FHIR Bundle: entry[].resource. A Bundle with no entry array yields nothing (it must NOT fall
  // through to the bare-resource branch and wrap the Bundle itself). Entries without a `.resource`
  // (e.g. a searchset entry with only fullUrl/search) are dropped, not leaked as bogus resources.
  if (raw.resourceType === "Bundle") {
    return Array.isArray(raw.entry)
      ? raw.entry.map((e) => (isObject(e) ? e.resource : undefined)).filter((r) => isObject(r))
      : [];
  }
  // A bare resource
  if (typeof raw.resourceType === "string") return [raw];
  return [];
}

/** A NEW coding-holder with reconciled codings, or the original reference if nothing changed. */
function reconciledHolder(holder: unknown): { holder: unknown; codings: Coding[] } {
  if (!isObject(holder) || !Array.isArray(holder.coding)) return { holder, codings: [] };
  const codings = reconcileCodings(holder.coding as Coding[]);
  if (codings === holder.coding) return { holder, codings }; // no-op — same reference
  return { holder: { ...holder, coding: codings }, codings };
}

// Only clinically-final events drive compliance. A cancelled/errored WebChart event — a `not-done` or
// `entered-in-error` Procedure/Immunization, a `preliminary`/`registered`/`cancelled`/`entered-in-error`
// Observation — must NOT be reconciled to a measure coding or synthesized into a `completed` Procedure, or
// the recency CQL (which matches only code + date, not status) would count it as compliant (Codex P2).
// A missing status is treated as non-final (conservative; the line-130 test guards it).
const FINAL_STATUS: Record<string, ReadonlySet<string>> = {
  Procedure: new Set(["completed"]),
  Immunization: new Set(["completed"]),
  Observation: new Set(["final", "amended", "corrected"]),
};

// BP panel LOINCs. teatea (verified 2026-07-23) exports the blood-pressure PANEL with status `unknown`
// (systolic/diastolic in component[], no top-level value) — `unknown` = FHIR "source doesn't know the
// workflow status", NOT an invalidity marker. We accept `unknown` ONLY for this verified shape.
const BP_PANEL_LOINC = new Set(["85354-9", "55284-4"]);

function isBpPanel(resource: Json): boolean {
  const code = resource.code;
  if (!isObject(code) || !Array.isArray(code.coding)) return false;
  return code.coding.some(
    (c) =>
      isObject(c) &&
      typeof c.code === "string" &&
      BP_PANEL_LOINC.has(c.code) &&
      (typeof c.system !== "string" || /loinc/i.test(c.system)),
  );
}

function isFinalEvent(resource: Json): boolean {
  const allowed = FINAL_STATUS[resource.resourceType as string];
  if (!allowed) return true; // non-event resources aren't status-gated (their codings don't reconcile anyway)
  const status = typeof resource.status === "string" ? resource.status : undefined;
  if (status && allowed.has(status)) return true;
  // Narrow exception: a BP PANEL with status `unknown` IS final (real WebChart BP shape). Scoped to the
  // verified BP shape so an unknown-status LAB (HbA1c/LDL) — where `unknown` could mean an unverified
  // result — can never synthesize a completed Procedure and read as compliant (AGENTS.md: never falsely
  // compliant; Codex P1 #328).
  return status === "unknown" && resource.resourceType === "Observation" && isBpPanel(resource);
}

/** The best effective instant for a lab Observation → a synthesized Procedure's `performedDateTime`. */
function observationEffective(obs: Json): string | undefined {
  if (typeof obs.effectiveDateTime === "string") return obs.effectiveDateTime;
  const period = obs.effectivePeriod;
  if (isObject(period) && typeof period.start === "string") return period.start;
  if (typeof obs.issued === "string") return obs.issued;
  return undefined;
}

/**
 * Reconcile one WebChart resource → one or more engine resources (a NEW array; the input is never
 * mutated). Appends the synthetic event coding to `code`/`vaccineCode`. Additionally, when a lab
 * `Observation` reconciles to a measure whose CQL retrieves `[Procedure]` (the recency lab/vital
 * measures — WebChart records the lab as an Observation, the measure looks for a Procedure), a dated
 * `Procedure` carrying that target coding is synthesized so the measure can match. `cms122` retrieves
 * `[Observation]`, so its coding stays on the Observation. Provenance: the real coding is preserved,
 * and a synthesized Procedure is tagged `derived-from-observation`.
 *
 * Non-final events (see `isFinalEvent`) pass through untouched — no measure coding is appended and no
 * Procedure is synthesized — so a cancelled/errored WebChart event can never read as compliant.
 */
function reconcileResource(resource: unknown): unknown[] {
  if (!isObject(resource)) return [];
  if (!isFinalEvent(resource)) return [resource]; // don't reconcile a non-final / errored clinical event
  const code = reconciledHolder(resource.code);
  const vaccineCode = reconciledHolder(resource.vaccineCode);
  const out: Json = { ...resource };
  if (code.holder !== resource.code) out.code = code.holder;
  if (vaccineCode.holder !== resource.vaccineCode) out.vaccineCode = vaccineCode.holder;
  const results: unknown[] = [out];

  if (resource.resourceType === "Observation") {
    const when = observationEffective(resource);
    const seen = new Set<string>();
    for (const target of code.codings) {
      const key = `${target.system}|${target.code}`;
      if (targetEventType(target) === "procedure" && !seen.has(key)) {
        seen.add(key);
        results.push({
          resourceType: "Procedure",
          status: "completed",
          meta: { tag: [{ system: "urn:workwell:webchart", code: "derived-from-observation" }] },
          ...(isObject(resource.subject) ? { subject: resource.subject } : {}),
          code: { coding: [target] },
          ...(when ? { performedDateTime: when } : {}),
        });
      }
    }
  }
  return results;
}

/** US Core sex, as the official CMS125 initial population reads it. */
const US_CORE_SEX = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-sex";
/**
 * `Object.create(null)`, not a literal: this is indexed by a string a third-party server sent, and a
 * plain object would answer `SEX_CONCEPT["constructor"]` with a function — measured in review (#390) to
 * emit a malformed `us-core-sex` extension for a gender the two-value allowlist supposedly rejects.
 */
const SEX_CONCEPT: Record<string, string> = Object.assign(Object.create(null), {
  female: "248152002",
  male: "248153007",
});

/**
 * Assert `us-core-sex` from `Patient.gender` when the server supplies one and not the other.
 *
 * **The gap this closes was live and silent.** Official CMS125's initial population reads this extension
 * and NEVER `Patient.gender` (ADR-042 cost a measurement pass establishing exactly that). Our own SQL→FHIR
 * paths — the `wcdb-fhir-shim` and the dev-DB export — emit both from WebChart's `patients.sex` column,
 * but they sit UPSTREAM of the live FHIR transport: a third-party WebChart server that serves
 * `gender: "female"` and no extension had its entire roster read out-of-population, as 100% MISSING_DATA
 * rather than an error. ADR-042 declined to infer it here and generalized that refusal from the config it
 * fixed to one it had not measured; ADR-043 then established that a whole roster out of the initial
 * population is the hazard, not the safe answer.
 *
 * So it is derived, on the ADR-037/ADR-044 normalization terms: from a value the server actually STATES,
 * through an explicit allowlist (only `male`/`female` — `other`, `unknown` and anything else map to
 * nothing, because there is no SNOMED concept to assert and guessing is what this must not do), never
 * overwriting an extension the server did supply, and TAGGED so a reader can tell an asserted sex from a
 * recorded one.
 *
 * It is not free of judgement, and the judgement is stated: administrative gender and recorded sex can
 * legitimately differ, so this is an inference. Reading a server's own "female" as not-female is also an
 * inference — a worse one, because it is silent and it empties the measure.
 */
function withUsCoreSex(patient: Json): Json {
  if (typeof patient.gender !== "string") return patient;
  const concept = SEX_CONCEPT[patient.gender];
  if (typeof concept !== "string") return patient;
  const existing = Array.isArray(patient.extension) ? patient.extension : [];
  if (existing.some((e) => isObject(e) && e.url === US_CORE_SEX)) return patient;
  // `{ url, valueCode }` and nothing else. FHIR's ext-1 invariant is "must have either extensions or
  // value[x], not both", so the nested provenance extension a first cut carried made every live tenant's
  // Patient structurally invalid (review, #390) — in a repo whose conformance posture is CVU+ and whose
  // last two QRDA rounds were about exactly this class. Provenance goes on `meta.tag`, which is where the
  // mammography derivation below already puts it.
  const tags = isObject(patient.meta) && Array.isArray(patient.meta.tag) ? patient.meta.tag : [];
  return {
    ...patient,
    extension: [...existing, { url: US_CORE_SEX, valueCode: concept }],
    meta: { ...(isObject(patient.meta) ? patient.meta : {}), tag: [...tags, DERIVED_SEX_TAG] },
  };
}

const DERIVED_SEX_TAG = { system: "urn:workwell:webchart", code: "derived-from-gender" };

// Through `codingKey`, NOT `${system}|${code}`. An exact match here disagreed with the crosswalk fifty
// lines away, which normalizes system aliases and upcases the code: measured (#390) on a CPT-as-OID
// mammogram, the crosswalk recognised it and the authored engine read COMPLIANT while this failed to
// derive and official read OVERDUE — the divergence this derivation exists to remove.
const MAMMOGRAPHY_PROCEDURE_KEYS = new Set(
  MAMMOGRAPHY_PROCEDURE_CODES.map((c) => codingKey(c)).filter((k): k is string => k !== null),
);
const MAMMOGRAM_OBSERVATION = ECQM_CANONICAL_CODES.mammogram;
const MAMMOGRAM_OBSERVATION_KEYS = new Set([codingKey(MAMMOGRAM_OBSERVATION)!]);

const IMAGING_CATEGORY_KEYS = new Set([
  "http://terminology.hl7.org/CodeSystem/observation-category|IMAGING",
  "|IMAGING",
]);

/** Day precision — a Procedure's `performed` and an Observation's `effective` rarely agree below it. */
function day(value: string | undefined): string {
  return value ? value.slice(0, 10) : "undated";
}

/** `subject.reference` (or `subject.identifier.value`), so a multi-patient payload cannot cross-suppress. */
function subjectKey(resource: Json): string {
  const subject = resource.subject;
  if (!isObject(subject)) return "";
  if (typeof subject.reference === "string") return subject.reference;
  const identifier = subject.identifier;
  if (isObject(identifier) && typeof identifier.value === "string") return identifier.value;
  return "";
}

/** `performed[x]` → the instant a derived Observation should carry. */
function procedurePerformed(procedure: Json): string | undefined {
  if (typeof procedure.performedDateTime === "string") return procedure.performedDateTime;
  const period = procedure.performedPeriod;
  if (isObject(period) && typeof period.start === "string") return period.start;
  return undefined;
}

/**
 * Dual-stamp a screening mammogram, for the LIVE path this time (ADR-044 did it for the crosswalk).
 *
 * The two engines read the event in different vocabularies: authored `cms125` retrieves
 * `[Procedure: "Mammography"]` against CPT/HCPCS, official CMS125 retrieves
 * `isDiagnosticStudyPerformed([Observation: "Mammography"])` where the value set is 92 LOINC codes only
 * AND `Status` also requires `category ~ imaging`. A WebChart server records the procedure. So with only
 * what the server sends, official CMS125 reports a woman who WAS screened as OVERDUE — a false
 * non-compliance that `case-logic.ts` escalates to HIGH.
 *
 * Normalization, not fabrication, on the same three tested properties as ADR-044: derived strictly from a
 * real Procedure (never minted), an explicit two-code allowlist rather than a category sweep, and
 * suppressed when the subject already has an Observation carrying **LOINC 24606-6** — so a server that
 * records both is untouched. That check is the one canonical code, not the whole 92-member Mammography
 * value set: a server recording the screening under one of the other 91 would still get a derived
 * duplicate. Harmless for `exists(...)` and stated rather than implied (review, #390); widening it would
 * mean reaching the official terminology sidecar from inside the engine, which the boundary forbids.
 *
 * Both numerators are `exists(...)`, so this cannot inflate either; for a COUNTING measure it would,
 * which is why the allowlist is two codes and not a category.
 */
function withMammographyObservation(entries: Array<{ resource: unknown }>): Array<{ resource: unknown }> {
  const resources = entries.map((e) => e.resource).filter(isObject);
  // Suppression is keyed on (SUBJECT, DAY) and counts only an Observation that could actually satisfy the
  // official predicate. Two narrower-than-obvious conditions, both measured hazards:
  //
  //   - per SUBJECT, because this function is exported, advertises robustness to shape drift, and
  //     `extractResources` flattens arrays of bundles — bundle-wide, patient A's Observation would
  //     suppress derivation for patient B, and two same-day mammograms across two patients would
  //     collapse into one Observation carrying A's subject;
  //   - per DAY and only for a QUALIFYING Observation, because an existing one that the measure cannot
  //     count — `preliminary`/`entered-in-error`, or missing `category ~ imaging`, or simply an old
  //     screening from years ago — would otherwise suppress derivation for a RECENT valid Procedure, and
  //     the patient reads OVERDUE and is escalated HIGH. Presence of the code is not usability
  //     (Codex, #390).
  const qualifyingObservation = (r: Json) =>
    r.resourceType === "Observation" &&
    holderHasCoding(r.code, MAMMOGRAM_OBSERVATION_KEYS) &&
    isFinalEvent(r) &&
    Array.isArray(r.category) &&
    r.category.some((c) => holderHasCoding(c, IMAGING_CATEGORY_KEYS));
  const alreadyObserved = new Set(
    resources.filter(qualifyingObservation).map((r) => `${subjectKey(r)}|${day(observationEffective(r))}`),
  );

  const derived: Array<{ resource: unknown }> = [];
  const seen = new Set<string>();
  for (const resource of resources) {
    if (resource.resourceType !== "Procedure") continue;
    if (!isFinalEvent(resource)) continue;
    if (!holderHasCoding(resource.code, MAMMOGRAPHY_PROCEDURE_KEYS)) continue;
    const when = procedurePerformed(resource);
    const key = `${subjectKey(resource)}|${day(when)}`;
    if (alreadyObserved.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    derived.push({
      resource: {
        resourceType: "Observation",
        status: "final",
        // `Status.isDiagnosticStudyPerformed` requires it; without it the retrieve matches and the
        // predicate still rejects, which is the same invisible failure one step later (ADR-042).
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "imaging" }] }],
        code: { coding: [{ system: MAMMOGRAM_OBSERVATION.system, code: MAMMOGRAM_OBSERVATION.code, display: MAMMOGRAM_OBSERVATION.display }] },
        meta: { tag: [{ system: "urn:workwell:webchart", code: "derived-from-procedure" }] },
        ...(isObject(resource.subject) ? { subject: resource.subject } : {}),
        ...(when ? { effectiveDateTime: when } : {}),
      },
    });
  }
  return derived.length > 0 ? [...entries, ...derived] : entries;
}

/**
 * Normalize one patient's WebChart API payload into the engine's `Bundle` (type `collection`),
 * reconciling terminology on the way. An empty/garbage payload yields an empty bundle (the engine
 * then evaluates it as MISSING_DATA), never a throw — per-patient error isolation stays with the
 * caller (`evaluateBatch`).
 */
export function normalizeWebChartBundle(raw: unknown): FhirBundle {
  const entries = extractResources(raw)
    .flatMap((r) => reconcileResource(r))
    .map((resource) => ({ resource: isObject(resource) && resource.resourceType === "Patient" ? withUsCoreSex(resource) : resource }));
  return { resourceType: "Bundle", type: "collection", entry: withMammographyObservation(entries) };
}
