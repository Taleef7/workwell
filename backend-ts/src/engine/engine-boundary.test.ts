import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, relative, sep } from "node:path";

/**
 * Engine package boundary guard (extraction PR-1; Doug's Jun-8 "CQL part independent/reusable"
 * mandate; strategic plan 2026-07-24 §7.4).
 *
 * **What `src/engine/` is, as of ADR-059:** no longer the future package — the eval core has MOVED to
 * `backend-ts/packages/measure-engine/`, and what remains here is WorkWell's measure CONTENT (the
 * catalog, the compiled ELM, the corpus expansions), the data-ingress adapters, the synthetic corpus and
 * the CLI edge. Containment still matters and for the same reason: this tree is what the app hands to the
 * engine, so it must not quietly acquire a store, a route, or a third-party dependency of its own. The
 * package's own two-dependency closure is proven from inside the package
 * (`packages/measure-engine/src/package-boundary.test.ts`), and how the app may reach in is proven by
 * `measure-engine-api.test.ts`.
 *
 * The rule is **containment**, not a blocklist of two bad targets:
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
 * This tree's dependency manifest, enforced. Adding an entry is a deliberate act — do it in a PR that
 * says so. `cql-execution` and `cql-exec-fhir` are deliberately NOT here any more: they are the
 * package's dependencies, declared in `packages/measure-engine/package.json` and enforced by its own
 * boundary test. A file here reaching for the CQL runtime directly would be evaluating measures beside
 * the engine instead of through it, so it stays a violation.
 */
const ALLOWED_BARE: { prefix: string; note: string; onlyIn?: RegExp }[] = [
  { prefix: "@workwell/measure-engine", note: "the extracted eval core (ADR-059) — the only way to evaluate" },
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
    // ADR-059: the CQL runtime belongs to the package now. A file here reaching for it directly would be
    // evaluating measures BESIDE the engine rather than through it — the shape the extraction exists to
    // prevent, and one that no other assertion in this file would catch.
    ["the CQL runtime, which is now the package's dependency", 'import cql from "cql-execution";'],
    ["the FHIR data-provider, likewise", 'import cqlfhir from "cql-exec-fhir";'],
  ];
  for (const [label, source] of violating) {
    assert.ok(
      findBoundaryViolations(here, source).length > 0,
      `matcher missed a boundary escape (${label}): ${source}`,
    );
  }

  const clean: [string, string][] = [
    ["sibling module", 'import { ELM_LIBRARIES } from "./elm/index.ts";'],
    ["parent-but-inside module", 'import { buildSyntheticBundle } from "../synthetic/fhir-bundle-builder.ts";'],
    ["deep relative inside the tree", 'import { MEASURES } from "../registry/measure-registry.ts";'],
    ["the extracted engine", 'import { CqlExecutionEngine } from "@workwell/measure-engine";'],
    ["a type from the extracted engine", 'import type { CqlCode } from "@workwell/measure-engine";'],
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
  // The extraction debt this used to carve out is GONE: `cql-translator.ts` moved to `src/measure/`
  // (ADR-048), so the ELM Explorer's translator is no longer reachable from the engine tree and
  // `@cqframework/cql` is refused ANYWHERE in it. Asserted once, at a path that still exists — the
  // earlier pair asserted the same thing twice, once against `cql/cql-translator.ts`, which no longer
  // does (review, #359).
  assert.ok(
    findBoundaryViolations(
      `${ENGINE_ROOT}/cql/workwell-engine.ts`,
      'import { CqlTranslator } from "@cqframework/cql/cql-to-elm";',
    ).length > 0,
    "the translator dep must NOT leak into this tree",
  );
});

test("src/engine/ is self-contained and declares only its allowlisted dependencies", () => {
  const files: string[] = [];
  walk(ENGINE_ROOT, files);
  const production = files.filter((f) => !f.endsWith(".test.ts"));

  // Pin near the real count: a walk that silently found half the tree would otherwise still pass and
  // report a green boundary over uninspected files. It was ~43 at PR-1 and ~33 after ADR-059 moved the
  // eval core out — lowered ONCE, with the reason, rather than left as a bound nothing can reach.
  assert.ok(
    production.length >= 30,
    `engine tree walk found only ${production.length} production files — expected ~33; the walk is broken`,
  );
  assert.ok(
    production.some((f) => f.endsWith("/cql/workwell-engine.ts")),
    "the content-wiring factory must be among the scanned files — it is what this tree exists to provide",
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
