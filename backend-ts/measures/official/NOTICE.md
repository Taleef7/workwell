# Third-party notices — vendored official measure artifacts

The files under `measures/official/<catalogId>/bundle.json` are **not WorkWell's work** and are **not
covered by this repository's Apache-2.0 LICENSE**. They are official CMS electronic clinical quality
measure artifacts, redistributed here unmodified except for the reduction described in
`scripts/vendor-official-measure.mjs` (resources and content types dropped; nothing added or rewritten).

Source: [`cqframework/dqm-content-qicore-2025`](https://github.com/cqframework/dqm-content-qicore-2025),
pinned per measure in each `manifest.json` (`source.repo`, `source.ref`, `source.rawSha256`).

## What licensed content remains in these files

Vendoring drops all 26 `ValueSet` resources and their expansions, which removes the bulk of the licensed
terminology (thousands of AMA CPT and SNOMED CT codes). **It does not remove all of it, and this
repository must not claim that it does.**

The official CQL declares some codes inline as direct-reference codes, so the compiled ELM still embeds
them, with their descriptions:

| Measure | Residual licensed codes in the vendored ELM |
|---|---|
| `cms122` | AMA CPT `97802`, `97803`, `97804` (medical nutrition therapy) + 7 SNOMED CT codes |
| `cms125` | 31 SNOMED CT codes |

These cannot be stripped without changing the measure logic, which would defeat the entire purpose of
running the official artifact. The `Measure.copyright` element is therefore **deliberately retained** in
each bundle rather than reduced away.

## The terms attached to that content

Reproduced from `Measure.copyright` in the vendored artifacts:

- **AMA:** "CPT(R) codes, descriptions and other data are copyright 2025. American Medical Association.
  All rights reserved. CPT is a registered trademark of the American Medical Association."
- **NCQA:** the measures are owned and developed by the National Committee for Quality Assurance.
  NCQA's notice states that uses other than the permitted ones — explicitly including *"a commercial
  use (including but not limited to vendors using or embedding the measures and specifications into any
  product or service to calculate measure results for customers for any purpose)"* — **must be approved
  by NCQA**.

## Open owner/legal question

That NCQA clause describes, fairly precisely, what a product that calculates these measures for
customers would be doing. Whether MIE's existing agreements cover it, and whether an NCQA licence is
needed before this capability ships to customers, is a **business and legal question, not an engineering
one**. It is recorded here so the decision is made deliberately rather than discovered later.

Nothing in this repository grants any right to the third-party content described above.
