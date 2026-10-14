# cms2 — WorkWell translation of CMS2v16 (`ww-2027.1`)

CMS has published no FHIR logic for the 2027 measurement year. CMS2 v15 → v16 changes what counts as a
follow-up for a positive depression screen (#822). This translation is CMS's own CMS2FHIR v1.0.000 logic with
those changes ported, recompiled by WorkWell, carrying the eCQM Update 2026-05-14 value sets, and routed for
2027 only (`selectArtifactForPeriod`). It is not a CMS measure and never carries CMS's identity
(`urn:workwell:measure:cms2:translation`). Its logic is **modified** from the measure steward's (CMS's;
developed under contract by AIR). The steward's notice is carried verbatim. Unlike the NCQA measures'
(`docs/OPEN_QUESTIONS.md` §4.12), it sets no approval condition on use; the code sets it contains keep their
owners' licenses.

## The edits (`edits.json`, six, each hash-anchored to CMS's text)

Owner decision 2026-10-14: port v16 as written. A positive screen now counts in three ways, each in CMS's own
FHIR idiom:

1. **The follow-up**, in a new window: from the end of the screening to two days after the visit (v15: during
   the visit, or authored up to two days after it). It is timed by its performed time or, failing that, by
   when it was authored (an order) or recorded (a procedure), as v16 times it by its author time. The
   medication follow-up is the order alone ("Medication, Order"); CMS's draft also required the order to be
   active over the visit.
2. **Active depression management** (new in v16): a completed Procedure from Active Depression Management
   (`…1248.413`, a value set new in v16), from the end of the screening to two days after the visit.
3. **An active depression medication**: a MedicationRequest active over and after the visit, with no timing
   on the order. v15 had this path too; CMS's FHIR draft folded it into the follow-up union, under the
   follow-up's timing. Its condition is CMS's own draft expression, moved into its own define.

The edits add the value set, change both follow-up unions, both "Positive and Follow Up Provided" defines (and
add the two new paths beside each), and the numerator. Not ported, because they change no result: v16's
renames and its restated negative-screen define. The data requirements were recomputed (a Procedure read on
the new value set).

## What is here

| File | Committed | Content |
|---|---|---|
| `bundle.json` | yes | the Measure and five Libraries, ELM only: the main library is WorkWell's compile, the other four are CMS's committed ones |
| `manifest.json` | yes | identity, pins, the terminology pin and the check records |
| `edits.json` | yes | the six edits |
| `edit-cases.json` | yes | 12 synthetic test patients, and the one Active Depression Management code they need; read only by `derived:check`, never by the corpus, ingest or any evaluation path |
| `madie-expected-differences.json` | yes | the four defines only the translation has, one population that moves, and twelve define values that differ |
| `terminology.json` | no (gitignored) | every declared value set at the release |

## What the checks proved

- `cypress-deck` (recorded): 379/379 on the 2027 Cypress deck. One patient states its follow-up (an
  intervention) only by an author time; v16 counts it, and so does the translation, through the QRDA
  importer's `recorded` mapping (#822).
- `terminology-equivalence` (recorded): all 16 declared value sets equal the deck's 2026-05-14 export. Nine
  differ from CMS's 2026 sidecar: eight moved by the release, and Active Depression Management, new in v16.
  Pinned in `src/wiring/derived-terminology.test.ts`.
- MADiE (CI, every push, not recorded): CMS's 36-case deck. **One population moves**: an adult with a positive
  screen and an antidepressant order that is active, has no stated end, and was written a year before the
  visit enters the numerator through v16's active-medication path. CMS's draft counts that order only as a
  follow-up timed by its order date. Four defines exist on the translation's side only; twelve define values
  differ without moving a population (the follow-up union now holds an order on its own, and the moving
  case's exceptions are not evaluated once it is in the numerator).
- Edit cases (CI, every push, not recorded): 12 patients, 6 of them telling the logics apart, give the stated
  answer under both: a follow-up between the screening and the visit, a medication ordered after the visit, a
  medication active from before it (adult and adolescent), a follow-up procedure stated only by when it was
  recorded, and active management stated the same way; and controls (a follow-up during the visit, a referral
  during it, a negative screen, no follow-up, one three days late, one before the screening). **These are
  the evidence that discriminates the edits, and they are WorkWell's own.**

## What to know before real data

- **The management path changes no result with these value sets.** Both Active Depression Management codes
  are also follow-up codes, and its window lies inside the follow-up's, so a management procedure already
  counts as a follow-up. It is ported as v16 states it, and an edit case shows it, but no case can tell it
  apart.
- **An active medication needs no timing on its order.** An antidepressant order left `active` with no stated
  end counts at every visit after it (the moving MADiE case). Whether WebChart closes old orders matters here,
  and its medication codes are FDDC, not RxNorm, so neither medication path can fire on its data today
  (`OPEN_QUESTIONS.md` §4.9).
- **The `recorded` fallback** reads QI-Core's `qicore-recorded` extension on a Procedure. The QRDA importer now
  maps a performed procedure's one stated author time to it; WebChart ingest does not set it.

## Commands (from `backend-ts/`)

```bash
pnpm build:derived --catalog-id cms2 --year 2027 --derived-from CMS2v16 --edits measures/derived/cms2/edits.json --package <CMS2-v16.0.000 zip> --vsac-manifest http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2026-05-14
```

```bash
pnpm derived:check --catalog-id cms2 --cypress-bundle <extracted Cypress bundle-2026> --package <zip> --package-cql-dir <extracted package> --record --madie
```

```bash
node scripts/vendor-derived-terminology.mjs --catalog-id cms2 --verify-pin
```
