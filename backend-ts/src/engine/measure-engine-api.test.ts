/**
 * The APP side of the `@work-well/measure-engine` boundary (ADR-059).
 *
 * ## What this file used to be
 *
 * `engine-core-boundary.test.ts` — which decided the package boundary BEFORE the files moved, listing
 * eleven `CORE_ENTRY_POINTS` under `src/engine/` and checking that app modules imported only those. Its
 * own docblock predicted its end: once the core moved, leaving it behind made every entry point
 * unresolvable, and moving it verbatim made the app-area assertions structurally vacuous. So it is
 * rewritten rather than relocated. The package's own closure is now proven from inside the package
 * (`packages/measure-engine/src/package-boundary.test.ts`); what remains here is the half that can only
 * be checked from outside — **how the app is allowed to reach in**.
 *
 * ## The three ways the app could break the boundary
 *
 *   1. **Deep-import** past the published entry — `@work-well/measure-engine/src/cql/...`. That resolves
 *      today under `moduleResolution: Bundler` and would break the moment `package.json#exports` is
 *      enforced by a real publish (C4) — the worst possible time to discover it.
 *   2. **Reach around** the specifier entirely — a relative `../../packages/measure-engine/src/...`.
 *   3. **Import a name the package does not export** — invisible until the surface is pinned, because
 *      TypeScript resolves the whole source tree today.
 *
 * All three are refused below. `CORE_ENTRY_POINTS` is gone: the published API is now `index.ts` itself,
 * READ from the file rather than restated here, so the check cannot drift from what the package exports.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath, relative, sep } from "node:path";

const ENGINE_ROOT = fileURLToPath(new URL("./", import.meta.url)).replace(/[\\/]$/, "");
const SRC_ROOT = resolvePath(ENGINE_ROOT, "..");
const BACKEND_ROOT = resolvePath(SRC_ROOT, "..");
const ENGINE_PACKAGE_SRC = resolvePath(BACKEND_ROOT, "packages", "measure-engine", "src");

const PACKAGE_NAME = "@work-well/measure-engine";

const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'`])([^"'`]*)\1/g;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
    .join("\n");
}

/**
 * Every source file under `src/` AND `scripts/`, tests included, `.ts` **and `.mjs`/`.js`**.
 *
 * Tests are in because a test that deep-imports the package breaks at publish time exactly like
 * production code does. **`.mjs` is in because of a defect this test failed to catch** (review, #400):
 * `scripts/gen-cql.mjs` imported `generateCql` from `@work-well/measure-engine`, and when ADR-062 moved
 * codegen to its own package that import silently became invalid — `pnpm gen-cql` would have thrown at
 * runtime. `tsc` does not typecheck `.mjs`, so nothing else in CI could see it. An API check that only
 * looks at the files the compiler already checks is checking the wrong half.
 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // `statSync` THROWS on a dangling pnpm symlink, so a pruned install would fail this with ENOENT
    // rather than a boundary violation.
    if (name === "node_modules") continue;
    const full = resolvePath(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) sourceFiles(full, out);
    else if (/\.(ts|mjs|js)$/.test(full)) out.push(full);
  }
  return out;
}

const SCRIPTS_ROOT = resolvePath(BACKEND_ROOT, "scripts");
const APP_FILES = [...sourceFiles(SRC_ROOT), ...sourceFiles(SCRIPTS_ROOT)].map((file) => ({
  rel: relative(BACKEND_ROOT, file).split(sep).join("/"),
  dir: resolvePath(file, ".."),
  source: stripComments(readFileSync(file, "utf8")),
}));

/** Files that mention the package at all — the population the API assertions are about. */
const IMPORTERS = APP_FILES.filter(({ source }) => source.includes(PACKAGE_NAME));

test("no app module deep-imports past the package's published entry point", () => {
  const deep: string[] = [];
  for (const { rel, source } of APP_FILES) {
    for (const [, , specifier] of source.matchAll(SPECIFIER_RE)) {
      if (specifier?.startsWith(`${PACKAGE_NAME}/`)) deep.push(`${rel} → ${specifier}`);
    }
  }
  assert.deepEqual(deep, [], `import from "${PACKAGE_NAME}" itself — subpaths are not part of the API`);
});

test("no app module reaches around the specifier into the package's files", () => {
  const reachArounds: string[] = [];
  for (const { rel, dir, source } of APP_FILES) {
    for (const [, , specifier] of source.matchAll(SPECIFIER_RE)) {
      if (specifier === undefined || !specifier.startsWith(".")) continue;
      const target = resolvePath(dir, specifier);
      if (target === ENGINE_PACKAGE_SRC || target.startsWith(ENGINE_PACKAGE_SRC + sep)) {
        reachArounds.push(`${rel} → ${specifier}`);
      }
    }
  }
  assert.deepEqual(reachArounds, [], "a relative path into the package survives no publish");
});

/** The names `index.ts` actually re-exports — read from the file, never restated here. */
const EXPORTED_NAMES: ReadonlySet<string> = new Set(
  [
    ...stripComments(readFileSync(resolvePath(ENGINE_PACKAGE_SRC, "index.ts"), "utf8")).matchAll(
      /export\s*(?:type\s*)?\{([^}]*)\}/g,
    ),
  ]
    .flatMap(([, names]) => (names ?? "").split(","))
    .map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "")
    .filter((n) => n.length > 0),
);

test("every name the app imports from the package is actually exported by it", () => {
  const unknown: string[] = [];
  const clauseRe = new RegExp(
    String.raw`import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']${PACKAGE_NAME}["']`,
    "g",
  );
  for (const { rel, source } of IMPORTERS) {
    for (const [, names] of source.matchAll(clauseRe)) {
      for (const raw of (names ?? "").split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
        if (name && !EXPORTED_NAMES.has(name)) unknown.push(`${rel} → ${name}`);
      }
    }
  }
  assert.deepEqual(unknown, [], "add it to the package's index.ts in a PR that says so, or stop importing it");
});

test("the package does not export WorkWell measure content back to the app (ADR-059)", () => {
  // `MEASURES`, `ELM_LIBRARIES` and `withBundledEcqmFallback` live in `src/engine/cql/`, and
  // `createWorkwellEngine` is the single place they are wired together. If the package ever re-acquired
  // them, a new export here is where it would surface — and the package-side content check would go red
  // at the same time. Two independent witnesses, deliberately.
  const CONTENT_NAMES = ["MEASURES", "ELM_LIBRARIES", "withBundledEcqmFallback", "bundledEcqmValueSetResolver"];
  const leaked = CONTENT_NAMES.filter((n) => EXPORTED_NAMES.has(n));
  assert.deepEqual(leaked, [], "measure content is constructor input, not part of the engine's API");
});

test("these assertions are non-degenerate — the app really does use the package", () => {
  // Every check above passes trivially against an empty file list or an unparsed index.
  assert.ok(APP_FILES.length >= 200, `walked ${APP_FILES.length} app files — did SRC_ROOT resolve?`);
  assert.ok(
    APP_FILES.some((f) => f.rel.endsWith(".mjs")),
    "no .mjs file was walked — the half `tsc` cannot check is the half this test exists for",
  );
  assert.ok(IMPORTERS.length >= 20, `only ${IMPORTERS.length} files import the package — did the name change?`);
  assert.ok(EXPORTED_NAMES.has("CqlExecutionEngine"), "index.ts did not parse — the API check is blind");
  assert.ok(EXPORTED_NAMES.size >= 25, `parsed ${EXPORTED_NAMES.size} exports — index.ts did not parse fully`);
});
