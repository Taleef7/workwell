/**
 * `@workwell/official-executor` — execution of OFFICIAL published eCQM artifacts.
 *
 * Runs a measure exactly as its steward published it: the MADiE/eCQI QICore FHIR bundle, executed from
 * the **pre-compiled ELM** shipped inside `Library.content` (`application/elm+json`) via MITRE's
 * `fqm-execution`. Nothing is translated — which is what ADR-024 found intractable under the pinned JS
 * translator — and fqm-execution runs that ELM on the same `cql-execution` + `cql-exec-fhir` runtime the
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
  /** fqm's rendered value — "TRUE"/"FALSE"/"NA"/"UNHIT", or a formatted value for non-boolean defines. */
  final?: unknown;
}

export interface FqmSubjectResult {
  patientId?: string;
  detailedResults?: Array<{
    populationResults?: FqmPopulationResult[];
    statementResults?: FqmStatementResult[];
  }>;
  /** Resources the engine actually retrieved — the signal that a retrieve matched anything at all. */
  evaluatedResource?: Array<{ resourceType?: string }>;
}

export interface FqmCalculationResult {
  results?: FqmSubjectResult[];
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
  const urls = new Set<string>();
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
      library?: { valueSets?: { def?: Array<{ id: string }> } };
    };
    for (const def of elm.library?.valueSets?.def ?? []) urls.add(def.id);
  }
  return [...urls];
}

/** `http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840...` → `2.16.840...` (expanders are keyed by bare OID). */
export function oidFromValueSetUrl(url: string): string {
  const marker = "/ValueSet/";
  return url.includes(marker) ? url.slice(url.lastIndexOf(marker) + marker.length) : url;
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
 * filed by this project 2026-07-15 and maintainer-confirmed). Normalizing to end-of-day is what makes
 * the official test cases pass — without it the CMS125 MADiE deck scores 64/66.
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
  statements: FqmStatementResult[];
}

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
  const calculate = input.calculate ?? (await loadCalculator());
  const output = await calculate(
    input.bundle,
    input.patientBundles,
    calculationOptions(input.period, input.options),
    input.valueSetCache,
  );
  const bySubject = new Map<string, OfficialSubjectResult>();
  for (const subject of output.results ?? []) {
    const detailed = subject.detailedResults?.[0];
    if (subject.patientId && detailed?.populationResults) {
      bySubject.set(subject.patientId, {
        populations: populationMembership(detailed.populationResults),
        populationResults: detailed.populationResults,
        statements: detailed.statementResults ?? [],
      });
    }
  }
  return bySubject;
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
