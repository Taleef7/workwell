import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * ADR-026 isolation, now enforced STRUCTURALLY (extraction PR-4).
 *
 * `fqm-execution` (and its heavy transitive deps — axios/handlebars/moment/lodash) must never reach the
 * worker's cold-start or request path. That used to be guarded by a file allowlist here; it is now a
 * package boundary: the dependency lives in `@workwell/official-executor` alone, and that package loads
 * it through a lazy `await import`. Three tests replace the allowlist — they check the *manifest*, the
 * *app tree*, and the *module graph*, so a regression has to defeat all three rather than one grep.
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

test("1/3 manifest: fqm-execution is declared by @workwell/official-executor and NOBODY else", () => {
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

test("2/3 app tree: no file under src/ (or any OTHER package) imports fqm-execution directly", () => {
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

test("3/3 module graph: the package reaches fqm-execution ONLY through a lazy import", async () => {
  // The property that actually protects worker cold start: a static import anywhere in the package
  // entry pulls axios/handlebars/moment/lodash into the graph of every consumer, and the static chain
  // worker.ts → routes/measures.ts → literal-diff.ts → this package means that reaches cold start.
  //
  // Scan the WHOLE source with the same multi-line-capable regex test 2/3 uses — a line-based check
  // misses the shape any formatter produces once the import list grows:
  //     import {
  //       Calculator,
  //     } from "fqm-execution";
  const source = readFileSync(`${BACKEND_ROOT}packages/official-executor/src/index.ts`, "utf8");
  const withoutComments = stripComments(source);

  const references = [...withoutComments.matchAll(new RegExp(FQM_IMPORT_RE, "g"))].map((m) => m[0]);
  assert.ok(references.length > 0, "sanity: the package must reference fqm-execution somewhere");
  for (const reference of references) {
    assert.match(
      reference,
      /import\s*\(\s*["']fqm-execution["']/,
      `fqm-execution must be reached only via a lazy dynamic import; found a static reference: ${reference}`,
    );
  }
  assert.match(withoutComments, /await import\("fqm-execution"\)/, "the lazy import must still be there");

  // Assert non-resolvability positively rather than treating it as a reason to skip: under pnpm's
  // strict linking the app genuinely cannot load fqm-execution now that it is not an app dependency.
  const require = createRequire(import.meta.url);
  let resolved: string | null = null;
  try {
    resolved = require.resolve("fqm-execution");
  } catch {
    resolved = null;
  }
  assert.equal(
    resolved,
    null,
    "fqm-execution must NOT be resolvable from the app — if it is, it leaked back into app node_modules",
  );

  const pkg = await import("@workwell/official-executor");
  assert.equal(typeof pkg.loadCalculator, "function", "sanity: the package entry loaded");
});
