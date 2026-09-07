/**
 * The corpus manifest — what a run's data is traceable to (spec §8, §11).
 *
 * A synthetic corpus that produces a number nobody can trace is worth very little, and the pilot's
 * quality lead is entitled to challenge the clinical assumptions. So the manifest carries three
 * separable things:
 *
 * - **Provenance of the GENERATOR** — the seed, the size, the generator version, and a hash of the
 *   parameter table, so a number can be tied to the exact assumptions that produced it.
 * - **Provenance of the MEASURE CONTENT** — the vendored artifact hashes and terminology digests, read
 *   from each measure's own committed manifest rather than recomputed, so this cannot disagree with
 *   what the executor actually loads.
 * - **REALIZED vs ESTIMATED** — what the corpus actually contains, kept strictly apart from what the
 *   parameter table predicts. The realized counts are facts about the generated data; the estimated
 *   cohorts are arithmetic over the rate table. Conflating them is how a projection gets read as a
 *   measurement, so they are separate keys and named accordingly.
 *
 * Nothing here decides an outcome. It describes the input; CQL decides everything else.
 */
import { createHash } from "node:crypto";
import {
  AGE_MIXTURE,
  CLINICS,
  CLINIC_WEIGHTS,
  COLORECTAL_MODALITIES,
  CONDITION_PREVALENCE,
  CORPUS_GENERATOR_VERSION,
  CORPUS_IDENTITY_YEAR,
  DEFAULT_CORPUS_MEASUREMENT_YEAR,
  EVENT_RATES,
  FEMALE_SHARE,
  GIVEN_NAMES,
  HISPANIC_OR_LATINO_SHARE,
  MAX_NAME_REDRAWS,
  PAYER_MIX,
  PCPS,
  RACE_MIX,
  SURNAMES,
  VISITS_PER_YEAR,
  ageBandFor,
  type AgeBand,
} from "../../engine/synthetic/corpus/corpus-parameters.ts";
import { ageAtPeriodStart, type CorpusPatient } from "../../engine/synthetic/corpus/corpus-patient.ts";

/**
 * The parameter table's digest — computed HERE, not in the table itself.
 *
 * `src/engine/` is the future `@work-well/measure-engine` package and sits on the worker request path,
 * which must stay portable: `node:crypto` is unavailable there and the engine-boundary test enforces
 * it. Hashing the table for provenance is a REPORTING concern rather than engine data, so it belongs on
 * this side of the line — which also lets it stay a real SHA-256 instead of degrading to a portable
 * 64-bit digest.
 */
export function parametersSha256(): string {
  const rows = {
    CORPUS_GENERATOR_VERSION, CORPUS_IDENTITY_YEAR, CLINICS, CLINIC_WEIGHTS, PCPS, AGE_MIXTURE, FEMALE_SHARE,
    CONDITION_PREVALENCE, EVENT_RATES, COLORECTAL_MODALITIES, VISITS_PER_YEAR,
    PAYER_MIX, RACE_MIX, HISPANIC_OR_LATINO_SHARE,
    GIVEN_NAMES, SURNAMES, MAX_NAME_REDRAWS,
  };
  return createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex");
}

/** The measures the pilot's ACO set names, in catalog-id form — the six computable ones, cms137 included (ADR-074). */
export const CORPUS_MEASURE_IDS = ["cms122", "cms2", "cms165", "cms125", "cms130", "cms137"] as const;

export interface CorpusManifest {
  readonly generatorVersion: string;
  readonly seed: string;
  readonly size: number;
  /**
   * The calendar year the clinical facts describe. Identity is the same in every year; the realized
   * counts and estimated cohorts below are for THIS one, because age — and therefore every age-gated
   * cohort — is age at the end of it.
   */
  readonly measurementYear: number;
  readonly parametersSha256: string;
  readonly generatedAt?: string;
  /** Per measure: the vendored artifact's own SHA-256, read from its committed manifest. */
  readonly artifactHashes: Record<string, string | null>;
  /** Per measure: the terminology sidecar digest the artifact's manifest records. */
  readonly terminologySha256s: Record<string, string | null>;
  /** FACTS about the generated data. */
  readonly realized: {
    readonly byClinic: Record<string, number>;
    readonly byProvider: Record<string, number>;
    readonly byAgeBand: Record<AgeBand, number>;
    readonly bySex: Record<"F" | "M", number>;
    readonly withCondition: Record<string, number>;
    readonly withEvent: Record<string, number>;
  };
  /** ARITHMETIC over the rate table — a projection, never a measurement. */
  readonly estimatedCohorts: Record<string, { initialPopulation: number; denominator: number; expectedNumeratorRate: number }>;
  /** SHA-256 per NDJSON stream the exporter wrote, keyed by resource type. */
  readonly ndjsonSha256: Record<string, string>;
}

export interface BuildManifestInput {
  readonly seed: string;
  readonly patients: readonly CorpusPatient[];
  readonly ndjsonSha256: Record<string, string>;
  /** Injectable so a test is not coupled to a wall clock; omitted entirely when not supplied. */
  readonly generatedAt?: string;
  /**
   * Reads a vendored measure's committed manifest. INJECTED, not imported: `src/engine/` is the future
   * `@work-well/measure-engine` package and may not reach into `src/wiring/` — a boundary the
   * `engine-boundary` test enforces mechanically, and which caught this exact import. The caller
   * (`run/cli/corpus-export-cli.ts`, app wiring) supplies the real loader; omitting it yields null
   * hashes rather than a broken build, so the engine stays usable standalone.
   */
  readonly loadArtifact?: (catalogId: string) => { manifest?: unknown } | null;
}

const tally = <T extends string>(values: Iterable<T>, seedKeys: readonly T[] = []): Record<T, number> => {
  const out = {} as Record<T, number>;
  // Every key is present with a zero, so "this provider has no patients" is visible as 0 rather than
  // as an absent key a reader has to notice is missing.
  for (const k of seedKeys) out[k] = 0;
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
};

/**
 * The cohorts the parameter table IMPLIES, per measure — computed over the generated patients' own
 * ages and conditions, not sampled from their events. This is the number the corpus was aiming at; the
 * number the engine actually produces is a run outcome and lives nowhere near here.
 *
 * Age gates are the artifacts' own Initial Population intervals, read off their ELM: cms122 [18,75],
 * cms125 [42,74] female, cms130 [46,75], cms165 [18,85] (all at period END), cms2 12+ and cms137 13+ at period START.
 */
function estimateCohorts(patients: readonly CorpusPatient[]): CorpusManifest["estimatedCohorts"] {
  const has = (p: CorpusPatient, c: string) => p.conditions.includes(c);
  const inAge = (p: CorpusPatient, lo: number, hi: number) => p.age >= lo && p.age <= hi;

  const cohort = (
    ipp: (p: CorpusPatient) => boolean,
    denom: (p: CorpusPatient) => boolean,
    expectedNumeratorRate: number,
  ) => ({
    initialPopulation: patients.filter(ipp).length,
    denominator: patients.filter(denom).length,
    expectedNumeratorRate,
  });

  return {
    // CMS122 is an INVERSE measure: its numerator counts poor control, so the expected rate is the
    // share in poor control plus the share with no result at all, which its logic also counts.
    cms122: cohort(
      (p) => inAge(p, 18, 75) && has(p, "diabetes"),
      (p) => inAge(p, 18, 75) && has(p, "diabetes"),
      EVENT_RATES.hba1cPoorControl + EVENT_RATES.hba1cMissing,
    ),
    // 12+ at the START of the period, as the artifact computes it.
    cms2: cohort((p) => ageAtPeriodStart(p) >= 12, (p) => ageAtPeriodStart(p) >= 12, EVENT_RATES.phq9Screened),
    cms165: cohort(
      (p) => inAge(p, 18, 85) && has(p, "hypertension"),
      (p) => inAge(p, 18, 85) && has(p, "hypertension") && !has(p, "esrd"),
      EVENT_RATES.bpControlled,
    ),
    cms125: cohort(
      (p) => p.sex === "F" && inAge(p, 42, 74),
      (p) => p.sex === "F" && inAge(p, 42, 74),
      EVENT_RATES.mammogramUpToDate,
    ),
    cms130: cohort(
      (p) => inAge(p, 46, 75),
      (p) => inAge(p, 46, 75) && !has(p, "colorectalCancer") && !has(p, "totalColectomy"),
      EVENT_RATES.colorectalUpToDate,
    ),
    // CMS137's initial population is 13+ AT THE START of the period with a new SUD episode on or before
    // Nov 14 (its ELM: `CalculateAgeAt(birthDate, start of MP) >= 13`; the generator caps the episode
    // draw at Nov 14). The expected numerator rate is RATE 1's — initiation — because a single number is
    // what this table carries; rate 2 is initiation × engagement.
    cms137: cohort(
      (p) => ageAtPeriodStart(p) >= 13 && has(p, "sudEpisode"),
      (p) => ageAtPeriodStart(p) >= 13 && has(p, "sudEpisode") && !has(p, "hospice"),
      EVENT_RATES.sudInitiation,
    ),
  };
}

export function buildManifest(input: BuildManifestInput): CorpusManifest {
  const { seed, patients, ndjsonSha256 } = input;
  const loadArtifact = input.loadArtifact;

  const artifactHashes: Record<string, string | null> = {};
  const terminologySha256s: Record<string, string | null> = {};
  for (const id of CORPUS_MEASURE_IDS) {
    // Read from the measure's own committed manifest rather than re-hashing the bundle: a second
    // implementation of the same hash is a second thing that can disagree with the executor.
    const artifact = loadArtifact?.(id) ?? null;
    const manifest = artifact?.manifest as { sha256?: string; terminology?: { sha256?: string } } | undefined;
    artifactHashes[id] = manifest?.sha256 ?? null;
    terminologySha256s[id] = manifest?.terminology?.sha256 ?? null;
  }

  const conditions = patients.flatMap((p) => p.conditions);
  const events = patients.flatMap((p) => p.events.map((e) => e.kind));
  // One year per manifest: a patient list mixing years would describe two corpora as one.
  const years = new Set(patients.map((p) => p.measurementYear));
  if (years.size > 1) throw new Error(`[workwell] manifest over patients from ${years.size} measurement years: ${[...years].join(", ")}`);
  const measurementYear = patients[0]?.measurementYear ?? DEFAULT_CORPUS_MEASUREMENT_YEAR;

  return {
    generatorVersion: CORPUS_GENERATOR_VERSION,
    seed,
    size: patients.length,
    measurementYear,
    parametersSha256: parametersSha256(),
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
    artifactHashes,
    terminologySha256s,
    realized: {
      byClinic: tally(patients.map((p) => p.site), CLINICS.map((c) => c.name)),
      byProvider: tally(patients.map((p) => p.providerId), PCPS.map((p) => p.id)),
      byAgeBand: tally(patients.map((p) => ageBandFor(p.age)), ["0-17", "18-44", "45-64", "65+"] as AgeBand[]),
      bySex: tally(patients.map((p) => p.sex), ["F", "M"] as ("F" | "M")[]),
      withCondition: tally(conditions),
      withEvent: tally(events),
    },
    estimatedCohorts: estimateCohorts(patients),
    ndjsonSha256,
  };
}

/** The manifest's own digest, for a consumer that wants to pin the whole description in one value. */
export function manifestSha256(manifest: CorpusManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex");
}
