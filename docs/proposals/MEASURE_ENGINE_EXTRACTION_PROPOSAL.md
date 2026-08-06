# @work-well/measure-engine extraction proposal

**Status:** decision proposal; documentation only. This memo does not perform the extraction, move a file, or change the package graph.

## Decision summary

- **Gate 1 — content packaging:** recommend an injected content contract. Keep the evaluation engine reusable and put WorkWell's catalog, WorkWell-authored compiled ELM libraries, and WorkWell value-set fallback in a separate sibling content package, tentatively @work-well/workwell-measures. Keep generic FHIRHelpers as a committed engine asset. backend-ts composes the two packages. The engine itself keeps exactly cql-execution and cql-exec-fhir as runtime dependencies.
- **Gate 2 — test edges:** recommend restructuring the 10 out-of-closure edge rows across 7 named test files by edge class. Package-local tests use minimal fixtures and resolver doubles; app-side tests that exercise ingress, SQLite persistence, SQL code generation, or the synthetic corpus stay in the app, while the committed WorkWell generated-CQL artifact check moves with the sibling content package. Do not strand coverage and do not give the package a dependency back to the app.

These recommendations propose resolutions for the later extraction PR; they are not final owner decisions. No extraction is included here.

## 1. Context and framing

M-C is the roadmap milestone for extracting and eventually publishing WorkWell's reusable measure libraries. C1 has already established the workspace shape and the official-executor template; C2 is the packages/measure-engine public surface, documentation, example consumer, measure-codegen, and package-boundary conformance guards. ADR-052 already decided that synthetic/, ingress/, immunization/, and cli/ are app content that stays behind, with the current core boundary enforced before the physical move. ADR-048 moved the translator to src/measure/ but explicitly left the node: CLI-surface debt unpaid. ADR-052 left two decisions open: whether the package ships WorkWell content, and how to handle test-only edges that the production closure cannot see. See ADR-052 (docs/DECISIONS.md, lines 152-246) and ADR-048 (docs/DECISIONS.md, lines 655-735).

The current tree makes the content question real rather than formal. cql/cql-execution-engine.ts imports MEASURES, ELM_LIBRARIES, and withBundledEcqmFallback directly (lines 24-27), and its constructor/evaluate behavior is approximately at lines ~71-115 (exact line numbers were not re-opened in this worktree this round): FHIRHelpers is loaded from the engine's bundled asset, while input.elm and input.metaOverride are accepted per evaluation. Consumer-supplied measure metadata and ELM are already supported at evaluation time. That makes bundled WorkWell content a default convenience, not a technical necessity, but the current implementation still needs a content source to construct and run.

The current engine-core-boundary.test.ts declares 11 entry points (lines 64-76), including the measure registry, ELM index, and bundled expansion table. That list is today's declared API, not a decision that those three data-bearing modules must remain in the engine package after Gate 1.

## 2. Gate 1 — content packaging

### Verified facts

The WorkWell-authored content currently hard-wired into the engine is:

- MEASURES in backend-ts/src/engine/cql/measure-registry.ts (line 23 onward): WorkWell's 14 authored measure metadata entries.
- ELM_LIBRARIES in backend-ts/src/engine/cql/elm/index.ts (line 20 onward): 17 imported .elm.json libraries. FHIRHelpers-4.0.1 is bundled in that map today, but it is generic CQL/QI-Core infrastructure rather than WorkWell-authored content and should remain a committed engine asset.
- withBundledEcqmFallback in backend-ts/src/engine/cql/bundled-ecqm-expansions.ts (line 152 onward): a fallback table whose docblock starts by describing the codes “the synthetic corpus stamps” (lines 2-18).

The argument for excluding synthetic/ is that a consumer of a reusable engine does not want WorkWell's fictional employee directory or demo fixtures. That argument applies directly to the value-set table, which is explicitly synthetic-corpus-oriented. It does not apply with equal force to authored measure metadata and compiled ELM: a consumer who wants to evaluate WorkWell's own measures needs those artifacts from somewhere. The right distinction is therefore **engine capability versus WorkWell content**, not “code versus data.”

### Option A — ship bundled WorkWell content in @work-well/measure-engine

The package would move the current registry, ELM map, and fallback table with the engine. The engine could retain a no-argument WorkWell default while allowing metaOverride, input.elm, and an injected primary value-set resolver to override parts of it.

Pros:

- The backend can continue to construct the engine with its current default behavior on day one.
- A consumer evaluating WorkWell's own 14 measures gets a working catalog, ELM, and offline fallback from one install.
- The package still has only the two runtime dependencies already promised; .elm.json files and TypeScript data are package files, not dependencies.
- It minimizes the first extraction's constructor and app-composition changes.

Cons:

- A package named “measure-engine” would publish WorkWell-specific content as if it were engine API.
- The fallback table is not a general terminology service; its documented purpose is the synthetic corpus. Bundling it makes an outside consumer's value-set behavior depend on WorkWell's fixtures.
- The hard imports make the content difficult to opt out of or tree-shake. Every content update becomes an engine package release and changes the package's install and compatibility surface.
- The current 11-entry-point list would continue to make data modules public even though the reusable engine does not need to own their values.

### Option B — injected-only engine plus a WorkWell content package

The engine would require a content object at construction. The object would provide the measure metadata map, ELM library map, and value-set resolver/fallback policy. A sibling package, tentatively @work-well/workwell-measures, would export WorkWell's 14 measures, WorkWell-authored compiled libraries, and its WorkWell-specific fallback. FHIRHelpers remains a committed engine asset. backend-ts would depend on both packages and pass the WorkWell content into the engine factory.

Pros:

- The engine means what an outside consumer expects: execution over an injected measure/content contract, not a promise to ship WorkWell's catalog.
- The engine's runtime dependency story remains exact: cql-execution and cql-exec-fhir, with no dependency on a WorkWell content package.
- WorkWell content can version independently, and the synthetic-oriented fallback is located with the content that explains why it exists.
- The existing input.elm and metaOverride escape hatches remain useful for per-evaluation overrides; the constructor-level contract supplies the required base libraries and default metadata without hard-importing them.
- A consumer that has its own catalog, ELM, and terminology resolver can use the same engine without installing WorkWell's authored content.

Cons:

- This is a real constructor/API refactor. The current engine cannot be made injected-only by moving files; the three hard imports must be replaced by the content contract, while the FHIRHelpers load remains an engine-owned asset.
- backend-ts must compose two WorkWell packages, and the content package name and release/version policy need owner approval.
- The extraction PR must split the current measure-registry.ts: the MeasureMeta type belongs to the engine contract, while the MEASURES value belongs to the WorkWell content package.
- Tests that currently rely on WorkWell's synthetic corpus need a deliberate app-side or content-package home instead of silently becoming package tests.

### Recommendation

**Recommend Option B: injected-only @work-well/measure-engine, with WorkWell content supplied by a separate sibling package.**

The decisive fact is that evaluate(input.elm, input.metaOverride) already supports consumer-supplied measure logic and metadata, while the current hard imports are an implementation detail rather than a contract. The WorkWell-authored compiled ELM and measure metadata are valuable WorkWell content, but they are not the definition of a generic engine. The value-set table is even more clearly content: its own docblock ties it to the synthetic corpus. Keeping those WorkWell-authored values in a WorkWell content package preserves a one-install default for backend-ts while avoiding a misleading public engine API.

The later extraction PR should introduce a typed content contract containing at least:

~~~ts
interface MeasureContent {
  measures: Readonly<Record<string, MeasureMeta>>;
  elmLibraries: Readonly<Record<string, unknown>>;
  valueSetResolver: ValueSetResolver;
}
~~~

The override and precedence semantics must mirror the current engine. When present, per-call `input.elm` replaces the resolved `content.elmLibraries[libraryName]` entry entirely; otherwise the engine resolves the library by name from the injected `elmLibraries` map. There is no merge, matching today's `input.elm ?? this.loadElm(libraryName)` behavior with the lookup sourced from injected content. Likewise, per-call `input.metaOverride` replaces the resolved `content.measures[measureId]` entry entirely; otherwise the engine falls back to the injected `measures` map by id. There is no partial-field merge, matching today's `input.metaOverride ?? MEASURES[input.measureId]` behavior.

FHIRHelpers is deliberately not a `MeasureContent` field. It ships as a committed asset inside `@work-well/measure-engine` itself, as it already does today, because it is generic HL7/QI-Core CQL infrastructure rather than WorkWell-authored measure content. That distinction preserves the memo's engine-capability versus WorkWell-content boundary and removes the "what if an injected map omits FHIRHelpers" failure mode by construction: the engine owns and loads it unconditionally from its own bundled asset.

`content.valueSetResolver` is a content-owned fallback factory/table, not a final or sole resolver. The engine composes it behind whatever primary `ValueSetResolver` the caller supplies at construction, preserving today's `withBundledEcqmFallback(this.opts.valueSetResolver)` order: the caller's primary resolver is used first and the content fallback is available underneath it.

The content package's dependency direction is a design constraint. Because its `measures` field uses the engine-owned `MeasureMeta` type and its `valueSetResolver` field uses the engine-owned `ValueSetResolver` type, the content package may depend on `@work-well/measure-engine` for types only, through a `devDependency` or type-only import, never through a runtime `dependencies` entry. The engine package must never depend on the content package at any level, type or runtime. The workspace graph is therefore one-way: content → engine (type-only, build-time), while `backend-ts` (the app) → both packages at runtime. This is what makes the two-dependency engine claim enforceable rather than merely asserted.

The engine must continue to derive the compliance result from CQL Outcome Status; content injection may change what is evaluated, never who decides compliance.

Under this recommendation, the current CORE_ENTRY_POINTS list is intentionally revised during the extraction:

- the engine retains the execution, resolver, VSAC-client, and generate-cql surfaces;
- the MeasureMeta type moves into the engine's public contract;
- the MEASURES value, WorkWell-authored ELM values, and WorkWell fallback move to the sibling content package, while FHIRHelpers remains engine-bundled;
- the three content exports become that package's public surface, not @work-well/measure-engine's.

That is a public API decision, not a claim that the current list was wrong. It is the decision Gate 1 is required to make.

## 3. Gate 2 — test-edge strategy

### Count correction and edge inventory

The corrected inventory is **10 out-of-production-closure edge rows across 7 distinct named test files**:

- 7 core-to-app import edges: four from cql-execution-engine.test.ts, one from measure-executor.test.ts, one from foreign-condition-scoping.test.ts, and one from cql/codegen/generate-sql.test.ts.
- 2 additional core test files that reach stores/sqlite/**: value-set-resolver.test.ts and audiogram-vsac-parity.test.ts; each imports both the SQLite value-set store and the floor schema.
- 1 filesystem-only content-artifact edge: cql/codegen/generated-files.test.ts constructs measures/generated/ with new URL(..., import.meta.url) and reads the committed generated CQL files.

The first two groups retain the same 7-plus-2 distinction stated by engine-core-boundary.test.ts (lines 31-38 and 201-203). The edge inventory used for that closure scan has a known blind spot: filesystem paths built with new URL(..., import.meta.url) are not bare or relative from/import/require specifiers. The named import lines are verified in cql-execution-engine.test.ts lines 14-17, measure-executor.test.ts line 18, foreign-condition-scoping.test.ts line 14, generate-sql.test.ts line 15, value-set-resolver.test.ts lines 17-18, and audiogram-vsac-parity.test.ts lines 15-16; generated-files.test.ts has the filesystem path construction at line 9.

### Option A — strand the tests in the app

The package would move only production code. The affected tests would remain app-side, be converted into app integration tests, or be deleted if their fixture setup could not be retained.

Pros:

- The package has no app test dependency and the smallest package boundary.
- SQLite, ingress, SQL-codegen, and synthetic fixtures remain where their owners live.
- No package-to-app workspace cycle is introduced.

Cons:

- “Remain in the app” is not a complete testing plan: without explicit split and replacement assertions, core behavior can lose coverage while the app suite still passes.
- Deleting or weakening the tests is not acceptable for engine construction, resolver, and scoping behavior.
- The moved package would be tested mostly by indirect app integration, making failures harder to localize and allowing the package to drift from the public API.

### Option B — move the tests with an app devDependency

The package would keep the tests substantially unchanged and declare a test-only/devDependency back to @work-well/api-ts or an equivalent app module.

Pros:

- Existing fixtures and assertions move with little immediate rewrite.
- The test names and coverage are easy to preserve initially.

Cons:

- It breaks the “measure-engine has zero app dependencies” story even if the dependency is marked development-only.
- The package is no longer independently testable or consumable; package → app → package is a likely workspace cycle once the app consumes the extracted package.
- It makes app paths and app-owned SQLite/ingress modules part of the package's test contract.
- It hides the important distinction between engine behavior and app-adapter integration.

### Option C — restructure by edge class

Split package assertions from app integration. Use package-local minimal FHIR fixtures, a small injected content object, and in-memory resolver doubles for core tests. Keep ingress, SQLite, SQL-codegen, and synthetic-corpus assertions in backend-ts and have them import the package only through its declared exports.

Pros:

- Preserves coverage without a package-to-app dependency.
- Gives the package a genuinely standalone test surface and keeps adapter behavior tested by the app that owns the adapters.
- Makes the content decision testable: package tests exercise injection; app/content tests exercise WorkWell's 14-measure catalog and compiled ELM.
- Avoids treating a SQLite persistence contract as a CQL-engine contract.

Cons:

- The extraction PR must split assertions and write package-local fixtures.
- Some behavior is intentionally tested twice: once as a small core invariant and once through the app's real ingress or store adapter.
- The current synthetic test matrix is not a drop-in package test; its expected outcomes need to be identified as content/conformance coverage.

### Recommendation and treatment of every edge row

**Recommend Option C.** It is the only option that preserves the engine's standalone dependency direction and keeps the coverage that motivated the tests. The concrete treatment is:

| Edge row verified in the tree | Later extraction treatment |
|---|---|
| cql-execution-engine.test.ts → buildSyntheticBundle | Replace the package-side use with a minimal package-local FHIR bundle fixture. Keep the full synthetic-bundle conformance path app-side. |
| cql-execution-engine.test.ts → deriveExamConfig / TargetOutcome | Replace package-side exam configuration with a small expected-outcome table or inline fixtures. Keep WorkWell exam configuration tests app-side. |
| cql-execution-engine.test.ts → MEASURE_BINDINGS | Inject a package-local MeasureContent fixture for engine tests. Keep the WorkWell binding taxonomy and content-package checks app-side. |
| cql-execution-engine.test.ts → EMPLOYEES | Do not move the fictional roster. Use one or two minimal patient bundles for core assertions; keep roster-scale outcomes app-side. |
| measure-executor.test.ts → ingress/evaluate-bundle.ts | Keep the ingress integration test in backend-ts; add package-local direct tests for the executor seam without importing ingress. |
| foreign-condition-scoping.test.ts → ingress/evaluate-bundle.ts | Keep the app integration wrapper in backend-ts; move the core condition-scoping assertion to a package test using a minimal bundle. |
| cql/codegen/generate-sql.test.ts → ingress/webchart/terminology.ts | Keep this test app-side. generate-sql*.ts is part of the app-side CLI/codegen seam; package tests cover generate-cql.ts, not WebChart SQL terminology. |
| value-set-resolver.test.ts → stores/sqlite/value-set-store-sqlite.ts and stores/sqlite/schema.ts | Keep the SQLite persistence test app-side. Package tests use an in-memory ValueSetResolver or a small fake store and do not import DDL or store code. |
| audiogram-vsac-parity.test.ts → stores/sqlite/value-set-store-sqlite.ts and stores/sqlite/schema.ts | Keep the VSAC/SQLite parity test app-side, including its audiogram fixtures. Package tests cover resolver contract behavior without the SQLite floor. |
| cql/codegen/generated-files.test.ts → measures/generated/ via new URL("../../../../measures/generated", import.meta.url) | Move this committed WorkWell content-artifact test with measures/generated/ into the sibling content package, updating the relative path to that package-local content location. It asserts the authored CQL filenames and shape, not generate-cql.ts or engine behavior; the generated files and their test belong with the content package under Gate 1's engine-capability versus WorkWell-content distinction. |

The package must have no @work-well/api-ts, stores/sqlite/**, ingress/**, or synthetic-catalog devDependency. The app-side tests may import @work-well/measure-engine and the WorkWell content package by public specifier.

## 4. Resulting package.json sketch

The existing structural template is backend-ts/packages/official-executor/package.json: it is private, uses an exports map with types and default, has a narrow dependency list, and ships only src (lines 1-19). The root backend already consumes it as a normal workspace dependency, and its test script already includes packages/*/src/**/*.test.ts (line 32), so adding package tests requires **no test-script change**. The workspace comments already reserve packages/* for WorkWell's extractable libraries and name measure-engine as the next member (lines 10-16).

Under the recommended injected-content option, the engine package's dependency story holds exactly. The tentative sketch is:

~~~json
{
  "name": "@work-well/measure-engine",
  "version": "0.1.0",
  "description": "Headless CQL-to-ELM measure evaluation over injected measure content.",
  "type": "module",
  "license": "Apache-2.0",
  "private": true,
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    },
    "./evaluate-measure": {
      "types": "./src/evaluate-measure.ts",
      "default": "./src/evaluate-measure.ts"
    },
    "./measure-executor": {
      "types": "./src/measure-executor.ts",
      "default": "./src/measure-executor.ts"
    },
    "./cql-execution-engine": {
      "types": "./src/cql/cql-execution-engine.ts",
      "default": "./src/cql/cql-execution-engine.ts"
    },
    "./measure-types": {
      "types": "./src/cql/measure-types.ts",
      "default": "./src/cql/measure-types.ts"
    },
    "./value-set-resolver": {
      "types": "./src/cql/value-set-resolver.ts",
      "default": "./src/cql/value-set-resolver.ts"
    },
    "./resolve-value-set-resolver": {
      "types": "./src/cql/resolve-value-set-resolver.ts",
      "default": "./src/cql/resolve-value-set-resolver.ts"
    },
    "./composite-value-set-resolver": {
      "types": "./src/cql/composite-value-set-resolver.ts",
      "default": "./src/cql/composite-value-set-resolver.ts"
    },
    "./vsac-client": {
      "types": "./src/cql/vsac-client.ts",
      "default": "./src/cql/vsac-client.ts"
    },
    "./codegen/generate-cql": {
      "types": "./src/cql/codegen/generate-cql.ts",
      "default": "./src/cql/codegen/generate-cql.ts"
    }
  },
  "dependencies": {
    "cql-exec-fhir": "^2.1.6",
    "cql-execution": "^3.3.2"
  },
  "files": [
    "src"
  ]
}
~~~

The sibling content package should make the type-only direction explicit in its own manifest:

~~~jsonc
{
  "name": "@work-well/workwell-measures",
  "devDependencies": {
    "@work-well/measure-engine": "workspace:*" // type-only contract import; never a runtime dependency
  }
}
~~~

This sketch deliberately does **not** export MEASURES, ELM_LIBRARIES, or withBundledEcqmFallback from the engine. It exports the measure metadata type as an engine contract; the sibling content package owns the WorkWell values. The exact subpath count is therefore nine engine subpaths plus the root barrel, rather than the current 11-entry-point list. A root barrel is useful for the documented consumer path, while explicit subpaths preserve the current entry-point granularity and stop an accidental internal module from becoming public.

The content package is not specified as a committed package in this memo, but it must expose a stable WorkWell content object and its own catalog/ELM/terminology exports. backend-ts would depend on that sibling package; @work-well/measure-engine would not. The sibling package name, whether it is private until M-C3, and the licensing review for publishing its fallback remain owner decisions. Its type-only dependency direction is decided above and is not an allowed runtime dependency. No external dependency is proposed.

measure-executor.ts remains in the engine surface even though sqlPushdownExecutor is documented as an inert stub that constructs and then rejects on evaluation (lines 57-75). That is an explicit published surface choice to revisit; it is not a reason to make the package depend on SQL or WebChart.

## 5. What the boundary tests become after the move

Both current tests need rewriting. Relocating either file without changing its invariants would produce a false sense of safety:

- engine-core-boundary.test.ts resolves ENGINE_ROOT from its own location and then inspects relative imports. If moved into packages/measure-engine, its synthetic/, ingress/, immunization/, and cli/ check becomes vacuous because those app directories no longer exist inside the package.
- Its app API check currently looks only at relative specifiers. After migration, app imports are bare @work-well/measure-engine specifiers, so the check would go blind.
- The older engine-boundary.test.ts proves that the **whole current src/engine/ directory** is self-contained. After extraction, the remaining app-side engine code is expected to import the package; whole-directory self-containment is no longer the right invariant.

### Post-move package test: package closure

Rewrite engine-core-boundary.test.ts to live with the package and assert:

1. every production relative import resolves inside packages/measure-engine;
2. every committed ELM/data member exists, and non-TypeScript data files are not admitted merely by name;
3. the package production closure contains no backend-ts/src/**, @mieweb/cloud, app package, or content-package import;
4. the only non-Node bare runtime dependencies are cql-execution and cql-exec-fhir;
5. the package production closure has no node: imports; and
6. every exported target in package.json exists, while every intended public entry point is reachable through an exports key; and
7. every `*.test.ts` file inside `packages/measure-engine` is scanned independently of the production closure. Each relative, `require`/dynamic-import, or filesystem-constructed path—including `new URL(..., import.meta.url)`—must resolve only to files inside the package boundary, Node built-ins used for test infrastructure, the two declared runtime dependencies, or package-local fixtures. It must not resolve to `backend-ts/src/**` or to content-package source files; if a content package is imported at all, the test may use only its declared exports. This explicit test-file scan prevents the production-only closure blind spot from being rebuilt one level up, because that same mechanism is what hid the existing `generated-files.test.ts` filesystem edge.

The test may use node:fs and node:path itself because it is a guard running under Node; the production-closure assertions remain about the package's production files, while item 7 covers the package's own test files. The package test should also validate the injected content contract with a package-local fixture, but it must not import WorkWell's app or synthetic content source files.

### Post-move app test: no reaching into package internals

Rewrite the older engine-boundary.test.ts to stay app-side and assert a different invariant:

1. app production files may import @work-well/measure-engine only at the package root or at a key in the package's declared exports map;
2. no app file may import packages/measure-engine/src/** by relative path, filesystem path, or an unexported package subpath;
3. app-side synthetic/, ingress/, immunization/, cli/, SQL-codegen, and SQLite modules may depend on the package, but the package may not depend on them; and
4. WorkWell content imports must use the content package's declared exports, not the content package's source files.

This is not the old self-contained-tree assertion moved to a new directory. It is a check that one workspace package consumes another through its public contract. The two tests then have separate owners: the package test protects the package's closure, and the app test protects the app-to-package seam.

## 6. Migration mechanics at 85-file / 125-import-statement scale

The current measured scope is larger than the original roadmap sketch. ADR-052 records 125 import statements across 85 files, not the earlier “~87 import sites”; the 29 closure members are 12 TypeScript modules plus 17 .elm.json data files. cql-libs.d.ts must move even though no import can see it because TypeScript picks it up through tsconfig include. The same ADR records that cql/codegen/ is not a unit: generate-cql.ts moves toward the package, while generate-sql*.ts stays app-side. These facts are in docs/DECISIONS.md lines 224-235 and the 2026-07-31 journal entry lines 201-208.

### Codemod

A jscodeshift or ts-morph codemod can rewrite relative imports to the appropriate bare export, for example ../../engine/cql/value-set-resolver.ts to @work-well/measure-engine/value-set-resolver. It can also distinguish the three content paths and send them to the content package.

Pros:

- Repeatable over 125 statements and rerunnable after review fixes.
- AST-aware, so it can preserve type-only imports, named bindings, and import assertions better than a text replacement.
- Leaves a machine-checkable report of changed files and unresolved paths.

Cons:

- It cannot decide the test-edge treatment, the content-package seam, or the CLI codegen seam.
- Relative paths with different depths, re-exports, dynamic imports, and test-only fixtures need explicit cases and manual review.
- A broad codemod can accidentally rewrite app-side synthetic/, ingress/, or generate-sql imports into the wrong package.

### Temporary barrel at the old path

Leave short-lived compatibility files at old core paths, for example:

~~~ts
export * from "@work-well/measure-engine/value-set-resolver";
~~~

Content paths would re-export from the WorkWell content package, not from the engine. This keeps a staged move buildable while consumers are migrated.

Pros:

- Reduces the size of any one migration commit and gives reviewers a stable intermediate tree.
- Makes the old-to-new mapping explicit and reversible without restoring production implementation files.
- Allows tests and app modules to migrate in separate focused commits.

Cons:

- A barrel can hide an incomplete migration and leave the old path as an accidental permanent API.
- It can create duplicate test discovery or confusing source maps if compatibility files are not excluded from the package walk.
- It cannot solve a test that genuinely imports an app adapter; that test still needs restructuring.

### Staged moves

Move the package closure, content package, app imports, and test edges in small slices while both old compatibility paths and new exports are available.

Pros:

- Matches the repository's “one task at a time,” “keep changes small and focused,” and “many small commits over few large ones” working style in CLAUDE.md.
- Makes the content decision, package boundary, test rewrite, and import migration reviewable as distinct changes.
- Provides clear checkpoints for the boundary tests and pnpm test glob.

Cons:

- The intermediate state has two import paths and therefore needs a removal deadline.
- A partially moved closure can make local path reasoning harder unless the compatibility map is kept complete and tested.

### Recommendation

**Recommend staged moves with a short-lived barrel, followed by an AST codemod and barrel removal.** Keep the work in the extraction task's focused commits (or a separately scoped cleanup task if the owner wants the compatibility window to cross PRs), but do not leave the compatibility files as a permanent API.

1. Add the package/content skeleton and post-move boundary-test shapes; record the exact export map.
2. Add compatibility re-exports for only the old core paths that are being migrated.
3. Run a targeted AST codemod over app production imports, then manually handle the seven distinct test files and the generate-sql/CLI seam.
4. Move cql-libs.d.ts and all ELM data explicitly; do not rely on import closure to discover them.
5. Run rg audits for old src/engine core imports, package-internal paths, and content paths; remove the compatibility barrels once no consumer remains.
6. Verify the package boundary tests and the existing root test glob. No package-test script change is needed because backend-ts/package.json already globs packages/*/src/**/*.test.ts.

## 7. What stays app-side

This memo does not reopen ADR-052's app-side decision. The following remain app-owned:

- backend-ts/src/engine/synthetic/
- backend-ts/src/engine/ingress/
- backend-ts/src/engine/immunization/
- backend-ts/src/engine/cli/
- the cql/codegen/generate-sql*.ts CLI/codegen seam;
- app-owned SQLite stores and schema under backend-ts/src/stores/sqlite/.

The generate-sql-cli.ts → ingress/webchart/terminology.ts edge is specifically recorded by ADR-048 and ADR-052 as app composition. The later package should not pull it across the boundary just to preserve a test import.

## 8. Honesty constraints and non-claims

### Workers portability

It is false that this memo makes the whole current src/engine/ Workers-portable. ADR-048's unpaid debt remains: generate-sql-cli.ts and devdb-cli.ts export library values used by multiple consumers, including production live-cli.ts (backend-ts/src/engine/ingress/webchart/live-cli.ts). The current whole-tree boundary test permits node: imports in *-cli.ts; ADR-048 says the exports make this a real refactor, not a git mv.

The narrower package closure can retain the existing node-free invariant, but that claim applies only to the extracted core after the CLI surface stays app-side. It must not be generalized to all of src/engine/ until the separate CLI refactor is paid.

### Test discovery

pnpm test does not need a config change for the new package. The verified root script is:

~~~text
node --import tsx --test "src/**/*.test.ts" "packages/*/src/**/*.test.ts" "scripts/**/*.test.mjs"
~~~

The proposal does not run it, because this task is docs-only and the extraction has not happened.

### Scope and measured discrepancies

- No file is moved, no extraction is run, and no code under backend-ts/src/** or backend-ts/packages/** is changed by this proposal.
- The roadmap's original §7.4 sketch says “29 files (9 TS + 20 ELM)” and “~53-file import rewrite.” The later measured ADR/JOURNAL facts are 29 members as 12 TypeScript modules plus 17 ELM data files and 125 import statements across 85 files. This memo uses the current measured figures.
- The tree verifies 10 edge rows across seven named test files: nine import/store edges plus the filesystem-only generated-files.test.ts content-artifact edge. That count correction is intentional and does not change the Gate 2 recommendation.

## 9. Open questions / owner judgment calls

These are the remaining owner calls after the recommendations above; the proposal recommends a resolution for the gates without recording these calls as final decisions.

- Approve or rename the placeholder @work-well/workwell-measures package and decide whether it remains private until M-C3 publication.
- Decide whether the content package should publish the WorkWell fallback table as-is, subject to the terminology/licensing review that already governs public packages.
- Confirm whether the root barrel plus explicit subpaths is the desired public API, or whether a smaller root-only API should be exposed first.
- Decide whether sqlPushdownExecutor remains a published inert stub or is moved behind a diagnostic-only subpath.
- Schedule the unpaid CLI-surface refactor relative to the physical extraction; this memo does not pay it.
- Confirm timing relative to M-A wave-2 and M-B work, and whether the example consumer lands in C2 or is held for C3's publication review.

## Verified tree references

The citations above were checked against this checkout on branch feat/measure-engine-extraction-proposal:

- docs/DECISIONS.md: ADR-052 lines 152-246; ADR-048 lines 655-735.
- docs/JOURNAL.md: the 2026-07-31 M-C entry beginning at line 166.
- backend-ts/src/engine/engine-core-boundary.test.ts: entry points lines 64-80, closure lines 107-202, app API scan lines 204-276.
- backend-ts/src/engine/engine-boundary.test.ts: older whole-src/engine/ containment guard.
- backend-ts/packages/official-executor/package.json: lines 1-19; src/ contains index.ts and index.test.ts.
- backend-ts/package.json: test glob line 32; workspace dependency and CQL versions lines 44-47.
- backend-ts/pnpm-workspace.yaml: package comments and members lines 10-16.
- docs/ROADMAP_2026-07-24.md: M-C lines 129-137 and migration §7.4 lines 227-245.
- backend-ts/src/engine/cql/cql-execution-engine.ts: constructor/evaluate behavior at lines ~71-115 (approximate; exact line numbers were not re-opened in this worktree this round), including the FHIRHelpers load, `input.elm`/`metaOverride` override-or-fallback paths, and resolver composition.
- backend-ts/src/engine/cql/measure-registry.ts, cql/elm/index.ts, and cql/bundled-ecqm-expansions.ts: the three WorkWell content sources.
- backend-ts/src/engine/cql/codegen/generated-files.test.ts: the filesystem-only measures/generated path at line 9 and committed generated-CQL artifact assertions.
- The seven named test files and their edge lines listed in Gate 2 above.
