# cms137 — WorkWell translation of CMS137v15 (`ww-2027.1`)

CMS has published no FHIR logic for the 2027 measurement year, and CMS137 v14 → v15 changes **value sets
only**. This translation is CMS's own CMS137FHIR v1.0.000 logic, recompiled by WorkWell with no edit
(`edits.json` is `[]`), carrying the eCQM Update 2026-05-14 value sets, routed for 2027 only (see
`src/wiring/official-artifacts.ts`, `selectArtifactForPeriod`). It is not a CMS measure and never
carries CMS's identity (`urn:workwell:measure:cms137:translation`).

## What is here

| File | Committed | Content |
|---|---|---|
| `bundle.json` | yes | the Measure and seven Libraries, ELM only; the main library is WorkWell's compile, the six shared CMS libraries are byte-for-byte the committed official ones |
| `manifest.json` | yes | identity, the base artifact pin, the build pins, the terminology pin and the check records |
| `edits.json` | yes | hash-anchored edits over CMS's CQL (none) |
| `terminology.json` | no (gitignored) | every declared value set expanded at the release; regenerated at CI and deploy and verified against the manifest's pin |

## Inputs (all pinned in `manifest.json`)

- CMS's artifact: `measures/official/cms137` (`derived.base.manifestSha256`).
- CMS's CQL: the hash-verified `.official-content` checkout, compiled with `@cqframework/cql@4.0.0-beta.1`
  and the pinned QI-Core 6.0.0 model info (`derived.build`).
- The 2027 QDM package `CMS137-v15.0.000`, hashed only (`derived.derivedFrom.packageSha256`); it is
  licensed content and never enters the repo.
- The VSAC release `http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2026-05-14` (`terminology.completion.manifest`).

## What the checks proved (`derived.oracles`)

- `cypress-deck`: every one of the 36 patients in the 2027 Cypress deck agrees with the steward's expected
  result on both rates and every stratum row. The deck scores 36/36 on either year's value sets, so it is
  evidence about the logic, not the codes.
- `terminology-equivalence`: all 28 declared value sets equal the Cypress 2027 deck's value-set export
  of the same release (eCQM Update 2026-05-14, an independent export of VSAC, not a list the measure
  steward wrote), exactly 10 of them differ from CMS's 2026 sidecar (43 codes added, 13 removed), and no
  other set moved. The ten are pinned in `src/wiring/derived-terminology.test.ts`.
- MADiE logic equivalence (CI, not recorded): CMS's 45-case MADiE deck for this measure, run through this
  main library with CMS's shared libraries, matches CMS's own run on every case, rate, stratifier and all
  2,970 define values.

## Commands (from `backend-ts/`)

```bash
pnpm build:derived --catalog-id cms137 --year 2027 --derived-from CMS137v15 --edits measures/derived/cms137/edits.json --package <CMS137-v15.0.000 zip> --vsac-manifest http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2026-05-14
```

```bash
pnpm derived:check --catalog-id cms137 --cypress-bundle <extracted Cypress bundle-2026> --package <zip> --package-cql-dir <extracted package> --record --madie
```

```bash
node scripts/vendor-derived-terminology.mjs --catalog-id cms137 --verify-pin
```

A rebuild changes nothing (`--verify`); the check records survive a rebuild only while the bundle and
the terminology pin are unchanged.
