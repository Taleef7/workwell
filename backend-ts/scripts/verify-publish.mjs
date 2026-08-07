/**
 * Packs the publishable `@work-well/*` packages and consumes them from OUTSIDE the workspace
 * (roadmap M-C / C4).
 *
 *   node scripts/verify-publish.mjs
 *
 * ## The gap this closes
 *
 * `packages/example-consumer` proves the engine evaluates content that is not WorkWell's, but it
 * resolves the engine through `workspace:*` — so it is a consumer outside the *app*, not outside the
 * *repo*. Its own docblock says so. Everything the workspace supplies for free is therefore untested:
 * whether `files` ships what the code needs, whether `publishConfig` actually repoints `exports` at
 * `dist/`, whether the emitted `.d.ts` resolve without `allowImportingTsExtensions`, and whether the
 * declared `dependencies` are sufficient.
 *
 * Each of those fails silently inside the workspace and loudly for the first integrator. So this
 * script builds real tarballs, installs them into a temporary directory under the OS temp dir with a
 * plain `npm install` and no knowledge of this repo, and then does two things there:
 *
 *   1. **Runs** the engine on a measure it has never seen, asserting a real outcome.
 *   2. **Typechecks** a TypeScript consumer against the packed `.d.ts` under `moduleResolution:
 *      node16` — the resolution an ordinary consumer has, rather than this workspace's `Bundler` plus
 *      `allowImportingTsExtensions`.
 *
 * **What step 5 does NOT prove, measured rather than assumed.** It was written expecting to catch a
 * declaration file still pointing at a `./x.ts` path. It does not: with the rewrite in
 * `build-packages.mjs` disabled, step 5 still passes, because `tsc` substitutes `.ts` → `.d.ts` when
 * resolving and finds the declaration sitting beside it. The claim is not made anywhere as a result,
 * and the property is asserted directly instead — see `assertNoTsSpecifiers` below, which reads the
 * tarball rather than trusting that a build ran.
 *
 * The measure content is `packages/example-consumer`'s, copied in — reusing it keeps the two proofs
 * about the same artifact rather than about two different toy measures.
 *
 * Requires network (npm resolves `cql-execution` and `cql-exec-fhir` from the registry), which is why
 * this is a separate CI job rather than part of `pnpm test`.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHABLE = ["measure-engine", "measure-codegen"];
const EVAL_DATE = "2026-06-12";

// A BARE command (`npm`, `tar`) needs a shell on Windows to find its `.cmd` shim; an ABSOLUTE path
// must not get one, because cmd.exe splits `C:\Program Files\...` at the space.
const needsShell = (cmd) => process.platform === "win32" && !/[\\/]/.test(cmd);
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: needsShell(cmd) });
const capture = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", shell: needsShell(cmd) });

/**
 * Packing MUST go through pnpm, not npm. The `publishConfig.exports` rewrite this script verifies is a
 * pnpm feature — npm's `publishConfig` only understands `registry`, `access` and `tag`, so `npm pack`
 * would ship a manifest still pointing at `src/*.ts` and the check below would fail for a reason that
 * has nothing to do with the packages.
 *
 * `npm_execpath` is set by whichever package manager invoked this script, and under corepack that is
 * the only reliable handle: `pnpm` itself need not be on PATH.
 */
function pnpm(args, cwd) {
  const exec = process.env.npm_execpath;
  if (exec && /\.(c?js|mjs)$/.test(exec)) return run(process.execPath, [exec, ...args], cwd);
  return run("pnpm", args, cwd);
}

function packAll(outDir) {
  const tarballs = {};
  for (const pkg of PUBLISHABLE) {
    const dir = join(ROOT, "packages", pkg);
    pnpm(["pack", "--pack-destination", outDir], dir);
    const name = readdirSync(outDir).find((f) => f.includes(pkg) && f.endsWith(".tgz"));
    if (!name) throw new Error(`pnpm pack produced no tarball for ${pkg}`);
    tarballs[`@work-well/${pkg}`] = join(outDir, name);
    console.log(`  packed ${pkg} → ${name}`);
  }
  return tarballs;
}

/**
 * The packed manifest is the thing a registry serves, and it is NOT the file in the tree —
 * `publishConfig` is applied at pack time. Reading it back is the only way to know the rewrite
 * happened; a typo in `publishConfig` leaves `exports` pointing at `src/*.ts` and the failure shows up
 * as a confusing resolution error much later.
 */
function assertPackedManifest(tarball, pkg) {
  const listing = capture("tar", ["-tzf", tarball]).split("\n").map((l) => l.trim()).filter(Boolean);
  const manifestRaw = capture("tar", ["-xOzf", tarball, "package/package.json"]);
  const manifest = JSON.parse(manifestRaw);

  const entry = manifest.exports?.["."];
  if (entry?.default !== "./dist/index.js" || entry?.types !== "./dist/index.d.ts") {
    throw new Error(`${pkg}: packed exports still point at source: ${JSON.stringify(entry)}`);
  }
  if (manifest.private) throw new Error(`${pkg}: packed manifest is private:true — it would never publish`);
  if (!listing.includes("package/dist/index.js") || !listing.includes("package/dist/index.d.ts")) {
    throw new Error(`${pkg}: tarball is missing dist/index.{js,d.ts}`);
  }
  if (!listing.includes("package/LICENSE")) throw new Error(`${pkg}: tarball ships no LICENSE`);
  const tests = listing.filter((f) => f.includes(".test."));
  if (tests.length > 0) throw new Error(`${pkg}: tarball ships test files: ${tests.join(", ")}`);
  assertNoTsSpecifiers(tarball, listing, pkg);
  console.log(`  ${pkg}: packed manifest points at dist, ${listing.length} entries, no tests, no .ts specifiers in dist`);
  return manifest;
}

/**
 * No emitted file in the TARBALL may import a relative `.ts` path.
 *
 * `build-packages.mjs` asserts the same thing over `dist/`, and that assertion is the one with teeth
 * for the `.js` half — an unrewritten runtime import breaks every consumer. This repeats it at the
 * artifact boundary because the build assertion only runs if the build ran: `pnpm pack` invokes
 * `prepack`, but a stale `dist/` produced some other way would sail past it. Reading the tarball is
 * the only check that describes what a registry would actually serve.
 */
function assertNoTsSpecifiers(tarball, listing, pkg) {
  const pattern = /(\bfrom\s*|\bimport\s*\(\s*)(["'])\.\.?\/[^"']*\.ts\2/;
  const offenders = listing
    .filter((f) => f.startsWith("package/dist/") && (f.endsWith(".js") || f.endsWith(".d.ts")))
    .filter((f) => pattern.test(capture("tar", ["-xOzf", tarball, f])));
  if (offenders.length > 0) {
    throw new Error(`${pkg}: tarball ships ${offenders.length} file(s) importing a .ts path:\n  ${offenders.join("\n  ")}`);
  }
}

const CONSUMER_JS = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CqlExecutionEngine } from "@work-well/measure-engine";
import { generateCql, validateRule } from "@work-well/measure-codegen";

const MEASURES = {
  tetanus_booster: { id: "tetanus_booster", name: "Tetanus Booster Currency", library: "TetanusBooster-1.0.0", periodMonths: 120 },
};
const ELM_LIBRARIES = {
  "TetanusBooster-1.0.0": JSON.parse(readFileSync(new URL("./tetanus-booster.elm.json", import.meta.url), "utf8")),
  "FHIRHelpers-4.0.1": JSON.parse(readFileSync(new URL("./FHIRHelpers-4.0.1.elm.json", import.meta.url), "utf8")),
};

const bundle = (id, birthDate, lastBoosterOn) => ({
  resourceType: "Bundle",
  type: "collection",
  entry: [
    { resource: { resourceType: "Patient", id, birthDate } },
    ...(lastBoosterOn
      ? [{ resource: { resourceType: "Immunization", id: id + "-imm", status: "completed", patient: { reference: "Patient/" + id }, occurrenceDateTime: lastBoosterOn, vaccineCode: { coding: [{ system: "http://hl7.org/fhir/sid/cvx", code: "115" }] } } }]
      : []),
  ],
});

const engine = new CqlExecutionEngine({ measures: MEASURES, elmLibraries: ELM_LIBRARIES });

const compliant = await engine.evaluate({ measureId: "tetanus_booster", patientBundle: bundle("p1", "1980-01-01", "2024-03-01"), evaluationDate: "${EVAL_DATE}" });
assert.equal(compliant.outcome, "COMPLIANT", "expected COMPLIANT, got " + compliant.outcome);
assert.equal(compliant.measure, "Tetanus Booster Currency");

const overdue = await engine.evaluate({ measureId: "tetanus_booster", patientBundle: bundle("p2", "1980-01-01"), evaluationDate: "${EVAL_DATE}" });
assert.equal(overdue.outcome, "OVERDUE", "expected OVERDUE, got " + overdue.outcome);

// The engine must still hold no catalog of its own once packed.
await assert.rejects(
  () => engine.evaluate({ measureId: "audiogram", patientBundle: bundle("p3", "1980-01-01"), evaluationDate: "${EVAL_DATE}" }),
  /unknown measure 'audiogram'/,
);

// Codegen is a separate tarball with no dependency on the engine — exercised here to prove the split
// survives packaging, not merely the source tree.
const rule = { type: "windowed-recency", windowDays: 365, dueSoonDays: 30 };
const bindings = {
  enrollment: { code: "enrolled", valueSet: "urn:example:vs:enrolled" },
  waiver: { code: "waived", valueSet: "urn:example:vs:waived" },
  event: { type: "procedure", code: "exam", valueSet: "urn:example:vs:exam" },
};
validateRule(rule);
const emitted = generateCql({ library: "Demo", version: "1.0.0", rule, bindings });
assert.match(emitted, /^library Demo version '1\\.0\\.0'/, "codegen did not emit a CQL library header");
assert.match(emitted, /define "Outcome Status"/, "codegen emitted no Outcome Status define");

console.log("outside-the-repo consumer: COMPLIANT/OVERDUE/unknown-measure all as expected, codegen emitted CQL");
`;

const CONSUMER_TS = `
// Typechecked with moduleResolution "node16" — the resolution an ordinary consumer has, and the one
// under which a .d.ts pointing at a "./x.ts" path is an error.
import { CqlExecutionEngine, type MeasureMeta, type MeasureOutcome, type OutcomeStatus } from "@work-well/measure-engine";
import { generateCql, type CodegenBindings, type Rule } from "@work-well/measure-codegen";

const meta: MeasureMeta = { id: "tetanus_booster", name: "Tetanus Booster Currency", library: "TetanusBooster-1.0.0", periodMonths: 120 };
const rule: Rule = { type: "windowed-recency", windowDays: 365, dueSoonDays: 30 };
const bindings: CodegenBindings = {
  enrollment: { code: "enrolled", valueSet: "urn:example:vs:enrolled" },
  waiver: { code: "waived", valueSet: "urn:example:vs:waived" },
  event: { type: "procedure", code: "exam", valueSet: "urn:example:vs:exam" },
};

export async function check(bundle: unknown): Promise<OutcomeStatus> {
  const engine = new CqlExecutionEngine({ measures: { [meta.id]: meta }, elmLibraries: {} });
  const outcome: MeasureOutcome = await engine.evaluate({ measureId: meta.id, patientBundle: bundle, evaluationDate: "${EVAL_DATE}" });
  return outcome.outcome;
}

export const cql: string = generateCql({ library: "Demo", version: "1.0.0", rule, bindings });
`;

const CONSUMER_TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "node16",
    moduleResolution: "node16",
    lib: ["ES2023", "DOM"],
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: ["node"],
  },
  include: ["consume.ts"],
};

function main() {
  const work = mkdtempSync(join(tmpdir(), "workwell-publish-"));
  const tarballDir = join(work, "tarballs");
  const consumer = join(work, "consumer");
  mkdirSync(tarballDir);
  mkdirSync(consumer);
  console.log(`workspace-free consumer at ${consumer}`);

  try {
    console.log("\n1. pack");
    const tarballs = packAll(tarballDir);

    console.log("\n2. inspect the packed manifests");
    for (const pkg of PUBLISHABLE) assertPackedManifest(tarballs[`@work-well/${pkg}`], pkg);

    console.log("\n3. install the tarballs into a directory that knows nothing about this repo");
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify(
        {
          name: "workwell-outside-consumer",
          private: true,
          type: "module",
          dependencies: Object.fromEntries(Object.entries(tarballs).map(([n, t]) => [n, `file:${t}`])),
          devDependencies: { "@types/node": "^22.0.0", typescript: "^5.9.0" },
        },
        null,
        2,
      ),
    );
    run("npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error"], consumer);

    console.log("\n4. run it");
    const content = join(ROOT, "packages", "example-consumer", "src");
    for (const f of ["tetanus-booster.elm.json", "FHIRHelpers-4.0.1.elm.json"]) {
      cpSync(join(content, f), join(consumer, f));
    }
    writeFileSync(join(consumer, "consume.mjs"), CONSUMER_JS);
    run(process.execPath, [join(consumer, "consume.mjs")], consumer);

    console.log("\n5. typecheck a TypeScript consumer against the packed declarations");
    writeFileSync(join(consumer, "consume.ts"), CONSUMER_TS);
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify(CONSUMER_TSCONFIG, null, 2));
    run(process.execPath, [join(consumer, "node_modules", "typescript", "lib", "tsc.js"), "-p", "tsconfig.json"], consumer);

    console.log("\nOK — both tarballs install, run and typecheck outside the workspace.");
  } finally {
    if (process.env.WORKWELL_KEEP_PUBLISH_WORKDIR) console.log(`\nkept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

main();
