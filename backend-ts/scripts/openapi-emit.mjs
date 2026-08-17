/**
 * Emit the OpenAPI document to a file, so an external validator can read it (ADR-068).
 *
 *   node --import tsx scripts/openapi-emit.mjs [outfile]     # default: openapi.json in the cwd
 *
 * Why this exists rather than a committed `openapi.json`: the document is generated from
 * `src/openapi/spec.ts`, so a committed copy would be a second artifact that can disagree with the served
 * one — the exact drift the contract test exists to prevent. CI emits it to a temp path, lints it, and
 * throws it away; the only source of truth is the code the worker serves.
 *
 * CI (`.github/workflows/ci.yml`, the backend-ts job):
 *   node --import tsx scripts/openapi-emit.mjs "$RUNNER_TEMP/openapi.json"
 *   REDOCLY_TELEMETRY=off npx --yes @redocly/cli@2.46.1 lint "$RUNNER_TEMP/openapi.json"
 *
 * Redocly is pinned exactly, for the same reason the official-terminology fetch is: `@latest` in CI makes
 * the gate non-reproducible. `REDOCLY_TELEMETRY=off` is not optional — the CLI otherwise reports
 * environment-variable values and the names of rules that fired.
 */
import { writeFileSync } from "node:fs";
import { openApiDocument } from "../src/openapi/spec.ts";

const out = process.argv[2] ?? "openapi.json";
writeFileSync(out, `${JSON.stringify(openApiDocument(), null, 2)}\n`);
console.log(`wrote ${out}`);
