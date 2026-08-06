/**
 * Unit tests for the publish build's specifier rewrite (roadmap M-C / C4).
 *
 * The end-to-end property — that no emitted file imports a `.ts` path — is asserted inside
 * `build-packages.mjs` itself and was mutation-checked by hand: disabling the rewrite makes the build
 * throw, naming 6 files. What is pinned HERE is the rewrite's precision, because a regex that is too
 * greedy is the failure mode a passing build cannot show: it would silently corrupt a bare specifier
 * or a string that merely mentions a filename, and everything downstream would still be green.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PUBLISHABLE, rewriteDeclarationSpecifiers } from "./build-packages.mjs";

test("relative .ts specifiers are rewritten in every import position", () => {
  assert.equal(rewriteDeclarationSpecifiers(`export type { X } from "./evaluate-measure.ts";`), `export type { X } from "./evaluate-measure.js";`);
  assert.equal(rewriteDeclarationSpecifiers(`export { Y } from '../cql/measure-meta.ts';`), `export { Y } from '../cql/measure-meta.js';`);
  assert.equal(rewriteDeclarationSpecifiers(`const m = await import("./cql/vsac-client.ts");`), `const m = await import("./cql/vsac-client.js");`);
  assert.equal(rewriteDeclarationSpecifiers(`import Z from "./deep/nested/thing.ts";`), `import Z from "./deep/nested/thing.js";`);
});

test("bare specifiers are left alone", () => {
  // `cql-execution` and `cql-exec-fhir` are the package's whole manifest. Rewriting one would produce
  // an import of a module that does not exist, and the build assertion would NOT catch it — it only
  // looks for surviving `.ts` paths.
  for (const line of [
    `import { Executor } from "cql-execution";`,
    `import { PatientSource } from "cql-exec-fhir";`,
    `import x from "some-pkg/sub.ts";`,
  ]) {
    assert.equal(rewriteDeclarationSpecifiers(line), line, line);
  }
});

test("a .ts mentioned outside an import position is not touched", () => {
  const doc = `/** See ./evaluate-measure.ts for the outcome contract. */\nconst note = "generated from src/index.ts";`;
  assert.equal(rewriteDeclarationSpecifiers(doc), doc);
});

test("only source-shaped extensions move", () => {
  // `.json` imports (the example consumer's ELM) and already-correct `.js` must be untouched.
  for (const line of [`import elm from "./tetanus.elm.json" with { type: "json" };`, `export { a } from "./b.js";`]) {
    assert.equal(rewriteDeclarationSpecifiers(line), line, line);
  }
});

test("the publishable set excludes the internal packages", () => {
  // official-executor is the ADR-026 fqm-execution quarantine; example-consumer is a test. Publishing
  // either would contradict what the engine package claims about its own dependency surface.
  assert.deepEqual(PUBLISHABLE, ["measure-engine", "measure-codegen"]);
});
