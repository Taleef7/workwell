# `@work-well/official-executor`

Executes **official published eCQM artifacts** — the MADiE/eCQI QICore FHIR bundles CMS ships — from the
**pre-compiled ELM** inside `Library.content`, via MITRE's [`fqm-execution`](https://github.com/projecttacoma/fqm-execution).

Nothing is translated. ADR-024 established that the literal multi-library QICore CQL is not compilable
under the pinned JS translator; it does not need to be, because the published bundles already carry
`application/elm+json`, and fqm-execution runs that ELM on the same `cql-execution` + `cql-exec-fhir`
runtime this repo already depends on.

> Nicole's correction (2026-07-24): *"if the CQL exists, use it."* For an official CMS measure, running
> the published artifact verbatim is the whole point — reauthoring it is at best an educational exercise.

## Why this is a package, not a module

`fqm-execution` pulls in axios, handlebars, moment and lodash. Those must never reach the worker's
cold-start or request path (ADR-026). That used to be enforced by a file-allowlist arch test; the package
boundary now states it structurally:

- `fqm-execution` appears in **exactly one** `package.json` — this one, pinned to `1.8.5`.
- This package's entry point **imports it only through a lazy `await import`**, so consuming the package
  (even just for a type) costs nothing until something actually calculates.

Three tests in `src/standards/fqm-isolation.test.ts` enforce all of that: the manifest, the app tree, and
the module graph.

## What it deliberately does not do

| Not here | Where it lives | Why |
|---|---|---|
| Reading vendored bundle bytes | app (`standards/`) | Keeps the package filesystem-free; the vendoring convention (paths, manifests, hashes) is the app's business. |
| Value-set expansion / VSAC | app (injected `expand(oid)`) | No terminology store dependency. |
| Mapping populations → `OutcomeStatus` | app — `officialOutcome` in `standards/literal-diff.ts` (and `fhir/measure-report.ts` on the export path) | That mapping is WorkWell policy, not measure execution. |

## Usage

```ts
import { buildValueSetCache, calculateOfficial, isExecutableMeasureBundle } from "@work-well/official-executor";

if (!isExecutableMeasureBundle(bundle)) throw new Error("bundle has no pre-compiled ELM");

const valueSetCache = await buildValueSetCache(bundle, (oid) => resolver.expand(oid));

const membershipBySubject = await calculateOfficial({
  bundle,
  patientBundles,
  period: { start: "2026-01-01", end: "2026-12-31" },
  valueSetCache,
});

membershipBySubject.get("patient-1"); // { "initial-population": true, denominator: true, numerator: false, ... }
```

## Things that are load-bearing and easy to get wrong

- **`calculateHTML: false`.** fqm-execution 1.8.5 has **no** `disableHTMLGeneration` option — a
  plausible-looking name that silently does nothing. HTML, clause coverage and RAVs are all on by
  default and are pure wasted CPU per subject at population scale.
- **Date-only `measurementPeriodEnd` is parsed as START-of-day** (upstream
  [projecttacoma/fqm-execution#371](https://github.com/projecttacoma/fqm-execution/issues/371), filed by
  this project 2026-07-15 and maintainer-confirmed), silently dropping everything on the period's last
  day. `normalizePeriodEnd` fixes it; without it the CMS125 MADiE deck scores 64/66.
- **A missing value set aborts the whole batch**, so `buildValueSetCache` emits failed expansions
  *empty but present* — that can only narrow a population, never invent membership.
- **`trustMetaProfile`** must be `false` for plain-FHIR bundles (retrieve by base type) and `true` for
  profile-tagged official test-case bundles. When you cannot know which you have, run once and use
  `hasRetrieveSignal` to decide whether to retry — fqm does **not** error when every retrieve comes back
  empty, it returns a complete-looking result with nobody in any population.

## Version pin

`fqm-execution` is pinned to `1.8.5`. Any bump requires the full official MADiE test-case matrix green
(`pnpm test:official-cases`) before it may land — that deck is the regression gate for this package.
