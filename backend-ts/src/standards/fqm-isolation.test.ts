import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

  const pkgPkg = JSON.parse(
    readFileSync(`${BACKEND_ROOT}packages/official-executor/package.json`, "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.equal(
    pkgPkg.dependencies?.["fqm-execution"],
    "1.8.5",
    "the executor package owns the pinned dependency (a bump requires the full MADiE matrix green)",
  );
});

test("2/3 app tree: no file under src/ imports fqm-execution directly", () => {
  const files: string[] = [];
  walk(SRC_ROOT.replace(/[\\/]$/, ""), files);
  const importers = files
    .filter((f) => FQM_IMPORT_RE.test(readFileSync(f, "utf8")))
    .map((f) => f.replace(/\\/g, "/"))
    .map((f) => f.slice(f.lastIndexOf("/src/") + "/src/".length));
  assert.deepEqual(
    importers,
    [],
    `fqm-execution must be reached only through @workwell/official-executor; found: ${importers.join(", ")}`,
  );
});

test("3/3 module graph: importing the executor package loads NO fqm-execution (lazy-import discipline)", async () => {
  // The property that actually protects worker cold start: a static import anywhere in the package
  // entry would pull axios/handlebars/moment/lodash into the graph of every consumer. `await import`
  // inside `loadCalculator()` is what keeps the cost at zero until someone genuinely calculates.
  // Under pnpm's strict linking the app cannot even RESOLVE fqm-execution now that it is not an app
  // dependency — the strongest possible form of this guard. Assert that, and treat a hoisted/flat
  // node_modules (where it would resolve) as the weaker case still worth checking via the module cache.
  const require = createRequire(import.meta.url);
  let fqmEntry: string | null = null;
  try {
    fqmEntry = require.resolve("fqm-execution");
  } catch {
    fqmEntry = null; // not resolvable from the app: the dependency really did move to the package.
  }
  const loadedBefore = fqmEntry !== null && Object.keys(require.cache).includes(fqmEntry);

  const pkg = await import("@workwell/official-executor");
  assert.equal(typeof pkg.loadCalculator, "function", "sanity: the package entry loaded");

  const source = readFileSync(`${BACKEND_ROOT}packages/official-executor/src/index.ts`, "utf8");
  const staticImports = source
    .split("\n")
    .filter((line) => /^\s*import\s/.test(line) && line.includes("fqm-execution"));
  assert.deepEqual(
    staticImports,
    [],
    `the package entry must not statically import fqm-execution (found: ${staticImports.join(" | ")})`,
  );
  assert.match(source, /await import\("fqm-execution"\)/, "it must be reached through a lazy import");
  if (fqmEntry !== null) {
    assert.equal(
      Object.keys(require.cache).includes(fqmEntry),
      loadedBefore,
      "importing the package must not have pulled fqm-execution into the module cache",
    );
  }
});
