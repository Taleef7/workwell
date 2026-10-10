# cms125 — WorkWell translation of CMS125v15 (`ww-2027.1`)

CMS has published no FHIR logic for the 2027 measurement year. CMS125 v14 → v15 changes logic in two
libraries and swaps a value set (#782). This translation is CMS's own CMS125FHIR v1.0.000 logic with those
changes ported, recompiled by WorkWell, carrying the eCQM Update 2026-05-14 value sets, and routed for 2027
only (`selectArtifactForPeriod`). It is not a CMS measure and never carries CMS's identity
(`urn:workwell:measure:cms125:translation`). Its logic is **modified** from the measure steward's (NCQA's).
The steward's copyright notice is carried verbatim: it allows internal, noncommercial use without NCQA's
approval and requires that approval for any other use, so any use beyond the sandbox waits on it
(`docs/OPEN_QUESTIONS.md`).

## The edits (`edits.json`, nine, each hash-anchored to CMS's text)

1. **The frailty look-back** — the same edit as CMS130 (#779), in CMS's shared AdvancedIllnessandFrailty
   1.27.000, carried as `WorkWellAdvancedIllnessandFrailtyTranslation2027` `ww-2027.1`: an advanced-illness
   diagnosis counts when it **overlaps** the year before or the measurement year (v14: it had to **start**
   there). The changed library is the same resource, byte for byte, in CMS130's bundle.
2. **Unilateral mastectomy laterality comes from the procedure's body site.** A "Unilateral Mastectomy"
   procedure (value set `…1003.1285`, new in v15) whose body site is "Entire left breast" (`361716006`) /
   "Entire right breast" (`361715005`) now counts toward the left/right pair, beside the existing
   "Unilateral Mastectomy Left/Right" procedures. The v14 path through an "Unilateral Mastectomy,
   Unspecified Laterality" diagnosis (`…198.12.1071`) with a Left/Right *qualifier* body site is removed.
   FHIR's `bodySite` is a list, so one procedure listing both breasts satisfies both sides (QDM's single
   `anatomicalLocationSite` cannot say that); the same semantics as CMS's own Condition pattern. The new
   value set includes `1208601007` (FNA biopsy of lesion of mastectomy scar): CMS's content, ported as is.
3. **Day precision** at six sites (both mastectomy diagnoses, both procedures, the bilateral pair): "on or
   before **day of** end of the measurement period". It compares the value's own local date, so it moves
   results both ways: a date-only value on the last day now counts, a time that is Dec 31 locally but Jan 1
   in UTC now counts, and one that is Jan 1 locally but Dec 31 in UTC no longer does.

Not ported, because they change no result: the reordered "Denominator Exclusions", the title-case define
renames, the rewritten nursing-home define, and the version and header text.

## Data requirements, recomputed

CMS's main library lists, in its `dataRequirement`, `depends-on` entries and direct-reference codes, the
value sets and codes its v14 ELM reads, and fqm refuses to evaluate when a listed value set is missing. The
edit swaps `…198.12.1071` for `…1003.1285`, so those lists were **edited to match the translation's ELM**
(`src/standards/derived-data-requirements.ts`; `derived.recomputedDataRequirements` names the library). The
changed frailty library reads what CMS's does, so its lists are CMS's. The router's D10 refuses any library
whose lists and ELM disagree.

## What is here

| File | Committed | Content |
|---|---|---|
| `bundle.json` | yes | the Measure and ten Libraries, ELM only: the main library and the changed library are WorkWell's compile, the other eight are CMS's committed ones |
| `manifest.json` | yes | identity, pins, `changedLibraries`, `recomputedDataRequirements`, the terminology pin and the check records |
| `edits.json` | yes | the nine edits |
| `madie-expected-differences.json` | yes | the three population moves and sixteen define values on CMS's MADiE deck the edits change, and why |
| `edit-cases.json` | yes | 22 synthetic test patients, and the one code they take from `…1003.1285` (below); read only by `derived:check`, never by the corpus, ingest or any evaluation path |
| `terminology.json` | no (gitignored) | every declared value set at the release |

## What the checks proved

- `cypress-deck` (recorded): 155/155 on the 2027 Cypress deck. **Non-regression only**: CMS's 2026 logic
  also scores 155/155, and no deck patient carries the new body-structure codes.
- `terminology-equivalence` (recorded): all 32 declared value sets equal the deck's 2026-05-14 export. Nine
  differ from CMS's 2026 sidecar: seven moved by the release, and `…1285` (added) and `…1071` (dropped) by the
  edit. Pinned in `src/wiring/derived-terminology.test.ts`.
- MADiE (CI, every push, not recorded): CMS's 66-case deck. 63 cases agree on every population; the three
  that move are listed and explained. `7e5d94fa` and `c6897181` lose their exclusion (their laterality came
  only from unspecified-laterality diagnoses); `cf727fca` gains it (the frailty edit: advanced illness active
  since 2023-12-31, before the window opens on 2025-01-01; aged 74; frail). Sixteen define values differ, all listed. Value set
  `…1285` does not exist in CMS's 2026 terminology, so the translation side runs with it **empty** (no deck
  case carries one of its codes); CMS's side never sees it.
- Edit cases (CI, every push, not recorded): 22 patients, 14 of them telling the logics apart, give the
  stated answer under both — each body-site branch, the both-breasts list, wrong body-site codes, a
  not-done procedure, the removed diagnosis path, a date-only value at each of the six day-precision sites,
  both offset directions, and the frailty edit. They take one code from `…1285` ("Simple mastectomy",
  `172043006`, in none of the left, right or bilateral sets), stated in the file and checked against the
  translation's sidecar when the checks are recorded. **These are the evidence that discriminates the
  edits, and they are WorkWell's own.**

## Commands (from `backend-ts/`)

```bash
pnpm build:derived --catalog-id cms125 --year 2027 --derived-from CMS125v15 --edits measures/derived/cms125/edits.json --package <CMS125-v15.0.000 zip> --vsac-manifest http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2026-05-14
```

```bash
pnpm derived:check --catalog-id cms125 --cypress-bundle <extracted Cypress bundle-2026> --package <zip> --package-cql-dir <extracted package> --record --madie
```

```bash
node scripts/vendor-derived-terminology.mjs --catalog-id cms125 --verify-pin
```
