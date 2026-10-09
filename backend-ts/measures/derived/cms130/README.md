# cms130 — WorkWell translation of CMS130v15 (`ww-2027.1`)

CMS has published no FHIR logic for the 2027 measurement year. CMS130 v14 → v15 changes **one line of
logic**, in the shared AdvancedIllnessandFrailty library, plus ten value sets (#779). This translation is
CMS's own CMS130FHIR v1.0.000 logic with that one line ported, recompiled by WorkWell, carrying the eCQM
Update 2026-05-14 value sets, and routed for 2027 only (see `src/wiring/official-artifacts.ts`,
`selectArtifactForPeriod`). It is not a CMS measure and never carries CMS's identity
(`urn:workwell:measure:cms130:translation`). Its logic is **modified** from the measure steward's (NCQA's).
The steward's copyright notice is carried verbatim: it allows internal, noncommercial use without NCQA's
approval and requires that approval for any other use, so any use beyond the sandbox waits on it
(`docs/OPEN_QUESTIONS.md`).

## The edit

"Has Advanced Illness in Year Before or During Measurement Period" (frailty exclusion, patients 66 and
older): an advanced-illness diagnosis now counts when its prevalence interval **overlaps** the window
[start of the measurement period − 1 year, end of the measurement period]; CMS's 2026 logic required it to
**start during** that window. `edits.json` holds that one line, hash-anchored to CMS's text.

The library WorkWell edited is a **changed library**: `WorkWellAdvancedIllnessandFrailtyTranslation2027`
`ww-2027.1`, edited from CMS's AdvancedIllnessandFrailty 1.27.000 (`derived.changedLibraries` names CMS's
ELM hash). The main library's CQL is CMS's, unedited — so `build.translationSha256` is CMS's text, and the
edit's provenance is `changedLibraries[].translationSha256` — and its include is repointed at the changed
library.

What the edit does on real data, read in CMS's FHIR conventions (`QICoreCommon.prevalenceInterval()`):
- a diagnosis that began before the window and is still active, or ended on or after the window's first
  day, now excludes the patient;
- an **active diagnosis with no onset date** now excludes the patient too: its interval is
  `Interval[null, null]`, closed, which the engine reads as boundless. WebChart problem-list entries often
  carry no onset, so this is likely the most common new exclusion;
- a diagnosis that is not active and has no abatement date still does **not** count: its interval ends at
  an unknown point (`Interval[onset, null)`), and `overlaps` is unknown. A QDM engine may read that case as
  ongoing, so on it the two can differ.

Not ported, because they change no result: the v15 define renames (title case), the rewritten nursing-home
define (equivalent for every input), and the version and header text. CMS's FHIR draft names are kept.

## What is here

| File | Committed | Content |
|---|---|---|
| `bundle.json` | yes | the Measure and ten Libraries, ELM only: the main library and the changed library are WorkWell's compile, the other eight are byte-for-byte CMS's committed ones |
| `manifest.json` | yes | identity, the base artifact pin, the build pins, `changedLibraries`, the terminology pin and the check records |
| `edits.json` | yes | the one hash-anchored edit |
| `madie-expected-differences.json` | yes | the one define value on CMS's MADiE deck the edit changes, and why |
| `edit-cases.json` | yes | 15 synthetic test patients (below); read only by `derived:check`, never by the corpus, ingest or any evaluation path |
| `terminology.json` | no (gitignored) | every declared value set expanded at the release; regenerated at CI and deploy and verified against the manifest's pin |

## Inputs (all pinned in `manifest.json`)

- CMS's artifact: `measures/official/cms130` (`derived.base.manifestSha256`).
- CMS's CQL: the hash-verified `.official-content` checkout, compiled with `@cqframework/cql@4.0.0-beta.1`
  and the pinned QI-Core 6.0.0 model info (`derived.build`).
- The 2027 QDM package `CMS130-v15.0.000`, hashed only (`derived.derivedFrom.packageSha256`); it is
  licensed content and never enters the repo.
- The VSAC release `http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2026-05-14`.

## What the checks proved

- `cypress-deck` (recorded): all 269 patients in the 2027 Cypress deck agree with Cypress's expected
  results on every row. **Non-regression only**: CMS's unchanged 2026 logic scores 269/269 on the same
  deck, so the deck does not exercise the edit.
- `terminology-equivalence` (recorded): all 31 declared value sets equal the deck's eCQM Update 2026-05-14
  export, and exactly ten differ from CMS's 2026 sidecar (84 codes added, 16 removed), pinned in
  `src/wiring/derived-terminology.test.ts`. The package's CQL also declares four sets the translation does
  not; they are CQMCommonQDM's own (a helper library CMS130's FHIR draft does not carry), and CMS130's
  measure specification lists none of them.
- MADiE (CI, every push, not recorded): CMS's 64-case MADiE deck through the translation matches CMS's own
  run on every case, rate and stratifier, and on 2687 of 2688 define values. The one difference is the one
  listed in `madie-expected-differences.json`: case `7822bd0a…`, whose diagnosis starts one minute before
  the window and is still active. The patient is 46, so no population moves. Forcing the edited define to
  null moves 84 define values, which proves the check runs WorkWell's copy of the library.
- Edit cases (CI, every push, not recorded): the 15 patients in `edit-cases.json` give the stated answer
  under both logics, and 6 of them tell the logics apart (an onset before the window still active, no
  onset, an abatement inside the window, an abatement on its first day, an encounter diagnosis, and age
  exactly 66). They run on CMS's 2026 value sets at the MADiE deck's period, with codes in both years'
  expansions. **This is the only check that discriminates the edit, and it is WorkWell's own.**

## Commands (from `backend-ts/`)

```bash
pnpm build:derived --catalog-id cms130 --year 2027 --derived-from CMS130v15 --edits measures/derived/cms130/edits.json --package <CMS130-v15.0.000 zip> --vsac-manifest http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2026-05-14
```

```bash
pnpm derived:check --catalog-id cms130 --cypress-bundle <extracted Cypress bundle-2026> --package <zip> --package-cql-dir <extracted package> --record --madie
```

```bash
node scripts/vendor-derived-terminology.mjs --catalog-id cms130 --verify-pin
```

A rebuild changes nothing (`--verify`); the check records survive a rebuild only while the bundle and
the terminology pin are unchanged.
