# Third-party notices — the QI-Core compile path

## `_modelinfo/qicore-modelinfo-6.0.0.xml`

cqframework's QICore 6.0.0 model info, unmodified, from
[`cqframework/clinical_quality_language`](https://github.com/cqframework/clinical_quality_language) at tag
`v3.27.0`, path `Src/java/quick/src/main/resources/org/hl7/fhir/qicore-modelinfo-6.0.0.xml` (git blob
`fead944520e61f3010a54b2a4e8a0b507ad4c58f`). Licensed under the Apache License, Version 2.0. It is a type
description of the QI-Core 6.0.0 profiles for the CQL translator; it carries no terminology.

`src/standards/qicore-compile.ts` refuses the file unless its LF-normalized bytes hash to
`75cf34cca8b6ce28f0841201681ff6f2db2235cdcd4ad39bd84c01b8ea76ad33`.

## Translations (`<catalogId>/`)

A WorkWell translation of a CMS measure, for a year CMS has not published FHIR logic for (decision 3),
lives in its own folder: `bundle.json` and `manifest.json` committed, and `terminology.json` fetched at
build and gitignored. Its Measure and every library WorkWell changed carry WorkWell's identity. CMS's
unchanged shared libraries keep CMS's names and are pinned by the hash of their ELM. CMS's direct-reference
codes in the compiled ELM fall under the same terms as `measures/official/NOTICE.md`, NCQA's notice
included.

- `cms137/` — WorkWell translation of CMS137v15 (`ww-2027.1`), built from CMS's CMS137FHIR v1.0.000 CQL
  with no edit (v15 changes value sets only) and the eCQM Update 2026-05-14 value sets. Its `README.md`
  carries the hashes, the commands and what its checks proved.
- `cms130/` — WorkWell translation of CMS130v15 (`ww-2027.1`), built from CMS's CMS130FHIR v1.0.000 CQL
  with ONE edit, in CMS's shared AdvancedIllnessandFrailty library (carried under WorkWell's name), and
  the eCQM Update 2026-05-14 value sets. Its logic is MODIFIED from the measure steward's (NCQA's). The
  copyright notice on its Measure is the steward's, carried verbatim: it allows internal, noncommercial
  use without NCQA's approval and requires that approval for any other use. Its `README.md` carries the
  edit, the hashes, the commands and what its checks proved. `edit-cases.json` beside it holds synthetic
  test patients written by WorkWell.
- `cms125/` — WorkWell translation of CMS125v15 (`ww-2027.1`), built from CMS's CMS125FHIR v1.0.000 CQL
  with nine edits: the same AdvancedIllnessandFrailty edit as `cms130/` (the same changed library), and
  CMS125v15's mastectomy-laterality and day-precision changes in the main library, whose computed data
  requirements were edited to match. Its logic is MODIFIED from the measure steward's (NCQA's), under the
  same carried notice as `cms130/`. Its `edit-cases.json` names one code it asserts is in value set
  `…1003.1285`, checked against the translation's own expansion when its checks are recorded; it is not a
  copy of the value set.

## What does not live here

No CMS CQL, ValueSet, Cypress or VSAC content is committed under this directory. The compile path reads
CMS's CQL from the gitignored `.official-content` checkout, hash-checked against each
`measures/official/<id>/manifest.json`.
