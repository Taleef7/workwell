/**
 * `pnpm cql-tests` — run the CQL language conformance corpus through our translator + engine (V7, #296).
 *
 *   pnpm cql-tests                          full run, writes JSON + summary
 *   pnpm cql-tests --file Interval          one test file (substring match)
 *   pnpm cql-tests --group Abs --test Abs0  one group / one case, for iterating on a failure
 *   pnpm cql-tests --check                  also compare against the committed baseline; non-zero on regression
 *   pnpm cql-tests --write-baseline         regenerate the baseline (do this in the PR that moves it)
 *
 * NOT part of `pnpm test`: it needs ~34 MB of upstream content fetched at a pinned commit, and a developer
 * with no network must still get a green local suite. Same reasoning the `official-cases` CI job records.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus, runCorpus, type RunFilter } from "./run.ts";
import {
  assertNonDegenerate,
  DegenerateRunError,
  improvements,
  notPassing,
  perFile,
  regressions,
  runnerJson,
  summary,
  tally,
  type Baseline,
} from "./report.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, "..", "..");
const CONTENT = path.join(BACKEND, ".cql-tests");
const OUT_DIR = path.join(BACKEND, ".cql-tests-results");
const BASELINE = path.join(BACKEND, "scripts", "cql-tests", "baseline.json");

/** Recorded in the report so a result is attributable to the exact toolchain that produced it. */
function toolchain(): { translator: string; engine: string } {
  const pkg = (p: string) => JSON.parse(readFileSync(p, "utf8")) as { dependencies?: Record<string, string> };
  const root = pkg(path.join(BACKEND, "package.json"));
  const engine = pkg(path.join(BACKEND, "packages", "measure-engine", "package.json"));
  return {
    translator: `@cqframework/cql@${root.dependencies?.["@cqframework/cql"] ?? "unknown"}`,
    engine: `cql-execution@${engine.dependencies?.["cql-execution"] ?? "unknown"}`,
  };
}

function parseArgs(argv: string[]): { filter: RunFilter; check: boolean; writeBaseline: boolean } {
  const filter: RunFilter = {};
  let check = false;
  let writeBaseline = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") check = true;
    else if (a === "--write-baseline") writeBaseline = true;
    else if (a === "--file") filter.file = argv[++i];
    else if (a === "--group") filter.group = argv[++i];
    else if (a === "--test") filter.test = argv[++i];
    else throw new Error(`unknown argument '${a}'`);
  }
  return { filter, check, writeBaseline };
}

async function main(argv: string[]): Promise<number> {
  const { filter, check, writeBaseline } = parseArgs(argv);
  const filtered = Boolean(filter.file || filter.group || filter.test);

  if (!existsSync(CONTENT)) {
    console.error(
      `cql-tests content not found at ${CONTENT}\n` +
        `Fetch it first:  pwsh -NoProfile -File scripts/fetch-cql-tests.ps1`,
    );
    return 2;
  }

  const corpus = loadCorpus(CONTENT);
  const pin = existsSync(path.join(CONTENT, ".pin"))
    ? readFileSync(path.join(CONTENT, ".pin"), "utf8").trim()
    : "unknown";

  const started = Date.now();
  let lastLogged = 0;
  const results = await runCorpus(corpus, filter, (done, total) => {
    if (done === total || done - lastLogged >= 250) {
      lastLogged = done;
      process.stderr.write(`  ${done}/${total}\r`);
    }
  });
  process.stderr.write("\n");

  try {
    assertNonDegenerate(results, corpus.files, { filtered });
  } catch (err) {
    if (err instanceof DegenerateRunError) {
      // Refuse to print a figure the run did not earn.
      console.error(`REFUSING TO REPORT — ${err.message}`);
      return 3;
    }
    throw err;
  }

  console.log(summary(results, corpus.files));
  console.log(`\n  ran in ${((Date.now() - started) / 1000).toFixed(1)}s at pin ${pin}`);

  mkdirSync(OUT_DIR, { recursive: true });
  const json = runnerJson(results, { pinned: pin, ...toolchain() });
  writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(json, null, 2));
  console.log(`  wrote ${path.relative(BACKEND, path.join(OUT_DIR, "results.json"))}`);

  if (writeBaseline) {
    if (filtered) {
      console.error("refusing to write a baseline from a FILTERED run — it would encode a subset");
      return 2;
    }
    const baseline: Baseline = {
      pinned: pin,
      total: results.length,
      counts: tally(results),
      perFile: perFile(results),
      notPassing: notPassing(results),
    };
    writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`  wrote ${path.relative(BACKEND, BASELINE)}`);
    return 0;
  }

  if (check) {
    if (filtered) {
      console.error("--check needs a full run; drop the filters");
      return 2;
    }
    if (!existsSync(BASELINE)) {
      console.error(`no baseline at ${BASELINE} — run with --write-baseline first`);
      return 2;
    }
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
    if (!baseline.notPassing) {
      // A pre-#398 baseline carries per-file tallies only, which cannot see a within-file swap. Refusing
      // is the point: silently falling back to the weaker comparison is how a gate stops meaning what its
      // name says.
      console.error(`baseline at ${BASELINE} predates per-case keying — regenerate it (--write-baseline)`);
      return 2;
    }
    const regs = regressions(results, baseline);
    const wins = improvements(results, baseline);
    if (regs.length > 0) {
      const shown = regs.slice(0, 40);
      console.error(`\nREGRESSIONS vs baseline (${baseline.pinned}) — ${regs.length}:\n  ${shown.join("\n  ")}`);
      if (regs.length > shown.length) console.error(`  … and ${regs.length - shown.length} more`);
      return 1;
    }
    if (wins.length > 0) {
      console.log(
        `\n  IMPROVED — ${wins.length} case(s) now pass:\n    ${wins.slice(0, 20).join("\n    ")}\n` +
          `  Not a failure, but regenerate the baseline (--write-baseline) in this PR so the gate holds ` +
          `the new floor.`,
      );
    } else {
      console.log(`\n  no regressions vs baseline (${baseline.pinned}) — ${Object.keys(baseline.notPassing).length} known non-passing cases unchanged`);
    }
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(String(err?.stack ?? err));
    process.exitCode = 2;
  });
