# Third-party notices — the QI-Core compile path

## `_modelinfo/qicore-modelinfo-6.0.0.xml`

cqframework's QICore 6.0.0 model info, unmodified, from
[`cqframework/clinical_quality_language`](https://github.com/cqframework/clinical_quality_language) at tag
`v3.27.0`, path `Src/java/quick/src/main/resources/org/hl7/fhir/qicore-modelinfo-6.0.0.xml` (git blob
`fead944520e61f3010a54b2a4e8a0b507ad4c58f`). Licensed under the Apache License, Version 2.0. It is a type
description of the QI-Core 6.0.0 profiles for the CQL translator; it carries no terminology.

`src/standards/qicore-compile.ts` refuses the file unless its LF-normalized bytes hash to
`75cf34cca8b6ce28f0841201681ff6f2db2235cdcd4ad39bd84c01b8ea76ad33`.

## What does not live here

No CMS CQL, ValueSet, Cypress or VSAC content is committed under this directory. The compile path reads
CMS's CQL from the gitignored `.official-content` checkout, hash-checked against each
`measures/official/<id>/manifest.json`.
