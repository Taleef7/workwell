# cms165 — WorkWell translation of CMS165v15 (`ww-2027.1`)

CMS has published no FHIR logic for the 2027 measurement year. CMS165 v14 → v15 changes its exclusions and
two date comparisons, and none of its blood-pressure logic (#816). This translation is CMS's own CMS165FHIR
v1.0.000 logic with those changes ported, recompiled by WorkWell, carrying the eCQM Update 2026-05-14 value
sets, and routed for 2027 only (`selectArtifactForPeriod`). It is not a CMS measure and never carries CMS's
identity (`urn:workwell:measure:cms165:translation`). Its logic is **modified** from the measure steward's
(NCQA's). The steward's copyright notice is carried verbatim: it allows internal, noncommercial use without
NCQA's approval and requires that approval for any other use, so any use beyond the sandbox waits on it
(`docs/OPEN_QUESTIONS.md` §4.12).

## The edits (`edits.json`, ten, each hash-anchored to CMS's text)

1. **The frailty look-back.** This is the same edit as CMS130 and CMS125: an advanced-illness diagnosis
   counts when it **overlaps** the year before or the measurement year, where v14 required it to **start**
   there. CMS165's AdvancedIllnessandFrailty 1.27.000 is byte-identical to theirs, and so is the changed
   library (`WorkWellAdvancedIllnessandFrailtyTranslation2027`).
2. **Pregnancy and renal diagnoses are two exclusions.** v14's "Pregnancy or Renal Diagnosis" required any of
   them to overlap the measurement period. In v15:
   - **"Pregnancy Diagnosis"** overlaps day of the measurement period;
   - **"Renal Diagnosis"** (end stage renal disease, CKD stage 5, kidney transplant status) **starts on or
     before day of the period's end**. A renal diagnosis that began and also ended before the period now
     excludes the patient: more patients are excluded.
3. **Kidney transplant status is the code `Z94.0`**, not the Kidney Transplant Recipient value set
   (`…109.12.1029`). That set's only code is `Z94.0`, so the swap alone moves no result. It does make the
   retrieve a direct-reference-code retrieve, which the data-requirements recompute now supports in the
   shape CMS's own CMS138 artifact lists its `Z71.6` retrieves (`src/standards/derived-data-requirements.ts`).
4. **The ESRD monthly outpatient encounter no longer excludes.** The define, its retrieve and its value set
   (`…109.12.1014`) are gone.
5. **Day precision** on the essential hypertension window ("overlaps day of", in the initial population) and
   on the ESRD procedures ("on or before day of end"). At day precision the engine compares each value's own
   local date, so results can move either way at the edges (the edit cases cover both offset directions).

Not ported, because they change no result: the reordered "Denominator Exclusions", the title-case renames
(the two "Lowest … Reading" defines, AdvancedIllnessandFrailty, PalliativeCare), the rewritten nursing-home
define (equivalent, #779), and the header text. CMS's FHIR draft names are kept. The blood-pressure logic is
CMS's, unchanged, so the QRDA panel import and the BP-only profile trust (#786, #787) apply as they are.

## Data requirements, recomputed

The main library's reads changed (a value set and an encounter retrieve dropped, a code retrieve added), so
its `dataRequirement`, `depends-on` and direct-reference-code lists were edited to match its ELM. The new
`Z94.0` entries are byte-for-byte the shape MADiE wrote for CMS138's `Z71.6`. The changed frailty library
reads what CMS's does, so its lists are CMS's.

## What is here

| File | Committed | Content |
|---|---|---|
| `bundle.json` | yes | the Measure and ten Libraries, ELM only: the main library and the changed library are WorkWell's compile, the other eight are CMS's committed ones |
| `manifest.json` | yes | identity, pins, `changedLibraries`, `recomputedDataRequirements`, the terminology pin and the check records |
| `edits.json` | yes | the ten edits |
| `edit-cases.json` | yes | 12 synthetic test patients; read only by `derived:check`, never by the corpus, ingest or any evaluation path |
| `madie-expected-differences.json` | yes | the two population moves, the four defines only one side has, and the twenty define values that follow from the moves |
| `cypress-expected-differences.json` | yes | the two Cypress deck patients CMS's own logic misses too, and why |
| `terminology.json` | no (gitignored) | every declared value set at the release |

## What the checks proved

- `cypress-deck` (recorded): 42/44 on the 2027 Cypress deck, plus the 2 listed misses. Both are blood
  pressures taken during an emergency admission or ED visit (`Z4_DQ_1`, `Z4_DQ_2`): the deck leaves the
  reading out, but CMS's FHIR logic keeps any reading whose `Observation.encounter` is not an ED or inpatient
  class, and a QRDA I document states no encounter link on a reading. **CMS's own 2026 logic misses the same
  two rows on the same deck**, which the check verifies by running it, and it fails on any miss not listed
  or listed but not seen. The record carries the list's hash, and a test holds it to this file. Otherwise
  **non-regression only**: no deck patient exercises the v15 changes.
- `terminology-equivalence` (recorded): all 31 declared value sets equal the deck's 2026-05-14 export. Ten
  differ from CMS's 2026 sidecar: eight moved by the release, and `…1014` and `…1029` dropped by the edits.
  Pinned in `src/wiring/derived-terminology.test.ts`.
- MADiE (CI, every push, not recorded): CMS's 68-case deck. 66 cases agree on every population; the two
  that move are listed and explained. `598f05e7` gains the exclusion through the frailty edit (dementia
  active since 2024-12-31T23:59:59Z, one second before the window opens; aged 67; a frailty device order);
  `78fc0433` loses it (its only exclusion was an ESRD monthly services encounter, CPT 90999). Four defines
  exist on one side only (the split and the removed encounter define), stated as presence entries the ELM
  must bear out; the twenty other define values that differ follow from the two moves.
- Edit cases (CI, every push, not recorded): 12 patients, 9 of them telling the logics apart, give the stated
  answer under both: a renal diagnosis and a kidney transplant status that ended before the period, an
  active one of each, an ESRD monthly encounter alone, pregnancy active and ending at the period's first edge,
  the hypertension window's edge in both offset directions, dialysis at the period's end in both directions,
  and the frailty edit. The pregnancy patients use `77386006` rather than `Z33.1`: CMS's upstream Pregnancy
  expansion (version 20210218) stops at 1,000 codes and lacks `Z33.1`, and the cases run on it. **These are
  the evidence that discriminates the edits, and they are WorkWell's own.**

## Commands (from `backend-ts/`)

```bash
pnpm build:derived --catalog-id cms165 --year 2027 --derived-from CMS165v15 --edits measures/derived/cms165/edits.json --package <CMS165-v15.0.000 zip> --vsac-manifest http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2026-05-14
```

```bash
pnpm derived:check --catalog-id cms165 --cypress-bundle <extracted Cypress bundle-2026> --package <zip> --package-cql-dir <extracted package> --record --madie
```

```bash
node scripts/vendor-derived-terminology.mjs --catalog-id cms165 --verify-pin
```
