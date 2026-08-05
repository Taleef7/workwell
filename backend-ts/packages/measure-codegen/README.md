# `@workwell/measure-codegen`

Declarative measure rules → canonical CQL. **Zero dependencies.**

```ts
import { generateCql, validateRule } from "@workwell/measure-codegen";

const cql = generateCql({ library: "TdapSeries", version: "1.0.0", rule, bindings });
```

## Why it is not part of the engine

`@workwell/measure-engine` answers *"is this patient compliant?"* from compiled ELM. This answers
*"what CQL expresses this rule?"*. They shared a directory, not code — `generate-cql.ts` has **zero
imports** — so separating them costs nothing and states something true: codegen is authoring-time, the
engine is runtime.

A consumer evaluating measures should not have to take a CQL emitter, and a rule-builder UI should not
have to take a CQL runtime. Being dependency-free, this one runs in a browser.

## What it does not do

It does not decide compliance and it executes nothing. Emitted CQL is compiled to ELM by the normal build
and run by the engine, which stays the sole authority on `Outcome Status` (ADR-008/ADR-015).

`validateRule` refuses numerics that make an outcome unreachable — a `dueSoonDays > windowDays` typo
compiles cleanly and mislabels a whole cohort, so it is rejected at authoring time instead of discovered
in a report.
