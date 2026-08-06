# `@workwell/measure-engine`

Headless eCQM evaluation. Give it a patient bundle and a measure; get back the outcome and the
per-define evidence that produced it.

```ts
import { CqlExecutionEngine } from "@workwell/measure-engine";

const engine = new CqlExecutionEngine({ measures, elmLibraries, expansionFallback });

const outcome = await engine.evaluate({
  measureId: "audiogram",
  patientBundle,                 // FHIR R4 Bundle
  evaluationDate: "2026-06-12",
});
// → { subjectId, measure, outcome, inInitialPopulation?, evidence: { expressionResults } }
```

## What it is

- **Two dependencies**: `cql-execution` and `cql-exec-fhir`. That is the whole manifest, and
  `src/package-boundary.test.ts` fails the build if a third appears.
- **No JVM.** CQL is translated to ELM ahead of time; this package executes the compiled ELM.
- **No `node:` builtins**, so it runs unchanged on a Node container, a Cloudflare-style worker, or in a
  browser bundle. File I/O belongs at the consumer's CLI edge.
- **Descriptive, never prescriptive.** The engine reports what the measure logic computed. It does not
  decide compliance policy, and nothing in it infers an outcome the CQL did not produce.

## What it deliberately does NOT contain

**Measure content is injected, not shipped** (ADR-059). The catalog, the compiled ELM and any offline
value-set expansions are constructor input:

```ts
interface MeasureContent {
  measures: Record<string, MeasureMeta>;      // id → evaluation metadata
  elmLibraries: Record<string, unknown>;      // library name → pre-compiled ELM (must include FHIRHelpers-4.0.1)
  expansionFallback?: (primary?: ValueSetResolver) => ValueSetResolver;
}
```

The reasoning is the same one that keeps WorkWell's synthetic employee directory out: nobody consuming a
measure engine wants somebody else's occupational-health catalog, 1.2 MB of their compiled libraries, or
a value-set table whose own docblock begins *"the codes the synthetic corpus stamps."*

Content is **required**, not defaulted. An engine with an empty catalog reports `MISSING_DATA` for every
subject — indistinguishable from a genuinely ineligible population, which is precisely the failure this
codebase has spent several ADRs learning to keep visible. A compile error is the cheapest place to catch it.

`evaluate()` also accepts `elm` and `metaOverride`, so a consumer can run a measure the injected catalog
has never heard of — useful for authoring tools and codegen parity checks.

## Value-set resolution

`ValueSetResolver` is a one-method port (`expand(url) → CqlCode[]`). Implementations included:

| | |
|---|---|
| `StoreValueSetResolver` | reads from any `ValueSetSource` the consumer provides |
| `VsacValueSetResolver` + `httpVsacClient` | live NLM VSAC expansion |
| `CompositeValueSetResolver` | routes VSAC OIDs to one resolver and everything else to another |
| `resolveValueSetResolver(env, store)` | config-driven selection; VSAC only when credentials are present |

When a measure declares value sets and no resolver can serve them, the engine runs the measure's base
library rather than entering expansion mode against an empty `CodeService` — a limited answer instead of
a silently wrong one.

## Also exported

- `MeasureExecutor` — the pluggable execution seam (ADR-025). `fhirNativeExecutor(engine)` is the default
  and the correctness oracle; `sqlPushdownExecutor()` is an inert stub that rejects on use.
- `evaluateExpressions(...)` — data-free execution of a library's defines, which is the subset the CQL
  language conformance suite is written in (ADR-060).

Rule → CQL codegen is **not** here. It moved to [`@workwell/measure-codegen`](../measure-codegen) in
ADR-062: it shares no code with the engine, answers a different question, and a consumer who wants to
evaluate measures should not have to take a CQL emitter.

## Where it sits next to the alternatives

It **composes** `fqm-execution`; it does not compete with it. See
[`docs/PACKAGES.md`](../../../docs/PACKAGES.md) for the full positioning — the short version is that
`fqm-execution` evaluates a published FHIR **Measure bundle** end to end, and this evaluates **compiled
ELM** against a bundle and hands back per-define evidence. WorkWell uses both: official CMS eCQMs route
through `fqm-execution` (quarantined in `@workwell/official-executor`, ADR-026), and everything else —
including the occupational measures nobody publishes — runs here.

## Status and stability

Published from CI with npm provenance (ADR-063). **Pre-1.0**, so a minor bump may break: read the semver
policy in [`docs/PACKAGES.md`](../../../docs/PACKAGES.md) before pinning.

The API is `src/index.ts` and nothing else — subpath imports are not supported and are refused by tests
on both sides of the boundary. The published tarball is proven to install, run and typecheck outside this
workspace by `pnpm verify:publish`, which runs on every PR.
