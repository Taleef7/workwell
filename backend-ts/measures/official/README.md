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

**ELM `annotation`/`locator`/`localId`** (`--strip-elm-annotations`). ~16 MB raw → ~2.4 MB vendored,
**86% smaller**, which matters because eight measures at the unstripped setting is ~80 MB of deploy image
and the job-poll window has already had to be raised once for image growth (PR #283). Proven, not
assumed: the MADiE gate's reduction check executes the stripped artifact against the full upstream bundle
over the same deck and reports **0/55 (CMS122) and 0/66 (CMS125) cases changed population vector**, with
121/121 still passing — on **population membership**, which is what the check compares.

What that costs: `clauseResults` (already empty — `calculateClauseCoverage` and `calculateHTML` are both
off), per-statement `localId`, and `locator`, which is what cql-execution/fqm error text uses to point at
a position in the ELM, so a runtime failure in an official measure can no longer be localized. What it
keeps: `populationResults`, and fqm's named `statementResults` — the shape PR-7 persists as
`evidence_json.official`. The reduction check counts those per measure (CMS122 419, CMS125 423) and the
evidence report records the count, so a future re-vendor or fqm bump that loses them fails visibly
instead of quietly breaking PR-7.

## Adding or updating a measure

```bash
pnpm vendor:official --measure CMS165FHIRControllingHighBP --catalog-id cms165 --strip-elm-annotations
```

Pass `--strip-elm-annotations` for anything destined for production. Omit it only to produce an
unstripped artifact for clause-level debugging — and do not commit that one.

The version lives in `manifest.json`, never in a filename or a code constant — that hardcoding is what
let the previous artifact sit at v0.5.000 while upstream had moved to v1.0.000.

A measure must not enter `WORKWELL_OFFICIAL_MEASURES` until its MADiE test-case gate is green (PR-6).
