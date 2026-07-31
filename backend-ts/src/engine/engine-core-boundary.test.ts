import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, relative, sep } from "node:path";

/**
 * The `@workwell/measure-engine` package boundary — decided, and enforced BEFORE the files move (M-C).
 *
 * ## Why this is not the same as `engine-boundary.test.ts`
 *
 * That test proves `src/engine/` is self-contained: nothing reaches out of the directory. Useful, and it
 * quietly assumes the answer to the question this file asks — **is `src/engine/` the package?**
 *
 * Measured, it is not. `src/engine/synthetic/employee-catalog.ts` is WorkWell's synthetic employee
 * directory and is the single most-imported module in the tree (51 call sites). No consumer of a
 * *measure engine* wants a fictional employee roster, and Doug's ask was "the CQL part, independent and
 * reusable". Shipping the directory as the package would export our fixtures as API.
 *
 * ## The boundary, from the dependency graph rather than from the folder names
 *
 *   PACKAGE (the eval core)   `evaluate-measure.ts`, `measure-executor.ts`, and `cql/**`
 *   APP (stays behind)        `synthetic/`, `ingress/`, `immunization/`, `cli/`
 *
 * Every cross-area edge runs app → core, with exactly **one** exception: `cql/codegen/generate-sql-cli.ts`
 * imports `ingress/webchart/terminology.ts`. That file is a CLI entrypoint, so it is app-side too — which
 * is what makes the core's closure clean rather than *nearly* clean. ADR-048 recorded that edge as
 * "`cql/` is NOT wholesale-liftable"; the accurate statement is that the SQL codegen CLI is not part of
 * the package, and the rest of `cql/` is.
 *
 * ## Scope, stated because the first draft did not
 *
 * "Every cross-area edge runs app to core, with exactly one exception" is true of **production** files.
 * There are seven further core-to-app edges from TEST files, plus two core tests reaching
 * `stores/sqlite/**` outside the engine tree entirely — and this closure starts at production entry
 * points, so it structurally cannot see any of them. ADR-048 §5 already named that hazard, and it is the
 * extraction's real blocker: the move must either strand those tests or give the package a
 * devDependency pointing back at the app.
 *
 * ## What this test buys — and what it does not
 *
 * Between now and the move: the app cannot quietly acquire a core-INTERNAL import, and the core cannot
 * quietly acquire an app dependency or a third-party one.
 *
 * It does NOT mean the move will "satisfy an already-green test". This file resolves every path from its
 * own location, so leaving it behind makes all eleven entry points unresolvable, while moving it into the
 * package makes the app-area assertion structurally vacuous — those directories will not exist there —
 * and blinds the API check, because app imports become the bare specifier `@workwell/measure-engine` and
 * it inspects only relative ones. Both need rewriting as part of the move (review, #363).
 *
 * It also does not settle the substantive question. `cql-execution-engine.ts` hard-imports our 15-measure
 * catalog, 17 compiled WorkWell ELM libraries (17 of the 29 members here) and a value-set table for the
 * synthetic corpus. The argument that excludes `synthetic/` applies to those with equal force, so whether
 * the package SHIPS that content or takes it injected is open — see ADR-052.
 */
const ENGINE_ROOT = fileURLToPath(new URL("./", import.meta.url)).replace(/[\\/]$/, "");

/**
 * The package's PUBLIC surface — every module the app is allowed to import from the core.
 *
 * This list IS the published API. It is not "everything under `cql/`": adding an entry widens what
 * `@workwell/measure-engine` promises to keep working, so it belongs in a PR that says so.
 */
const CORE_ENTRY_POINTS = [
  "evaluate-measure.ts",
  "measure-executor.ts",
  "cql/cql-execution-engine.ts",
  "cql/measure-registry.ts",
  "cql/value-set-resolver.ts",
  "cql/resolve-value-set-resolver.ts",
  "cql/composite-value-set-resolver.ts",
  "cql/bundled-ecqm-expansions.ts",
  "cql/vsac-client.ts",
  "cql/elm/index.ts",
  "cql/codegen/generate-cql.ts",
];

/** The package's dependency manifest, enforced. Two entries — that is the point (locked decision #3). */
const CORE_BARE_DEPS = new Set(["cql-execution", "cql-exec-fhir"]);

const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'`])([^"'`]*)\1/g;

/**
 * KNOWN LIMIT, inherited from `engine-boundary.test.ts`: `/\*` inside a STRING LITERAL starts a match,
 * so an import after it can be deleted from the scan. Inert today — the only production occurrence in
 * the tree is itself inside a doc comment — but `cql/codegen/generate-cql.ts` is in the closure and its
 * job is emitting CQL, whose block-comment syntax is `/* *\/`. One comment template and the closure
 * silently shrinks (review, #363). A real tokenizer is the fix if that day comes.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
    .join("\n");
}

interface Closure {
  files: Set<string>;
  /** Specifiers that resolved to a path with no file — a broken entry point or a bad import. */
  missing: Set<string>;
  bare: Map<string, string[]>;
  escapes: string[];
}

/** Every file reachable from the entry points, with the bare specifiers and out-of-tree escapes found. */
function coreClosure(entryPoints: readonly string[]): Closure {
  const files = new Set<string>();
  const missing = new Set<string>();
  const bare = new Map<string, string[]>();
  const escapes: string[] = [];
  const queue = entryPoints.map((e) => resolvePath(ENGINE_ROOT, e));

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file) || missing.has(file)) continue;
    // Only TypeScript sources carry imports; the bundled `.elm.json` artifacts are data.
    if (!file.endsWith(".ts")) {
      // Existence-checked like a `.ts` member. Adding it unconditionally meant a renamed or deleted
      // bundled ELM library left every assertion green with a HEALTHY-looking 30-file closure, while
      // test 1's own message says an import resolving to nothing is a hole in the map (review, #363).
      if (existsSync(file)) files.add(file);
      else missing.add(file);
      continue;
    }
    let source: string;
    try {
      source = stripComments(readFileSync(file, "utf8"));
    } catch {
      // Recorded as MISSING, not as a closure member. Mutation-testing this file caught the difference:
      // adding it to `files` first meant a typo'd entry point satisfied the non-degeneracy check ("it is
      // in its own closure") while contributing nothing — the exact shape that check exists to prevent.
      missing.add(file);
      continue;
    }
    files.add(file);
    for (const [, , specifier] of source.matchAll(SPECIFIER_RE)) {
      if (specifier === undefined) continue;
      if (specifier.startsWith(".")) {
        const target = resolvePath(dirname(file), specifier);
        const inside = target === ENGINE_ROOT || target.startsWith(ENGINE_ROOT + sep);
        if (!inside) escapes.push(`${relative(ENGINE_ROOT, file)} → ${specifier}`);
        else queue.push(target);
      } else {
        bare.set(specifier, [...(bare.get(specifier) ?? []), relative(ENGINE_ROOT, file)]);
      }
    }
  }
  return { files, missing, bare, escapes };
}

const closure = coreClosure(CORE_ENTRY_POINTS);
const relativeFiles = [...closure.files].map((f) => relative(ENGINE_ROOT, f).split(sep).join("/"));

test("the eval core reaches nothing outside the engine tree", () => {
  assert.deepEqual(closure.escapes, [], "an escape means the package cannot be lifted");
  assert.deepEqual([...closure.missing], [], "an import resolving to nothing means this map has a hole in it");
});

test("the eval core is CONFINED to the package boundary — no synthetic/, ingress/, immunization/, cli/", () => {
  // The finding this file exists for. `synthetic/employee-catalog.ts` is a fictional employee directory
  // with 51 call sites; shipping `src/engine/` as the package would publish our fixtures as API.
  const APP_AREAS = ["synthetic/", "ingress/", "immunization/", "cli/"];
  const intruders = relativeFiles.filter((f) => APP_AREAS.some((a) => f.startsWith(a)));
  assert.deepEqual(
    intruders,
    [],
    "the eval core must not reach app content — that content depends on the core, never the reverse",
  );
});

test("the eval core is NODE-FREE, so the package surface stays Workers-portable", () => {
  // ARCHITECTURE states this as an invariant; `engine-boundary.test.ts` permits `node:` in any
  // `*-cli.ts`, which is right for the directory and wrong for the package.
  //
  // NOT caused by this change, though an earlier draft said so: running this same algorithm against
  // `main` gives a byte-identical closure with zero `node:` imports, because the closure contains no
  // `ingress/` file at all. Relocating `DEVDB_WHITELIST` out of `devdb-cli.ts` is a tidy-up worth having
  // and is not what makes this assertion pass (review, #363).
  const nodeImports = [...closure.bare.entries()].filter(([spec]) => spec.startsWith("node:"));
  assert.deepEqual(nodeImports, [], "file I/O belongs at the CLI edge, which is app-side");
});

test("the eval core's third-party dependencies are exactly cql-execution + cql-exec-fhir", () => {
  // This IS the package manifest. Locked decision #3 promises `measure-engine` = those two deps only;
  // a test is the difference between a promise and a fact.
  const declared = [...closure.bare.keys()].filter((s) => !s.startsWith("node:")).sort();
  assert.deepEqual(declared, [...CORE_BARE_DEPS].sort());
});

test("the closure is non-degenerate — this test cannot pass by reaching nothing", () => {
  // Every assertion above is satisfied by an empty closure, so a typo in CORE_ENTRY_POINTS would turn
  // this file into four green tests that check nothing. The vacuous-guard shape, pre-empted.
  assert.ok(closure.files.size >= 25, `closure has ${closure.files.size} files — did the entry points resolve?`);
  for (const entry of CORE_ENTRY_POINTS) {
    assert.ok(
      relativeFiles.includes(entry),
      `entry point ${entry} is not in its own closure — it does not exist at that path`,
    );
  }
  assert.ok(closure.bare.has("cql-execution"), "the CQL runtime must actually be reached");
});

/**
 * Every non-test `.ts` under `src/` and `packages/`, so the API check can see what the app really does.
 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // `engine-boundary.test.ts`'s own walker already skips this; omitting it meant 39 of the 40 files
    // found under `packages/` were `fqm-execution`'s shipped .d.ts, reached through a pnpm symlink —
    // and `statSync` THROWS on a dangling one, so a pruned install failed this test with ENOENT rather
    // than a boundary violation (review, #363).
    if (name === "node_modules") continue;
    const full = resolvePath(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue; // a broken link is not a boundary violation
    }
    if (isDir) sourceFiles(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** `src/engine/<rel>` for a path inside the engine tree, else null. */
function engineRelative(file: string): string | null {
  if (file !== ENGINE_ROOT && !file.startsWith(ENGINE_ROOT + sep)) return null;
  return relative(ENGINE_ROOT, file).split(sep).join("/");
}

const APP_AREAS = ["synthetic/", "ingress/", "immunization/", "cli/"];
const isCoreArea = (engineRel: string) => !APP_AREAS.some((a) => engineRel.startsWith(a));

test("the app imports the core ONLY through its declared entry points", () => {
  // Codex (#363) caught that the docblock above calls CORE_ENTRY_POINTS "every module the app is allowed
  // to import" while NOTHING checked it: an app module importing, say, `cql/vsac-value-set-resolver.ts`
  // directly left all five other assertions green, because it is already inside the closure. The list
  // read as an API and enforced nothing — the vacuous-guard shape, inside the test written to pre-empt
  // that class.
  //
  // It matters at the moment of extraction: `package.json#exports` restricted to this list turns every
  // such import into a build error in a 150-file mechanical PR, which is the worst possible place to
  // discover an API decision.
  const SRC_ROOT = resolvePath(ENGINE_ROOT, "..");
  const PACKAGES_ROOT = resolvePath(SRC_ROOT, "..", "packages");
  const roots = [SRC_ROOT, PACKAGES_ROOT].filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });

  const violations: string[] = [];
  for (const file of roots.flatMap((r) => sourceFiles(r))) {
    const ownEngineRel = engineRelative(file);
    // A core file reaching another core file is internal, not API use.
    if (ownEngineRel !== null && isCoreArea(ownEngineRel)) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    for (const [, , specifier] of source.matchAll(SPECIFIER_RE)) {
      if (specifier === undefined || !specifier.startsWith(".")) continue;
      const targetRel = engineRelative(resolvePath(dirname(file), specifier));
      if (targetRel === null || !isCoreArea(targetRel)) continue;
      if (!CORE_ENTRY_POINTS.includes(targetRel)) {
        violations.push(`${relative(SRC_ROOT, file).split(sep).join("/")} → engine/${targetRel}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    "these reach past the published API — either route them through an entry point, or add one in a PR that says so",
  );
});
