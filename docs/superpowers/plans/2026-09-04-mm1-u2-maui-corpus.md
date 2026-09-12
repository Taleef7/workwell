# MM-1 U2 — 20,000-patient Maui corpus with provenance: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate, wire, filter and retain a deterministic 20,000-patient primary-care corpus for the Maui deployment — clinically data-first, provenance-stamped, spread across five clinics and forty PCPs, with no duplicate identities and a nightly run that stays inside its window and its storage budget.

**Architecture:** A pure generator (`patientAt(seed, index)`) built on an in-repo SplitMix64, whose first 48 records are today's `MAUI_BASE` verbatim so every existing fixture keeps its identities. The generator feeds three consumers that share nothing else: a `SyntheticDirectoryView` for the Maui deployment profile, a `SubjectBundleSource` (U1's seam) for the run pipeline, and an NDJSON exporter that writes a hash-pinned manifest. Scale is absorbed by chunking the existing run pipeline (not by a worker pool) and by a retention pass that compacts per-subject outcome history after the quality snapshot is taken.

**Tech Stack:** TypeScript on `@mieweb/cloud`, `node:test` + `node:assert/strict` (the repo has **no vitest** — run tests with `node --import tsx --test "<glob>"` from `backend-ts/`), SQLite floor + Postgres ceiling behind the existing store contract, FHIR R4 / QI-Core resources, `@work-well/official-executor` (fqm-execution) for the official measures.

**Spec:** `docs/superpowers/specs/2026-09-04-mm1-u2-maui-corpus-design.md`. Read it before starting; every task below cites the section it implements.

**Depends on:** U1 PR 1 (`SubjectBundleSource`, `classifyRunnable`, the calendar measurement period). Do not start Task 8 before U1 PR 1 is merged.

---

## File structure

| File | Responsibility |
|---|---|
| `backend-ts/src/engine/synthetic/corpus/splitmix64.ts` | The PRNG. One class, no dependency, no domain knowledge. |
| `backend-ts/src/engine/synthetic/corpus/corpus-parameters.ts` | Every tunable number and pool, each with a one-line source comment. No logic. |
| `backend-ts/src/engine/synthetic/corpus/corpus-fixture-prefix.ts` | The 48 `MAUI_BASE` rows, moved verbatim out of `employee-catalog.ts`. |
| `backend-ts/src/engine/synthetic/corpus/corpus-patient.ts` | `patientAt(seed, index)` — identity, panel, conditions, events. Pure. |
| `backend-ts/src/engine/synthetic/corpus/corpus-bundle.ts` | `bundleForPatient(patient, evaluationDate)` — FHIR resources + one `Provenance` each. |
| `backend-ts/src/engine/synthetic/corpus/corpus-directory.ts` | `corpusDirectory(seed, size)` → `SyntheticDirectoryView`; the 40 PCPs and 5 clinics. |
| `backend-ts/src/engine/synthetic/corpus/corpus-bundle-source.ts` | `corpusBundleSource(seed)` — U1's `SubjectBundleSource` over the corpus. |
| `backend-ts/src/engine/synthetic/corpus/corpus-manifest.ts` | Manifest assembly + hashing. |
| `backend-ts/src/engine/synthetic/corpus/corpus-export-cli.ts` | `pnpm corpus:export` — streams NDJSON, writes the manifest. |
| `backend-ts/src/run/outcome-compaction.ts` | `compactOutcomes` + the `pnpm outcomes:compact` entry. |

Each file is independently testable and has a sibling `*.test.ts`. The generator never imports the run pipeline; the pipeline never imports `corpus-parameters.ts`.

---

# Stage A — the generator (§3, §8)

> **One PR for all of U2** (owner decision, 2026-09-04). The four "PR" headings below are now
> **stages within a single branch `feat/maui-corpus`** — they still gate each other and still commit
> separately, so the history inside the PR stays readable, but nothing is opened for review until the
> whole unit is done and two reviewers from different families have been through it.

## Task 1: SplitMix64

**Files:**
- Create: `backend-ts/src/engine/synthetic/corpus/splitmix64.ts`
- Test: `backend-ts/src/engine/synthetic/corpus/splitmix64.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { SplitMix64, streamKeyFor } from "./splitmix64.ts";

test("SplitMix64 reproduces the reference vectors for seed 0", () => {
  // Reference output of the canonical splitmix64 (Vigna), state advanced by 0x9E3779B97F4A7C15 per draw.
  const rng = new SplitMix64(0n);
  assert.equal(rng.nextU64(), 0xe220a8397b1dcdafn);
  assert.equal(rng.nextU64(), 0x6e789e6aa1b965f4n);
  assert.equal(rng.nextU64(), 0x06c45d188009454fn);
});

test("nextFloat is in [0,1) and nextInt is in range", () => {
  const rng = new SplitMix64(42n);
  for (let i = 0; i < 1000; i += 1) {
    const f = rng.nextFloat();
    assert.ok(f >= 0 && f < 1, `float out of range: ${f}`);
    const n = rng.nextInt(7);
    assert.ok(Number.isInteger(n) && n >= 0 && n < 7, `int out of range: ${n}`);
  }
});

test("pick draws from a weighted table deterministically and covers every entry", () => {
  const table = [["a", 0.5], ["b", 0.3], ["c", 0.2]] as const;
  const first = new SplitMix64(1n);
  const second = new SplitMix64(1n);
  assert.equal(first.pick(table), second.pick(table), "same seed, same draw");
  const seen = new Set<string>();
  const rng = new SplitMix64(9n);
  for (let i = 0; i < 500; i += 1) seen.add(rng.pick(table));
  assert.deepEqual([...seen].sort(), ["a", "b", "c"]);
});

test("streamKeyFor is a pure function of (seed, index) and differs per index", () => {
  assert.equal(streamKeyFor("maui-py2027-v1", 7), streamKeyFor("maui-py2027-v1", 7));
  assert.notEqual(streamKeyFor("maui-py2027-v1", 7), streamKeyFor("maui-py2027-v1", 8));
  assert.notEqual(streamKeyFor("other-seed", 7), streamKeyFor("maui-py2027-v1", 7));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend-ts && node --import tsx --test "src/engine/synthetic/corpus/splitmix64.test.ts"`
Expected: FAIL — `ERR_MODULE_NOT_FOUND: Cannot find module '.../splitmix64.ts'`.

- [ ] **Step 3: Implement**

`backend-ts/src/engine/synthetic/corpus/splitmix64.ts`:
```ts
/**
 * SplitMix64 (Vigna) — the corpus PRNG. In-repo and dependency-free on purpose: the corpus must be
 * byte-reproducible from (seed, index) for the life of the pilot, which a third-party PRNG whose
 * implementation may change across a major version cannot promise.
 *
 * Every patient draws from their OWN stream, keyed by (seed, index), so generation order and batch
 * boundaries never change a record (spec §3, "Determinism").
 */
import { createHash } from "node:crypto";

const MASK = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;

export class SplitMix64 {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = seed & MASK;
  }

  /** One 64-bit draw. */
  nextU64(): bigint {
    this.state = (this.state + GOLDEN) & MASK;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    return (z ^ (z >> 31n)) & MASK;
  }

  /** Uniform in [0, 1). 53 bits of mantissa, so the conversion is exact. */
  nextFloat(): number {
    return Number(this.nextU64() >> 11n) / 2 ** 53;
  }

  /** Uniform integer in [0, bound). */
  nextInt(bound: number): number {
    if (bound <= 0) throw new Error(`[corpus] nextInt bound must be positive, got ${bound}`);
    return Math.floor(this.nextFloat() * bound);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.nextFloat() < p;
  }

  /** One entry from a weighted table. Weights need not sum to 1; the last entry absorbs rounding. */
  pick<T>(table: readonly (readonly [T, number])[]): T {
    const total = table.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.nextFloat() * total;
    for (const [value, weight] of table) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return table[table.length - 1]![0];
  }

  /** One entry from an unweighted pool. */
  pickOne<T>(pool: readonly T[]): T {
    return pool[this.nextInt(pool.length)]!;
  }
}

/**
 * The per-patient stream key: the first 8 bytes of sha256(seed) as a big-endian BigInt, XOR the index.
 * Hashing the seed means two human-chosen seeds that differ by one character produce unrelated streams.
 */
export function streamKeyFor(seed: string, index: number): bigint {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  const base = digest.readBigUInt64BE(0);
  return (base ^ BigInt(index)) & MASK;
}

/** The stream a patient draws every one of their values from. */
export const streamFor = (seed: string, index: number): SplitMix64 => new SplitMix64(streamKeyFor(seed, index));
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend-ts && node --import tsx --test "src/engine/synthetic/corpus/splitmix64.test.ts"`
Expected: `# fail 0`.

If the reference vectors in Step 1 disagree with the implementation, **the implementation is right and the vectors were mistyped** — recompute them by running the algorithm and paste the actual values into the test, then say so in the handoff. Do not weaken the test to a round-trip check.

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/engine/synthetic/corpus/splitmix64.ts backend-ts/src/engine/synthetic/corpus/splitmix64.test.ts
git commit -m "feat(corpus): SplitMix64, the dependency-free PRNG the corpus is reproducible from"
```

---

## Task 2: The parameter table and the fixture prefix

**Files:**
- Create: `backend-ts/src/engine/synthetic/corpus/corpus-parameters.ts`
- Create: `backend-ts/src/engine/synthetic/corpus/corpus-fixture-prefix.ts`
- Modify: `backend-ts/src/engine/synthetic/employee-catalog.ts` (delete `MAUI_BASE`, import the prefix)
- Test: `backend-ts/src/engine/synthetic/corpus/corpus-parameters.test.ts`

- [ ] **Step 1: Move the 48 rows**

Cut the `MAUI_BASE` array (currently `employee-catalog.ts:273`, 48 rows `pat-001..pat-048`) **verbatim** into `corpus-fixture-prefix.ts` and export it as `CORPUS_FIXTURE_PREFIX`. In `employee-catalog.ts`, import it and use it in the `EMPLOYEE_BASE` composition:

```ts
import { CORPUS_FIXTURE_PREFIX } from "./corpus/corpus-fixture-prefix.ts";
// ...
const EMPLOYEE_BASE: readonly EmployeeBase[] = [...TWH_BASE, ...IHN_BASE, ...CORPUS_FIXTURE_PREFIX];
```

Do not change a single field of any of the 48 rows. This is a move, and `git diff` must show the rows only as deleted from one file and added to the other.

- [ ] **Step 2: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { CORPUS_FIXTURE_PREFIX } from "./corpus-fixture-prefix.ts";
import { CLINICS, PCPS, CLINIC_WEIGHTS, AGE_MIXTURE, CONDITION_PREVALENCE, EVENT_RATES, parametersSha256 } from "./corpus-parameters.ts";

test("the fixture prefix is exactly the 48 pat-001..pat-048 rows", () => {
  assert.equal(CORPUS_FIXTURE_PREFIX.length, 48);
  assert.equal(CORPUS_FIXTURE_PREFIX[0]!.externalId, "pat-001");
  assert.equal(CORPUS_FIXTURE_PREFIX[47]!.externalId, "pat-048");
  assert.ok(CORPUS_FIXTURE_PREFIX.every((p) => p.tenantId === "maui" && p.role === "Patient"));
});

test("there are five clinics and forty PCPs, eight per clinic, and the first four PCPs are the existing ids", () => {
  assert.deepEqual(CLINICS.map((c) => c.name), ["Wailuku Clinic", "Kahului Clinic", "Kihei Clinic", "Lahaina Clinic", "Pukalani Clinic"]);
  assert.equal(PCPS.length, 40);
  for (const [i, clinic] of CLINICS.entries()) {
    assert.equal(PCPS.filter((p) => p.location === clinic.name).length, PCPS_PER_CLINIC[i], `${clinic.name} PCP count`);
  }
  // The bound in the distribution test below is only reachable because PCP count scales with weight.
  for (const [i, [, weight]] of CLINIC_WEIGHTS.entries()) {
    const expected = (20000 * weight) / PCPS_PER_CLINIC[i]!;
    assert.ok(expected >= 400 && expected <= 600, `${CLINICS[i]!.name} expected panel ${expected}`);
  }
  assert.deepEqual(PCPS.slice(0, 4).map((p) => p.id), ["maui-prov-001", "maui-prov-002", "maui-prov-003", "maui-prov-004"]);
  assert.ok(PCPS.every((p) => /^maui-prov-\d{3}$/.test(p.id)), "PCP ids are pseudonymous");
});

test("clinic weights sum to 1 and every clinic is represented", () => {
  const total = CLINIC_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
  assert.deepEqual(CLINIC_WEIGHTS.map(([name]) => name).sort(), CLINICS.map((c) => c.name).sort());
});

test("every prevalence and rate is a probability", () => {
  const all = [...Object.values(CONDITION_PREVALENCE).flatMap((band) => Object.values(band)), ...Object.values(EVENT_RATES)];
  for (const value of all) assert.ok(typeof value === "number" && value >= 0 && value <= 1, `not a probability: ${value}`);
  assert.ok(Math.abs(AGE_MIXTURE.reduce((sum, c) => sum + c.weight, 0) - 1) < 1e-9);
});

test("parametersSha256 is stable and changes when a parameter changes", () => {
  assert.match(parametersSha256(), /^[0-9a-f]{64}$/);
  assert.equal(parametersSha256(), parametersSha256(), "pure");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd backend-ts && node --import tsx --test "src/engine/synthetic/corpus/corpus-parameters.test.ts"`
Expected: FAIL — `Cannot find module './corpus-parameters.ts'`.

- [ ] **Step 4: Implement the parameter table**

`corpus-parameters.ts`. **Every row carries a one-line source comment** — the spec calls these cited estimates, not the pilot's real prevalence, and the manifest exposes them so the quality lead can challenge them (spec §11).

```ts
/**
 * Every tunable number the corpus draws from, in one table so the manifest can hash it and a reviewer
 * can read the whole clinical model on one screen. NO LOGIC lives here.
 *
 * The rates are cited public estimates, not the pilot group's measured prevalence. `parametersSha256`
 * goes into the manifest so a run's data is traceable to the exact table that produced it, and
 * CORPUS_GENERATOR_VERSION is bumped by hand whenever a row or the drawing logic changes.
 */
import { createHash } from "node:crypto";

export const CORPUS_GENERATOR_VERSION = "1.0.0";
export const DEFAULT_CORPUS_SEED = "maui-py2027-v1";

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
export const CONDITION_PREVALENCE: Record<AgeBand, Record<string, number>> = {
  "0-17": { diabetes: 0.004, hypertension: 0.003, bipolar: 0.002, colorectalCancer: 0.0, esrd: 0.0004, pregnancy: 0.004, hospice: 0.0, frailty: 0.0, sudEpisode: 0.010 },
  "18-44": { diabetes: 0.045, hypertension: 0.110, bipolar: 0.028, colorectalCancer: 0.001, esrd: 0.002, pregnancy: 0.075, hospice: 0.0005, frailty: 0.0, sudEpisode: 0.055 },
  "45-64": { diabetes: 0.170, hypertension: 0.400, bipolar: 0.022, colorectalCancer: 0.008, esrd: 0.008, pregnancy: 0.002, hospice: 0.002, frailty: 0.0, sudEpisode: 0.035 },
  "65+":   { diabetes: 0.265, hypertension: 0.630, bipolar: 0.012, colorectalCancer: 0.020, esrd: 0.020, pregnancy: 0.0, hospice: 0.012, frailty: 0.090, sudEpisode: 0.012 },
};

/** Event rates the six measures read (spec §3, item 3). */
export const EVENT_RATES = {
  /** CMS122: share of diabetics whose most recent HbA1c is > 9 % (the measure's numerator is poor control). */
  hba1cPoorControl: 0.20,
  /** CMS122: share of diabetics with NO HbA1c in the year at all — also numerator by the measure's own logic. */
  hba1cMissing: 0.08,
  /** CMS165: share of hypertensives whose most recent BP is controlled (< 140/90). */
  bpControlled: 0.62,
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
  /** D5: share of screening events sourced outside the practice (HIE / outside lab / referring specialist). */
  externalSourced: 0.20,
} as const;

/** Colorectal modality mix within the up-to-date share, with each modality's look-back in months (CMS130). */
export const COLORECTAL_MODALITIES: readonly (readonly [{ readonly key: string; readonly lookbackMonths: number }, number])[] = [
  [{ key: "colonoscopy", lookbackMonths: 120 }, 0.55],
  [{ key: "fit", lookbackMonths: 12 }, 0.28],
  [{ key: "fitDna", lookbackMonths: 36 }, 0.09],
  [{ key: "sigmoidoscopy", lookbackMonths: 60 }, 0.05],
  [{ key: "ctColonography", lookbackMonths: 60 }, 0.03],
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

/** SHA-256 of the parameter table, for the manifest. Keys in declaration order; comments excluded. */
export function parametersSha256(): string {
  const rows = {
    CORPUS_GENERATOR_VERSION, CLINICS, CLINIC_WEIGHTS, PCPS, AGE_MIXTURE, FEMALE_SHARE,
    CONDITION_PREVALENCE, EVENT_RATES, COLORECTAL_MODALITIES, VISITS_PER_YEAR,
    GIVEN_NAMES, SURNAMES, MAX_NAME_REDRAWS,
  };
  return createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex");
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd backend-ts && node --import tsx --test "src/engine/synthetic/corpus/corpus-parameters.test.ts" "src/engine/synthetic/employee-catalog*.test.ts"`
Expected: `# fail 0`. The `employee-catalog` tests must pass **unchanged** — the prefix move changes no identity.

- [ ] **Step 6: Commit**

```bash
git add backend-ts/src/engine/synthetic/corpus/corpus-parameters.ts backend-ts/src/engine/synthetic/corpus/corpus-fixture-prefix.ts backend-ts/src/engine/synthetic/corpus/corpus-parameters.test.ts backend-ts/src/engine/synthetic/employee-catalog.ts
git commit -m "feat(corpus): the parameter table and the 48-row fixture prefix, moved out of the employee catalog"
```

---

## Task 3: `patientAt` — identity and panel

**Files:**
- Create: `backend-ts/src/engine/synthetic/corpus/corpus-patient.ts`
- Test: `backend-ts/src/engine/synthetic/corpus/corpus-patient.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { patientAt, corpusPatients } from "./corpus-patient.ts";
import { CORPUS_FIXTURE_PREFIX } from "./corpus-fixture-prefix.ts";
import { CLINICS, PCPS, DEFAULT_CORPUS_SEED } from "./corpus-parameters.ts";

test("the first 48 patients are the fixture prefix verbatim", () => {
  for (const [i, fixture] of CORPUS_FIXTURE_PREFIX.entries()) {
    const p = patientAt(DEFAULT_CORPUS_SEED, i);
    assert.equal(p.externalId, fixture.externalId);
    assert.equal(p.name, fixture.name);
    assert.equal(p.site, fixture.site);
    assert.equal(p.dateOfBirth, fixture.dateOfBirth);
  }
});

test("generated ids start at pat-00049 and are zero-padded to five digits", () => {
  assert.equal(patientAt(DEFAULT_CORPUS_SEED, 48).externalId, "pat-00049");
  assert.equal(patientAt(DEFAULT_CORPUS_SEED, 19999).externalId, "pat-20000");
});

test("patientAt is pure: same (seed, index) gives a byte-identical record", () => {
  const a = patientAt(DEFAULT_CORPUS_SEED, 5000);
  const b = patientAt(DEFAULT_CORPUS_SEED, 5000);
  assert.deepEqual(a, b);
});

test("generation order does not matter: EVERY index is the same alone as it is in sequence", () => {
  // The whole first 2,000 rather than one lucky index: the failure this guards against only shows up
  // where a name collides, and index 900 may well not collide. A single-index version of this test
  // passed against an implementation that was genuinely order-dependent.
  const inSequence = corpusPatients(DEFAULT_CORPUS_SEED, 2000);
  for (let i = 0; i < 2000; i += 1) {
    const alone = patientAt(DEFAULT_CORPUS_SEED, i);
    assert.deepEqual({ ...alone, name: undefined }, { ...inSequence[i]!, name: undefined }, `index ${i} differs outside the name`);
  }
  // The NAME is the one field allowed to differ, and only by disambiguation against lower indices.
  const collided = inSequence.filter((p, i) => p.name !== patientAt(DEFAULT_CORPUS_SEED, i).name);
  for (const p of collided) assert.match(p.name, /^\S+ (?:[A-Z]|\d{5})\. /, `${p.externalId} differs but is not a disambiguation`);
});

test("a different seed produces a different corpus", () => {
  assert.notDeepEqual(patientAt("other-seed", 5000), patientAt(DEFAULT_CORPUS_SEED, 5000));
});

test("the first 100 patients hash to a pinned value — a silent generator drift fails here", () => {
  const digest = createHash("sha256").update(JSON.stringify(corpusPatients(DEFAULT_CORPUS_SEED, 100)), "utf8").digest("hex");
  assert.equal(digest, "<RECORD THE ACTUAL HASH IN STEP 4>");
});

test("every patient lands in a real clinic with a PCP at that clinic", () => {
  const byId = new Map(PCPS.map((p) => [p.id, p]));
  const names = new Set(CLINICS.map((c) => c.name));
  for (const p of corpusPatients(DEFAULT_CORPUS_SEED, 2000)) {
    assert.ok(names.has(p.site), `${p.externalId} is at unknown clinic ${p.site}`);
    assert.equal(byId.get(p.providerId)?.location, p.site, `${p.externalId}'s PCP is not at their clinic`);
  }
});

test("no duplicate (name, dateOfBirth) pair across the full 20,000", () => {
  const seen = new Set<string>();
  for (const p of corpusPatients(DEFAULT_CORPUS_SEED, 20000)) {
    const key = `${p.name}|${p.dateOfBirth}`;
    assert.ok(!seen.has(key), `duplicate identity: ${key} at ${p.externalId}`);
    seen.add(key);
  }
});

test("distributions land inside their tolerances over the full 20,000", () => {
  const all = corpusPatients(DEFAULT_CORPUS_SEED, 20000);
  for (const [name, weight] of [["Wailuku Clinic", 0.28], ["Kahului Clinic", 0.26], ["Kihei Clinic", 0.20], ["Lahaina Clinic", 0.16], ["Pukalani Clinic", 0.10]] as const) {
    const share = all.filter((p) => p.site === name).length / all.length;
    assert.ok(Math.abs(share - weight) < 0.02, `${name}: ${(share * 100).toFixed(1)}% vs ${weight * 100}%`);
  }
  for (const pcp of PCPS) {
    const panel = all.filter((p) => p.providerId === pcp.id).length;
    assert.ok(panel >= 350 && panel <= 650, `${pcp.id} panel ${panel} outside 350-650`);
  }
  const ages = all.map((p) => p.age).sort((a, b) => a - b);
  const median = ages[Math.floor(ages.length / 2)]!;
  assert.ok(median >= 48 && median <= 56, `age median ${median}`);
  const female = all.filter((p) => p.sex === "F").length / all.length;
  assert.ok(female >= 0.50 && female <= 0.54, `female share ${(female * 100).toFixed(1)}%`);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend-ts && node --import tsx --test "src/engine/synthetic/corpus/corpus-patient.test.ts"`
Expected: FAIL — `Cannot find module './corpus-patient.ts'`.

- [ ] **Step 3: Implement**

`corpus-patient.ts`. The draw order below is **contract** — changing it changes every record, which is what `CORPUS_GENERATOR_VERSION` and the pinned hash exist to catch.

```ts
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

const PERIOD_END = `${CORPUS_MEASUREMENT_YEAR}-12-31`;
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

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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

  const sex: "F" | "M" = fixture ? (rng.chance(FEMALE_SHARE) ? "F" : "M") : rng.chance(FEMALE_SHARE) ? "F" : "M";
  const age = fixture
    ? CORPUS_MEASUREMENT_YEAR - Number(fixture.dateOfBirth!.slice(0, 4))
    : ageFor(rng);
  const dateOfBirth = fixture ? fixture.dateOfBirth! : dobFor(rng, age);
  const band = ageBandFor(age);

  // Two draws either way, so the stream position entering conditionsFor does not depend on `taken`.
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
```

**Note on the fixture prefix and the PCP:** the 48 keep their `externalId`, `name`, `site` and `dateOfBirth`, but their PCP is re-derived from the corpus PCP table (they had round-robin ids before). If `employee-catalog.maui.test.ts` pins a `providerId` for one of the 48, update the pin — record the change in the handoff.

- [ ] **Step 4: Record the pinned hash and run**

Run the suite once; the pinned-hash test will fail with the actual digest in the assertion diff. Paste that digest into Step 1's test, then re-run.

Run: `cd backend-ts && node --import tsx --test "src/engine/synthetic/corpus/corpus-patient.test.ts"`
Expected: `# fail 0`. The 20,000-patient uniqueness and distribution tests take ~10–30 s; that is expected.

If a distribution tolerance fails, **tune the parameter table, never the tolerance** — the tolerances are the spec's acceptance criteria (§8). If a tolerance is unreachable, stop and report which one and by how much.

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/engine/synthetic/corpus/corpus-patient.ts backend-ts/src/engine/synthetic/corpus/corpus-patient.test.ts
git commit -m "feat(corpus): patientAt — deterministic identity, panel and clinical facts per patient"
```

---

## Task 4: The FHIR bundle and its Provenance

**Files:**
- Create: `backend-ts/src/engine/synthetic/corpus/corpus-bundle.ts`
- Test: `backend-ts/src/engine/synthetic/corpus/corpus-bundle.test.ts`

**Before writing code:** read `backend-ts/src/engine/synthetic/fhir-bundle-builder.ts` in full and match its resource shapes, its `meta.profile` stamping and its id conventions. QI-Core retrieval is `meta.profile`-sensitive — an unstamped resource is silently never retrieved (CLAUDE.md, "Two traps"). Read U1's official-only shapes (`docs/superpowers/specs/2026-09-04-mm1-five-measures-live-design.md` §4.1) for the exact codes each measure retrieves, and use U1's dual-stamped code constants rather than typing LOINC/SNOMED strings again.

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { bundleForPatient, practitionerResources, organizationResources } from "./corpus-bundle.ts";
import { patientAt, corpusPatients } from "./corpus-patient.ts";
import { DEFAULT_CORPUS_SEED, PCPS, CLINICS } from "./corpus-parameters.ts";

const EVAL_DATE = "2027-12-31";

test("every clinical resource has exactly one Provenance whose target resolves inside the bundle", () => {
  for (const patient of corpusPatients(DEFAULT_CORPUS_SEED, 200)) {
    const bundle = bundleForPatient(patient, EVAL_DATE);
    const entries = bundle.entry.map((e) => e.resource);
    const ids = new Set(entries.map((r) => `${r.resourceType}/${r.id}`));
    const provenances = entries.filter((r) => r.resourceType === "Provenance");
    const clinical = entries.filter((r) => !["Patient", "Provenance"].includes(r.resourceType));
    assert.equal(provenances.length, clinical.length, `${patient.externalId}: one Provenance per clinical resource`);
    for (const prov of provenances) {
      const target = prov.target[0].reference;
      assert.ok(ids.has(target), `${patient.externalId}: Provenance targets ${target}, which is not in the bundle`);
    }
  }
});

test("Provenance names the patient's own PCP and clinic, and an external informant only when the event is external", () => {
  const patient = corpusPatients(DEFAULT_CORPUS_SEED, 400).find((p) => p.events.some((e) => e.external))!;
  const bundle = bundleForPatient(patient, EVAL_DATE);
  const provenances = bundle.entry.map((e) => e.resource).filter((r) => r.resourceType === "Provenance");
  for (const prov of provenances) {
    const author = prov.agent.find((a) => a.type.coding[0].code === "author");
    assert.equal(author.who.reference, `Practitioner/${patient.providerId}`);
    assert.match(author.onBehalfOf.reference, /^Organization\/maui-clinic-/);
    assert.equal(prov.entity[0].what.display, "WorkWell synthetic corpus maui-py2027-v1 #1.0.0");
  }
  assert.ok(provenances.some((p) => p.agent.some((a) => a.type.coding[0].code === "informant")), "an external event carries an informant agent");
});

test("a patient with no conditions still gets a Patient and their encounters, and no orphan Provenance", () => {
  const bare = corpusPatients(DEFAULT_CORPUS_SEED, 400).find((p) => p.conditions.length === 0)!;
  const bundle = bundleForPatient(bare, EVAL_DATE);
  const types = bundle.entry.map((e) => e.resource.resourceType);
  assert.ok(types.includes("Patient"));
  assert.ok(types.includes("Encounter"));
  assert.equal(types.filter((t) => t === "Provenance").length, types.filter((t) => !["Patient", "Provenance"].includes(t)).length);
});

test("bundleForPatient is pure — the same patient yields byte-identical JSON", () => {
  const p = patientAt(DEFAULT_CORPUS_SEED, 1234);
  assert.equal(JSON.stringify(bundleForPatient(p, EVAL_DATE)), JSON.stringify(bundleForPatient(p, EVAL_DATE)));
});

test("the 40 Practitioners and 5 Organizations are emitted once with the ids the bundles reference", () => {
  assert.deepEqual(practitionerResources().map((r) => r.id), PCPS.map((p) => p.id));
  assert.deepEqual(organizationResources().map((r) => r.id), CLINICS.map((c) => c.id));
});
```

- [ ] **Step 2: Run to verify it fails** — `Cannot find module './corpus-bundle.ts'`.

- [ ] **Step 3: Implement**

Write `corpus-bundle.ts` exporting:
- `bundleForPatient(patient: CorpusPatient, evaluationDate: string): FhirBundle`
- `practitionerResources(): FhirResource[]` — one `Practitioner` per row of `PCPS`, `id` = the PCP id, `name` split from the display name.
- `organizationResources(): FhirResource[]` — one `Organization` per row of `CLINICS`.
- `provenanceFor(resource, patient, external): FhirResource` — the shape in spec §3 verbatim.

Rules that must hold, each stated as a comment at the site that enforces it:
- One `Provenance` per clinical resource, `id` = `<resourceId>-prov`, `recorded` = `<resource date>T12:00:00Z`.
- The `author` agent is `Practitioner/<patient.providerId>` `onBehalfOf` `Organization/<the clinic id for patient.site>`.
- The `informant` agent (`who.display: "Outside laboratory (HIE)"`) appears **only** when the source event is `external`.
- `entity[0].what.display` is `` `WorkWell synthetic corpus ${seed} #${CORPUS_GENERATOR_VERSION}` ``.
- Every clinical resource carries the same `meta.profile` its `fhir-bundle-builder.ts` counterpart carries.
- Codes come from U1's dual-stamped constants. Do not hand-type a LOINC or SNOMED code in this file.

Emit, per patient: `Patient` (with `birthDate`, `gender`, `managingOrganization`), one `Encounter` per visit, one `Condition` per condition, and for each `CorpusEvent` the resource U1's shapes retrieve — `Observation` for `hba1c` / `bp` (a panel with components) / `phq9`; `Procedure` for `mammogram` / `colorectal` / `sudEngagement`; `ServiceRequest` for `phq9FollowUp`; `MedicationRequest` or `Procedure` for `sudInitiation` per its modality; and an `Observation` carrying the documented reason for each entry in `exceptions`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend-ts && node --import tsx --test "src/engine/synthetic/corpus/corpus-bundle.test.ts"`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/engine/synthetic/corpus/corpus-bundle.ts backend-ts/src/engine/synthetic/corpus/corpus-bundle.test.ts
git commit -m "feat(corpus): QI-Core bundles with one Provenance per clinical resource"
```

---

## Task 5: Terminology membership — every emitted code is in its artifact's expansion

**Files:**
- Modify: `backend-ts/src/standards/corpus-membership.test.ts` (extend; find its exact path with `git grep -l corpus-membership`)

- [ ] **Step 1: Read the existing test** and follow its sidecar-gating pattern exactly — it self-skips when the terminology sidecar is absent, and that behaviour must be preserved so the default suite stays runnable without VSAC credentials.

- [ ] **Step 2: Add the failing case**

```ts
test("every code the corpus emits is a member of its artifact's expansion", { skip: skipWithoutSidecar() }, async () => {
  const patients = corpusPatients(DEFAULT_CORPUS_SEED, 500);
  const offenders: string[] = [];
  for (const patient of patients) {
    for (const entry of bundleForPatient(patient, "2027-12-31").entry) {
      for (const coding of codingsOf(entry.resource)) {
        if (!(await isMemberOfAnyExpansion(coding))) offenders.push(`${patient.externalId} ${entry.resource.resourceType} ${coding.system}|${coding.code}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `codes outside every vendored expansion:\n${offenders.slice(0, 20).join("\n")}`);
});
```

Reuse the file's existing `skipWithoutSidecar`, `codingsOf` and expansion-membership helpers; if they are named differently, use the existing names and say so in the handoff.

- [ ] **Step 3: Run**

Run: `cd backend-ts && node --import tsx --test "src/standards/corpus-membership.test.ts"`
Expected: `# fail 0`, or a skip when the sidecar is absent. **A code outside every expansion is a real defect in Task 4** — fix the emitting code, never the assertion.

- [ ] **Step 4: Commit**

```bash
git add backend-ts/src/standards/corpus-membership.test.ts
git commit -m "test(corpus): every emitted code is a member of a vendored expansion"
```

---

## Task 6: The manifest

**Files:**
- Create: `backend-ts/src/engine/synthetic/corpus/corpus-manifest.ts`
- Test: `backend-ts/src/engine/synthetic/corpus/corpus-manifest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "./corpus-manifest.ts";
import { corpusPatients } from "./corpus-patient.ts";
import { DEFAULT_CORPUS_SEED, CLINICS, PCPS, parametersSha256, CORPUS_GENERATOR_VERSION } from "./corpus-parameters.ts";

test("the manifest carries every key the spec names, with the declared types", () => {
  const m = buildManifest({ seed: DEFAULT_CORPUS_SEED, patients: corpusPatients(DEFAULT_CORPUS_SEED, 48), ndjsonSha256: { Patient: "a".repeat(64) } });
  assert.equal(m.generatorVersion, CORPUS_GENERATOR_VERSION);
  assert.equal(m.seed, DEFAULT_CORPUS_SEED);
  assert.equal(m.size, 48);
  assert.equal(m.parametersSha256, parametersSha256());
  for (const key of ["artifactHashes", "terminologySha256s", "realized", "estimatedCohorts", "ndjsonSha256"]) {
    assert.ok(key in m, `manifest is missing ${key}`);
  }
  assert.deepEqual(Object.keys(m.realized.byAgeBand).sort(), ["0-17", "18-44", "45-64", "65+"]);
  assert.deepEqual(Object.keys(m.realized.bySex).sort(), ["F", "M"]);
  assert.equal(Object.keys(m.realized.byClinic).length, CLINICS.length);
  assert.equal(Object.keys(m.realized.byProvider).length, PCPS.length, "every PCP appears, even with a zero panel");
});

test("realized counts sum to the corpus size", () => {
  const patients = corpusPatients(DEFAULT_CORPUS_SEED, 2000);
  const m = buildManifest({ seed: DEFAULT_CORPUS_SEED, patients, ndjsonSha256: {} });
  const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
  for (const key of ["byClinic", "byProvider", "byAgeBand", "bySex"] as const) {
    assert.equal(sum(m.realized[key]), 2000, `${key} does not sum to the corpus size`);
  }
});

test("the 48-patient manifest matches its golden fixture", async () => {
  const m = buildManifest({ seed: DEFAULT_CORPUS_SEED, patients: corpusPatients(DEFAULT_CORPUS_SEED, 48), ndjsonSha256: {} });
  const golden = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("./__fixtures__/manifest-48.json", import.meta.url), "utf8"));
  assert.deepEqual({ ...m, artifactHashes: {}, terminologySha256s: {} }, { ...golden, artifactHashes: {}, terminologySha256s: {} });
});
```

- [ ] **Step 2: Run to verify it fails** — `Cannot find module './corpus-manifest.ts'`.

- [ ] **Step 3: Implement** `buildManifest({ seed, patients, ndjsonSha256 })` returning exactly the keys spec §8 lists. `artifactHashes` and `terminologySha256s` read the vendored `manifest.json` per measure through the existing loader (`git grep -n "loadOfficialArtifact"` for it) — do not re-hash the bundle yourself. `estimatedCohorts` computes, per catalog id, the IPP and denominator the parameter table implies over the generated patients plus the expected numerator rate from `EVENT_RATES`.

- [ ] **Step 4: Record the golden**

Generate the 48-patient manifest, write it to `backend-ts/src/engine/synthetic/corpus/__fixtures__/manifest-48.json`, re-run.

Run: `cd backend-ts && node --import tsx --test "src/engine/synthetic/corpus/corpus-manifest.test.ts"`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/engine/synthetic/corpus/corpus-manifest.ts backend-ts/src/engine/synthetic/corpus/corpus-manifest.test.ts backend-ts/src/engine/synthetic/corpus/__fixtures__/manifest-48.json
git commit -m "feat(corpus): the provenance manifest — seed, parameter hash, artifact hashes, realized counts"
```

---

## Task 7: `pnpm corpus:export`

**Files:**
- Create: `backend-ts/src/engine/synthetic/corpus/corpus-export-cli.ts`
- Modify: `backend-ts/package.json` (add the `corpus:export` script **only** — no dependency changes)
- Test: `backend-ts/src/engine/synthetic/corpus/corpus-export-cli.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCorpusExport } from "./corpus-export-cli.ts";

test("the export writes one NDJSON per resource type plus practitioners, organizations and the manifest", async () => {
  const out = await mkdtemp(join(tmpdir(), "corpus-"));
  await runCorpusExport({ seed: "maui-py2027-v1", size: 60, out });
  const files = (await readdir(out)).sort();
  assert.ok(files.includes("manifest.json"));
  assert.ok(files.includes("practitioners.ndjson"));
  assert.ok(files.includes("organizations.ndjson"));
  assert.ok(files.includes("Patient.ndjson"));
  assert.ok(files.includes("Provenance.ndjson"));

  const patients = (await readFile(join(out, "Patient.ndjson"), "utf8")).trim().split("\n");
  assert.equal(patients.length, 60);
  for (const line of patients) assert.equal(JSON.parse(line).resourceType, "Patient");

  const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.size, 60);
  assert.match(manifest.ndjsonSha256.Patient, /^[0-9a-f]{64}$/);
});

test("the same seed and size export byte-identical NDJSON", async () => {
  const [a, b] = [await mkdtemp(join(tmpdir(), "corpus-a-")), await mkdtemp(join(tmpdir(), "corpus-b-"))];
  await runCorpusExport({ seed: "maui-py2027-v1", size: 40, out: a });
  await runCorpusExport({ seed: "maui-py2027-v1", size: 40, out: b });
  assert.equal(await readFile(join(a, "Patient.ndjson"), "utf8"), await readFile(join(b, "Patient.ndjson"), "utf8"));
});
```

- [ ] **Step 2: Run to verify it fails** — `Cannot find module './corpus-export-cli.ts'`.

- [ ] **Step 3: Implement**

`runCorpusExport({ seed, size, out })` streams: it generates patients in batches of 500, appends each resource to its type's write stream, hashes each stream incrementally, and writes `manifest.json` last. **Memory must stay flat** — never accumulate 20,000 bundles in an array. Add a `main()` guarded by `import.meta.url` that parses `--seed`, `--size`, `--out` and calls it, matching the argument style of the existing CLIs in `backend-ts/src/run/`.

In `backend-ts/package.json` add exactly one line to `scripts`:
```json
"corpus:export": "tsx src/engine/synthetic/corpus/corpus-export-cli.ts"
```

- [ ] **Step 4: Run to verify it passes, then run it for real**

```bash
cd backend-ts && node --import tsx --test "src/engine/synthetic/corpus/corpus-export-cli.test.ts"
corepack pnpm@10 corpus:export --seed maui-py2027-v1 --size 20000 --out ../.corpus-check
```
Expected: tests `# fail 0`; the 20,000 export completes and `manifest.json` shows `size: 20000`. Record the wall-clock time and the total output size in the handoff, then **delete `../.corpus-check`** — no corpus files in the repo (D3).

- [ ] **Step 5: Run the whole backend gate**

```bash
cd backend-ts && corepack pnpm@10 typecheck && corepack pnpm@10 test
```
Expected: exit 0, `# fail 0`.

- [ ] **Step 6: Commit and open PR 1**

```bash
git add backend-ts/src/engine/synthetic/corpus/corpus-export-cli.ts backend-ts/src/engine/synthetic/corpus/corpus-export-cli.test.ts backend-ts/package.json
git commit -m "feat(corpus): pnpm corpus:export — streaming NDJSON plus the manifest"
```

No PR yet — Stage A is the first third of one branch. The PR opens after Stage D, titled
`feat(corpus): a deterministic 20,000-patient Maui corpus, wired, filterable and retained (MM-1 U2)`.

---

# Stage B — wiring and scale (§4, §6)

> Do not start before U1 PR 1 is merged: every task here depends on `SubjectBundleSource`.

## Task 8: The corpus directory, composed lazily — including the eager captures

**Files:**
- Create: `backend-ts/src/engine/synthetic/corpus/corpus-directory.ts`
- Modify: `backend-ts/src/config/deployment-profile.ts`, `backend-ts/src/segment/segment-seed.ts`,
  `backend-ts/src/engine/ingress/webchart/live-directory.ts`
- Test: `backend-ts/src/engine/synthetic/corpus/corpus-directory.test.ts`

> **Plan-review finding (this task was wrong).** Turning the named exports into getters is not enough.
> Three module-scope constants capture the directory eagerly at import, and each defeats the laziness
> silently — the code still works, it just reads the 48-patient default no matter what
> `WORKWELL_MAUI_CORPUS_SIZE` says:
> - `deployment-profile.ts` — `const DIRECTORY = { employees: DEPLOYMENT_DIRECTORY.EMPLOYEES, ... }`.
>   This is the big one: **eight non-test modules import `DIRECTORY`** (`mcp/tools.ts`,
>   `quality/materialize-run.ts`, `program/program-read-models.ts`, `program/hierarchy-rollup.ts`,
>   `export/export-csv.ts`, `routes/cases.ts`, `routes/orders.ts`, `routes/runs.ts`,
>   `run/employee-profile.ts`).
> - `segment/segment-seed.ts` — `const DEMO_SEGMENTS = demoSegmentsFor(..., EMPLOYEES, ...)`.
> - `engine/ingress/webchart/live-directory.ts` — `const STATIC_DIRECTORY = { employees: EMPLOYEES, ... }`.
>
> A captured function reference (`enterpriseForTenant`) is fine — re-pointing a function is safe. A
> captured **array** is not.

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { corpusDirectory } from "./corpus-directory.ts";
import { PCPS, CLINICS, DEFAULT_CORPUS_SEED } from "./corpus-parameters.ts";

test("corpusDirectory yields `size` patients, the 40 providers and the maui tenant", () => {
  const dir = corpusDirectory(DEFAULT_CORPUS_SEED, 500);
  assert.equal(dir.EMPLOYEES.length, 500);
  assert.equal(dir.PROVIDERS.length, PCPS.length);
  assert.ok(dir.EMPLOYEES.every((e) => e.tenantId === "maui" && e.role === "Patient"));
  assert.ok(dir.EMPLOYEES.every((e) => CLINICS.some((c) => c.name === e.site)));
});

test("the default size is the 48-patient fixture prefix", () => {
  assert.deepEqual(
    corpusDirectory(DEFAULT_CORPUS_SEED, 48).EMPLOYEES.map((e) => e.externalId),
    Array.from({ length: 48 }, (_, i) => `pat-${String(i + 1).padStart(3, "0")}`),
  );
});

test("providersForLocation returns only that clinic's PCPs", () => {
  const dir = corpusDirectory(DEFAULT_CORPUS_SEED, 200);
  assert.equal(dir.providersForLocation("Kahului Clinic").length, 10);
  assert.ok(dir.providersForLocation("Kahului Clinic").every((p) => p.location === "Kahului Clinic"));
  assert.deepEqual(dir.providersForLocation("Nowhere Clinic"), []);
});
```

- [ ] **Step 2: Write the test that proves laziness actually reaches the consumers**

This is the test the original plan lacked, and without it the three eager captures above would have
shipped unnoticed. It runs in a **child process** so the env is set before any import — copy the
mechanism from `backend-ts/src/test-support/run-profile-child.ts`.

`backend-ts/src/config/deployment-directory-lazy.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

test("every directory consumer sees the configured corpus size, not the default 48", async () => {
  const out = await runProfileChild({
    env: { WORKWELL_INSTANCE: "maui", WORKWELL_MAUI_CORPUS_SIZE: "300" },
    body: `
      const { EMPLOYEES, DIRECTORY } = await import("../config/deployment-profile.ts");
      const { DEMO_SEGMENTS } = await import("../segment/segment-seed.ts");
      console.log(JSON.stringify({
        employees: EMPLOYEES.length,
        directoryEmployees: DIRECTORY.employees.length,
        segmentSubjects: DEMO_SEGMENTS[0]?.subjectCount ?? null,
      }));
    `,
  });
  assert.equal(out.employees, 300, "the named export is lazy");
  assert.equal(out.directoryEmployees, 300, "DIRECTORY is lazy — eight modules read the directory through it");
  assert.ok((out.segmentSubjects ?? 0) > 48, "the demo segment seed is lazy too");
});

test("with no size set, every consumer sees the 48-patient fixture prefix", async () => {
  const out = await runProfileChild({
    env: { WORKWELL_INSTANCE: "maui" },
    body: `
      const { EMPLOYEES, DIRECTORY } = await import("../config/deployment-profile.ts");
      console.log(JSON.stringify({ employees: EMPLOYEES.length, directoryEmployees: DIRECTORY.employees.length }));
    `,
  });
  assert.equal(out.employees, 48);
  assert.equal(out.directoryEmployees, 48);
});
```

Adapt the harness call to `run-profile-child.ts`'s actual signature — read it first and match it;
do not invent an API. If it cannot run an arbitrary body, extend it minimally rather than stubbing
the import, because stubbing at that level is what would make this test fictional.

- [ ] **Step 3: Run to verify both fail** — `Cannot find module './corpus-directory.ts'`, then (once
  the module exists but the captures remain) `directoryEmployees` is 48 while `employees` is 300.
  **Report both failures; the second is the one that matters.**

- [ ] **Step 4: Implement `corpusDirectory`**

Returns a `SyntheticDirectoryView` (read its interface in `employee-catalog.ts`) whose `EMPLOYEES`
maps each `CorpusPatient` to an `EmployeeProfile` (`externalId`, `name`, `role: "Patient"`, `site`,
`providerId`, `tenantId: "maui"`, `dateOfBirth`; **no `nationalId`** — spec §3). Every other member
is derived from those arrays exactly as `employee-catalog.ts` derives its own.

- [ ] **Step 5: Make the directory lazy, all the way through**

In `deployment-profile.ts`: a memoized `getDeploymentDirectory()` reading
`WORKWELL_MAUI_CORPUS_SIZE` (default 48) and `WORKWELL_MAUI_CORPUS_SEED` (default
`DEFAULT_CORPUS_SEED`) **at first access, not at import**. Then:
- Keep every existing named export working by making it a getter that delegates.
- **`DIRECTORY` becomes a getter too** (or `getDirectory()`, with the eight consumers updated). A
  getter is the smaller diff and keeps the eight call sites unchanged — prefer it.
- `segment-seed.ts`: `DEMO_SEGMENTS` becomes a memoized function (`demoSegments()`); update its
  consumers.
- `live-directory.ts`: `STATIC_DIRECTORY` becomes lazy the same way.
- Add `__resetDeploymentDirectory()` alongside U1's `__resetRunnableMemo()`, and reset **all three**
  memos.

**`validateRunnableMeasureIds(MAUI_MEASURE_IDS)` and `(DEFAULT_MEASURE_IDS)` stay at module load.**
They validate compile-time constants, not env-dependent state, and moving them into the lazy path
would delay a configuration error from import to first request. Do not "fix" them.

- [ ] **Step 6: Run the whole gate**

```bash
cd backend-ts && corepack pnpm@10 typecheck && corepack pnpm@10 test
```
Expected: `# fail 0`. **Any Maui pin that moves is a finding to report, not a number to overwrite** —
spec §3 names the files that legitimately need re-recording; anything outside that list changing means
the laziness changed behaviour.

- [ ] **Step 7: Commit**

```bash
git add backend-ts/src/engine/synthetic/corpus/corpus-directory.ts backend-ts/src/engine/synthetic/corpus/corpus-directory.test.ts backend-ts/src/config/deployment-profile.ts backend-ts/src/config/deployment-directory-lazy.test.ts backend-ts/src/segment/segment-seed.ts backend-ts/src/engine/ingress/webchart/live-directory.ts
git commit -m "feat(corpus): the Maui directory is the corpus, composed lazily — including the three eager captures"
```

---

## Task 9: `corpusBundleSource` and one bundle per subject per chunk

**Files:**
- Create: `backend-ts/src/engine/synthetic/corpus/corpus-bundle-source.ts`
- Modify: `backend-ts/src/wiring/subject-bundle-source.ts` (add optional `bundleForSubject`)
- Test: `backend-ts/src/engine/synthetic/corpus/corpus-bundle-source.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { corpusBundleSource } from "./corpus-bundle-source.ts";
import { corpusDirectory } from "./corpus-directory.ts";
import { DEFAULT_CORPUS_SEED } from "./corpus-parameters.ts";

const EMPLOYEES = corpusDirectory(DEFAULT_CORPUS_SEED, 48).EMPLOYEES;

test("bundleForSubject returns the patient's whole record, and bundleFor returns the same regardless of measure", () => {
  const src = corpusBundleSource(DEFAULT_CORPUS_SEED);
  const e = EMPLOYEES[0]!;
  const whole = JSON.stringify(src.bundleForSubject!(e, "2027-12-31"));
  for (const id of ["cms122", "cms125", "cms2", "cms130", "cms165"]) {
    assert.equal(JSON.stringify(src.bundleFor(e, id, "COMPLIANT", "2027-12-31")), whole, `${id} sees the same record`);
  }
});

test("distribution covers every employee and targetFor is COMPLIANT for all — the corpus is data-first", () => {
  const src = corpusBundleSource(DEFAULT_CORPUS_SEED);
  assert.equal(src.distribution(EMPLOYEES, "cms122").length, EMPLOYEES.length);
  assert.equal(src.targetFor(EMPLOYEES, "cms122", EMPLOYEES[3]!.externalId), "COMPLIANT");
});

test("an employee outside the corpus is a clear error, not an empty bundle", () => {
  const src = corpusBundleSource(DEFAULT_CORPUS_SEED);
  assert.throws(() => src.bundleFor({ ...EMPLOYEES[0]!, externalId: "emp-999" }, "cms122", "COMPLIANT", "2027-12-31"), /not a corpus subject/);
});
```

- [ ] **Step 2: Run to verify it fails** — `Cannot find module './corpus-bundle-source.ts'`.

- [ ] **Step 3: Implement**

`corpusBundleSource(seed)` resolves an `externalId` back to its corpus index (`pat-00049` → 48; the 48 prefix ids map by position) and calls `bundleForPatient`. Add to `SubjectBundleSource`:

```ts
  /**
   * The subject's WHOLE record, measure-independent. The pipeline prefers this when a source
   * provides it and builds it ONCE PER CHUNK — a full-record bundle rebuilt per measure is 5x
   * redundant at the pilot's measure count (spec §4).
   */
  bundleForSubject?(employee: EmployeeProfile, evaluationDate: string): FhirBundle;
```

Add a comment on `targetFor` in this implementation: the target is unused by the corpus — it is data-first, and CQL alone decides every outcome. `compositeBundleSource` picks the corpus source on the Maui profile.

- [ ] **Step 4: Run** — `cd backend-ts && node --import tsx --test "src/engine/synthetic/**/*.test.ts"` → `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/engine/synthetic/corpus/corpus-bundle-source.ts backend-ts/src/engine/synthetic/corpus/corpus-bundle-source.test.ts backend-ts/src/wiring/subject-bundle-source.ts
git commit -m "feat(corpus): the corpus as a SubjectBundleSource, one whole-record bundle per subject"
```

---

## Task 10: Chunked evaluation in the run pipeline

**Files:**
- Modify: `backend-ts/src/run/run-pipeline.ts`
- Test: `backend-ts/src/run/run-pipeline.chunking.test.ts` (create),
  `backend-ts/src/run/run-pipeline.test-support.ts` (create)

This is the highest-risk task in U2, and the plan-review rewrote it. **Three corrections carried in
from that review — read them before writing a line, because the original tests could not have run:**

1. **`planManualRun` is the PLANNING half only.** It returns
   `PlannedRun = { run: { id }, items, measureIds, scopeLabel, scopeType, evalDate, livePopulation? }`
   — **no `status`, no counters, no `warnings`, no `dataFreshAsOf`.** Evaluation and finalization live
   in `finishOrFail` / `finishManualRun`. Every assertion below therefore reads the **stores and the
   audit events** after running the full pipeline, never a field on the planning result.
2. **`dataFreshAsOf` is not computed by the pipeline at all** — it is `MAX(evaluated_at)` in
   `read-models.ts:144`. Assert it through the read model, and do not add it to the pipeline.
3. **Bundle construction is internal to `run-pipeline.ts`** (`bundleFor`, ~line 184) and is *not*
   observable at the store/executor boundary. A harness that reached in to count bundles would be
   instrumenting internals and proving nothing about the real caller. So the memory invariant is
   observed through the **`SubjectBundleSource` dependency** (U1's seam, already injectable): the
   test injects a counting source and the pipeline's per-chunk cache is what the counts reveal.

- [ ] **Step 1: Build the test support first**

`backend-ts/src/run/run-pipeline.test-support.ts`. Stub at the **lowest** boundary — stores, the
executor, and the injected `bundleSource` — never at `planManualRun`/`finishOrFail` themselves, or
the harness becomes gentler than the real caller and the tests stop meaning anything.

```ts
/**
 * Deps for the chunking tests. Everything is stubbed at the store / executor / bundle-source
 * boundary, which is where the real caller sits; nothing stubs the pipeline functions themselves.
 * `counters` is what the invariants are read from.
 */
export interface ChunkTestDeps extends RunPipelineDeps {
  counters: {
    listCasesCalls: { preload: number; rollover: number };
    recordOutcomesBatchSizes: number[];
    bundlesBuilt: number;          // incremented by the counting bundleSource
    maxLiveBundles: number;        // peak of (built - released), released when a chunk cache drops
  };
}

export function makeTestDeps(opts: {
  subjects: EmployeeProfile[];
  chunkSize: number;
  ippSubjectIds?: string[];        // subjects the stub engine puts in the initial population
  staleCycleCases?: number;
  failOnChunk?: number;            // make the STORE throw while persisting this chunk (0-based)
  officialRouting?: boolean;       // sets the engine stub's logicVersion to the official prefix
}): ChunkTestDeps;

export function seedSubjects(n: number): EmployeeProfile[];
export function drainAuditEvents(deps: ChunkTestDeps): AuditEvent[];
/** Runs plan + finish and returns the persisted run row plus its outcomes. */
export function runFully(deps: ChunkTestDeps, req: ManualRunRequest): Promise<{ run: RunRecord; outcomes: OutcomeRecord[] }>;
```

`failOnChunk` must make a **store write** throw, not the engine: a per-subject engine failure is
already caught by the pipeline's per-item isolation and becomes `MISSING_DATA`/`PARTIAL_FAILURE`,
which is not the failure mode invariant 3 is about.

- [ ] **Step 2: Write the eight failing tests**

```ts
test("invariant 1: ADR-043 empty-IPP membership is judged over the COMPLETE roster, never per chunk", async () => {
  // 1,200 subjects, chunk size 500, and the ONLY subject in the IPP is the last one. A per-chunk
  // empty-IPP judgement would flag chunks 1 and 2.
  // officialRouting: true is REQUIRED — the empty-IPP check is gated on the engine reporting an
  // official logicVersion (run-pipeline.ts:868). Without it the check never fires and this test
  // passes against a per-chunk implementation too, which is exactly how it was vacuous before.
  const deps = makeTestDeps({ chunkSize: 500, subjects: seedSubjects(1200), ippSubjectIds: ["pat-01200"], officialRouting: true });
  const { run } = await runFully(deps, { measureIds: ["cms122"] });
  assert.equal(run.status, "COMPLETED", "ADR-043 warns, it never refuses");
  const warned = drainAuditEvents(deps).filter((e) => /empty initial population/i.test(JSON.stringify(e.payload ?? {})));
  assert.deepEqual(warned, [], "no empty-IPP warning: one chunk having no IPP member is not an empty roster");
});

test("invariant 1b: a roster with NO ipp member anywhere still warns — the check is not simply disabled", async () => {
  // The negative control. Without it, invariant 1 passes trivially against an implementation that
  // deleted the empty-IPP check outright.
  const deps = makeTestDeps({ chunkSize: 500, subjects: seedSubjects(1200), ippSubjectIds: [], officialRouting: true });
  const { run } = await runFully(deps, { measureIds: ["cms122"] });
  assert.equal(run.status, "COMPLETED");
  const warned = drainAuditEvents(deps).filter((e) => /empty initial population/i.test(JSON.stringify(e.payload ?? {})));
  assert.equal(warned.length, 1, "a genuinely empty IPP is still surfaced");
});

test("invariant 2: a re-run over the same period creates no duplicate case", async () => {
  const deps = makeTestDeps({ chunkSize: 100, subjects: seedSubjects(250) });
  await runFully(deps, { measureIds: ["cms122"] });
  const afterFirst = (await deps.stores.cases.listCases({ limit: 100000 })).length;
  await runFully(deps, { measureIds: ["cms122"] });
  assert.equal((await deps.stores.cases.listCases({ limit: 100000 })).length, afterFirst);
});

test("invariant 3: a chunk failure finalizes the run once, as FAILED", async () => {
  const ok = makeTestDeps({ chunkSize: 100, subjects: seedSubjects(250) });
  const { run: okRun } = await runFully(ok, { measureIds: ["cms122"] });
  assert.equal(okRun.status, "COMPLETED");
  assert.equal(drainAuditEvents(ok).filter((e) => e.eventType === "RUN_COMPLETED").length, 1);

  const bad = makeTestDeps({ chunkSize: 100, subjects: seedSubjects(250), failOnChunk: 1 });
  await runFully(bad, { measureIds: ["cms122"] }).catch(() => undefined);
  const badRun = (await bad.stores.runs.listRuns({ limit: 10 }))[0]!;
  assert.equal(badRun.status, "FAILED");
  // NOTE: failPlannedRun emits RUN_COMPLETED with status FAILED (pre-existing, not this change's
  // doing). What matters is that exactly ONE terminal event is written, not which name it carries.
  assert.equal(drainAuditEvents(bad).filter((e) => e.eventType === "RUN_COMPLETED" || e.eventType === "RUN_FAILED").length, 1);
});

test("invariant 4: cycle rollover runs once, at run finish, not at a chunk boundary", async () => {
  const deps = makeTestDeps({ chunkSize: 100, subjects: seedSubjects(250), staleCycleCases: 3 });
  await runFully(deps, { measureIds: ["cms122"] });
  const rolled = drainAuditEvents(deps).filter((e) => e.payload?.closedReason === "CYCLE_ROLLED_OVER");
  assert.equal(rolled.length, 3, "each stale case rolls over exactly once, not once per chunk");
});

test("invariant 5: the active-case snapshot is preloaded once per measure, however many chunks", async () => {
  // Counted SEPARATELY from the rollover's own listCases calls: the rollover also queries per
  // measure (run-pipeline.ts:904) and this change does not alter it, so a single combined counter
  // would read 4 for two measures and the assertion would be wrong rather than discriminating.
  const deps = makeTestDeps({ chunkSize: 100, subjects: seedSubjects(500) });
  await runFully(deps, { measureIds: ["cms122", "cms125"] });
  assert.equal(deps.counters.listCasesCalls.preload, 2, "one preload per measure across five chunks each");
});

test("invariant 6: counters accumulate across chunks, and dataFreshAsOf comes from the read model", async () => {
  const deps = makeTestDeps({ chunkSize: 100, subjects: seedSubjects(250) });
  const { run } = await runFully(deps, { measureIds: ["cms122"] });
  assert.equal(run.totalEvaluated, 250);
  const completed = drainAuditEvents(deps).find((e) => e.eventType === "RUN_COMPLETED")!;
  assert.equal(completed.payload.totalEvaluated, 250);
  // dataFreshAsOf is NOT a pipeline field — read-models.ts:144 derives it as MAX(evaluated_at).
  const readModel = await runDetailReadModel(deps.stores, run.id);
  assert.ok(readModel.dataFreshAsOf, "the read model sees every chunk's outcomes");
});

test("invariant 7 + memory: each chunk persists before the next is built, and only one chunk's bundles live", async () => {
  const deps = makeTestDeps({ chunkSize: 100, subjects: seedSubjects(250) });
  await runFully(deps, { measureIds: ["cms122", "cms125"] });
  assert.deepEqual(deps.counters.recordOutcomesBatchSizes, [100, 100, 50]);
  // Observed through the injected SubjectBundleSource, not by instrumenting pipeline internals.
  assert.equal(deps.counters.bundlesBuilt, 250, "one bundle per subject per RUN, not per measure");
  assert.ok(deps.counters.maxLiveBundles <= 100, `held ${deps.counters.maxLiveBundles} bundles at once`);
});
```

- [ ] **Step 3: Run to verify they fail, and record WHY each fails**

Run: `cd backend-ts && node --import tsx --test "src/run/run-pipeline.chunking.test.ts"`

Expected today: 1b passes (the check exists), 2 and 4 pass (behaviour already correct), and
**1, 3, 5, 6, 7 fail** — today's pipeline is measure-major over the whole roster, persists per item
via `recordOutcome` (singular, ~line 721) rather than `recordOutcomes`, and builds a bundle per
(subject, measure). A test that passes both before and after proves nothing, so **state in the
handoff which tests changed state and which did not**, and treat any test that passes before *and*
after as a defect in the test.

- [ ] **Step 4: Implement the chunk loop**

In `run-pipeline.ts`:
- `const CHUNK_SIZE = Number(process.env.WORKWELL_RUN_CHUNK_SIZE ?? 500);`
- Before the loop, per measure: preload the active-case snapshot once (invariant 5) and initialize
  the `ippByMeasure` accumulators (invariant 1).
- Per chunk: build each subject's bundle once through `bundleForSubject` when the source offers it,
  run every routed measure's `evaluateBatch` over the chunk, upsert cases, persist with
  `recordOutcomes` (plural — introduce it if the store has only the singular, keeping the singular
  working), then **drop the bundle cache** (invariant 7 / memory).
- After the final chunk only: judge `emptyIppMeasures`, run cycle rollover, emit the single terminal
  event (invariants 1, 3, 4, 6).
- A chunk failure routes to the existing `failPlannedRun`; nothing else writes a terminal event.

Each invariant gets a one-line comment at the site that enforces it, naming the invariant number and
its test.

- [ ] **Step 5: Run the whole gate**

```bash
cd backend-ts && corepack pnpm@10 typecheck && corepack pnpm@10 test
```
Expected: `# fail 0`, including every pre-existing `run-pipeline.test.ts` case.

- [ ] **Step 6: Commit**

```bash
git add backend-ts/src/run/run-pipeline.ts backend-ts/src/run/run-pipeline.chunking.test.ts backend-ts/src/run/run-pipeline.test-support.ts
git commit -m "feat(run): chunked measure-major evaluation with the seven invariants pinned"
```

---

## Task 11: The scheduler anchor hour — in the tick, not only in the display

**Files:**
- Modify: `backend-ts/src/admin/scheduler.ts`
- Test: `backend-ts/src/admin/scheduler.test.ts`

> **Plan-review finding (this task was a no-op as written).** `computeNextFireAt`
> (`scheduler.ts:137`) is **module-private**, takes **one argument** (`lastAt: string | null`), and has
> **exactly one caller** — `getSchedulerStatusFromStores` at line 163, which puts it in the status
> response as `nextFireAt`. **It is a display function.** The decision that actually fires a run is an
> independent inline min-gap check inside the tick (~lines 236-243) against
> `lastSchedulerRun.startedAt`. Changing only `computeNextFireAt` would have changed the *displayed*
> next-fire time and nothing else, under a commit message claiming the nightly run had moved. That is
> a control that reads as present and cannot fire — do not ship it.

- [ ] **Step 1: Write the failing tests — the display AND the tick**

```ts
test("computeNextFireAt returns the next occurrence of the anchor hour, not last-run + 24h", () => {
  // Last run 03:00 UTC; the next anchor is 12:00 UTC the SAME day.
  assert.equal(
    computeNextFireAt({ lastRunAtMs: Date.parse("2027-03-04T03:00:00Z"), nowMs: Date.parse("2027-03-04T03:05:00Z"), anchorHourUtc: 12, minGapMs: 6 * 3600_000 }),
    "2027-03-04T12:00:00.000Z",
  );
});

test("after today's anchor has passed, the next fire is tomorrow's", () => {
  assert.equal(
    computeNextFireAt({ lastRunAtMs: Date.parse("2027-03-04T12:00:00Z"), nowMs: Date.parse("2027-03-04T13:00:00Z"), anchorHourUtc: 12, minGapMs: 6 * 3600_000 }),
    "2027-03-05T12:00:00.000Z",
  );
});

test("the min-gap is a FLOOR: an anchor inside the gap is pushed past it", () => {
  assert.equal(
    computeNextFireAt({ lastRunAtMs: Date.parse("2027-03-04T11:00:00Z"), nowMs: Date.parse("2027-03-04T11:05:00Z"), anchorHourUtc: 12, minGapMs: 6 * 3600_000 }),
    "2027-03-05T12:00:00.000Z",
  );
});

test("a deployment that has never run fires on the next tick, not after a day of waiting", () => {
  // Preserves today's behaviour for lastAt === null (scheduler.ts:139-144). A fresh Maui deploy
  // must not sit idle until the anchor.
  const now = Date.parse("2027-03-04T03:00:00Z");
  assert.equal(computeNextFireAt({ lastRunAtMs: null, nowMs: now, anchorHourUtc: 12, minGapMs: 6 * 3600_000 }), new Date(now).toISOString());
});

test("a clock exactly at the anchor fires now, not in 24 hours", () => {
  const at = Date.parse("2027-03-04T12:00:00Z");
  assert.equal(
    computeNextFireAt({ lastRunAtMs: Date.parse("2027-03-03T12:00:00Z"), nowMs: at, anchorHourUtc: 12, minGapMs: 6 * 3600_000 }),
    new Date(at).toISOString(),
  );
});

test("THE TICK ITSELF honours the anchor — not just the status display", async () => {
  // Without this test the change is cosmetic: the tick has its own inline min-gap check
  // (scheduler.ts ~236-243) and never consulted computeNextFireAt.
  const deps = makeSchedulerDeps({ lastSchedulerRunAt: "2027-03-04T03:00:00Z" });
  assert.equal(await shouldFire(deps, { nowMs: Date.parse("2027-03-04T11:00:00Z"), anchorHourUtc: 12 }), false, "before the anchor: no run");
  assert.equal(await shouldFire(deps, { nowMs: Date.parse("2027-03-04T12:00:01Z"), anchorHourUtc: 12 }), true, "at/after the anchor: run");
});
```

- [ ] **Step 2: Run to verify they fail.** Expected: the first three fail on arithmetic
  (today returns `2027-03-05T03:00:00.000Z` for the first), and the last fails to compile — the
  function is not exported and `shouldFire` does not exist.

- [ ] **Step 3: Implement**

- Export `computeNextFireAt` and change its signature to the options object above; default
  `anchorHourUtc` to `Number(process.env.WORKWELL_SCHEDULER_ANCHOR_HOUR_UTC ?? 12)`.
- **Update the one existing caller** at line 163 to pass the new shape.
- Extract the tick's inline min-gap decision into a testable `shouldFire(deps, { nowMs, anchorHourUtc })`
  that reads the same anchor, and call it from `runTickLocked`. **The display and the tick must derive
  from one function**, or they will drift again.
- `lastRunAtMs === null` keeps today's meaning: fire on the next tick.

- [ ] **Step 4: Run** — `cd backend-ts && node --import tsx --test "src/admin/scheduler.test.ts"` → `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/admin/scheduler.ts backend-ts/src/admin/scheduler.test.ts
git commit -m "feat(admin): the nightly run fires at a wall-clock anchor hour, with the debounce as a floor"
```

---

## Task 12: The `run-scale-maui` CI job and the performance ceiling

**Files:**
- Modify: `.github/workflows/ci.yml` — **ORCHESTRATOR-ONLY. A delegate must not edit this file.** Leave it to the orchestrator and say so in the handoff.
- Create: `backend-ts/src/run/run-scale-maui.test.ts`

- [ ] **Step 1: Write the performance test**

```ts
import test from "node:test";
import assert from "node:assert/strict";

const CEILING_MS = 15 * 60 * 1000;

test("a full five-measure run over 20,000 patients completes inside the CI ceiling", { skip: process.env.WORKWELL_RUN_SCALE_MAUI !== "1" }, async () => {
  process.env.WORKWELL_MAUI_CORPUS_SIZE = "20000";
  const started = Date.now();
  const run = await runFiveMeasureMauiRun();   // build from the existing scale harness in src/run/
  const elapsed = Date.now() - started;
  assert.equal(run.status, "COMPLETED");
  assert.equal(run.totalEvaluated, 20000 * 5);
  assert.ok(elapsed < CEILING_MS, `run took ${(elapsed / 60000).toFixed(1)} min, ceiling is 15 min`);
});
```

The `skip` gate is what keeps this out of the default suite; the CI job sets `WORKWELL_RUN_SCALE_MAUI=1`.

- [ ] **Step 2: Run it locally once**

```bash
cd backend-ts && WORKWELL_RUN_SCALE_MAUI=1 node --import tsx --test "src/run/run-scale-maui.test.ts"
```
Record the measured wall-clock in the handoff. **If it exceeds 15 minutes, do not raise the ceiling** — report the number; spec §11 says the threshold is measured on the first run and pinned then, and that is the orchestrator's call.

- [ ] **Step 3: Commit the test only**

```bash
git add backend-ts/src/run/run-scale-maui.test.ts
git commit -m "test(run): the 20k five-measure run has a pinned wall-clock ceiling"
```

The orchestrator adds the `run-scale-maui` job to `ci.yml` (a sibling of `e2e-maui`, `timeout-minutes: 30`, `schedule` + `workflow_dispatch` only, gated on the same sidecar/VSAC secrets as `official-cases`) and sets `WORKWELL_MAUI_CORPUS_SIZE=20000` / `WORKWELL_OUTCOME_RETENTION_DAYS=90` in the two Maui workflows, extending `official-flip-config.test.ts`'s MUST_AGREE pair check to both keys.

---

## Task 13: Stage B docs

**Files:**
- Modify: `docs/DEPLOY.md`, `docs/JOURNAL.md`

- [ ] **Step 1:** Add to `DEPLOY.md`'s Maui section: `WORKWELL_MAUI_CORPUS_SIZE` (48 by default, 20000 on the deployed instance, and that the deploy and reconcile workflows must agree), `WORKWELL_MAUI_CORPUS_SEED`, `WORKWELL_RUN_CHUNK_SIZE`, `WORKWELL_SCHEDULER_ANCHOR_HOUR_UTC` (12 = 02:00 HST), and that the run is chunked so memory is bounded by one chunk.
- [ ] **Step 2:** Add the day's `JOURNAL.md` entry with the realized corpus numbers, the measured 20k run time, and the re-recorded Maui fixture counts.
- [ ] **Step 3: Commit** — `docs(deploy): the Maui corpus size, seed, chunk size and scheduler anchor`.

---

# Stage C — filters (§5)

## Task 14: Backend filters — `providerId`, `ageBand`, `sex`

**Files:**
- Modify: `backend-ts/src/compliance/roster-read-model.ts`, the cases route, `backend-ts/src/export/export-csv.ts`, `backend-ts/src/mcp/tools.ts`
- Test: siblings of each

**The placement rule is load-bearing (spec §5):** every new filter is a **route-level read-time join against the directory, at the same layer `site` is filtered today**. `CaseQuery` — the store interface — does **not** change. If you find yourself editing a store, stop: you have gone one layer too deep.

- [ ] **Step 1: Write the failing tests**

```ts
test("roster filters by providerId against the PCP external id, never a display name", async () => {
  const rows = await rosterRows({ providerId: "maui-prov-012" });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => directory.byExternalId(r.subjectExternalId)!.providerId === "maui-prov-012"));
  assert.deepEqual(await rosterRows({ providerId: "Dr. Ana Silva" }), [], "a display name matches nothing");
});

test("ageBand is derived from dateOfBirth against today's UTC date", async () => {
  for (const band of ["0-17", "18-44", "45-64", "65+"] as const) {
    const rows = await rosterRows({ ageBand: band });
    assert.ok(rows.every((r) => ageBandFor(ageAsOfToday(directory.byExternalId(r.subjectExternalId)!.dateOfBirth!)) === band), band);
  }
});

test("sex filters F and M, and the four filters compose", async () => {
  const rows = await rosterRows({ providerId: "maui-prov-012", ageBand: "65+", sex: "F", site: "Kahului Clinic" });
  assert.ok(rows.every((r) => {
    const e = directory.byExternalId(r.subjectExternalId)!;
    return e.providerId === "maui-prov-012" && e.site === "Kahului Clinic";
  }));
});

test("an unknown providerId returns an empty list, not every row", async () => {
  assert.deepEqual(await rosterRows({ providerId: "maui-prov-999" }), []);
});

test("the cases route and the outcomes/cases CSV exports accept the same params", async () => {
  const cases = await fetchCases({ providerId: "maui-prov-012" });
  assert.ok(cases.every((c) => directory.byExternalId(c.subjectExternalId)!.providerId === "maui-prov-012"));
  const csv = await exportOutcomesCsv({ providerId: "maui-prov-012", site: "Kahului Clinic" });
  assert.ok(csv.split("\n").length > 1);
});

test("MCP list_noncompliant accepts providerId with the same semantics", async () => {
  const out = await callTool("list_noncompliant", { providerId: "maui-prov-012" });
  assert.ok(out.every((r) => directory.byExternalId(r.subjectExternalId)!.providerId === "maui-prov-012"));
});
```

- [ ] **Step 2: Run to verify they fail** — the filters are not accepted, so each returns unfiltered rows.

- [ ] **Step 3: Implement** — `RosterFilters` gains `providerId?`, `ageBand?`, `sex?`; `CaseExportFilter` gains `providerId`; the outcomes CSV gains `providerId` and `site` query params; `list_noncompliant` gains optional `providerId`. Every one is applied as a post-filter joined against the directory.

- [ ] **Step 4: Run** — `cd backend-ts && corepack pnpm@10 typecheck && corepack pnpm@10 test` → `# fail 0`.

- [ ] **Step 5: Update the contract doc**

`docs/DATA_MODEL_CONTRACTS.md`: §6.3's "Supports filters" line gains `providerId`; §6.2 gains a new "Supports filters" line listing `runId, providerId, site`. Column names and order are unchanged.

- [ ] **Step 6: Commit** — `feat(compliance): roster, cases, exports and MCP filter by PCP, age band and sex`.

---

## Task 15: `/api/providers` for the PCP select

**Files:**
- Modify or create the providers route (check first: `git grep -n "api/providers" backend-ts/src`)
- Test: its sibling

- [ ] **Step 1:** If a directory providers route already exists, add nothing but a test pinning that it returns `{ id, name, location }` for the current deployment's providers. If it does not, add a read-only `GET /api/providers` returning exactly that, authenticated like the other directory routes.
- [ ] **Step 2:** Test that on the Maui profile it returns 40 rows and on the default profile it returns the default directory's providers.
- [ ] **Step 3: Commit** — `feat(api): a read-only providers list for the PCP filter`.

---

## Task 16: Frontend filters

**Files:**
- Modify: the roster and cases pages under `frontend/app/(dashboard)/`
- Test: their siblings

- [ ] **Step 1:** Add `providerId`, `ageBand` and `sex` to the URL-driven filter chips using the **existing MM-0 chip mechanism** — read how `site` does it and follow it exactly; do not introduce a second filter mechanism.
- [ ] **Step 2:** Populate the PCP select from `/api/providers`. The status chips carry the active filters into their drill-down links.
- [ ] **Step 3:** Tests: each filter round-trips through the URL; the chips render the active set; a deep link with all four filters renders the filtered list.
- [ ] **Step 4:** Run `cd frontend && npm run lint && npm run build`.
- [ ] **Step 5: Commit** — `feat(ui): roster and cases filter by PCP, age band and sex`.

---

## Task 17: Maui e2e sees the PCP filter

**Files:**
- Modify: `e2e/maui/roster.spec.ts` (find the exact path with `git grep -l "maui/roster"`)

- [ ] **Step 1:** Add a spec: select a PCP, assert the roster narrows to that panel and the URL carries `providerId`.
- [ ] **Step 2:** Run the Maui e2e project locally if the harness allows; otherwise state in the handoff that it is CI-verified only.
- [ ] **Step 3: Commit** — `test(e2e): the Maui roster filters by PCP`.

---

# Stage D — retention (§7, ADR-073)

## Task 18: `OutcomeStore.compactOlderThan` on both stores

**Files:**
- Modify: the SQLite outcome store and the Pg outcome store (`git grep -ln "recordOutcomes" backend-ts/src/stores`)
- Test: the existing store contract test

**No schema change** — this is a DELETE against the existing `(subject_id, evaluated_at DESC)` index. **The owner reviews the SQL in the PR**; do not apply anything resembling DDL.

- [ ] **Step 1: Write the failing contract test** (in the shared store contract, so both stores run it)

```ts
test("compactOlderThan keeps the newest row per (subject, measure) and every row an open case points at", async () => {
  await store.recordOutcomes([
    { subjectId: "pat-001", measureId: "cms122", evaluatedAt: "2027-01-01T00:00:00Z", runId: "run-old" },
    { subjectId: "pat-001", measureId: "cms122", evaluatedAt: "2027-06-01T00:00:00Z", runId: "run-mid" },
    { subjectId: "pat-001", measureId: "cms122", evaluatedAt: "2027-09-01T00:00:00Z", runId: "run-new" },
    { subjectId: "pat-002", measureId: "cms122", evaluatedAt: "2027-01-01T00:00:00Z", runId: "run-old" },
  ]);
  const deleted = await store.compactOlderThan("2027-08-01T00:00:00Z", ["run-mid"]);
  assert.equal(deleted, 1, "only pat-001's Jan row goes: Sep is newest, Jun is pinned by an open case, pat-002's Jan is its newest");
  const remaining = await store.listOutcomes({ subjectId: "pat-001", measureId: "cms122" });
  assert.deepEqual(remaining.map((o) => o.runId).sort(), ["run-mid", "run-new"]);
  assert.equal((await store.listOutcomes({ subjectId: "pat-002" })).length, 1, "a subject's only row is never deleted");
});

test("compactOlderThan is idempotent", async () => {
  await store.compactOlderThan("2027-08-01T00:00:00Z", []);
  assert.equal(await store.compactOlderThan("2027-08-01T00:00:00Z", []), 0);
});
```

- [ ] **Step 2: Run to verify it fails** — the method does not exist.
- [ ] **Step 3: Implement** on both stores.
- [ ] **Step 4: Run** the store contract suite on the SQLite floor; the Pg ceiling runs against a local `postgres:16` and otherwise self-skips (CLAUDE.md).
- [ ] **Step 5: Commit** — `feat(stores): OutcomeStore.compactOlderThan on the SQLite floor and the Pg ceiling`.

---

## Task 19: `compactOutcomes` and its ordering guarantee

**Files:**
- Create: `backend-ts/src/run/outcome-compaction.ts`
- Modify: `backend-ts/src/admin/scheduler.ts` (call it after the quality snapshot), `backend-ts/src/run/backfill-trend-history.ts` (refuse when retention is on), `backend-ts/package.json` (the `outcomes:compact` script)
- Test: `backend-ts/src/run/outcome-compaction.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("compaction is a hard no-op unless WORKWELL_OUTCOME_RETENTION_DAYS is set", async () => {
  const deps = makeStores();
  assert.equal(await compactOutcomes(deps, { retentionDays: undefined, now: Date.now() }), null);
  assert.equal(drainAuditEvents(deps).filter((e) => e.eventType === "OUTCOMES_COMPACTED").length, 0);
});

test("compaction runs AFTER the quality snapshot for that run, never before", async () => {
  const order: string[] = [];
  const deps = makeStores({ onSnapshot: () => order.push("snapshot"), onCompact: () => order.push("compact") });
  await runSchedulerTick(deps, { retentionDays: 90 });
  assert.deepEqual(order, ["snapshot", "compact"], "compacting first would destroy the history the snapshot preserves");
});

test("one OUTCOMES_COMPACTED audit event per pass, with the declared payload", async () => {
  const deps = makeStores();
  await compactOutcomes(deps, { retentionDays: 90, now: Date.parse("2027-12-31T00:00:00Z") });
  const [event] = drainAuditEvents(deps).filter((e) => e.eventType === "OUTCOMES_COMPACTED");
  assert.deepEqual(Object.keys(event.payload).sort(), ["cutoff", "deleted", "durationMs", "kept"]);
  assert.equal(event.payload.cutoff, "2027-10-02T00:00:00.000Z");
});

test("backfill-trend-history refuses to run when retention is enabled, and says why", async () => {
  await assert.rejects(
    () => backfillTrendHistory({ retentionDays: 90 }),
    /retention/i,
    "the tool cannot reconstruct history older than the window, and must say so rather than write a wrong series",
  );
});

test("runs rows and their summary counts survive compaction", async () => {
  const deps = makeStores();
  const before = await deps.stores.runs.listRuns({ limit: 1000 });
  await compactOutcomes(deps, { retentionDays: 90, now: Date.parse("2027-12-31T00:00:00Z") });
  assert.deepEqual(await deps.stores.runs.listRuns({ limit: 1000 }), before);
});
```

- [ ] **Step 2: Run to verify they fail** — `Cannot find module './outcome-compaction.ts'`.
- [ ] **Step 3: Implement.** `compactOutcomes(stores, { retentionDays, now })` returns `null` when `retentionDays` is undefined; otherwise it computes the cutoff, collects the run ids referenced by open cases' `last_run_id`, calls `compactOlderThan`, and writes one `OUTCOMES_COMPACTED` event. Wire it into the scheduler **after** the snapshot with a comment naming the ordering rule. Add the `outcomes:compact` script.
- [ ] **Step 4: Run** — `cd backend-ts && corepack pnpm@10 typecheck && corepack pnpm@10 test` → `# fail 0`.
- [ ] **Step 5: Commit** — `feat(run): outcome compaction under a retention window, after the quality snapshot`.

---

## Task 20: The compacted-run notice, ADR-073 and the unit's docs

**Files:**
- Modify: the run detail read model + its frontend page, `docs/DECISIONS.md`, `docs/ADR_INDEX.md`, `docs/DATA_MODEL_CONTRACTS.md`, `docs/DEPLOY.md`, `docs/JOURNAL.md`, `docs/guide/` (the synthetic-data chapter and chapter 9's numbers), `docs/MEASURES.md`

- [ ] **Step 1: The notice.** When a run's summary count exceeds the number of outcome rows that survive, the run detail shows "compacted under the N-day retention policy". Test both branches.
- [ ] **Step 2: ADR-073** in `DECISIONS.md` — corpus determinism, provenance and retention; state the consequence plainly: the quality-over-time snapshots become the durable history, and per-subject outcome history is a 90-day window. Add the title to `ADR_INDEX.md` (newest first).
- [ ] **Step 3: `DATA_MODEL_CONTRACTS.md`** — retention is a new contract: what is deleted, what is never deleted, and what a consumer of the outcomes CSV sees after the window.
- [ ] **Step 4: `DEPLOY.md`** — `WORKWELL_OUTCOME_RETENTION_DAYS` (90 on Maui, unset on TWH), and that lowering it to 30 is the storage lever with no code change.
- [ ] **Step 5:** `guide/` chapter on synthetic data rewritten for the corpus; chapter 9's numbers re-dated; `MEASURES.md` gains the cohort estimates; the `JOURNAL.md` entry.
- [ ] **Step 6: Commit** — `docs(adr): ADR-073 — corpus determinism, provenance and outcome retention`.

---

## Self-review notes

- **Spec coverage:** §3 → Tasks 1–4; §8 provenance/manifest/tests → Tasks 5–7, 12; §4 → Tasks 8–9; §6 → Tasks 10–12; §5 → Tasks 14–17; §7 → Tasks 18–20; §9's four PRs are the four sections above.
- **Deliberately deferred, with the spec's agreement:** the worker pool on the production path (§6 — a follow-up gated on the measured run time), stratified rates on the overview (U3 §7), provider attribution *semantics* (MM-2), saved filters (MM-2).
- **Owner-only edits inside this plan:** `.github/workflows/ci.yml` and the two Maui workflows (Task 12), and the review of Task 18's SQL. A delegate must leave all three to the orchestrator.
- **The riskiest task is 10.** Its seven invariants are the ones that turn a scale change into a correctness regression, which is why each has its own test written before the loop exists.
