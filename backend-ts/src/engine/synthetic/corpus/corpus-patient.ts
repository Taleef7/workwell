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
  AGE_MIXTURE, CLINIC_WEIGHTS, COLORECTAL_MODALITIES, CONDITION_PREVALENCE, EVENT_RATES,
  FEMALE_SHARE, GIVEN_NAMES, MAX_NAME_REDRAWS, PCPS, SURNAMES, VISITS_PER_YEAR, ageBandFor,
  type AgeBand,
} from "./corpus-parameters.ts";

/** The measurement year the corpus is generated against (U1's calendar period). */
export const CORPUS_MEASUREMENT_YEAR = 2027;

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
  readonly age: number;         // age at the END of the measurement period
  readonly ageBand: AgeBand;
  readonly site: string;
  readonly providerId: string;
  readonly tenantId: "maui";
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

/** A date `monthsBack` months before the period end, jittered inside that window. */
function dateWithinLookback(rng: SplitMix64, monthsBack: number): string {
  const back = rng.nextInt(monthsBack);
  const end = new Date(Date.UTC(CORPUS_MEASUREMENT_YEAR, 11, 31));
  end.setUTCMonth(end.getUTCMonth() - back);
  end.setUTCDate(rng.nextInt(daysInMonth(end.getUTCFullYear(), end.getUTCMonth() + 1)) + 1);
  return end.toISOString().slice(0, 10);
}

function ageFor(rng: SplitMix64): number {
  const band = rng.pick(AGE_MIXTURE.map((b) => [b, b.weight] as const));
  return band.min + rng.nextInt(band.max - band.min + 1);
}

function dobFor(rng: SplitMix64, age: number): string {
  const year = CORPUS_MEASUREMENT_YEAR - age;
  const month = rng.nextInt(12) + 1;
  return iso(year, month, rng.nextInt(daysInMonth(year, month)) + 1);
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

function conditionsFor(rng: SplitMix64, band: AgeBand, sex: "F" | "M", age: number): string[] {
  const prevalence = CONDITION_PREVALENCE[band];
  const out: string[] = [];
  for (const [key, p] of Object.entries(prevalence)) {
    // The skipped draws are DELIBERATE: an ineligible condition still consumes its draw so that the
    // stream position after this loop does not depend on sex or age.
    if (key === "pregnancy" && (sex !== "F" || age < 15 || age > 49)) { rng.nextFloat(); continue; }
    if (key === "frailty" && age < 66) { rng.nextFloat(); continue; }
    if (rng.chance(p)) out.push(key);
  }
  return out;
}

function visitsFor(rng: SplitMix64): string[] {
  const count = rng.pick(VISITS_PER_YEAR);
  // The first visit is before Nov 14 so every measure with a "qualifying encounter before the
  // follow-up window" requirement (CMS2, CMS137) has one (spec §3, item 1).
  const visits = [dateInYear(rng, CORPUS_MEASUREMENT_YEAR, 11)];
  for (let i = 1; i < count; i += 1) visits.push(dateInYear(rng, CORPUS_MEASUREMENT_YEAR));
  return visits.sort();
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function eventsFor(rng: SplitMix64, patient: { conditions: readonly string[]; age: number; sex: "F" | "M"; visits: readonly string[] }): { events: CorpusEvent[]; exceptions: string[] } {
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
      events.push({ kind: "hba1c", date: dateInYear(rng, CORPUS_MEASUREMENT_YEAR), value: Math.round(value * 10) / 10, external: ext() });
    }
  }

  // CMS165 — the MOST RECENT BP in the period is what the measure reads.
  if (has("hypertension")) {
    const controlled = rng.chance(EVENT_RATES.bpControlled);
    const systolic = controlled ? 112 + rng.nextInt(26) : 140 + rng.nextInt(35);
    const diastolic = controlled ? 66 + rng.nextInt(23) : 90 + rng.nextInt(20);
    events.push({ kind: "bp", date: dateInYear(rng, CORPUS_MEASUREMENT_YEAR), value: systolic, value2: diastolic, external: false });
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
      events.push({ kind: "mammogram", date: dateWithinLookback(rng, 27), external: ext() });
    }
  }

  // CMS130 — colorectal screening, modality-specific look-back. The artifact's INITIAL POPULATION is
  // `Interval[46, 75]` (read off cms130/bundle.json's `Initial Population` def). As with CMS125, the
  // narrower `Interval[50, 75]` in the ELM is `Stratification 2`, not the denominator; stratum 1 is
  // 46-49. Generated 44-77 — two years below the IPP — for the same boundary reason as CMS125 above.
  // NOTE this is the 2026-vintage artifact: USPSTF lowered screening to 45, but the vendored measure
  // has not, and the ARTIFACT is what runs (spec §1's re-vendor caveat).
  if (patient.age >= 44 && patient.age <= 77) {
    if (rng.chance(EVENT_RATES.colorectalUpToDate)) {
      const modality = rng.pick(COLORECTAL_MODALITIES);
      events.push({ kind: "colorectal", date: dateWithinLookback(rng, modality.lookbackMonths), modality: modality.key, external: ext() });
    }
  }

  // CMS137 — a new SUD episode, then initiation, then engagement. The episode is before Nov 14 so the
  // 34-day engagement window closes inside the measurement period (U3 §5).
  if (has("sudEpisode")) {
    const episode = dateInYear(rng, CORPUS_MEASUREMENT_YEAR, 11);
    events.push({ kind: "sudEpisode", date: episode, external: false });
    if (rng.chance(EVENT_RATES.sudInitiation)) {
      const offset = rng.nextInt(15);
      const longActing = rng.chance(EVENT_RATES.sudLongActing);
      events.push({ kind: "sudInitiation", date: addDays(episode, offset), modality: longActing ? "longActingMedication" : "visit", external: false });
      if (longActing || rng.chance(EVENT_RATES.sudEngagement)) {
        events.push({ kind: "sudEngagement", date: addDays(episode, offset + 1 + rng.nextInt(33)), external: false });
      }
    }
  }

  return { events: events.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind)), exceptions };
}

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
export function patientAt(seed: string, index: number, taken: Set<string> = new Set()): CorpusPatient {
  const rng = streamFor(seed, index);
  const fixture = CORPUS_FIXTURE_PREFIX[index];

  const sex: "F" | "M" = rng.chance(FEMALE_SHARE) ? "F" : "M";
  const age = fixture
    ? CORPUS_MEASUREMENT_YEAR - Number(fixture.dateOfBirth!.slice(0, 4))
    : ageFor(rng);
  const dateOfBirth = fixture ? fixture.dateOfBirth! : dobFor(rng, age);
  const band = ageBandFor(age);

  const baseName = fixture ? fixture.name : baseNameFor(rng, sex, dateOfBirth);
  const identity = fixture
    ? { name: fixture.name, redraws: 0, fallback: false }
    : disambiguate(seed, index, baseName, dateOfBirth, taken);
  const panel = fixture
    ? { site: fixture.site, providerId: PCPS.find((p) => p.location === fixture.site)!.id }
    : panelFor(rng);

  const conditions = conditionsFor(rng, band, sex, age);
  const visits = visitsFor(rng);
  const { events, exceptions } = eventsFor(rng, { conditions, age, sex, visits });

  return {
    index,
    externalId: fixture ? fixture.externalId : `pat-${pad(index + 1, 5)}`,
    name: identity.name,
    sex,
    dateOfBirth,
    age,
    ageBand: band,
    site: panel.site,
    providerId: panel.providerId,
    tenantId: "maui",
    conditions,
    visits,
    events,
    exceptions,
  };
}

/** The first `size` patients, with identity collisions resolved against the ones already generated. */
export function corpusPatients(seed: string, size: number): CorpusPatient[] {
  const taken = new Set<string>();
  const out: CorpusPatient[] = [];
  for (let i = 0; i < size; i += 1) {
    const patient = patientAt(seed, i, taken);
    taken.add(`${patient.name}|${patient.dateOfBirth}`);
    out.push(patient);
  }
  return out;
}
