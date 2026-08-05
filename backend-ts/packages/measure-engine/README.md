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
- `generateCql(input)` — declarative rule → CQL codegen (ADR-015), so authored rules compile to the same
  canonical language the engine executes.

## Status

`private: true` while the public surface settles (roadmap M-C: C2 adds the external consumer and the
conformance harness, C4 publishes). The API is `src/index.ts` and nothing else — subpath imports are not
supported and are refused by tests on both sides of the boundary.
