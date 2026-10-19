/**
 * Every entry point pins the process to UTC with its FIRST import (#845).
 *
 * An entry point is anything a person or a container runs directly:
 * - the server, the dev worker and the official-calculation thread;
 * - every `*-bin.ts` / `bin.ts` CLI;
 * - every top-level `scripts/*.ts`.
 *
 * They are found by rule, not listed, so a new CLI cannot skip the pin by being new. ESM evaluates imports
 * in order, so "first" is what guarantees the pin runs before anything reads a date.
 *
 * Plain `.mjs` scripts run under bare `node` and cannot import a `.ts` file. None of them evaluates a
 * measure, and the image's `TZ=UTC` covers them in a container.
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
  const all = new Set([...FIXED.map((f) => join(backendRoot, f)), ...bins, ...topLevelScripts]);
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
  for (const known of ["src/server.ts", "src/run/cli/official-cases-bin.ts", "scripts/cql-tests/bin.ts", "scripts/cross-engine-check.ts"]) {
    assert.ok(files.includes(known), `the discovery rule must find ${known}`);
  }
  assert.ok(files.length >= 27, `expected at least 27 entry points, found ${files.length}`);

  const wrong: string[] = [];
  for (const rel of files) {
    const specifier = firstImport(readFileSync(join(backendRoot, rel), "utf8"));
    const target = specifier?.startsWith(".") ? resolve(dirname(join(backendRoot, rel)), specifier) : null;
    if (target !== PIN) wrong.push(`${rel}: first import is ${specifier ?? "missing"}`);
  }
  assert.deepEqual(wrong, [], "each of these must start with `import \"<relative path>/engine/utc.ts\";`");
});
