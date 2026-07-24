import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Engine package boundary guard (extraction PR-1; Doug's Jun-8 "CQL part independent/reusable"
 * mandate; strategic plan 2026-07-24).
 *
 * `src/engine/` is the future `@workwell/measure-engine` package: its PRODUCTION code must import
 * nothing from the app layer — no `stores/` (persistence) and no `@mieweb/*` (platform). The two
 * historical escapes were severed in PR-1: the fat `ValueSetStore` type imports became the local
 * `ValueSetSource` port, and `engine-factory.ts` (the one `getStores` VALUE coupling — app wiring,
 * not engine) plus `UnconfiguredEngine` (the one `@mieweb/cloud` consumer) moved to `src/wiring/`.
 *
 * Test files are exempt: integration tests legitimately wire real SQLite stores + `@mieweb/cloud-local`
 * fixtures to prove engine behavior against the app's adapters. The rule protects what would ship.
 *
 * Same grep-the-tree mechanics as `standards/fqm-isolation.test.ts` (the proven pattern).
 */
const ENGINE_ROOT = fileURLToPath(new URL("./", import.meta.url)); // .../backend-ts/src/engine/

// Any import/require of the app's store layer (relative, any depth) or any @mieweb package.
const FORBIDDEN_RES: { name: string; re: RegExp }[] = [
  { name: "stores/ (app persistence layer)", re: /(?:from\s*|import\s*\(\s*)["'](?:\.\.\/)+stores\// },
  { name: "@mieweb/* (platform layer)", re: /(?:from\s*|import\s*\(\s*)["']@mieweb\// },
];

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

test("src/engine/ production code imports nothing from stores/ or @mieweb/* (engine package boundary)", () => {
  const files: string[] = [];
  walk(ENGINE_ROOT.replace(/\/$/, ""), files);
  const production = files.filter((f) => !f.endsWith(".test.ts"));

  const violations: string[] = [];
  for (const file of production) {
    const source = readFileSync(file, "utf8");
    for (const { name, re } of FORBIDDEN_RES) {
      if (re.test(source)) {
        const rel = file.replace(/\\/g, "/");
        violations.push(`${rel.slice(rel.lastIndexOf("/src/") + 1)} imports ${name}`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `engine boundary violated — move app wiring to src/wiring/ or widen a port instead:\n${violations.join("\n")}`,
  );
});
