/**
 * The `@workwell/measure-engine` package boundary, enforced from INSIDE the package.
 *
 * This replaces the package half of the old `src/engine/engine-core-boundary.test.ts`, which decided the
 * boundary before the files moved and said in its own docblock that the move would leave it either
 * unresolvable (if left behind) or structurally vacuous (if moved verbatim, since the app directories it
 * asserted about would no longer exist relative to it). Neither happened: the closure is recomputed here
 * from the package's real entry point, and the app-side half now lives in
 * `src/engine/measure-engine-api.test.ts`.
 *
 * What it proves, from `index.ts`:
 *   1. nothing reaches outside the package (so it is publishable as-is);
 *   2. no `node:` builtin (so it stays portable to a Cloudflare-style worker, not just the Node container);
 *   3. exactly two third-party dependencies — this test IS the manifest (locked decision #3);
 *   4. no WorkWell CONTENT — the catalog, the compiled ELM and the corpus expansions are injected
 *      (ADR-059), and this is what keeps that decision from being quietly reverted;
 *   5. the closure is non-degenerate, so none of the above can pass by reaching nothing.
 *
 * KNOWN LIMIT, carried over deliberately: the closure starts at the production entry point, so TEST files
 * are outside it. They are allowed `node:test`/`node:assert` and nothing else follows from their imports.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, relative, sep } from "node:path";

const PACKAGE_SRC = fileURLToPath(new URL("./", import.meta.url)).replace(/[\\/]$/, "");

/** The published entry point. `package.json#exports` points at exactly this file. */
const ENTRY = "index.ts";

/** The package's dependency manifest, enforced. Two entries — that is the point. */
const BARE_DEPS = new Set(["cql-execution", "cql-exec-fhir"]);

/**
 * WorkWell CONTENT, by name. An import of any of these from inside the package would also show up as an
 * escape (they live under `src/engine/`), but naming them makes the ADR-059 decision legible at the point
 * it is enforced rather than inferable from a path assertion.
 */
const CONTENT_PATTERNS = [/measure-registry/, /\/elm\//, /bundled-ecqm-expansions/, /synthetic/];

const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'`])([^"'`]*)\1/g;

/**
 * KNOWN LIMIT, inherited: `/*` inside a STRING LITERAL starts a match, so an import after it can be
 * deleted from the scan. `cql/codegen/generate-cql.ts` is in the closure and its job is emitting CQL,
 * whose block-comment syntax is that sequence. A real tokenizer is the fix if that day comes.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
    .join("\n");
}

const files = new Set<string>();
const missing = new Set<string>();
const bare = new Map<string, string[]>();
const escapes: string[] = [];
/** Every specifier seen anywhere in the closure, with the file that wrote it. */
const allSpecifiers: Array<{ file: string; specifier: string }> = [];

{
  const queue = [resolvePath(PACKAGE_SRC, ENTRY)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file) || missing.has(file)) continue;
    if (!file.endsWith(".ts")) {
      if (existsSync(file)) files.add(file);
      else missing.add(file);
      continue;
    }
    let source: string;
    try {
      source = stripComments(readFileSync(file, "utf8"));
    } catch {
      missing.add(file);
      continue;
    }
    files.add(file);
    const rel = relative(PACKAGE_SRC, file).split(sep).join("/");
    for (const [, , specifier] of source.matchAll(SPECIFIER_RE)) {
      if (specifier === undefined) continue;
      allSpecifiers.push({ file: rel, specifier });
      if (specifier.startsWith(".")) {
        const target = resolvePath(dirname(file), specifier);
        const inside = target === PACKAGE_SRC || target.startsWith(PACKAGE_SRC + sep);
        if (!inside) escapes.push(`${rel} → ${specifier}`);
        else queue.push(target);
      } else {
        bare.set(specifier, [...(bare.get(specifier) ?? []), rel]);
      }
    }
  }
}

const relativeFiles = [...files].map((f) => relative(PACKAGE_SRC, f).split(sep).join("/")).sort();

test("the package reaches nothing outside itself", () => {
  assert.deepEqual(escapes, [], "an escape means the package cannot be published as it stands");
  assert.deepEqual([...missing], [], "an import resolving to nothing means this map has a hole in it");
});

test("the package is NODE-FREE, so it stays portable beyond the Node container", () => {
  const nodeImports = [...bare.entries()].filter(([spec]) => spec.startsWith("node:"));
  assert.deepEqual(nodeImports, [], "file I/O belongs at the CLI edge, which is app-side");
});

test("the package's third-party dependencies are exactly cql-execution + cql-exec-fhir", () => {
  const declared = [...bare.keys()].filter((s) => !s.startsWith("node:")).sort();
  assert.deepEqual(declared, [...BARE_DEPS].sort(), "this assertion IS the package manifest");
});

test("the package ships NO WorkWell measure content — it is injected (ADR-059)", () => {
  // The catalog, the 17 compiled ELM libraries and `withBundledEcqmFallback` ("the codes the synthetic
  // corpus stamps") are the consumer's to supply. Without this, a later change could re-import them and
  // every other assertion here would stay green until someone read the diff.
  const contentImports = allSpecifiers
    .filter(({ specifier }) => CONTENT_PATTERNS.some((p) => p.test(specifier)))
    .map(({ file, specifier }) => `${file} → ${specifier}`);
  assert.deepEqual(contentImports, [], "measure content is constructor input, never an import");
});

test("the closure is non-degenerate — this file cannot pass by reaching nothing", () => {
  // Every assertion above is satisfied by an empty closure, so a typo in ENTRY would turn this into four
  // green tests that check nothing. The vacuous-guard shape, pre-empted.
  assert.ok(files.size >= 10, `closure has ${files.size} files — did the entry point resolve?`);
  assert.ok(relativeFiles.includes(ENTRY), `${ENTRY} is not in its own closure — it does not exist there`);
  assert.ok(relativeFiles.includes("cql/cql-execution-engine.ts"), "the engine itself must be reached");
  assert.ok(bare.has("cql-execution"), "the CQL runtime must actually be reached");
});
