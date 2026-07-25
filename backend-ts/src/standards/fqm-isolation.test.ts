import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

/**
 * ADR-026 isolation, now enforced STRUCTURALLY (extraction PR-4).
 *
 * `fqm-execution` (and its heavy transitive deps — axios/handlebars/moment/lodash) must never reach the
 * worker's cold-start or request path. That used to be guarded by a file allowlist here; it is now a
 * package boundary: the dependency lives in `@workwell/official-executor` alone, and that package loads
 * it through a lazy `await import`. Five tests replace the allowlist — they check the *manifest*, the
 * *app tree*, the *package source*, the *module graph*, and *who may import the package at all* — so a
 * regression has to defeat five checks rather than one grep.
 */
const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url)); // .../backend-ts/src/
const BACKEND_ROOT = fileURLToPath(new URL("../../", import.meta.url)); // .../backend-ts/
const FQM_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']fqm-execution["']/;

/**
 * Comments must not count as imports — this very file documents the forbidden shape in a comment, and
 * the engine-boundary guard learned the same lesson. Strips block comments and comment-only lines.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
    .join("\n");
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      walk(full, out);
    } else if (name.endsWith(".ts")) {
      out.push(full);
    }
  }
}

test("1/5 manifest: fqm-execution is declared by @workwell/official-executor and NOBODY else", () => {
  const appPkg = JSON.parse(readFileSync(`${BACKEND_ROOT}package.json`, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(
    appPkg.dependencies?.["fqm-execution"],
    undefined,
    "the app must not depend on fqm-execution — it consumes @workwell/official-executor",
  );
  assert.equal(appPkg.devDependencies?.["fqm-execution"], undefined, "not as a devDependency either");
  assert.equal(
    appPkg.dependencies?.["@workwell/official-executor"],
    "workspace:*",
    "the app must consume the executor package from the workspace",
  );

  // Scan EVERY workspace package, not just this one — otherwise a future package (PR-2's
  // measure-engine) could declare fqm-execution and this guard would not notice.
  const declarers: string[] = [];
  for (const name of readdirSync(`${BACKEND_ROOT}packages`)) {
    const manifest = `${BACKEND_ROOT}packages/${name}/package.json`;
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (pkg.dependencies?.["fqm-execution"] ?? pkg.devDependencies?.["fqm-execution"]) declarers.push(name);
  }
  assert.deepEqual(
    declarers,
    ["official-executor"],
    `exactly one package may declare fqm-execution; found: ${declarers.join(", ")}`,
  );

  const pkgPkg = JSON.parse(
    readFileSync(`${BACKEND_ROOT}packages/official-executor/package.json`, "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.equal(
    pkgPkg.dependencies?.["fqm-execution"],
    "1.8.5",
    "the executor package owns the pinned dependency (a bump requires the full MADiE matrix green)",
  );
});

test("2/5 app tree: no file under src/ (or any OTHER package) imports fqm-execution directly", () => {
  const files: string[] = [];
  walk(SRC_ROOT.replace(/[\\/]$/, ""), files);
  // Every workspace package except the executor itself is held to the same rule, so a future package
  // (PR-2's measure-engine) cannot quietly take the dependency on.
  for (const name of readdirSync(`${BACKEND_ROOT}packages`)) {
    if (name === "official-executor") continue;
    const packageSrc = `${BACKEND_ROOT}packages/${name}/src`;
    if (existsSync(packageSrc)) walk(packageSrc, files);
  }
  const importers = files
    .filter((f) => FQM_IMPORT_RE.test(stripComments(readFileSync(f, "utf8"))))
    .map((f) => f.replace(/\\/g, "/"))
    .map((f) => f.slice(f.lastIndexOf("/src/") + "/src/".length));
  assert.deepEqual(
    importers,
    [],
    `fqm-execution must be reached only through @workwell/official-executor; found: ${importers.join(", ")}`,
  );
});

test("3/5 package source: every fqm reference in the package is a LAZY dynamic import", () => {
  // Scan EVERY production file in the package, not just index.ts: a helper module with a static import,
  // imported by index.ts, would load the heavy graph at cold start while a single-file check saw nothing.
  //
  // And scan the whole file, not line by line — the shape a formatter produces once the import list
  // grows has no single line matching both predicates:
  //     import {
  //       Calculator,
  //     } from "fqm-execution";
  const packageSrc = `${BACKEND_ROOT}packages/official-executor/src`;
  const files: string[] = [];
  walk(packageSrc, files);
  const production = files.filter((f) => !f.endsWith(".test.ts"));
  assert.ok(production.length > 0, "sanity: the package has source files to scan");

  let lazyImports = 0;
  for (const file of production) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(new RegExp(FQM_IMPORT_RE, "g"))) {
      const reference = match[0];
      assert.match(
        reference,
        /import\s*\(\s*["']fqm-execution["']/,
        `${file.replace(/\\/g, "/")}: fqm-execution must be reached only via a lazy dynamic import, found: ${reference}`,
      );
      lazyImports += 1;
    }
  }
  assert.ok(lazyImports > 0, "sanity: the package must reference fqm-execution somewhere");
});

test("4/5 module graph: fqm resolves FROM the package, not from the app, and stays unloaded", async () => {
  // Resolve from the package's own location — rooting `createRequire` in src/ (as this test first did)
  // cannot see a dependency nested beside packages/official-executor, so the check silently skipped.
  const fromPackage = createRequire(
    pathToFileURL(`${BACKEND_ROOT}packages/official-executor/src/index.ts`).href,
  );
  let packageEntry: string | null = null;
  try {
    packageEntry = fromPackage.resolve("fqm-execution");
  } catch {
    packageEntry = null;
  }
  assert.notEqual(packageEntry, null, "fqm-execution must be installed FOR the executor package");

  // ...and must NOT be reachable from the app, which is what makes the quarantine real rather than
  // merely declared.
  const fromApp = createRequire(import.meta.url);
  let appEntry: string | null = null;
  try {
    appEntry = fromApp.resolve("fqm-execution");
  } catch {
    appEntry = null;
  }
  assert.equal(appEntry, null, "fqm-execution must NOT be resolvable from the app — it leaked back in");

  const loadedBefore = Object.keys(fromPackage.cache).includes(packageEntry!);
  const pkg = await import("@workwell/official-executor");
  assert.equal(typeof pkg.loadCalculator, "function", "sanity: the package entry loaded");
  assert.equal(
    Object.keys(fromPackage.cache).includes(packageEntry!),
    loadedBefore,
    "importing the package entry must not have pulled fqm-execution into the module graph",
  );
});

/**
 * The executor package is the ONLY door to fqm-execution, so who may open that door is itself part of
 * the quarantine (roadmap §7.1). Without this, a route or run-pipeline module could import the package
 * and call `loadCalculator()` — putting the heavy graph on a request path while all the tests above
 * still pass, since none of them looks for imports of the PACKAGE.
 */
const EXECUTOR_IMPORTERS_ALLOWLIST = [
  "standards/literal-diff.ts",
  "standards/official-cases.ts",
  "wiring/official-artifacts.ts",
  // NOT run/cli/official-cases.ts — that shell reaches fqm only through standards/official-cases.ts,
  // which is exactly the layering this list is meant to preserve.
  // PR-7 adds "wiring/executor-router.ts" here — deliberately a conscious edit, not an open door.
];

test("5/5 consumers: only the approved app layers may import @workwell/official-executor", () => {
  const files: string[] = [];
  walk(SRC_ROOT.replace(/[\\/]$/, ""), files);
  const executorImport = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']@workwell\/official-executor["']/;
  const importers = files
    .filter((f) => !f.endsWith(".test.ts"))
    .filter((f) => executorImport.test(stripComments(readFileSync(f, "utf8"))))
    .map((f) => f.replace(/\\/g, "/"))
    .map((f) => f.slice(f.lastIndexOf("/src/") + "/src/".length))
    .sort();

  assert.deepEqual(
    importers,
    EXECUTOR_IMPORTERS_ALLOWLIST,
    "a new consumer of the executor package must be added to EXECUTOR_IMPORTERS_ALLOWLIST deliberately — " +
      "it is the door to fqm-execution, and must never be opened from a route or the run pipeline",
  );
});
