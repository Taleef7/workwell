/**
 * Builds the publishable `@workwell/*` packages to `dist/` (roadmap M-C / C4).
 *
 *   node scripts/build-packages.mjs [--package <name>]
 *
 * ## Why a build step exists at all
 *
 * The workspace resolves these packages straight from `src/*.ts` under `moduleResolution: Bundler`
 * with `allowImportingTsExtensions`. No registry consumer has either, so a tarball has to contain
 * JavaScript and declaration files. `rewriteRelativeImportExtensions` does the load-bearing part: it
 * lets the sources keep their `./x.ts` specifiers while the emitted **JS** carries `./x.js`. Without
 * it the published JS would `import "./x.ts"` and fail at runtime for every consumer.
 *
 * ## What the post-pass does, and what it does NOT rescue
 *
 * That flag does not perform the same rewrite in the emitted `.d.ts`, so declarations still say
 * `from "./evaluate-measure.ts"`. **Measured: TypeScript consumers are unaffected** — `tsc` substitutes
 * `.ts` → `.d.ts` when resolving, finds `evaluate-measure.d.ts` sitting beside it, and typechecks
 * clean. Verified by disabling this rewrite and watching `scripts/verify-publish.mjs` step 5 still
 * pass. So this is not a fix for a consumer-breaking bug, and it is not described as one.
 *
 * It is kept because the specifiers are false on their face — no `.ts` file ships in `dist/` — and
 * that only works by a TypeScript-specific resolution rule. Anything reading declarations without
 * that rule (API extractors, doc generators, non-tsc type resolvers, declaration-map consumers) sees
 * a dangling path. Emitting the truth is cheaper than depending on the substitution.
 *
 * The ASSERTION afterwards is the part with teeth, and it covers `.js` as well: if
 * `rewriteRelativeImportExtensions` were ever dropped from a build config, the published JavaScript
 * would import a `.ts` path and break at runtime — a failure `pnpm typecheck` cannot see, because it
 * never reads `dist/`.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The packages that go to a registry. `official-executor` is deliberately absent — it is the
 * ADR-026 `fqm-execution` quarantine and its whole purpose is to be an internal boundary; publishing
 * it would advertise a dependency the engine exists to keep out. `example-consumer` is a test.
 */
export const PUBLISHABLE = ["measure-engine", "measure-codegen"];

/** Matches a relative specifier with a `.ts` extension in an import/export/dynamic-import position. */
export const TS_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.\.?\/[^"']*)\.ts\2/g;

/** Rewrites relative `./x.ts` specifiers to `./x.js`. Bare specifiers are left alone. */
export function rewriteDeclarationSpecifiers(source) {
  return source.replace(TS_SPECIFIER, "$1$2$3.js$2");
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function buildOne(pkg) {
  const dir = join(ROOT, "packages", pkg);
  rmSync(join(dir, "dist"), { recursive: true, force: true });

  execFileSync(process.execPath, [join(ROOT, "node_modules", "typescript", "lib", "tsc.js"), "-p", join(dir, "tsconfig.build.json")], {
    stdio: "inherit",
  });

  const files = walk(join(dir, "dist"));
  let rewritten = 0;
  for (const file of files.filter((f) => f.endsWith(".d.ts"))) {
    const before = readFileSync(file, "utf8");
    const after = rewriteDeclarationSpecifiers(before);
    if (after !== before) {
      writeFileSync(file, after);
      rewritten += 1;
    }
  }

  const offenders = files
    .filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"))
    .filter((f) => new RegExp(TS_SPECIFIER.source).test(readFileSync(f, "utf8")));
  if (offenders.length > 0) {
    throw new Error(`${pkg}: ${offenders.length} emitted file(s) still import a .ts path:\n  ${offenders.join("\n  ")}`);
  }

  console.log(`  ${pkg}: ${files.filter((f) => f.endsWith(".js")).length} js, ${files.filter((f) => f.endsWith(".d.ts")).length} d.ts (${rewritten} rewritten)`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const only = process.argv.indexOf("--package");
  const targets = only === -1 ? PUBLISHABLE : [process.argv[only + 1]];
  for (const t of targets) {
    if (!PUBLISHABLE.includes(t)) throw new Error(`not a publishable package: ${t} (have ${PUBLISHABLE.join(", ")})`);
    buildOne(t);
  }
}
