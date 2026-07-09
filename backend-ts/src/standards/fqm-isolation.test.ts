import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * #258 / ADR-026 isolation guard: `fqm-execution` is a DIAGNOSTIC-ONLY dependency. It (and its heavy
 * transitive deps — axios/handlebars/moment/lodash) must NEVER be imported by the live run pipeline,
 * engine ingress, or the worker entrypoint — only by the standards diagnostic module reached from the
 * fidelity-diff route. This arch test greps the whole `src/` tree for any `fqm-execution` import and
 * asserts the sole owner is `standards/literal-diff.ts`.
 */
const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url)); // .../backend-ts/src/
const IMPORT_RE = /(?:from\s*|import\s*\(\s*)["']fqm-execution["']/;

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

test("fqm-execution is imported ONLY from standards/literal-diff.ts (ADR-026 isolation)", () => {
  const files: string[] = [];
  walk(SRC_ROOT.replace(/\/$/, ""), files);
  const importers = files
    .filter((f) => IMPORT_RE.test(readFileSync(f, "utf8")))
    .map((f) => f.replace(/\\/g, "/"));

  assert.equal(importers.length, 1, `fqm-execution imported from unexpected files: ${importers.join(", ")}`);
  assert.match(importers[0]!, /standards\/literal-diff\.ts$/);
});

test("fqm-execution is NOT imported by run/, engine/ingress/, or worker.ts (ADR-026)", () => {
  const files: string[] = [];
  walk(SRC_ROOT.replace(/\/$/, ""), files);
  const forbidden = files
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => /\/run\/|\/engine\/ingress\/|\/worker\.ts$/.test(f))
    .filter((f) => IMPORT_RE.test(readFileSync(f, "utf8")));
  assert.deepEqual(forbidden, [], `fqm-execution leaked into request/ingress path: ${forbidden.join(", ")}`);
});
