# `@workwell/example-consumer`

**The proof that `@workwell/measure-engine` works for someone who is not us.**

ADR-059 made the engine content-free and a boundary test proves it imports no WorkWell content. That is an
architectural claim. It is not the same as proving the package is *usable* by a consumer who has none — so
this package pretends to be that consumer.

It declares **one** dependency, ships **its own** measure, and evaluates it:

```
src/tetanus-booster.cql        the measure, written here — nothing in the app references it
src/tetanus-booster.elm.json   compiled from that CQL, committed (ELM is the engine's input format)
src/FHIRHelpers-4.0.1.elm.json required by the engine's constructor — see below
src/index.ts                   catalog + bundle builder + evaluate()
```

```ts
const outcome = await evaluate({ id: "p1", birthDate: "1980-01-01", lastBoosterOn: "2024-03-01" }, "2026-06-12");
// → { subjectId: "p1", measure: "Tetanus Booster Currency", outcome: "COMPLIANT", evidence: {...} }
```

All three outcomes are exercised in `src/index.test.ts`, which runs in the normal suite. If the engine
ever re-acquires a dependency on WorkWell's catalog, this stops evaluating — a stronger signal than an
import-graph assertion, because it takes the code path a real integrator takes.

## What building this taught us, which the API docs did not

**`FHIRHelpers-4.0.1` is mandatory.** `CqlExecutionEngine`'s constructor loads it eagerly, so *every*
consumer must supply it in `elmLibraries` or construction throws. That is asserted as its own test here,
because it is the first thing an integrator will hit and nothing else stated it.

## The limitation, stated — and where it is now answered

This resolves the engine through `workspace:*`, so it is a consumer **outside the app** — not outside the
repo. Whether the *published tarball* contains what a consumer needs is a different question, and calling
this "an external consumer" without that caveat would overclaim.

**C4 answers it (ADR-063), and this package stays as it is.** `scripts/verify-publish.mjs` packs real
tarballs, installs them into a temp directory under the OS temp dir with a plain `npm install`, and runs
this package's measure content there — outside the workspace, outside the repo, with no `workspace:*`
resolution and no knowledge of this tree. It runs on every PR as CI's `packages` job.

The two are complementary rather than redundant: this one is a fast in-suite test of the *engine's*
content-independence, and `verify:publish` is a slow networked test of the *packaging*. A break in the
first is a code defect; a break in the second is a manifest defect, and neither test sees the other's.
