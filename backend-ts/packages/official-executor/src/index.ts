/**
 * `@work-well/official-executor` — execution of OFFICIAL published eCQM artifacts.
 *
 * Runs a measure exactly as its steward published it: the MADiE/eCQI QICore FHIR bundle, executed from
 * the **pre-compiled ELM** shipped inside `Library.content` (`application/elm+json`) via MITRE's
 * `fqm-execution`. Nothing is translated here (the CQL does compile, given the QICore model info —
 * `src/standards/qicore-compile.ts` — but this package runs CMS's own ELM), and fqm-execution runs that ELM on the same `cql-execution` + `cql-exec-fhir` runtime the
 * rest of this repo already depends on.
 *
 * ## Why this is a package
 *
 * ADR-026 quarantined `fqm-execution` (which drags in axios/handlebars/moment/lodash) behind a
 * file-allowlist arch test, because those deps must never reach the worker's cold-start or request path.
 * A package boundary states the same invariant structurally: `fqm-execution` appears in exactly ONE
 * `package.json`, and **this entry point imports nothing from it statically** — the calculator is loaded
 * through a lazy `await import` at first use, so importing this module costs nothing.
 *
 * ## What deliberately stays OUT
 *
 * - **No filesystem.** Vendored bundle bytes are read by the consumer and passed in. That keeps this
 *   package portable and makes the vendoring convention (paths, manifests, hashes) the app's business.
 * - **No terminology store.** Value-set expansion arrives as an injected `expand(oid)` function.
 * - **No WorkWell vocabulary.** This returns official population membership; mapping that onto
 *   `OutcomeStatus` is a WorkWell policy decision and lives in the app.
 */

/**
 * One population's membership as fqm-execution reports it. The index signature is deliberate: fqm also
 * carries `criteriaExpression`, `populationId`, and observation payloads on these entries, and consumers
 * persist the object verbatim as regulatory evidence — so the type must not imply those fields are gone.
 */
export interface FqmPopulationResult {
  populationType: string;
  result: boolean;
  [key: string]: unknown;
}

/** One CQL statement's result, as fqm reports it with `verboseCalculationResults`. */
export interface FqmStatementResult {
  statementName?: string;
  libraryName?: string;
  /** fqm's label — "TRUE"/"FALSE"/"NA"/"UNHIT" from relevance and truthiness, never the value itself. */
  final?: unknown;
}

/**
 * One stratifier's result for one subject, as fqm reports it. `strataCode` is the stratifier's
 * `code.text`, falling back to its `id` (CMS137's stratifiers declare no code, so it IS the id —
 * `Stratification_1_1`); `strataId` is the `Measure.group.stratifier.id` when present.
 */
export interface FqmStratifierResult {
  strataCode: string;
  result: boolean;
  /** In the stratum AND in the population it applies to; fqm computes it for patient-based measures. */
  appliesResult?: boolean;
  strataId?: string;
}

export interface FqmSubjectResult {
  patientId?: string;
  detailedResults?: Array<{
    populationResults?: FqmPopulationResult[];
    statementResults?: FqmStatementResult[];
    stratifierResults?: FqmStratifierResult[];
  }>;
  /** Resources the engine actually retrieved — the signal that a retrieve matched anything at all. */
  evaluatedResource?: Array<{ resourceType?: string }>;
}

export interface FqmCalculationResult {
  results?: FqmSubjectResult[];
  /**
   * Present only when `enableDebugOutput` was passed. `rawResults` is cql-execution's own result: each
   * patient's main-library define values keyed by NAME, which the statement results cannot give us
   * (they find a value by `localId`, and the vendored ELM has none).
   */
  debugOutput?: { rawResults?: { patientResults?: Record<string, Record<string, unknown>> } };
}

/** The `fqm-execution` `Calculator.calculate` signature, injectable so consumers can test without it. */
export type FqmCalculate = (
  measureBundle: unknown,
  patientBundles: unknown[],
  options: unknown,
  valueSetCache?: unknown[],
) => Promise<FqmCalculationResult>;

/** Minimal shape of a measure bundle — we only ever introspect Libraries and confirm a Measure exists. */
export interface MeasureBundle {
  resourceType: "Bundle";
  type?: string;
  entry: Array<{ resource: Record<string, unknown> }>;
}

/**
 * Load the real calculator. **Lazy on purpose**: a static import here would pull fqm-execution's
 * dependency tree into the module graph of anything that so much as imports a type from this package,
 * which is exactly what ADR-026 forbids.
 */
export async function loadCalculator(): Promise<FqmCalculate> {
  const mod = (await import("fqm-execution")) as { Calculator: { calculate: unknown } };
  return mod.Calculator.calculate as FqmCalculate;
}

/**
 * True when a bundle can actually be executed: it has a Measure, at least one Library, and **every**
 * Library carries pre-compiled ELM. A bundle missing ELM anywhere would force translation at runtime,
 * which is the thing this package exists to avoid — better to reject it than to fail deep inside fqm.
 */
export function isExecutableMeasureBundle(bundle: unknown): bundle is MeasureBundle {
  const b = bundle as MeasureBundle | null | undefined;
  if (!b || b.resourceType !== "Bundle" || !Array.isArray(b.entry)) return false;
  // Every entry must actually carry a resource object. This guard is the precondition the rest of the
  // package trusts (referencedValueSetUrls dereferences `entry.resource` unconditionally), so a guard
  // that narrowed while tolerating a null entry would be handing downstream code a lie.
  if (!b.entry.every((e) => !!e && typeof e.resource === "object" && e.resource !== null)) return false;
  const libraries = b.entry.filter((e) => e.resource["resourceType"] === "Library");
  const hasMeasure = b.entry.some((e) => e.resource["resourceType"] === "Measure");
  const everyLibraryHasElm =
    libraries.length > 0 &&
    libraries.every((l) =>
      (l.resource["content"] as Array<{ contentType?: string; data?: string }> | undefined)?.some(
        (c) => c.contentType === "application/elm+json" && !!c.data,
      ),
    );
  return hasMeasure && everyLibraryHasElm;
}

/**
 * Every distinct value-set canonical the measure's ELM retrieves reference, across all libraries.
 * Read from the compiled ELM rather than the CQL text, so it reflects what will actually execute.
 */
export function referencedValueSetUrls(bundle: MeasureBundle): string[] {
  return referencedValueSets(bundle).map((v) => v.url);
}

/**
 * As `referencedValueSetUrls`, but keeps the CQL alias the ELM declares alongside each canonical
 * ("Hospice Encounter", "Diabetes"). A terminology importer wants that: without it every row it writes
 * is named by its bare OID, and a human reading the value-set catalog has nothing to go on.
 */
export function referencedValueSets(bundle: MeasureBundle): Array<{ url: string; name?: string }> {
  const byUrl = new Map<string, { url: string; name?: string }>();
  for (const entry of bundle.entry) {
    const resource = entry.resource as {
      resourceType?: string;
      content?: Array<{ contentType?: string; data?: string }>;
    };
    if (resource.resourceType !== "Library") continue;
    const data = resource.content?.find((c) => c.contentType === "application/elm+json")?.data;
    if (!data) continue;
    // Deliberately NOT tolerant, matching the pre-extraction behavior: a library whose ELM will not
    // parse means the value sets it retrieves are missing from the cache, and fqm/cql-execution errors
    // on an unresolvable value set anyway - so swallowing this would only trade a precise parse error
    // for an opaque failure deep inside the batch.
    const elm = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as {
      library?: { valueSets?: { def?: Array<{ id: string; name?: string }> } };
    };
    for (const def of elm.library?.valueSets?.def ?? []) {
      // First name wins: the same canonical is declared in several libraries, and the first is as good
      // as any. Keeping a set keyed by url preserves the previous de-duplication exactly.
      if (!byUrl.has(def.id)) byUrl.set(def.id, { url: def.id, ...(def.name ? { name: def.name } : {}) });
    }
  }
  return [...byUrl.values()];
}

/**
 * `http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840...|1.2` → `2.16.840...` (expanders key by bare OID).
 *
 * The **`|version` suffix is stripped too**, and that half was missing until review of #364 found it. A
 * FHIR canonical may carry one, and shipped `ValueSet.url` never does (the version lives in
 * `ValueSet.version`). So an ELM declaring `…/2.16.1|1.2` produced the key `2.16.1|1.2` while the
 * artifact's terminology was keyed `2.16.1` — the value set would be reported ABSENT though present,
 * and `--complete-terminology` would then ask VSAC for a malformed version-suffixed id.
 *
 * Measured before changing it: **zero** versioned canonicals across all six upstream bundles at the
 * pinned commit, so this fixes nothing that occurs today and changes no current artifact. It is a
 * latent correctness fix, and it makes the de-duplication in `absentValueSets` mean what its comment
 * already claimed — a versioned and an unversioned canonical for one set now really do collapse to one
 * OID.
 *
 * Matching on the OID rather than the exact canonical is right here because the artifact IS the
 * authority: one bundle carries at most one ValueSet per OID, and the sidecar records its `version`
 * for provenance. There is no second candidate to be ambiguous about.
 */
export function oidFromValueSetUrl(url: string): string {
  const marker = "/ValueSet/";
  const withoutPrefix = url.includes(marker) ? url.slice(url.lastIndexOf(marker) + marker.length) : url;
  const pipe = withoutPrefix.indexOf("|");
  return pipe === -1 ? withoutPrefix : withoutPrefix.slice(0, pipe);
}

export interface ExpandedCode {
  code: string;
  system: string;
}

/**
 * Build fqm-execution's `valueSetCache` — one ValueSet per canonical the ELM references.
 *
 * A canonical that fails to expand is emitted **empty but present**: fqm-execution errors on a missing
 * value set, so omitting it would abort the whole batch, whereas an empty one makes that retrieve return
 * nothing. That is the conservative direction — it can only narrow a population, never invent membership.
 */
export async function buildValueSetCache(
  bundle: MeasureBundle,
  expand: (oid: string) => Promise<ExpandedCode[]>,
  expansionTimestamp = "2026-01-01T00:00:00Z",
): Promise<unknown[]> {
  const cache: unknown[] = [];
  for (const url of referencedValueSetUrls(bundle)) {
    const oid = oidFromValueSetUrl(url);
    let codes: ExpandedCode[] = [];
    try {
      codes = await expand(oid);
    } catch {
      codes = [];
    }
    cache.push({
      resourceType: "ValueSet",
      id: oid,
      url,
      status: "active",
      expansion: {
        timestamp: expansionTimestamp,
        contains: codes.map((c) => ({ system: c.system, code: c.code })),
      },
    });
  }
  return cache;
}

/**
 * fqm-execution 1.8.5 parses a **date-only** `measurementPeriodEnd` as START-of-day, silently dropping
 * everything that happened on the last day of the period (upstream: projecttacoma/fqm-execution#371,
 * filed by this project 2026-07-15 and maintainer-confirmed; fix proposed in #372). Normalizing to
 * end-of-day is what makes the official test cases pass — without it the CMS125 MADiE deck scores 64/66.
 *
 * **What this actually achieves is `23:59:59.000Z`, not `.999`**, and the difference is worth writing
 * down rather than leaving to be discovered. fqm parses the string we hand it with
 * `moment.defaultFormatUtc` — `YYYY-MM-DDTHH:mm:ss[Z]`, which carries no fractional-second token — so
 * our milliseconds are dropped on arrival (measured; upstream #376). The `.999` is therefore aspirational
 * today and becomes real when #376 lands. The MADiE deck passes because its boundary Procedure sits at
 * exactly `23:59:59Z`; an event at `23:59:59.500Z` would still be read as outside the period.
 *
 * **Delete this function when #372 merges, do not keep it.** After that fix a bare `2026-12-31` resolves
 * to the full `.999` inside fqm, whereas the string this produces is not date-only, bypasses the new
 * branch, and stays truncated at `.000` — so keeping the workaround would leave us a millisecond short
 * of the behaviour the upstream fix provides.
 */
export function normalizePeriodEnd(periodEnd: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(periodEnd) ? `${periodEnd}T23:59:59.999Z` : periodEnd;
}

export interface CalculationPeriod {
  start: string;
  end: string;
}

/**
 * The exact option set we pass to fqm-execution. Literal types on the flags that must never change
 * silently: they are all on by default in fqm and are pure cost, and `calculateHTML` is the one with a
 * plausible-looking impostor (`disableHTMLGeneration`, which does nothing).
 */
export interface FqmCalculationOptions {
  measurementPeriodStart: string;
  measurementPeriodEnd: string;
  calculateSDEs: false;
  calculateHTML: false;
  calculateClauseCoverage: false;
  calculateRAVs: false;
  trustMetaProfile: boolean;
  verboseCalculationResults: true;
}

export interface CalculationOptionOverrides {
  /**
   * Retrieve by `meta.profile` instead of by base resource type. FALSE for plain-FHIR bundles (ours);
   * TRUE is needed for profile-tagged official test-case bundles, where retrieving by base type finds
   * nothing. Callers that cannot know which they have run once and retry — see `hasRetrieveSignal`.
   */
  trustMetaProfile?: boolean;
  /**
   * Retrieve by `meta.profile` for THESE profiles only, and by base resource type for every other one
   * (#591). A measure whose decisive retrieve is profile-typed with no code filter needs the profile to
   * know what it is reading; requiring every other profile too would make each resource of plain or
   * imported data invisible. Serializable, so it crosses the fqm worker thread; the PatientSource it
   * describes is built on the far side (`profileNarrowedPatientSource`). Exclusive with
   * `trustMetaProfile: true`, which already trusts every profile.
   */
  trustedProfiles?: readonly string[];
}

/** The parts of `cql-exec-fhir` this package uses. */
interface CqlExecFhir {
  PatientSource: { FHIRv401(options: { requireProfileTagging: boolean }): CqlPatientSource };
}
interface CqlPatientSource {
  loadBundles(bundles: unknown[]): void;
  currentPatient(): CqlPatient | undefined;
}
interface CqlPatient {
  findRecords(profile: string, retrieveDetails: unknown): Array<{ _json?: { meta?: { profile?: unknown } } }>;
}

/**
 * Load `cql-exec-fhir`, lazily for the same reason as the calculator: importing this package must not
 * pull fqm's runtime into the caller's module graph (ADR-026). It is the version fqm-execution 1.8.5
 * itself runs on, pinned exactly in this package's manifest.
 */
export async function loadCqlExecFhir(): Promise<CqlExecFhir> {
  const mod = (await import("cql-exec-fhir")) as unknown as CqlExecFhir & { default?: CqlExecFhir };
  return mod.default ?? mod;
}

/**
 * A FHIR R4 PatientSource that retrieves by base resource type, except that a retrieve for one of
 * `trustedProfiles` keeps only the resources whose `meta.profile` names it.
 *
 * What fqm builds itself from `trustMetaProfile` is all or nothing: on, every retrieve needs its exact
 * QI-Core profile and the Patient retrieve throws without `qicore-patient`; off, a profile-typed retrieve
 * with no code filter (cms165's `[Observation: us-core-blood-pressure]`) matches every Observation. This
 * is the middle: profile-sensitive only where the profile is the only thing that says what a resource is.
 * Measured on 2026-10-10 against full trust for cms165: identical on CMS's 68 MADiE cases and on all
 * 20,000 corpus patients; trusting no profile differs on 624 of a 2,500-patient sample.
 *
 * Each patient's `findRecords` is wrapped as it becomes current, and the filter reads the raw resource
 * (`_json`), the field cql-exec-fhir 2.1.6 keeps it in; the version is pinned and a test runs the real
 * package. fqm skips its own "no entries" check when handed a source, so it is repeated here.
 */
export function profileNarrowedPatientSource(
  sources: CqlExecFhir["PatientSource"],
  patientBundles: unknown[],
  trustedProfiles: readonly string[],
): CqlPatientSource {
  const hasEntries = patientBundles.some((b) => ((b as { entry?: unknown[] })?.entry?.length ?? 0) > 0);
  if (!hasEntries) throw new Error("No entries found in passed patient bundles");
  const trusted = new Set(trustedProfiles);
  const source = sources.FHIRv401({ requireProfileTagging: false });
  source.loadBundles(patientBundles);
  const current = source.currentPatient.bind(source);
  // `nextPatient` reaches the patient through `this.currentPatient()`, so wrapping this one method on the
  // instance covers both ways fqm walks the bundles.
  source.currentPatient = () => {
    const patient = current();
    if (!patient) return patient;
    const find = patient.findRecords.bind(patient);
    patient.findRecords = (profile, retrieveDetails) => {
      const records = find(profile, retrieveDetails);
      if (!trusted.has(profile)) return records;
      return records.filter((r) => {
        const declared = r._json?.meta?.profile;
        return Array.isArray(declared) && declared.includes(profile);
      });
    };
    return patient;
  };
  return source;
}

/**
 * The calculation options, in one place because several are hard-won:
 *
 * `calculateHTML` — fqm-execution 1.8.5 has **no** `disableHTMLGeneration` option (a plausible-looking
 * name that silently does nothing); HTML is on by default and is pure wasted CPU per subject at
 * population scale. Same for clause coverage and RAVs. `trustMetaProfile` defaults to false because
 * plain-FHIR bundles must be retrieved by base type rather than by profile. `verboseCalculationResults`
 * is required — population membership lives in `detailedResults`.
 */
export function calculationOptions(
  period: CalculationPeriod,
  overrides: CalculationOptionOverrides = {},
): FqmCalculationOptions {
  if (overrides.trustMetaProfile === true && (overrides.trustedProfiles?.length ?? 0) > 0) {
    throw new Error("trustMetaProfile and trustedProfiles are exclusive: one trusts every profile, the other only some");
  }
  return {
    measurementPeriodStart: period.start,
    measurementPeriodEnd: normalizePeriodEnd(period.end),
    calculateSDEs: false,
    calculateHTML: false,
    calculateClauseCoverage: false,
    calculateRAVs: false,
    trustMetaProfile: overrides.trustMetaProfile ?? false,
    verboseCalculationResults: true,
  };
}

/** Official population membership for one subject, keyed by FHIR population code. */
export type PopulationMembership = Record<string, boolean>;

/** Reduce fqm's population array to a code→boolean map (the shape persisted as official evidence). */
export function populationMembership(results: FqmPopulationResult[]): PopulationMembership {
  const membership: PopulationMembership = {};
  for (const population of results) {
    // FIRST wins, matching the pre-extraction `.find()` semantics. A ratio or multi-observation measure
    // can legitimately repeat a populationType within a group; last-wins would silently pick a
    // different one than the code this was extracted from.
    if (typeof population?.populationType === "string" && !(population.populationType in membership)) {
      membership[population.populationType] = population.result === true;
    }
  }
  return membership;
}

export interface OfficialCalculationInput {
  bundle: MeasureBundle;
  patientBundles: unknown[];
  period: CalculationPeriod;
  valueSetCache?: unknown[];
  /** Injectable calculator (tests / alternate runtimes). Defaults to the lazily-imported real one. */
  calculate?: FqmCalculate;
  /** Option overrides - notably `trustMetaProfile` for profile-tagged official test-case bundles. */
  options?: CalculationOptionOverrides;
  /**
   * Main-library defines whose values to return per subject, rendered as text (`renderCqlValue`).
   * Which ones are worth keeping is the caller's decision, as with statements. Only a non-empty list
   * turns on fqm's debug output, which is what holds the values; it computes nothing extra, only keeps
   * references to what the calculation already produced.
   */
  recordDefines?: readonly string[];
}

/**
 * Execute an official measure over a batch of patient bundles in a single pass (the ELM is parsed once,
 * so batching is materially cheaper than per-subject calls) and return per-subject population membership
 * keyed by patient id. Subjects fqm returns no detailed result for are simply absent from the map —
 * the caller decides whether that is an error, because only it knows what it asked for.
 */
export async function calculateOfficial(
  input: OfficialCalculationInput,
): Promise<Map<string, PopulationMembership>> {
  const detailed = await calculateOfficialDetailed(input);
  return new Map([...detailed].map(([subject, result]) => [subject, result.populations]));
}

/** Population membership plus the per-statement results the caller persists as evidence. */
export interface OfficialSubjectResult {
  /** Reduced code→boolean map — convenient for deciding things. */
  populations: PopulationMembership;
  /**
   * fqm's population array, VERBATIM. Kept alongside the reduced map because the map is lossy: it drops
   * duplicate population types (legal for ratio and multi-observation measures) and any field beyond
   * `populationType`/`result`. Callers persisting regulatory evidence should write this one.
   */
  populationResults: FqmPopulationResult[];
  /**
   * EVERY rate the measure declares, in the artifact's own `group` order. `populationResults` above is
   * `rates[0]`, kept because most measures have exactly one and every existing caller reads it.
   *
   * A MULTI-RATE measure is not an edge case to reduce away: CMS137 (MIPS 305) has two — Initiation and
   * Engagement — and in 8 of its 45 steward-published cases the two DISAGREE, because a patient can
   * start treatment and then not continue it. Reporting only the first silently answers half the
   * measure, and the half it drops is the one describing whether care actually continued (ADR-074).
   */
  rates: FqmPopulationResult[][];
  /**
   * Each rate's STRATIFIER results, index-aligned with `rates`; an empty array for a rate whose group
   * declares no stratifier. CMS137 declares three per group (age 13-17, 18-64, 65+), and a QRDA III for
   * a stratified measure is required to report every stratum — a document without them is a wrong
   * submission that looks complete. Read off fqm's `detailedResults[i].stratifierResults`, which the
   * package had never surfaced.
   */
  strata: FqmStratifierResult[][];
  statements: FqmStatementResult[];
  /**
   * One entry per `recordDefines` name the main library holds, in the order asked; absent when none
   * were asked for, and for a subject in no group's initial population. A name the library does not
   * define is left out rather than reported as null, so a caller can tell "CQL answered null" from "no
   * such define".
   */
  defineValues?: DefineValue[];
}

/** One define's value for one subject, rendered on the side of the worker thread it was computed on. */
export interface DefineValue {
  define: string;
  /** `null` when CQL's answer is null or an empty list: there is nothing to show. */
  value: string | null;
}

/** The most a rendered value may take, in UTF-8 bytes, marker included. */
export const DEFINE_VALUE_MAX_BYTES = 600;
const TRUNCATED = "…[truncated]";
const LIST_ITEMS_SHOWN = 3;
const MAX_DEPTH = 5;

/**
 * Elements of a FHIR resource left out of its rendering: bookkeeping (`meta`, the narrative `text`,
 * `identifier`…), extensions, and free-text notes. A Reference is left out too (`subject`, `requester`):
 * it points at another resource and states nothing about this one. Everything else the resource states is
 * shown, by its own element name, in the order the resource states it. Below the resource only extensions
 * are left out: a `text` there is a CodeableConcept's own, and is what it says.
 */
const FHIR_ELEMENT_SKIPPED = new Set(["extension", "modifierExtension"]);
const FHIR_SKIPPED = new Set([
  "meta",
  "text",
  "contained",
  "extension",
  "modifierExtension",
  "identifier",
  "implicitRules",
  "language",
  "note",
]);

/** FHIR R4's Reference elements. */
const REFERENCE_ELEMENTS = new Set(["id", "extension", "reference", "type", "identifier", "display"]);

/**
 * A Reference, by its shape: a `reference` string, or nothing but Reference elements with at least one that
 * points somewhere. A Reference stated only by `identifier` (an MRN) or `display` (a person's name) is one
 * too, and is the reason the shape is read rather than the `reference` string alone.
 */
const isReference = (node: unknown): boolean => {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  if (typeof (node as { reference?: unknown }).reference === "string") return true;
  const keys = Object.keys(node).filter((key) => !key.startsWith("_"));
  return keys.some((key) => key === "identifier" || key === "display") && keys.every((key) => REFERENCE_ELEMENTS.has(key));
};

function capBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  const room = max - Buffer.byteLength(TRUNCATED, "utf8");
  let out = "";
  for (const ch of text) {
    if (Buffer.byteLength(out + ch, "utf8") > room) break;
    out += ch;
  }
  return out + TRUNCATED;
}

function renderList(items: readonly unknown[], one: (item: unknown) => string): string {
  const shown = items.slice(0, LIST_ITEMS_SHOWN).map(one).join(" | ");
  return items.length > LIST_ITEMS_SHOWN ? `${shown} | … (${items.length} in all)` : shown;
}

/** A FHIR element as stated: a Coding as `system|code (display)`, a Quantity as `value unit`, else by name. */
function renderFhirElement(node: unknown, depth: number): string {
  if (node === null || node === undefined) return "null";
  if (typeof node !== "object") return String(node);
  if (depth > MAX_DEPTH) return Array.isArray(node) ? "[…]" : "{…}";
  if (Array.isArray(node)) return renderList(node, (item) => renderFhirElement(item, depth + 1));
  const o = node as Record<string, unknown>;
  if (Array.isArray(o["coding"]) && (o["coding"] as unknown[]).length > 0) {
    return (o["coding"] as unknown[]).map((c) => renderFhirElement(c, depth + 1)).join(" / ");
  }
  // A CodeableConcept stated only as text (a Dosage's `text` beside its other elements is not one).
  if (typeof o["text"] === "string" && Object.keys(o).every((key) => key === "text" || key === "coding" || key.startsWith("_"))) {
    return `"${o["text"]}"`;
  }
  if (typeof o["code"] === "string" && ("system" in o || "display" in o) && !("value" in o)) {
    const coded = `${typeof o["system"] === "string" ? o["system"] : ""}|${o["code"]}`;
    return typeof o["display"] === "string" ? `${coded} (${o["display"]})` : coded;
  }
  if (typeof o["value"] === "number" && ("unit" in o || "code" in o)) {
    const unit = typeof o["unit"] === "string" ? o["unit"] : typeof o["code"] === "string" ? o["code"] : "";
    const comparator = typeof o["comparator"] === "string" ? o["comparator"] : "";
    return `${comparator}${o["value"]}${unit ? ` ${unit}` : ""}`;
  }
  return `{${renderFhirElements(o, depth + 1, FHIR_ELEMENT_SKIPPED)}}`;
}

function renderFhirElements(o: Record<string, unknown>, depth: number, skipped: ReadonlySet<string>): string {
  const parts: string[] = [];
  for (const [name, element] of Object.entries(o)) {
    if (skipped.has(name) || name.startsWith("_") || isReference(element)) continue;
    // The References in a list are left out too, and a list of nothing but References with them.
    const shown = Array.isArray(element) ? element.filter((item) => !isReference(item)) : element;
    if (Array.isArray(shown) && shown.length === 0 && (element as unknown[]).length > 0) continue;
    parts.push(`${name}=${renderFhirElement(shown, depth)}`);
  }
  return parts.join("; ");
}

/** A resource as `Type/id {element=…; …}`; an element that is not a resource, as the element. */
function renderFhir(json: unknown, depth: number): string {
  if (!json || typeof json !== "object" || Array.isArray(json)) return renderFhirElement(json, depth);
  // A define whose value is itself a Reference: what it points at is not shown, as within a resource.
  if (isReference(json)) return "(a reference)";
  const resource = json as Record<string, unknown>;
  if (typeof resource["resourceType"] !== "string") return renderFhirElement(resource, depth);
  const { resourceType, id, ...rest } = resource;
  return `${resourceType}/${typeof id === "string" ? id : "?"} {${renderFhirElements(rest, depth + 1, FHIR_SKIPPED)}}`;
}

function render(value: unknown, depth: number): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return String(value);
  if (depth > MAX_DEPTH) return Array.isArray(value) ? "[…]" : "{…}";
  if (Array.isArray(value)) return renderList(value, (item) => render(item, depth + 1));
  // cql-exec-fhir keeps the source FHIR JSON of what a retrieve returned in `_json`.
  if ("_json" in value) return renderFhir((value as { _json: unknown })._json, depth);
  const v = value as Record<string, unknown> & { constructor?: { name?: string } };
  // cql-execution's own types answer these getters; their `toString` keeps a date's precision and offset.
  if (v["isDate"] === true || v["isDateTime"] === true) return String(value);
  if (v["isInterval"] === true) {
    return `${v["lowClosed"] === false ? "(" : "["}${render(v["low"], depth + 1)}, ${render(v["high"], depth + 1)}${v["highClosed"] === false ? ")" : "]"}`;
  }
  if (v["isQuantity"] === true) return v["unit"] && v["unit"] !== "1" ? `${String(v["value"])} ${String(v["unit"])}` : String(v["value"]);
  if (v["isRatio"] === true) return `${render(v["numerator"], depth + 1)}:${render(v["denominator"], depth + 1)}`;
  if (v["isCode"] === true) {
    const coded = `${v["system"] ?? ""}|${v["code"] ?? ""}`;
    return typeof v["display"] === "string" ? `${coded} (${v["display"]})` : coded;
  }
  if (v["isConcept"] === true) return (Array.isArray(v["codes"]) ? v["codes"] : []).map((c) => render(c, depth + 1)).join(" / ");
  if (v["isUncertainty"] === true) return `${render(v["low"], depth + 1)}..${render(v["high"], depth + 1)}`;
  // A CQL Tuple is a plain object: each field by name.
  const ctor = v.constructor;
  if (!ctor || ctor === Object) {
    const fields = Object.entries(v).filter(([, field]) => typeof field !== "function");
    return `{${fields.map(([name, field]) => `${name}=${render(field, depth + 1)}`).join("; ")}}`;
  }
  return `<unrendered ${ctor.name || "object"}>`;
}

/**
 * A CQL value as text, without choosing anything from it.
 *
 * Dates and DateTimes are CQL's own `toString` (precision and offset as computed); a FHIR resource is
 * its type, id and every element it states by name, never "the" date picked out of it; a list is its
 * first three items in CQL's own order and how many there are. Each run of control or line-separator
 * characters (a newline or tab in a display string, NEL, U+2028/9) becomes one space, so a value is one
 * line wherever it is shown, and an unpaired surrogate becomes U+FFFD, so the text is well-formed (Postgres
 * jsonb refuses one, and would fail the chunk the value was written with).
 * Capped at `DEFINE_VALUE_MAX_BYTES`, with a marker where it was cut. `null` for null and for an empty list.
 *
 * Never throws: it runs inside the calculation, and a value it cannot render must not fail the batch the
 * patient's score came from. Such a value is `<unrendered: error>`.
 */
export function renderCqlValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  let text: string;
  try {
    text = render(value, 0);
  } catch {
    text = "<unrendered: error>";
  }
  const oneLine = text.replace(LONE_SURROGATE, "\ufffd").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
  return capBytes(oneLine, DEFINE_VALUE_MAX_BYTES);
}

// A high surrogate with no low after it, or a low with no high before it (`toWellFormed` is ES2024).
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * As `calculateOfficial`, but also returns each subject's statement results.
 *
 * Kept as the richer primitive with `calculateOfficial` derived from it, because a caller that persists
 * evidence needs both and running the measure twice to get them would be absurd. The statements are
 * returned RAW — deciding which of a measure's ~420 statements are worth persisting is a WorkWell
 * storage-cost decision, not something this package should presume.
 */
export async function calculateOfficialDetailed(
  input: OfficialCalculationInput,
): Promise<Map<string, OfficialSubjectResult>> {
  return (await calculateOfficialWithSignal(input)).bySubject;
}

/** Per-subject results plus the one fact about the batch that no individual result carries. */
export interface OfficialBatchResult {
  bySubject: Map<string, OfficialSubjectResult>;
  /**
   * `hasRetrieveSignal` over the WHOLE batch (see that function). Surfaced here because it is the only
   * thing the raw fqm output says that the per-subject map cannot: an empty population is a legitimate
   * per-subject answer, so a caller can only judge it by looking across subjects — and by then the raw
   * output is gone. Deciding what to DO about it needs to know how many subjects were asked for, which
   * is the caller's business, not this package's.
   */
  retrieveSignal: boolean;
}

/**
 * The richest entry: everything `calculateOfficialDetailed` returns, plus whether any retrieve matched
 * anywhere in the batch. The other two entries are derived from this one so a caller that needs both
 * never runs the measure twice.
 */
export async function calculateOfficialWithSignal(
  input: OfficialCalculationInput,
): Promise<OfficialBatchResult> {
  const calculate = input.calculate ?? (await loadCalculator());
  const trusted = input.options?.trustedProfiles ?? [];
  const recordDefines = input.recordDefines ?? [];
  const options: Record<string, unknown> = { ...calculationOptions(input.period, input.options) };
  // Added here, never in `calculationOptions`, so a caller that records nothing passes fqm exactly the
  // options it always did.
  if (recordDefines.length > 0) options["enableDebugOutput"] = true;
  if (trusted.length > 0) {
    // Built here, not by the caller, because this is the side of the worker thread fqm runs on: the
    // input is structured-cloned across it, and a PatientSource does not survive a clone.
    const { PatientSource } = await loadCqlExecFhir();
    options["patientSource"] = profileNarrowedPatientSource(PatientSource, input.patientBundles, trusted);
  }
  const output = await calculate(input.bundle, input.patientBundles, options, input.valueSetCache);
  const rawByPatient = recordDefines.length > 0 ? output.debugOutput?.rawResults?.patientResults : undefined;
  const bySubject = new Map<string, OfficialSubjectResult>();
  for (const subject of output.results ?? []) {
    const detailedResults = subject.detailedResults ?? [];
    const detailed = detailedResults[0];
    if (subject.patientId && detailed?.populationResults) {
      // Rendered only for a subject in some group's initial population: anyone else's values describe a
      // measure that does not apply to them, and rendering them for the whole batch is the cost (#875).
      const inSomeInitialPopulation = detailedResults.some(
        (entry) =>
          Array.isArray(entry?.populationResults) &&
          entry.populationResults.some((p) => p.populationType === "initial-population" && p.result === true),
      );
      const raw = inSomeInitialPopulation ? rawByPatient?.[subject.patientId] : undefined;
      bySubject.set(subject.patientId, {
        populations: populationMembership(detailed.populationResults),
        populationResults: detailed.populationResults,
        rates: detailedResults
          .map((entry) => entry?.populationResults)
          .filter((results): results is FqmPopulationResult[] => Array.isArray(results)),
        // Index-aligned with `rates`: only groups that carried a population array are rates at all,
        // and each keeps whatever stratifier results fqm attached to that same group.
        strata: detailedResults
          .filter((entry) => Array.isArray(entry?.populationResults))
          .map((entry) => (Array.isArray(entry?.stratifierResults) ? entry.stratifierResults : [])),
        statements: detailed.statementResults ?? [],
        ...(raw
          ? {
              defineValues: recordDefines
                .filter((define) => Object.prototype.hasOwnProperty.call(raw, define))
                .map((define) => ({ define, value: renderCqlValue(raw[define]) })),
            }
          : {}),
      });
    }
  }
  return { bySubject, retrieveSignal: hasRetrieveSignal(output) };
}

/**
 * Did any retrieve actually match? fqm-execution does not error when every retrieve comes back empty —
 * it returns a complete-looking result with nobody in any population, which is indistinguishable from a
 * legitimately empty measure. The usual cause is a profile/base-type mismatch, so callers use this to
 * decide whether to retry with `trustMetaProfile: true`.
 */
export function hasRetrieveSignal(output: FqmCalculationResult): boolean {
  return (output.results ?? []).some((result) => {
    const retrievedNonPatient = result.evaluatedResource?.some((r) => r.resourceType !== "Patient") ?? false;
    const anyPopulation = result.detailedResults?.[0]?.populationResults?.some((p) => p.result) ?? false;
    return retrievedNonPatient || anyPopulation;
  });
}
