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
 * Same grep-the-tree mechanics as `standards/fqm-isolation.test.ts` (the proven pattern), with one
 * hardening (Codex review, PR #333): rather than matching two import *shapes*, extract EVERY module
 * specifier — `from "x"`, side-effect `import "x"`, dynamic `import("x")`, `require("x")`,
 * `export … from "x"` — and test the specifier itself. A guard that silently passes is worse than no
 * guard, so `findForbiddenImports` is itself unit-tested against every import form below.
 */
const ENGINE_ROOT = fileURLToPath(new URL("./", import.meta.url)); // .../backend-ts/src/engine/

/**
 * Every module-specifier position TypeScript/ESM/CJS offers. The `\bimport\s+["']` alternative is
 * what catches a bare side-effect import (`import "@mieweb/cloud";`); `\bfrom\s*` covers static and
 * `export … from` re-exports (including `import type`, which still declares a package dependency).
 */
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])([^"']+)\1/g;

const FORBIDDEN: { name: string; matches: (specifier: string) => boolean }[] = [
  {
    name: "stores/ (app persistence layer)",
    matches: (s) => /^(?:\.\.\/)+stores\//.test(s),
  },
  {
    name: "@mieweb/* (platform layer)",
    matches: (s) => s.startsWith("@mieweb/"),
  },
];

/** Returns one label per forbidden import found in `source` (empty = clean). */
function findForbiddenImports(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(SPECIFIER_RE)) {
    const specifier = match[2] ?? "";
    for (const { name, matches } of FORBIDDEN) {
      if (matches(specifier)) found.push(`${name} via "${specifier}"`);
    }
  }
  return found;
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

test("the boundary matcher catches every import form (guard self-test)", () => {
  const violating = [
    'import { getStores } from "../../stores/factory.ts";',
    'import type { ValueSetStore } from "../stores/value-set-store.ts";',
    'import "@mieweb/cloud";', // side-effect — the form the original regex missed
    'import{UnsupportedBindingError}from"@mieweb/cloud";', // no spaces
    'const cloud = require("@mieweb/cloud");',
    'const { getStores } = require("../../stores/factory.ts");',
    'const cloud = await import("@mieweb/cloud");',
    'export * from "../../stores/factory.ts";',
    "export { getStores } from '../../stores/factory.ts';", // single quotes
  ];
  for (const source of violating) {
    assert.ok(
      findForbiddenImports(source).length > 0,
      `matcher missed a forbidden import: ${source}`,
    );
  }

  const clean = [
    'import { CqlCode } from "./cql/value-set-resolver.ts";',
    'import { readFileSync } from "node:fs";',
    'import { Library } from "cql-execution";',
    " * portable across every @mieweb/cloud target", // prose in a doc comment, not an import
    " * imports NOTHING from the app layer (stores/, @mieweb/*)",
    'import { restoreStore } from "./restores/helper.ts";', // "restores/" must not match "stores/"
  ];
  for (const source of clean) {
    assert.deepEqual(findForbiddenImports(source), [], `matcher false-positived on: ${source}`);
  }
});

test("src/engine/ production code imports nothing from stores/ or @mieweb/* (engine package boundary)", () => {
  const files: string[] = [];
  // fileURLToPath yields a trailing OS separator (a backslash on Windows) — strip either form so
  // the joined paths, and therefore the violation labels below, stay single-separator.
  walk(ENGINE_ROOT.replace(/[\\/]$/, ""), files);
  const production = files.filter((f) => !f.endsWith(".test.ts"));
  assert.ok(production.length > 20, "engine tree walk found suspiciously few files");

  const violations: string[] = [];
  for (const file of production) {
    for (const label of findForbiddenImports(readFileSync(file, "utf8"))) {
      const rel = file.replace(/\\/g, "/");
      violations.push(`${rel.slice(rel.lastIndexOf("/src/") + 1)} imports ${label}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `engine boundary violated — move app wiring to src/wiring/ or widen a port instead:\n${violations.join("\n")}`,
  );
});
