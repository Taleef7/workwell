# cms122 — WorkWell translation of CMS122v15 (`ww-2027.1`)

CMS has published no FHIR logic for the 2027 measurement year. CMS122 v14 → v15 changes the frailty
look-back and which glycemic status assessment the numerator reads (#818). This translation is CMS's own
CMS122FHIR v1.0.000 logic with those changes ported, recompiled by WorkWell, carrying the eCQM Update
2026-05-14 value sets, and routed for 2027 only (`selectArtifactForPeriod`). It is not a CMS measure and never
carries CMS's identity (`urn:workwell:measure:cms122:translation`). Its logic is **modified** from the measure
steward's (NCQA's). The steward's copyright notice is carried verbatim: it allows internal, noncommercial use
without NCQA's approval and requires that approval for any other use, so any use beyond the sandbox waits on it
(`docs/OPEN_QUESTIONS.md` §4.12).

CMS122 is an inverse measure: its numerator is **poor control** (a result above 9 %, an assessment with no
result, or no assessment at all). So this translation's group declares `cqfm-improvementNotation`
**`decrease`** (#848), where CMS's CMS122FHIR artifact declares `increase`; that is reported upstream
(cqframework/dqm-content-qicore-2025#61) and left as CMS shipped it in the vendored official artifact.

## The edits (`edits.json`, three, each hash-anchored to CMS's text)

1. **The frailty look-back.** This is the same edit as CMS130, CMS125 and CMS165: an advanced-illness
   diagnosis counts when it **overlaps** the year before or the measurement year, where v14 required it to
   **start** there. The changed library (`WorkWellAdvancedIllnessandFrailtyTranslation2027`) is byte-identical
   to theirs.
2. **Which assessment the numerator reads.** In CMS's v14 draft, the most recent day was the day of the latest
   assessment in the period, and the reading was the first of that day's assessments sorted by value. An
   assessment with no result sorts first, so a result-less test made the patient "poor control" even beside a
   numerical one. In v15:
   - the most recent day is the day of the latest assessment whose result is a number **above 0 %**;
   - the reading is the **lowest numerical result** on that day; else the most recent assessment in the period
     with a result; else the most recent one with no result.
3. **"Without result" and "> 9 %"** are read off that reading.

Not ported, because they change no result: the renames, the reformatted initial population, the rewritten
nursing-home define (equivalent, #779), and the header text. CMS's FHIR draft names are kept for the defines
v15 keeps. The reads do not change (no value set or retrieve moves), so CMS's computed data requirements carry
over unchanged.

## What is here

| File | Committed | Content |
|---|---|---|
| `bundle.json` | yes | the Measure and nine Libraries, ELM only: the main library and the changed library are WorkWell's compile, the other seven are CMS's committed ones |
| `manifest.json` | yes | identity, pins, `changedLibraries`, the terminology pin and the check records |
| `edits.json` | yes | the three edits |
| `edit-cases.json` | yes | 12 synthetic test patients; read only by `derived:check`, never by the corpus, ingest or any evaluation path |
| `madie-expected-differences.json` | yes | the five defines only one side has, and three define values that differ without moving a population |
| `terminology.json` | no (gitignored) | every declared value set at the release |

## What the checks proved

- `cypress-deck` (recorded): 64/64 on the 2027 Cypress deck. **Non-regression only**: CMS's 2026 logic also
  agrees, and no deck patient carries the shapes the numerator edit changes.
- `terminology-equivalence` (recorded): all 26 declared value sets equal the deck's 2026-05-14 export. Seven
  differ from CMS's 2026 sidecar, all moved by the release. Pinned in `src/wiring/derived-terminology.test.ts`.
- MADiE (CI, every push, not recorded): CMS's 55-case deck. **No population moves.** Five defines exist on one
  side only (one removed, four added), stated as presence entries the ELM must bear out. Three cases' "Most
  Recent Glycemic Status Date" differs (`ab29ab81` and `21695544` have only a result-less assessment,
  `5ed37c9e` only a coded "Yes"): v15 finds no result above 0 %, falls through to the same assessment CMS's
  logic read, and the population stays.
- Edit cases (CI, every push, not recorded): 12 patients, 6 of them telling the logics apart, give the stated
  answer under both: a result-less and a 7 % assessment on one day, a result-less latest day after an earlier
  6 %, a 0 % latest result after an earlier 10 %, a 0 % in June and a result-less one in September (the first
  fallback), a `>14 %` result after an earlier 7 % (below), the frailty edit, and controls (only result-less,
  one 10 %, none at all, two numbers on one day, a coded result beside a number, and the day boundary across
  offsets, where both logics take each reading's own date). Deleting the first fallback from the translation
  fails one of them. **These are the evidence that discriminates the edits, and they are WorkWell's own.**

## What to know before real data

- **A result with a comparator** (`>14 %`) is read as no result by the FHIR helper library. CMS's 2026 draft
  then calls the patient poor control; v15 skips a result-less latest day and reads an earlier number, so
  an earlier normal result makes the patient controlled. An edit case pins this. The sandbox corpus states
  one plain UCUM `%` result per patient, so it never arises there (`OPEN_QUESTIONS.md` §4.14).
- **More results are read.** v15 reads every HbA1c/GMI result in the year (for the most recent day and both
  fallbacks), where the 2026 draft read only the most recent day's. One result whose unit is not valid UCUM
  anywhere in the year now fails the patient's evaluation (no case changes; §4.14).
- **"Last result date" on a 2027 row** is the last day with a result above 0 % (the define the read model
  reads). A patient whose only results are result-less, coded or 0 % shows none, though the measure still
  scores them.

## Commands (from `backend-ts/`)

```bash
pnpm build:derived --catalog-id cms122 --year 2027 --derived-from CMS122v15 --edits measures/derived/cms122/edits.json --package <CMS122-v15.0.000 zip> --vsac-manifest http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2026-05-14
```

```bash
pnpm derived:check --catalog-id cms122 --cypress-bundle <extracted Cypress bundle-2026> --package <zip> --package-cql-dir <extracted package> --record --madie
```

```bash
node scripts/vendor-derived-terminology.mjs --catalog-id cms122 --verify-pin
```
