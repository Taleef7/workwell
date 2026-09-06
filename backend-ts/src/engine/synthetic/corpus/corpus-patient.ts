/**
 * `patientAt(seed, index)` — one corpus patient, pure. Every value comes from that patient's own
 * SplitMix64 stream, so generation order and batch boundaries never change a record (spec §3).
 *
 * DRAW ORDER IS CONTRACT. Inserting a draw shifts every later value for every patient. Any change
 * here bumps CORPUS_GENERATOR_VERSION and re-records the pinned hash in corpus-patient.test.ts.
 *
 * Nothing here decides an outcome. The generator emits clinical FACTS at population rates; CQL alone
 * decides compliance (docs/AI_GUARDRAILS.md §1, ADR-008).
 */
import { streamFor, type SplitMix64 } from "./splitmix64.ts";
import { CORPUS_FIXTURE_PREFIX } from "./corpus-fixture-prefix.ts";
import {
  AGE_MIXTURE, CLINIC_WEIGHTS, COLORECTAL_MODALITIES, CONDITION_PREVALENCE, CORPUS_IDENTITY_YEAR,
  DEFAULT_CORPUS_MEASUREMENT_YEAR, EVENT_RATES, FEMALE_SHARE, GIVEN_NAMES, HISPANIC_OR_LATINO_SHARE,
  MAX_NAME_REDRAWS, PAYER_MIX, PCPS, RACE_MIX, SURNAMES, VISITS_PER_YEAR, ageBandFor,
  type AgeBand,
} from "./corpus-parameters.ts";

export { CORPUS_IDENTITY_YEAR, DEFAULT_CORPUS_MEASUREMENT_YEAR };

/** The measurement year a `YYYY-MM-DD` evaluation date falls in — the year the run scores (ADR-072). */
export const measurementYearOf = (evaluationDate: string): number => {
  const year = Number(evaluationDate.slice(0, 4));
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    throw new Error(`[workwell] "${evaluationDate}" is not a YYYY-MM-DD evaluation date`);
  }
  return year;
};

export interface CorpusEvent {
  readonly kind: string;      // "hba1c" | "bp" | "phq9" | "mammogram" | "colorectal" | "sudInitiation" | ...
  readonly date: string;      // YYYY-MM-DD
  readonly value?: number;    // HbA1c %, PHQ-9 score, systolic
  readonly value2?: number;   // diastolic
  readonly modality?: string; // colorectal modality key
  readonly external: boolean; // D5 — sourced outside the practice
}

export interface CorpusPatient {
  readonly index: number;
  readonly externalId: string;
  readonly name: string;
  readonly sex: "F" | "M";
  readonly dateOfBirth: string;
  /**
   * The calendar year this record's CLINICAL FACTS describe — the year the run scores (ADR-072).
   * Identity (id, name, dateOfBirth, sex, site, PCP, payer, race, ethnicity) is the same in every
   * year; conditions, visits, events and exceptions are generated for this one.
   */
  readonly measurementYear: number;
  readonly age: number;         // age at the END of `measurementYear`
  readonly ageBand: AgeBand;
  readonly site: string;
  readonly providerId: string;
  readonly tenantId: "maui";
  /** Source of Payment Typology code — what `SDE Payer` reads off the patient's Coverage. */
  readonly payer: string;
  /** CDC race category code, carried as the `us-core-race` extension. */
  readonly race: string;
  /** CDC ethnicity code, carried as the `us-core-ethnicity` extension. */
  readonly ethnicity: string;
  readonly conditions: readonly string[];
  readonly visits: readonly string[];
  readonly events: readonly CorpusEvent[];
  readonly exceptions: readonly string[]; // documented refusals / medical reasons, read by CQL as exceptions
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m, 2)}-${pad(d, 2)}`;

/** Days in a month, Gregorian. Keeps every generated date real so FHIR validation never sees Feb 30. */
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** A uniform date inside the measurement year, optionally capped at a month/day. */
function dateInYear(rng: SplitMix64, year: number, lastMonth = 12): string {
  const month = rng.nextInt(lastMonth) + 1;
  return iso(year, month, rng.nextInt(daysInMonth(year, month)) + 1);
}

/**
 * A uniform date on or before November 14 — the last day a new SUD episode can start and still be in
 * CMS137's initial population (its ELM: the diagnosis starts `SameOrBefore` the period end minus 47
 * days, so the 14-day initiation and 34-day engagement windows close inside the period). The previous
 * cap was "month 11", which put 29 of 604 episodes at 20,000 on Nov 15-30: outside the population, while
 * the comment beside the draw and the manifest's cohort estimate both said otherwise. Same two draws as
 * `dateInYear`, so only the November episodes moved.
 */
function dateOnOrBeforeNov14(rng: SplitMix64, year: number): string {
  const month = rng.nextInt(11) + 1;
  return iso(year, month, rng.nextInt(month === 11 ? 14 : daysInMonth(year, month)) + 1);
}

/**
 * Age at the START of the measurement year — what CMS2's age bands and CMS137's initial population
 * actually compute (`CalculateAgeAt(birthDate, start of "Measurement Period")`). `age` on the record is
 * age at the END of the year; the two differ by one for everyone not born on January 1, and the corpus
 * banded the depression-screening instrument by the wrong one: a patient who is 17 on Dec 31 was 16 on
 * Jan 1, the measure reads them as an adolescent, and the adult instrument the corpus emitted put 102
 * screened patients per 20,000 in the denominator with no numerator.
 */
export function ageAtPeriodStart(patient: Pick<CorpusPatient, "age" | "dateOfBirth">): number {
  return patient.dateOfBirth.endsWith("-01-01") ? patient.age : patient.age - 1;
}

/** A date `monthsBack` months before the period end, jittered inside that window. */
function dateWithinLookback(rng: SplitMix64, monthsBack: number, measurementYear: number): string {
  const back = rng.nextInt(monthsBack);
  // Anchored on the FIRST of the month, not the 31st. `setUTCMonth` on a day-31 date overflows every
  // 30-day month — Dec 31 minus one month is "Nov 31", which normalises to Dec 1 — so of 27 look-back
  // months only 16 were reachable and February, April, June, September and November never occurred at
  // all. No outcome changed (every date still landed inside its window), but the manifest published
  // the seasonal distribution as a parameter-derived draw when it was an artifact of a date bug.
  const anchor = new Date(Date.UTC(measurementYear, 11, 1));
  anchor.setUTCMonth(anchor.getUTCMonth() - back);
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + 1;
  return iso(year, month, rng.nextInt(daysInMonth(year, month)) + 1);
}

/** A date one to `maxYearsBack` years before the measurement year — surgical history, not period data. */
function dateYearsBefore(rng: SplitMix64, maxYearsBack: number, measurementYear: number): string {
  const year = measurementYear - 1 - rng.nextInt(maxYearsBack);
  const month = rng.nextInt(12) + 1;
  return iso(year, month, rng.nextInt(daysInMonth(year, month)) + 1);
}

function ageFor(rng: SplitMix64): number {
  const band = rng.pick(AGE_MIXTURE.map((b) => [b, b.weight] as const));
  return band.min + rng.nextInt(band.max - band.min + 1);
}

/**
 * Date of birth from a drawn age, relative to CORPUS_IDENTITY_YEAR — never to the year being evaluated.
 * That is what makes a patient the same person in 2026 and in 2027: the roster's DOB is fixed, and the
 * age the measures see (`year - birth year`) is derived from it per evaluation year.
 */
function dobFor(rng: SplitMix64, ageInIdentityYear: number): string {
  const year = CORPUS_IDENTITY_YEAR - ageInIdentityYear;
  const month = rng.nextInt(12) + 1;
  return iso(year, month, rng.nextInt(daysInMonth(year, month)) + 1);
}

/** Payer, race and ethnicity — identity facts, drawn once, the same in every evaluation year. */
function demographicsFor(rng: SplitMix64, band: AgeBand): { payer: string; race: string; ethnicity: string } {
  const payer = rng.pick(PAYER_MIX[band]);
  const race = rng.pick(RACE_MIX);
  const ethnicity = rng.chance(HISPANIC_OR_LATINO_SHARE) ? "2135-2" : "2186-5";
  return { payer, race, ethnicity };
}

/** The decade key the given-name pools are indexed by. */
const decadeOf = (dob: string): string => `${dob.slice(0, 3)}0`;

/**
 * The BASE name: exactly two draws, always, whatever else is true. This is what makes
 * `patientAt(seed, i)` and `corpusPatients(seed, n)[i]` the same record.
 *
 * The obvious design — re-draw from the patient's stream until the name is unique — is WRONG here,
 * and a review caught it: a standalone `patientAt` call has no `taken` set, so it never re-draws and
 * stops after two draws, while the same index inside a full generation may re-draw and consume more.
 * Every later value for that patient (conditions, visits, events) then shifts, and the two calls
 * return different people. Uniqueness must therefore be settled WITHOUT consuming a variable number
 * of draws from the stream the rest of the record depends on.
 */
function baseNameFor(rng: SplitMix64, sex: "F" | "M", dob: string): string {
  const pool = GIVEN_NAMES[sex][decadeOf(dob)] ?? GIVEN_NAMES[sex]["1990"]!;
  return `${rng.pickOne(pool)} ${rng.pickOne(SURNAMES)}`;
}

/**
 * Disambiguation, from a SEPARATE stream keyed by (seed, index) so it costs the patient's own stream
 * nothing. Called only when the base name collides with a lower index; the suffix escalates
 * deterministically, so uniqueness is guaranteed at any corpus size and the result depends only on
 * (seed, index, how many lower indices already hold this name+DOB) — never on generation order.
 */
function disambiguate(seed: string, index: number, base: string, dob: string, taken: Set<string>): { name: string; redraws: number; fallback: boolean } {
  if (!taken.has(`${base}|${dob}`)) return { name: base, redraws: 0, fallback: false };
  const alt = streamFor(`${seed}:disambiguate`, index);
  const [given, ...rest] = base.split(" ");
  for (let attempt = 1; attempt <= MAX_NAME_REDRAWS; attempt += 1) {
    const initial = String.fromCharCode(65 + alt.nextInt(26));
    const name = `${given} ${initial}. ${rest.join(" ")}`;
    if (!taken.has(`${name}|${dob}`)) return { name, redraws: attempt, fallback: false };
  }
  // Guaranteed terminator: the index itself is unique, so this can collide with nothing.
  return { name: `${given} ${String(index + 1).padStart(5, "0")}. ${rest.join(" ")}`, redraws: MAX_NAME_REDRAWS, fallback: true };
}

/**
 * The youngest age at which each condition is drawn at all. Deliberately conservative — these are floors
 * below which the diagnosis is implausible in a primary-care panel, not epidemiological onset curves.
 * `sudEpisode` is 13 because CMS137's own initial population starts there.
 */
const CONDITION_MIN_AGE: Record<string, number> = {
  diabetes: 12,
  hypertension: 18,
  bipolar: 13,
  colorectalCancer: 20,
  esrd: 18,
  sudEpisode: 13,
  hospice: 18,
  palliativeCare: 18,
  bilateralMastectomy: 25,
  totalColectomy: 20,
};

function conditionsFor(rng: SplitMix64, band: AgeBand, sex: "F" | "M", age: number): string[] {
  const prevalence = CONDITION_PREVALENCE[band];
  const out: string[] = [];
  for (const [key, p] of Object.entries(prevalence)) {
    // The skipped draws are DELIBERATE: an ineligible condition still consumes its draw so that the
    // stream position after this loop does not depend on sex or age.
    if (key === "bilateralMastectomy" && sex !== "F") { rng.nextFloat(); continue; }
    // The AIFrailLTCF exclusion starts at 66, so frailty below it would be data no measure reads.
    if (key === "frailty" && age < 66) { rng.nextFloat(); continue; }
    // A clinical floor per condition. Without these the prevalences were drawn uniformly across the
    // whole age band, which produced 17 patients under 13 with a substance-use episode (7 under six),
    // 6 type-2 diabetics under 12 and 3 with essential hypertension. None of them moved a measure —
    // every ACO measure's initial population starts at 12 or later — but they are visible on the
    // roster and in any chart view, and a physician shown a four-year-old with a cocaine-induced mood
    // disorder stops trusting everything else in the sandbox.
    if (key in CONDITION_MIN_AGE && age < CONDITION_MIN_AGE[key]!) { rng.nextFloat(); continue; }
    if (rng.chance(p)) out.push(key);
  }
  return out;
}

function visitsFor(rng: SplitMix64, year: number): string[] {
  const count = rng.pick(VISITS_PER_YEAR);
  // The first visit is before Nov 14 so every measure with a "qualifying encounter before the
  // follow-up window" requirement (CMS2, CMS137) has one (spec §3, item 1).
  const visits = [dateInYear(rng, year, 11)];
  for (let i = 1; i < count; i += 1) visits.push(dateInYear(rng, year));
  return visits.sort();
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function eventsFor(
  rng: SplitMix64,
  patient: { conditions: readonly string[]; age: number; sex: "F" | "M"; visits: readonly string[] },
  year: number,
): { events: CorpusEvent[]; exceptions: string[] } {
  const events: CorpusEvent[] = [];
  const exceptions: string[] = [];
  const ext = () => rng.chance(EVENT_RATES.externalSourced);
  const has = (c: string) => patient.conditions.includes(c);

  // CMS122 — HbA1c poor control. A diabetic with NO result is in the numerator by the measure's logic,
  // so "missing" is generated as a real state rather than treated as a data gap.
  if (has("diabetes")) {
    if (!rng.chance(EVENT_RATES.hba1cMissing)) {
      const poor = rng.chance(EVENT_RATES.hba1cPoorControl);
      const value = poor ? 9.1 + rng.nextFloat() * 4 : 5.6 + rng.nextFloat() * 3.3;
      events.push({ kind: "hba1c", date: dateInYear(rng, year), value: Math.round(value * 10) / 10, external: ext() });
    }
  }

  // CMS165 — the MOST RECENT BP in the period is what the measure reads.
  if (has("hypertension")) {
    const controlled = rng.chance(EVENT_RATES.bpControlled);
    const systolic = controlled ? 112 + rng.nextInt(26) : 140 + rng.nextInt(35);
    // ISOLATED SYSTOLIC HYPERTENSION — high systolic with a normal diastolic — is the dominant
    // uncontrolled phenotype over 65, which is a third of this panel. Driving both components off one
    // `controlled` flag produced ZERO such readings in 7,126, with two consequences: the panel is not
    // one a clinician recognises, and CMS165's decisive conjunction ("BOTH components below
    // threshold") is never exercised — a logic error dropping the diastolic clause would score
    // identically on the whole corpus.
    const isolatedSystolic = !controlled && rng.chance(EVENT_RATES.isolatedSystolic);
    const diastolic = controlled || isolatedSystolic ? 66 + rng.nextInt(23) : 90 + rng.nextInt(20);
    events.push({ kind: "bp", date: dateInYear(rng, year), value: systolic, value2: diastolic, external: false });
  }

  // CMS2 — depression screening, its positive share, and follow-up on the same day.
  if (patient.age >= 12) {
    if (rng.chance(EVENT_RATES.phq9Exception)) {
      exceptions.push("depressionScreeningRefused");
    } else if (rng.chance(EVENT_RATES.phq9Screened)) {
      const positive = rng.chance(EVENT_RATES.phq9Positive);
      const date = patient.visits[0]!;
      events.push({ kind: "phq9", date, value: positive ? 10 + rng.nextInt(17) : rng.nextInt(10), external: false });
      if (positive && rng.chance(EVENT_RATES.phq9FollowUp)) events.push({ kind: "phq9FollowUp", date, external: false });
    }
  }

  // CMS125 — mammography inside the 27-month look-back. The artifact's INITIAL POPULATION is
  // `AgeInYearsAt(end of Measurement Period) in Interval[42, 74]`, read off cms125/bundle.json's ELM
  // — specifically the `Initial Population` def, NOT `Stratification 2`, which is `Interval[52, 74]`
  // and is what an earlier adjudication of this plan mistook for the denominator. The measure is
  // age-STRATIFIED: stratum 1 is 42-51, stratum 2 is 52-74. Generating only from 52 (or 50) would
  // leave every woman 42-51 in the initial population with no mammogram ever emitted — a whole
  // stratum uniformly non-compliant, and invisible because the number would still look plausible.
  // We generate from 40 ON PURPOSE — two years below the IPP — so the corpus contains women just
  // outside it and the boundary is exercised rather than assumed. Everything 40-41 must land OUT.
  if (patient.sex === "F" && patient.age >= 40 && patient.age <= 76) {
    if (rng.chance(EVENT_RATES.mammogramUpToDate)) {
      events.push({ kind: "mammogram", date: dateWithinLookback(rng, 27, year), external: ext() });
    }
  }

  // CMS130 — colorectal screening, modality-specific look-back. The artifact's INITIAL POPULATION is
  // `Interval[46, 75]` (read off cms130/bundle.json's `Initial Population` def). As with CMS125, the
  // narrower `Interval[50, 75]` in the ELM is `Stratification 2`, not the denominator; stratum 1 is
  // 46-49. Generated 44-77 — two years below the IPP — for the same boundary reason as CMS125 above.
  // NOTE this is the 2026-vintage artifact: USPSTF lowered screening to 45, but the vendored measure
  // has not, and the ARTIFACT is what runs (spec §1's re-vendor caveat).
  // 44-77 spans CMS130's initial population (46-75) with two years either side, deliberately: a
  // patient who turns 46 during the year needs screening history from before it, and one who turned 76
  // still has last year's. Records outside the IPP are never evaluated by the measure, which is
  // correct — they are chart history, not measure input.
  if (patient.age >= 44 && patient.age <= 77) {
    if (rng.chance(EVENT_RATES.colorectalUpToDate)) {
      const modality = rng.pick(COLORECTAL_MODALITIES);
      events.push({ kind: "colorectal", date: dateWithinLookback(rng, modality.lookbackMonths, year), modality: modality.key, external: ext() });
    }
  }

  // The 66+ ADVANCED-ILLNESS-AND-FRAILTY exclusion (AIFrailLTCF, shared by cms122/125/130/165) needs
  // frailty AND one of two further facts: a dementia medication, or an advanced-illness diagnosis with
  // onset in the year before or during the period. Both are drawn among the frail at published shares;
  // a frail patient with neither stays in the denominator, exactly as the measure logic says.
  if (has("frailty")) {
    if (rng.chance(EVENT_RATES.frailtyDementiaMedication)) {
      events.push({ kind: "dementiaMedication", date: dateInYear(rng, year), external: false });
    }
    if (rng.chance(EVENT_RATES.frailtyAdvancedIllness)) {
      events.push({ kind: "advancedIllness", date: dateInYear(rng, year), external: false });
    }
  }

  // Palliative care IN the measurement period excludes on every one of the ACO's four screening and
  // control measures. Emitted as the intervention Procedure the PalliativeCare library retrieves.
  if (has("palliativeCare")) {
    events.push({ kind: "palliativeCare", date: dateInYear(rng, year), external: false });
  }

  // Surgical HISTORY: a bilateral mastectomy excludes from cms125 and a total colectomy from cms130,
  // whenever they were performed. Dated one to twenty years before the period, as chart history is.
  if (has("bilateralMastectomy")) {
    events.push({ kind: "bilateralMastectomy", date: dateYearsBefore(rng, 20, year), external: ext() });
  }
  if (has("totalColectomy")) {
    events.push({ kind: "totalColectomy", date: dateYearsBefore(rng, 20, year), external: ext() });
  }

  // CMS137 — a new SUD episode, then initiation, then engagement. The episode is before Nov 14 so the
  // 34-day engagement window closes inside the measurement period (U3 §5). The episode becomes an
  // ENCOUNTER with the diagnosis recorded during it (see `corpus-bundle.ts`): the measure's denominator
  // is "a qualifying encounter during which a SUD diagnosis starts", not a diagnosis on its own.
  if (has("sudEpisode")) {
    const episode = dateOnOrBeforeNov14(rng, year);
    events.push({ kind: "sudEpisode", date: episode, external: false });
    if (rng.chance(EVENT_RATES.sudInitiation)) {
      const offset = rng.nextInt(15);
      const longActing = rng.chance(EVENT_RATES.sudLongActing);
      events.push({ kind: "sudInitiation", date: addDays(episode, offset), modality: longActing ? "longActingMedication" : "visit", external: false });
      // TWO engagement services, not one. CMS137 rate 2 requires "two or more" further services within
      // 34 days of initiating, so a single event can never enter its numerator — the whole Engagement
      // rate would read 0% across the corpus, which is precisely the rate multi-rate support exists to
      // surface. The long-acting-medication shortcut is deliberately NOT taken here: that branch needs a
      // medication resource from the artifact's long-acting value set, which this corpus does not emit
      // yet, so claiming engagement through it would be a numerator we cannot actually evidence.
      if (rng.chance(EVENT_RATES.sudEngagement)) {
        const first = 1 + rng.nextInt(16);
        const second = first + 1 + rng.nextInt(33 - first);
        events.push({ kind: "sudEngagement", date: addDays(episode, offset + first), external: false });
        events.push({ kind: "sudEngagement", date: addDays(episode, offset + second), external: false });
      }
    }
  }

  return { events: events.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind)), exceptions };
}

/**
 * The fixture prefix's PCPs, spread across each clinic's panel in `externalId` order.
 *
 * The fixture rows carry no `providerId` — the catalog used to derive one by round-robin, and the
 * corpus keeps that rule rather than handing every patient at a clinic its FIRST PCP: on the default
 * 48-patient deployment that would collapse forty providers into two panels, and the PCP filter the
 * pilot's quality staff work by would have nothing to filter. This consumes NO draws from the
 * patient's stream, so the fixture records are otherwise byte-identical to what the stream produces.
 */
const FIXTURE_PANEL: ReadonlyMap<string, string> = (() => {
  const rank = new Map<string, number>();
  const out = new Map<string, string>();
  for (const fixture of [...CORPUS_FIXTURE_PREFIX].sort((a, b) => a.externalId.localeCompare(b.externalId))) {
    const atSite = PCPS.filter((p) => p.location === fixture.site);
    const seen = rank.get(fixture.site) ?? 0;
    rank.set(fixture.site, seen + 1);
    out.set(fixture.externalId, atSite[seen % atSite.length]!.id);
  }
  return out;
})();

/** The clinic and PCP a patient is attributed to. PCP is uniform within the clinic, giving 350-650 panels. */
function panelFor(rng: SplitMix64): { site: string; providerId: string } {
  const site = rng.pick(CLINIC_WEIGHTS);
  const atSite = PCPS.filter((p) => p.location === site);
  return { site, providerId: rng.pickOne(atSite).id };
}

/**
 * One patient. `taken` is the identity set used for collision re-draws; it is threaded by
 * `corpusPatients` for a full generation and passed empty for a single-index call, which is safe
 * because a single record's identity does not depend on it unless it collides.
 */
export function patientAt(
  seed: string,
  index: number,
  taken: Set<string> = new Set(),
  /**
   * The calendar year the clinical facts are generated for — the year the run scores. Identity does not
   * depend on it (see `dobFor`); everything from `conditions` on does, because the age the measures see
   * is the age at the end of THIS year.
   */
  year: number = DEFAULT_CORPUS_MEASUREMENT_YEAR,
): CorpusPatient {
  const rng = streamFor(seed, index);
  const fixture = CORPUS_FIXTURE_PREFIX[index];

  // IDENTITY — every draw here is year-independent, so a patient is the same person whichever year the
  // corpus is asked about. The age drawn from the mixture is the age in CORPUS_IDENTITY_YEAR and exists
  // only to fix a date of birth; the age the record carries is derived from that DOB below.
  const sex: "F" | "M" = rng.chance(FEMALE_SHARE) ? "F" : "M";
  const dateOfBirth = fixture ? fixture.dateOfBirth! : dobFor(rng, ageFor(rng));
  const age = year - Number(dateOfBirth.slice(0, 4));
  const band = ageBandFor(age);

  const baseName = fixture ? fixture.name : baseNameFor(rng, sex, dateOfBirth);
  const identity = fixture
    ? { name: fixture.name, redraws: 0, fallback: false }
    : disambiguate(seed, index, baseName, dateOfBirth, taken);
  const panel = fixture
    ? { site: fixture.site, providerId: FIXTURE_PANEL.get(fixture.externalId)! }
    : panelFor(rng);
  // Payer follows the age band of the IDENTITY year, not the evaluation year, so it never flips at a
  // 65th birthday between two runs — a payer change is a real-world event this corpus does not model.
  const demographics = demographicsFor(rng, ageBandFor(CORPUS_IDENTITY_YEAR - Number(dateOfBirth.slice(0, 4))));

  // CLINICAL FACTS — everything below is generated for `year`.
  const conditions = conditionsFor(rng, band, sex, age);
  const visits = visitsFor(rng, year);
  const { events, exceptions } = eventsFor(rng, { conditions, age, sex, visits }, year);

  return {
    index,
    externalId: fixture ? fixture.externalId : `pat-${pad(index + 1, 5)}`,
    name: identity.name,
    sex,
    dateOfBirth,
    measurementYear: year,
    age,
    ageBand: band,
    site: panel.site,
    providerId: panel.providerId,
    tenantId: "maui",
    payer: demographics.payer,
    race: demographics.race,
    ethnicity: demographics.ethnicity,
    conditions,
    visits,
    events,
    exceptions,
  };
}

/** The first `size` patients, with identity collisions resolved against the ones already generated. */
export function corpusPatients(seed: string, size: number, year: number = DEFAULT_CORPUS_MEASUREMENT_YEAR): CorpusPatient[] {
  const taken = new Set<string>();
  const out: CorpusPatient[] = [];
  for (let i = 0; i < size; i += 1) {
    const patient = patientAt(seed, i, taken, year);
    taken.add(`${patient.name}|${patient.dateOfBirth}`);
    out.push(patient);
  }
  return out;
}
