/**
 * Every tunable number the corpus draws from, in one table so the manifest can hash it and a reviewer
 * can read the whole clinical model on one screen. NO LOGIC lives here.
 *
 * The rates are cited public estimates, not the pilot group's measured prevalence. `parametersSha256`
 * goes into the manifest so a run's data is traceable to the exact table that produced it, and
 * CORPUS_GENERATOR_VERSION is bumped by hand whenever a row or the drawing logic changes.
 */
// 4.1.0 (2026-09-07): the dementia-medication order now states its supply window in
// `dosageInstruction.timing.repeat.boundsPeriod` as well as the dispense request, because the second
// engine reads only the former (`docs/evidence/CROSS_ENGINE_2026-09-07_CMS2.md`). No row moved and no
// patient changed, so it is a MINOR bump: the same people, one order described more completely.
export const CORPUS_GENERATOR_VERSION = "4.1.0";
export const DEFAULT_CORPUS_SEED = "maui-py2027-v1";

/**
 * The year a patient's IDENTITY is drawn against, and the year the corpus describes when nobody says
 * otherwise. These are two different things and were one constant until 4.0.0:
 *
 * - `CORPUS_IDENTITY_YEAR` fixes who a patient IS. An age is drawn from the mixture and turned into a
 *   date of birth relative to this year, so the roster — ids, names, dates of birth, sex, clinic, PCP —
 *   is the same in every year the corpus is ever evaluated for. It is the pilot's first performance
 *   year and it does not move.
 * - `DEFAULT_CORPUS_MEASUREMENT_YEAR` is the year a patient's CLINICAL FACTS are generated for when a
 *   caller passes none. The run pipeline always passes one — the calendar year of the run's evaluation
 *   date (ADR-072) — so a sandbox evaluated in 2026 gets 2026 encounters and a run in 2027 gets 2027's.
 *   Until 4.0.0 the facts were pinned to 2027 whatever year the run scored, so every nightly run on the
 *   deployed sandbox scored a year the corpus had no data in and put the whole roster out of every
 *   initial population.
 */
export const CORPUS_IDENTITY_YEAR = 2027;
export const DEFAULT_CORPUS_MEASUREMENT_YEAR = CORPUS_IDENTITY_YEAR;

export interface CorpusClinic {
  readonly id: string;
  readonly name: string;
}

export interface CorpusPcp {
  readonly id: string;
  readonly name: string;
  readonly location: string;
}

/** Maui place names (owner decision D2). Wailuku and Kihei already exist and keep their exact names. */
export const CLINICS: readonly CorpusClinic[] = [
  { id: "maui-clinic-wailuku", name: "Wailuku Clinic" },
  { id: "maui-clinic-kahului", name: "Kahului Clinic" },
  { id: "maui-clinic-kihei", name: "Kihei Clinic" },
  { id: "maui-clinic-lahaina", name: "Lahaina Clinic" },
  { id: "maui-clinic-pukalani", name: "Pukalani Clinic" },
];

/**
 * Panel share per clinic (D1), and the PCP COUNT that keeps every panel near 500.
 *
 * Eight PCPs at every clinic does not work and the arithmetic says so before any sampling: at 20,000
 * patients, Wailuku's 0.28 gives 700 per PCP and Pukalani's 0.10 gives 250, so the plan's own
 * "every panel is 350-650" assertion could never pass. Real groups do not staff every clinic
 * identically either — they staff to the panel. So PCP count scales with the weight and the total is
 * still 40: expected panels are 509 / 520 / 500 / 457 / 500, all comfortably inside 350-650.
 */
export const CLINIC_WEIGHTS: readonly (readonly [string, number])[] = [
  ["Wailuku Clinic", 0.28],
  ["Kahului Clinic", 0.26],
  ["Kihei Clinic", 0.20],
  ["Lahaina Clinic", 0.16],
  ["Pukalani Clinic", 0.10],
];

/** PCPs per clinic, index-aligned with CLINICS. Sums to 40. */
export const PCPS_PER_CLINIC: readonly number[] = [11, 10, 8, 7, 4];

/** Pseudonymous PCP names (locked decision §4A.6 — no client-side staff names). The first four are the existing rows. */
const PCP_SURNAMES = [
  "Stone", "Venn", "Tide", "Cove", "Marsh", "Reyes", "Kalani", "Ito",
  "Ferro", "Nakoa", "Silva", "Aoki", "Puna", "Duarte", "Hale", "Mori",
  "Lani", "Correia", "Kimura", "Alona", "Baptiste", "Kahale", "Tanaka", "Souza",
  "Iona", "Fujii", "Medeiros", "Kaluna", "Sato", "Perreira", "Nohea", "Yamada",
  "Rocha", "Makani", "Endo", "Vieira", "Kealoha", "Ueda", "Freitas", "Malia",
];
const PCP_GIVEN = [
  "Aven", "Kira", "Oren", "Nima", "Talia", "Ruben", "Leilani", "Kenji",
  "Marisol", "Kai", "Ana", "Hiro", "Noe", "Elias", "Mei", "Sora",
  "Lehua", "Paulo", "Yuki", "Kalea", "Andre", "Nalani", "Taro", "Ines",
  "Koa", "Sachi", "Rui", "Malia", "Jun", "Ilima", "Bento", "Aiko",
  "Nico", "Pua", "Haru", "Tiago", "Moana", "Kenzo", "Rosa", "Iris",
];
const PCP_PREFIX = ["Dr.", "NP", "Dr.", "PA", "Dr.", "Dr.", "NP", "Dr."];

/** PCPS_PER_CLINIC PCPs per clinic, ids maui-prov-001..040; the first four preserve today's names. */
export const PCPS: readonly CorpusPcp[] = CLINICS.flatMap((clinic, clinicIndex) => {
  const before = PCPS_PER_CLINIC.slice(0, clinicIndex).reduce((a, b) => a + b, 0);
  return Array.from({ length: PCPS_PER_CLINIC[clinicIndex]! }, (_, slot) => {
    const index = before + slot;
    return {
      id: `maui-prov-${String(index + 1).padStart(3, "0")}`,
      name: `${PCP_PREFIX[slot % PCP_PREFIX.length]!} ${PCP_GIVEN[index]!} ${PCP_SURNAMES[index]!}`,
      location: clinic.name,
    };
  });
});

/** Age mixture skewed older than the US average (D1): median ~52, range 0-95. */
export const AGE_MIXTURE: readonly { readonly min: number; readonly max: number; readonly weight: number }[] = [
  { min: 0, max: 17, weight: 0.14 },   // pediatric panel share in a primary-care group
  { min: 18, max: 44, weight: 0.22 },
  { min: 45, max: 64, weight: 0.30 },
  { min: 65, max: 79, weight: 0.24 },
  { min: 80, max: 95, weight: 0.10 },
];

/** Female share of the panel (D1). */
export const FEMALE_SHARE = 0.52;

export type AgeBand = "0-17" | "18-44" | "45-64" | "65+";

export const ageBandFor = (age: number): AgeBand =>
  age <= 17 ? "0-17" : age <= 44 ? "18-44" : age <= 64 ? "45-64" : "65+";

/**
 * Condition prevalence by age band. Sources are US primary-care population estimates; they are
 * ESTIMATES and the manifest publishes them so they can be challenged (spec §11).
 */
/**
 * SOURCES, per row, because a blanket "US primary-care estimates" header is not a citation and the
 * previous version of this table had nothing else. These are public national estimates rounded to the
 * precision a synthetic panel needs, not a fitted model:
 *  - diabetes: CDC National Diabetes Statistics Report (diagnosed, by age).
 *  - hypertension: CDC/NHANES age-adjusted prevalence — 65+ raised from 0.63 to 0.74 to match it.
 *  - bipolar: NIMH 12-month prevalence by age.
 *  - colorectalCancer: SEER prevalence, which is the right basis for CMS130's exclusion (a history of
 *    the disease), not incidence.
 *  - esrd: USRDS treated-ESRD prevalence. Corrected 2026-09-06 — the previous 0.008/0.020 for 45-64
 *    and 65+ were 3-5x the real ~0.2%/~0.6-0.7%, and ESRD is a CMS165 denominator exclusion that IS
 *    emitted, so the error inflated a reported denominator rather than being cosmetic.
 *  - hospice / frailty: NHPCO and the CMS frailty-indicator literature, order of magnitude only.
 *  - palliativeCare: CAPC/NPCRC estimates of palliative-care receipt outside hospice, order of magnitude.
 *  - bilateralMastectomy: women only; SEER breast-cancer prevalence times the bilateral-surgery share.
 *  - totalColectomy: order of magnitude from colectomy incidence over a lifetime; it is a CMS130
 *    denominator EXCLUSION, so what matters is that some patients carry it, not the third decimal.
 *  - sudEpisode: SAMHSA NSDUH past-year SUD, discounted to the share presenting in primary care.
 *
 * `pregnancy` was removed in 4.0.0. No vendored measure retrieves a pregnancy value set, the corpus had
 * no verified code to stamp, and a fact that is drawn, counted and published but never emitted is the
 * exact shape of claim this table exists to avoid. The four rows added in its place are all
 * denominator exclusions the ACO's measures actually read: `frailty` is now EMITTED (with the dementia
 * medication or advanced-illness diagnosis the 66+ exclusion also needs, see EVENT_RATES),
 * `palliativeCare` excludes on cms122/125/130/165, `bilateralMastectomy` on cms125 and
 * `totalColectomy` on cms130. Before 4.0.0 none of those exclusions could fire on any patient, so a
 * regression in exclusion handling would have been invisible on the whole corpus.
 */
export const CONDITION_PREVALENCE: Record<AgeBand, Record<string, number>> = {
  "0-17": { diabetes: 0.004, hypertension: 0.003, bipolar: 0.002, colorectalCancer: 0.0, esrd: 0.0001, hospice: 0.0, frailty: 0.0, sudEpisode: 0.010, palliativeCare: 0.0, bilateralMastectomy: 0.0, totalColectomy: 0.0 },
  "18-44": { diabetes: 0.045, hypertension: 0.110, bipolar: 0.028, colorectalCancer: 0.001, esrd: 0.0008, hospice: 0.0005, frailty: 0.0, sudEpisode: 0.055, palliativeCare: 0.0002, bilateralMastectomy: 0.0008, totalColectomy: 0.0003 },
  "45-64": { diabetes: 0.170, hypertension: 0.400, bipolar: 0.022, colorectalCancer: 0.008, esrd: 0.002, hospice: 0.002, frailty: 0.0, sudEpisode: 0.035, palliativeCare: 0.001, bilateralMastectomy: 0.006, totalColectomy: 0.0012 },
  "65+":   { diabetes: 0.265, hypertension: 0.740, bipolar: 0.012, colorectalCancer: 0.020, esrd: 0.007, hospice: 0.012, frailty: 0.090, sudEpisode: 0.012, palliativeCare: 0.006, bilateralMastectomy: 0.010, totalColectomy: 0.0025 },
};

/**
 * Payer mix by age band, as Source of Payment Typology codes — the vocabulary the measures' `SDE Payer`
 * reads through the "Payer Type" value set (2.16.840.1.114222.4.11.3591). Every code here is verified a
 * member of that expansion by `corpus-membership.test.ts`. Medicare for the 65+ panel (with a Medicare
 * Advantage share near the national figure), commercial and Medicaid below it; the pediatric band is
 * where Medicaid/CHIP is largest. Order of magnitude, like everything else in this table.
 */
export const PAYER_MIX: Record<AgeBand, readonly (readonly [string, number])[]> = {
  "0-17": [["5", 0.58], ["2", 0.42]],
  "18-44": [["5", 0.74], ["2", 0.26]],
  "45-64": [["5", 0.80], ["2", 0.16], ["1", 0.04]],
  "65+": [["1", 0.55], ["11", 0.43], ["5", 0.02]],
};

/**
 * Race (CDC/OMB categories) and ethnicity, as the `us-core-race` / `us-core-ethnicity` extensions the
 * measures' `SDE Race` / `SDE Ethnicity` read. Maui County's mix from the decennial census, rounded:
 * Asian and Native Hawaiian or Other Pacific Islander shares far above the US average, and a Hispanic
 * or Latino share near 11%. Codes are members of the Race (…4.11.836) and Ethnicity (…4.11.837) value
 * sets every vendored artifact declares.
 */
export const RACE_MIX: readonly (readonly [string, number])[] = [
  ["2106-3", 0.33], // White
  ["2028-9", 0.29], // Asian
  ["2076-8", 0.24], // Native Hawaiian or Other Pacific Islander
  ["2131-1", 0.11], // Other Race
  ["2054-5", 0.02], // Black or African American
  ["1002-5", 0.01], // American Indian or Alaska Native
];
export const HISPANIC_OR_LATINO_SHARE = 0.11;

/** Event rates the six measures read (spec §3, item 3). */
export const EVENT_RATES = {
  /** CMS122: share of diabetics whose most recent HbA1c is > 9 % (the measure's numerator is poor control). */
  hba1cPoorControl: 0.20,
  /** CMS122: share of diabetics with NO HbA1c in the year at all — also numerator by the measure's own logic. */
  hba1cMissing: 0.08,
  /** CMS165: share of hypertensives whose most recent BP is controlled (< 140/90). */
  bpControlled: 0.62,
  /**
   * Share of UNCONTROLLED hypertensives whose diastolic is normal — isolated systolic hypertension.
   * The dominant uncontrolled phenotype over 65 (NHANES-era US estimates put it around two thirds of
   * uncontrolled hypertension in that age group); 0.55 across the whole hypertensive cohort here,
   * which skews younger. Without it the corpus produced none at all, and CMS165's "BOTH components
   * below threshold" conjunction was never exercised.
   */
  isolatedSystolic: 0.55,
  /** CMS2: share of the eligible population screened for depression. */
  phq9Screened: 0.70,
  /** CMS2: share of screens that are positive. */
  phq9Positive: 0.12,
  /** CMS2: share of positive screens with a documented follow-up plan on the same day. */
  phq9FollowUp: 0.80,
  /** CMS2: documented refusal / medical reason (a denominator exception). */
  phq9Exception: 0.01,
  /** CMS125: share of eligible women with a mammogram inside the 27-month look-back. */
  mammogramUpToDate: 0.72,
  /** CMS130: share of the 46-75 cohort up to date on any colorectal modality. */
  colorectalUpToDate: 0.65,
  /** CMS137: share of new SUD episodes with initiation within 14 days. */
  sudInitiation: 0.45,
  /** CMS137: share of initiators who engage within 34 days. */
  sudEngagement: 0.35,
  /** CMS137: share of initiations that are a long-acting medication (the single-visit variant). */
  sudLongActing: 0.10,
  /**
   * The 66+ advanced-illness-and-frailty exclusion (AIFrailLTCF, shared by cms122/125/130/165) needs
   * frailty AND either a dementia medication or an advanced-illness diagnosis in the year before or
   * during the period. Among frail elders these are the shares carrying each; a frail patient with
   * neither stays IN the denominator, which is what the measure logic says and what a real panel has.
   */
  frailtyDementiaMedication: 0.45,
  frailtyAdvancedIllness: 0.60,
  /** D5: share of screening events sourced outside the practice (HIE / outside lab / referring specialist). */
  externalSourced: 0.20,
} as const;

/**
 * Colorectal modality mix within the up-to-date share, with each modality's look-back in months.
 *
 * CMS130's ELM retrieves FIVE modality value sets — read off `measures/official/cms130/bundle.json`:
 * Colonoscopy (…108.12.1020), Fecal Occult Blood Test (…198.12.1011), sDNA FIT Test (…108.12.1039),
 * Flexible Sigmoidoscopy (…198.12.1010) and CT Colonography (…108.12.1038).
 *
 * Only TWO are generated today, and the reason is deliberate rather than an oversight. A modality is
 * only emittable if we know a real MEMBER CODE of its value set: an event stamped with a code outside
 * the artifact's expansion is silently never retrieved, so the patient reads as unscreened and the
 * measure reports a number that looks plausible and is wrong. Colonoscopy (SNOMED 44054006-adjacent,
 * already in ECQM_CANONICAL_CODES) and FOBT (LOINC 2335-8, confirmed a member) are the two whose codes
 * are established. sDNA FIT, flexible sigmoidoscopy and CT colonography are NOT included because their
 * member codes could not be confirmed against VSAC — the vendored bundles carry zero ValueSet
 * resources and the terminology sidecar is fetched at build (ADR-036), so nothing local can verify a
 * guess. Add them when the sidecar is available and `corpus-membership.test.ts` can prove membership;
 * that test is the gate, not this comment.
 *
 * The weights below preserve the two modalities' relative ratio (0.55 : 0.28) and re-normalise to 1,
 * so the overall `colorectalUpToDate` rate is unchanged and no screened patient is left with an
 * un-emittable modality — which would have been a silent ~17% under-count of the CMS130 numerator.
 */
export const COLORECTAL_MODALITIES: readonly (readonly [{ readonly key: string; readonly lookbackMonths: number }, number])[] = [
  [{ key: "colonoscopy", lookbackMonths: 120 }, 0.66],
  [{ key: "fobt", lookbackMonths: 12 }, 0.34],
];

/** Office visits in the measurement year (spec §3, item 1). At least one falls before Nov 14. */
export const VISITS_PER_YEAR: readonly (readonly [number, number])[] = [[1, 0.34], [2, 0.31], [3, 0.22], [4, 0.13]];

/** Given-name pools by birth decade and sex; composition reflects Maui's demographic mix (D2 rationale). */
export const GIVEN_NAMES: Record<"F" | "M", Record<string, readonly string[]>> = {
  F: {
    "1930": ["Doris", "Shizue", "Amelia", "Rosalina", "Harriet", "Yoshie", "Constance", "Leimomi"],
    "1940": ["Linda", "Setsuko", "Teresa", "Kalei", "Marjorie", "Emiko", "Consuelo", "Nohea"],
    "1950": ["Deborah", "Keiko", "Maria", "Ululani", "Patricia", "Haruko", "Lucinda", "Kahealani"],
    "1960": ["Lisa", "Naomi", "Rosario", "Kaimana", "Sandra", "Yuki", "Perpetua", "Malia"],
    "1970": ["Jennifer", "Ayako", "Marisol", "Leilani", "Michelle", "Sachiko", "Cristina", "Pualani"],
    "1980": ["Ashley", "Miho", "Angelica", "Kealoha", "Brittany", "Rina", "Jocelyn", "Noelani"],
    "1990": ["Taylor", "Hana", "Adriana", "Kaiulani", "Megan", "Airi", "Danica", "Lehua"],
    "2000": ["Madison", "Yui", "Camila", "Kalena", "Ava", "Sakura", "Elena", "Maile"],
    "2010": ["Olivia", "Aoi", "Sofia", "Kaleimomi", "Mia", "Rio", "Isabela", "Kiana"],
    "2020": ["Amelia", "Ema", "Valentina", "Lokelani", "Luna", "Hina", "Beatriz", "Anuhea"],
  },
  M: {
    "1930": ["Robert", "Tadashi", "Manuel", "Kimo", "Donald", "Isamu", "Alfredo", "Keoni"],
    "1940": ["Richard", "Hiroshi", "Jose", "Kawika", "Gary", "Masao", "Domingo", "Ikaika"],
    "1950": ["Steven", "Kenji", "Ramon", "Makoa", "Bruce", "Noboru", "Ernesto", "Kai"],
    "1960": ["Scott", "Takeshi", "Rogelio", "Nainoa", "Brian", "Osamu", "Rodolfo", "Koa"],
    "1970": ["Jason", "Ryo", "Marlon", "Kekoa", "Eric", "Yosuke", "Reynaldo", "Keanu"],
    "1980": ["Tyler", "Sho", "Angelo", "Kainoa", "Justin", "Daiki", "Emilio", "Makani"],
    "1990": ["Austin", "Ren", "Mateo", "Kamaka", "Dylan", "Yuto", "Rafael", "Kanoa"],
    "2000": ["Ethan", "Haruto", "Sebastian", "Kaimana", "Logan", "Sota", "Diego", "Kealii"],
    "2010": ["Liam", "Riku", "Santiago", "Kaikane", "Noah", "Yuma", "Andres", "Nohea"],
    "2020": ["Mateo", "Aoto", "Thiago", "Kaiao", "Ezra", "Itsuki", "Bruno", "Laakea"],
  },
};

/** Surname pool weighted to Maui's family mix: Native Hawaiian, Filipino, Japanese, Portuguese, Anglo. */
export const SURNAMES: readonly string[] = [
  "Kealoha", "Kahananui", "Nakoa", "Kaluna", "Makani", "Iona", "Puna", "Hale", "Lani", "Malia",
  "Reyes", "Ramos", "Bautista", "Domingo", "Corpuz", "Agustin", "Pascual", "Ancheta", "Bumanglag", "Galam",
  "Tanaka", "Yamada", "Nakamura", "Kobayashi", "Fujii", "Ueda", "Aoki", "Sato", "Endo", "Mori",
  "Silva", "Souza", "Medeiros", "Freitas", "Rocha", "Vieira", "Correia", "Duarte", "Perreira", "Baptiste",
  "Carter", "Bennett", "Hayes", "Whitfield", "Sutton", "Prescott", "Marlowe", "Ashford", "Kingsley", "Vance",
];

/** Collision handling (spec §3, "Identity and uniqueness"). */
export const MAX_NAME_REDRAWS = 16;

// The parameter table is HASHED for provenance, but not here: this module is on the worker request
// path, which must stay portable (no `node:crypto`). `parametersSha256` lives in
// `run/cli/corpus-manifest.ts`, on the wiring side of the engine boundary.
