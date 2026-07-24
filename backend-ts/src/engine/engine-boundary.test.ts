import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, relative, sep } from "node:path";

/**
 * Engine package boundary guard (extraction PR-1; Doug's Jun-8 "CQL part independent/reusable"
 * mandate; strategic plan 2026-07-24 §7.4).
 *
 * `src/engine/` is the future `@workwell/measure-engine` package. The rule is **containment**, not a
 * blocklist of two bad targets:
 *
 *   1. every RELATIVE import must resolve to a path inside `src/engine/` — the tree must be
 *      self-contained, because anything reaching out cannot be lifted into a package; and
 *   2. every BARE import must be on the allowlist below — that list IS the package's dependency
 *      manifest, so a new third-party dep can't appear silently.
 *
 * Containment is what PR-2 actually needs. A target blocklist is not: it passes a one-hop
 * indirection (`import … from "../wiring/engine-factory.ts"`, which itself pulls `getStores` and
 * `@mieweb/cloud`), which is precisely how the two escapes severed in PR-1 would come back.
 *
 * Test files are exempt: integration tests legitimately wire real SQLite stores + `@mieweb/cloud-local`
 * fixtures to prove engine behavior against the app's adapters. The rule protects what would ship.
 *
 * Grep-the-tree mechanics follow `standards/fqm-isolation.test.ts` (the proven pattern). Hardened
 * twice under review on PR #333: match every specifier form (Codex), then containment + allowlist
 * with comment stripping (self-review).
 */
const ENGINE_ROOT = fileURLToPath(new URL("./", import.meta.url)).replace(/[\\/]$/, "");

/**
 * The engine package's dependency manifest, enforced. Adding an entry is a deliberate act that
 * widens what `@workwell/measure-engine` would need to declare — do it in a PR that says so.
 */
const ALLOWED_BARE: { prefix: string; note: string; onlyIn?: RegExp }[] = [
  { prefix: "cql-execution", note: "the CQL runtime" },
  { prefix: "cql-exec-fhir", note: "the FHIR data-provider for that runtime" },
  {
    // Extraction debt, tracked in the roadmap: the ELM Explorer's translator is reached from
    // routes/measures.ts, so it is a real runtime dep of this tree TODAY. PR-2 moves
    // cql-translator.ts to the app, which is what restores the two-dependency package story.
    prefix: "@cqframework/cql",
    note: "the CQL→ELM translator (ELM Explorer) — PR-2 moves this file to the app",
    onlyIn: /[\\/]cql[\\/]cql-translator\.ts$/,
  },
  {
    // ARCHITECTURE's "portable across every @mieweb/cloud target — file I/O lives only at the CLI
    // edge" is an invariant, so enforce it rather than assert it: node built-ins may appear only in
    // the CLI entrypoints, never in a module the worker request path can reach.
    prefix: "node:",
    note: "Node built-ins — CLI entrypoints only, so the library surface stays Workers-portable",
    onlyIn: /-cli\.ts$/,
  },
];

/**
 * Every module-specifier position TypeScript/ESM/CJS offers, including backticks so a template
 * literal can't smuggle one past. `\bimport\s+["'`]` is what catches a bare side-effect import.
 */
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'`])([^"'`]*)\1/g;

/**
 * Drop comment-only lines and block comments before scanning. This file's own header quotes import
 * statements, and so do several engine doc comments — without this, documenting the boundary inside
 * an engine file would fail the boundary test.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
    .join("\n");
}

/** Returns one violation label per offending import in `file` (empty = clean). */
function findBoundaryViolations(file: string, source: string): string[] {
  const found: string[] = [];
  for (const match of stripComments(source).matchAll(SPECIFIER_RE)) {
    const specifier = match[2] ?? "";
    if (specifier === "") continue;

    if (specifier.includes("${")) {
      found.push(`interpolated specifier \`${specifier}\` — not statically verifiable`);
      continue;
    }

    if (specifier.startsWith(".")) {
      const target = resolvePath(dirname(file), specifier);
      const rel = relative(ENGINE_ROOT, target);
      if (rel.startsWith("..") || rel.startsWith(`.${sep}..`)) {
        found.push(`"${specifier}" escapes the engine tree (resolves outside src/engine/)`);
      }
      continue;
    }

    const allowed = ALLOWED_BARE.find((a) =>
      a.prefix.endsWith(":")
        ? specifier.startsWith(a.prefix) // "node:" scheme → node:fs, node:path, …
        : specifier === a.prefix || specifier.startsWith(`${a.prefix}/`), // exact or subpath export
    );
    if (!allowed) {
      found.push(`"${specifier}" is not on the engine dependency allowlist`);
    } else if (allowed.onlyIn && !allowed.onlyIn.test(file)) {
      found.push(`"${specifier}" is allowed only in ${allowed.onlyIn} (${allowed.note})`);
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

test("the boundary matcher catches every escape form (guard self-test)", () => {
  const here = `${ENGINE_ROOT}/cql/probe.ts`;

  const violating: [string, string][] = [
    ["static app import", 'import { getStores } from "../../stores/factory.ts";'],
    ["type-only app import", 'import type { ValueSetStore } from "../../stores/value-set-store.ts";'],
    ["side-effect platform import", 'import "@mieweb/cloud";'],
    ["no-whitespace import", 'import{UnsupportedBindingError}from"@mieweb/cloud";'],
    ["CJS require", 'const cloud = require("@mieweb/cloud");'],
    ["CJS require of a relative escape", 'const { getStores } = require("../../stores/factory.ts");'],
    ["dynamic import", 'const cloud = await import("@mieweb/cloud");'],
    ["re-export", 'export * from "../../stores/factory.ts";'],
    ["single-quoted re-export", "export { getStores } from '../../stores/factory.ts';"],
    // The forms a target-blocklist missed — the reason this guard is containment-based:
    ["one-hop indirection via wiring", 'import { engineForEnv } from "../../wiring/engine-factory.ts";'],
    ["any other app module", 'import { finishManualRun } from "../../run/run-pipeline.ts";'],
    ["non-normalized path", 'import { getStores } from "./../../../stores/factory.ts";'],
    ["template-literal specifier", "const m = await import(`../../stores/${name}.ts`);"],
    ["undeclared third-party dep", 'import axios from "axios";'],
    ["node built-in outside a CLI", 'import { readFileSync } from "node:fs";'],
  ];
  for (const [label, source] of violating) {
    assert.ok(
      findBoundaryViolations(here, source).length > 0,
      `matcher missed a boundary escape (${label}): ${source}`,
    );
  }

  const clean: [string, string][] = [
    ["sibling module", 'import { CqlCode } from "./value-set-resolver.ts";'],
    ["parent-but-inside module", 'import { evaluateMeasure } from "../evaluate-measure.ts";'],
    ["deep relative inside the tree", 'import { MEASURES } from "../registry/measure-registry.ts";'],
    ["allowlisted runtime", 'import { Library } from "cql-execution";'],
    ["allowlisted runtime subpath", 'import { PatientSource } from "cql-exec-fhir/lib/x.js";'],
    // The real false positive the comment stripper closes — doc comments in this repo quote paths:
    ["quoted import inside a doc comment", ' * severed `import x from "../../stores/factory.ts"`'],
    ["quoted import inside a line comment", '// was: import { getStores } from "../../stores/factory.ts";'],
    ["quoted import inside a block comment", '/* import "@mieweb/cloud"; */'],
    // Near-miss that must NOT be treated as the app's stores/ directory:
    ["a sibling dir whose name ends in 'stores'", 'import { restore } from "../restores/helper.ts";'],
  ];
  for (const [label, source] of clean) {
    assert.deepEqual(
      findBoundaryViolations(here, source),
      [],
      `matcher false-positived (${label}): ${source}`,
    );
  }

  // The allowlist's onlyIn scoping must actually scope.
  assert.deepEqual(
    findBoundaryViolations(`${ENGINE_ROOT}/cli/evaluate-measure-cli.ts`, 'import { readFileSync } from "node:fs";'),
    [],
    "node built-ins must be permitted in a *-cli.ts entrypoint",
  );
  assert.deepEqual(
    findBoundaryViolations(
      `${ENGINE_ROOT}/cql/cql-translator.ts`,
      'import { CqlTranslator } from "@cqframework/cql/cql-to-elm";',
    ),
    [],
    "the translator dep must be permitted in cql-translator.ts",
  );
  assert.ok(
    findBoundaryViolations(
      `${ENGINE_ROOT}/cql/cql-execution-engine.ts`,
      'import { CqlTranslator } from "@cqframework/cql/cql-to-elm";',
    ).length > 0,
    "the translator dep must NOT leak into the evaluation core",
  );
});

test("src/engine/ is self-contained and declares only its allowlisted dependencies", () => {
  const files: string[] = [];
  walk(ENGINE_ROOT, files);
  const production = files.filter((f) => !f.endsWith(".test.ts"));

  // Pin near the real count (43 at PR-1): a walk that silently found half the tree would otherwise
  // still pass and report a green boundary over uninspected files.
  assert.ok(
    production.length >= 40,
    `engine tree walk found only ${production.length} production files — expected ~43; the walk is broken`,
  );
  assert.ok(
    production.some((f) => f.endsWith("/cql/cql-execution-engine.ts")),
    "the evaluation core must be among the scanned files",
  );

  const violations: string[] = [];
  for (const file of production) {
    for (const label of findBoundaryViolations(file, readFileSync(file, "utf8"))) {
      const rel = file.replace(/\\/g, "/");
      violations.push(`${rel.slice(rel.lastIndexOf("/src/") + 1)}: ${label}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `engine boundary violated — move app wiring to src/wiring/, widen a port, or (for a new dependency)\n` +
      `add it to ALLOWED_BARE in a PR that says why:\n${violations.join("\n")}`,
  );
});
