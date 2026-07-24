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

/** One population's membership as fqm-execution reports it. */
export interface FqmPopulationResult {
  populationType: string;
  result: boolean;
}

export interface FqmSubjectResult {
  patientId?: string;
  detailedResults?: Array<{ populationResults?: FqmPopulationResult[] }>;
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
  const libraries = b.entry.filter((e) => e?.resource?.["resourceType"] === "Library");
  const hasMeasure = b.entry.some((e) => e?.resource?.["resourceType"] === "Measure");
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
    try {
      const elm = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as {
        library?: { valueSets?: { def?: Array<{ id: string }> } };
      };
      for (const def of elm.library?.valueSets?.def ?? []) urls.add(def.id);
    } catch {
      // A single unparseable library must not sink the whole cache build; its retrieves will simply
      // find no cached expansion, which the empty-but-present policy below already handles safely.
    }
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
): Record<string, unknown> {
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
    if (typeof population?.populationType === "string") {
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
  const calculate = input.calculate ?? (await loadCalculator());
  const output = await calculate(
    input.bundle,
    input.patientBundles,
    calculationOptions(input.period),
    input.valueSetCache,
  );
  const bySubject = new Map<string, PopulationMembership>();
  for (const subject of output.results ?? []) {
    const populations = subject.detailedResults?.[0]?.populationResults;
    if (subject.patientId && populations) {
      bySubject.set(subject.patientId, populationMembership(populations));
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
