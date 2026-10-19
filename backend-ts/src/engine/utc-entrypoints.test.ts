/**
 * Every entry point pins the process to UTC with its FIRST import (#845).
 *
 * An entry point is anything a person or a container runs directly:
 * - the server, the dev worker and the official-calculation thread;
 * - every `*-bin.ts` / `bin.ts` CLI;
 * - every top-level `scripts/*.ts`;
 * - every `.mjs` under `scripts/` or `spike/` that imports an evaluation engine (fqm-execution,
 *   cql-execution, cql-exec-fhir, the official executor or the measure engine), for example the parity and
 *   cost-curve scripts and the published-package check. Node 24 loads the `.ts` pin under plain `node`
 *   (type stripping), so these import the same pin.
 *
 * They are found by rule, not listed, so a new CLI or script cannot skip the pin by being new. ESM evaluates
 * imports in order, so "first" is what guarantees the pin runs before anything reads a date. `.mjs` scripts
 * that evaluate nothing (vendoring, packaging) are not entry points for this purpose; the image's `TZ=UTC`
 * covers them in a container anyway.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PIN = join(backendRoot, "src", "engine", "utc.ts");
const FIXED = ["src/server.ts", "src/worker.ts", "src/wiring/fqm-worker-entry.ts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function entryPoints(): string[] {
  const bins = walk(join(backendRoot, "src"))
    .concat(walk(join(backendRoot, "scripts")))
    .filter((f) => /(^|[\\/])(?:[\w-]+-)?bin\.ts$/.test(f));
  const topLevelScripts = readdirSync(join(backendRoot, "scripts"))
    .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
    .map((n) => join(backendRoot, "scripts", n));
  // A `.mjs` script counts when it imports an evaluation engine, judged by its import specifiers, so a new
  // measure-running script is caught without anyone remembering to list it.
  const ENGINE_IMPORT = /(?:from|import\()\s*["'][^"']*(?:fqm-execution|cql-execution|cql-exec-fhir|official-executor|measure-engine)[^"']*["']/;
  const evaluatingScripts = walk(join(backendRoot, "scripts"))
    .concat(walk(join(backendRoot, "spike")))
    .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
    .filter((f) => ENGINE_IMPORT.test(readFileSync(f, "utf8")));
  const all = new Set([...FIXED.map((f) => join(backendRoot, f)), ...bins, ...topLevelScripts, ...evaluatingScripts]);
  return [...all].map((f) => relative(backendRoot, f).split(sep).join("/")).sort();
}

/** The specifier of the file's first import statement (`import type` counts: it is still the first line). */
function firstImport(source: string): string | null {
  const line = source.split(/\r?\n/).find((l) => /^import[\s{"'*]/.test(l));
  if (!line) return null;
  return /^import\s+["']([^"']+)["']/.exec(line)?.[1] ?? `(not a bare import) ${line.trim()}`;
}

test("#845: every entry point imports the UTC pin first", () => {
  const files = entryPoints();
  // Non-vacuity: the rule must find the entry points we know exist, or it is checking nothing.
  for (const known of ["src/server.ts", "src/run/cli/official-cases-bin.ts", "scripts/cql-tests/bin.ts", "scripts/cross-engine-check.ts", "spike/parity.mjs", "scripts/batch-cost-curve.mjs"]) {
    assert.ok(files.includes(known), `the discovery rule must find ${known}`);
  }
  assert.ok(files.length >= 32, `expected at least 32 entry points, found ${files.length}`);

  const wrong: string[] = [];
  for (const rel of files) {
    const specifier = firstImport(readFileSync(join(backendRoot, rel), "utf8"));
    const target = specifier?.startsWith(".") ? resolve(dirname(join(backendRoot, rel)), specifier) : null;
    if (target !== PIN) wrong.push(`${rel}: first import is ${specifier ?? "missing"}`);
  }
  assert.deepEqual(wrong, [], "each of these must start with `import \"<relative path>/engine/utc.ts\";`");
});
