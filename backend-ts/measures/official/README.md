# Vendored official measure artifacts

One directory per catalog measure id, written by `pnpm vendor:official`:

```
measures/official/<catalogId>/
  bundle.json     # Measure + Libraries (pre-compiled ELM only)
  manifest.json   # provenance, version, scoring, SHA-256 of bundle.json
```

## What is deliberately absent

**Value sets.** The upstream bundles ship all 26 ValueSets with full expansions, and those expansions
embed **AMA CPT** and SNOMED CT content. This repository is public and Apache-2.0 licensed, so it must
not redistribute them. Terminology is supplied at runtime from our own VSAC import, under our UMLS
licence (`pnpm resolve-valuesets` → the `value_sets` table → `buildValueSetCache`).

**Test-case patients.** The MADiE decks are fetched separately and gitignored
(`scripts/fetch-official-cases.ps1`); shipping them in the deploy image would be dead weight.

**CQL source, ELM XML, narratives.** Only `application/elm+json` is executed.

## Adding or updating a measure

```bash
pnpm vendor:official --measure CMS165FHIRControllingHighBP --catalog-id cms165
```

The version lives in `manifest.json`, never in a filename or a code constant — that hardcoding is what
let the previous artifact sit at v0.5.000 while upstream had moved to v1.0.000.

A measure must not enter `WORKWELL_OFFICIAL_MEASURES` until its MADiE test-case gate is green (PR-6).
