/**
 * Split the backend test files into N balanced shards, so CI runs them as a matrix instead of one
 * 12-minute job.
 *
 * WHY NOT `node --test --test-shard=i/N`: it assigns files round-robin by their index in the sorted
 * glob, and this repo's expensive files sit at adjacent indices (the three webchart suites at 71/72/80,
 * the three run/route suites at 176/188/189). Measured against the real file list, `i % 3` put FOUR of
 * the six heaviest in one shard and none in another. Worse, the index of every file shifts when a test
 * file is added anywhere earlier in the sort, so the balance — and CI's wall-clock — would reshuffle on
 * unrelated PRs. This packs by measured weight instead, which is stable under insertion.
 *
 * THE FLOOR IS THE SLOWEST SINGLE FILE. `node --test` parallelises across files, never within one, so
 * no shard count takes the job below the longest file (`routes/runs.test.ts`, measured at 238 s alone).
 * Splitting that file is the next win if this stops being enough; adding shards past that point buys
 * nothing.
 *
 * Usage:
 *   node scripts/test-shards.mjs <shard> <total>   the files for that shard, one per line
 *   node scripts/test-shards.mjs --verify <total>  assert the split is exhaustive, disjoint and Pg-safe
 */
import { globSync } from "node:fs";
import { readFileSync } from "node:fs";

/** The globs `pnpm test` runs. Kept identical on purpose — see the --verify note below. */
export const TEST_GLOBS = [
  "src/**/*.test.ts",
  "packages/*/src/**/*.test.ts",
  "scripts/**/*.test.mjs",
  "scripts/**/*.test.ts",
];

/**
 * Seconds, measured one file at a time on an idle machine (2026-09-15) — NOT read off a CI log, where
 * every number is inflated by contention with the other files running beside it (`runs.test.ts` reads
 * as 279 s there and is 238 s alone).
 *
 * Only files worth more than a few seconds need an entry; everything else takes DEFAULT_WEIGHT, which
 * is deliberately ~1 file ≈ 1 unit. A stale entry costs balance, never correctness: the split stays
 * exhaustive whatever the weights say. Re-measure with:
 *   for f in <paths>; do /usr/bin/time -f "%e $f" node --import tsx --test "$f"; done
 */
const WEIGHTS = new Map([
  ["src/routes/runs.test.ts", 238],
  ["src/engine/ingress/webchart/mock-http-conformance.test.ts", 169],
  ["src/run/backfill-trend-history.test.ts", 102],
  ["src/engine/ingress/webchart/devdb-eval.test.ts", 100],
  ["src/engine/ingress/webchart/devdb-cli.test.ts", 61],
  ["src/routes/measures.test.ts", 40],
]);

const DEFAULT_WEIGHT = 2;

/**
 * Every Postgres-dependent file is pinned to shard 1. The store contract SELF-SKIPS when it cannot
 * reach a `postgres:16` service — it does not fail — so "the job was green" has never been evidence
 * that the ceiling ran. CI asserts it did, by grepping shard 1's output for `[postgres]`, and that
 * assertion needs a static home: this pin is what lets it sit on `if: matrix.shard == 1` without
 * going stale. `--verify` keeps the pin honest by failing if any Pg-dependent file drifts off it.
 * (Every shard is given the service regardless, so the drift degrades to a failing gate rather than
 * to a suite that quietly skips.)
 */
const PG_PIN_PREFIX = "src/stores/postgres/";
const PG_ENV_MARKER = "WORKWELL_TEST_PG_URL";
const PG_SHARD = 1;

/** The glob result, normalised to forward slashes and sorted, so the split never depends on the OS. */
export function allTestFiles() {
  const seen = new Set();
  for (const pattern of TEST_GLOBS) {
    for (const file of globSync(pattern)) seen.add(file.split("\\").join("/"));
  }
  return [...seen].sort();
}

const weightOf = (file) => WEIGHTS.get(file) ?? DEFAULT_WEIGHT;

/**
 * Longest-processing-time-first bin packing: heaviest file into the lightest shard, ties broken by
 * path and then by the lowest shard index, so the same file list always produces the same split on
 * every machine and every run.
 */
export function shardFiles(total) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`shard count must be a positive integer, got ${total}`);
  const shards = Array.from({ length: total }, () => ({ files: [], weight: 0 }));

  const files = allTestFiles();
  const pinned = files.filter((f) => f.startsWith(PG_PIN_PREFIX));
  const rest = files.filter((f) => !f.startsWith(PG_PIN_PREFIX));

  const pinTarget = shards[Math.min(PG_SHARD, total) - 1];
  for (const file of pinned) {
    pinTarget.files.push(file);
    pinTarget.weight += weightOf(file);
  }

  const ordered = rest.sort((a, b) => weightOf(b) - weightOf(a) || a.localeCompare(b));
  for (const file of ordered) {
    let lightest = shards[0];
    for (const shard of shards) if (shard.weight < lightest.weight) lightest = shard;
    lightest.files.push(file);
    lightest.weight += weightOf(file);
  }

  for (const shard of shards) shard.files.sort();
  return shards;
}

function verify(total) {
  const files = allTestFiles();
  const shards = shardFiles(total);
  const problems = [];

  // Exhaustive and disjoint. A file in no shard is the failure that matters: it would never run, and
  // nothing else in CI would notice its absence.
  const placed = shards.flatMap((s) => s.files);
  const missing = files.filter((f) => !placed.includes(f));
  const counts = new Map();
  for (const f of placed) counts.set(f, (counts.get(f) ?? 0) + 1);
  const duplicated = [...counts].filter(([, n]) => n > 1).map(([f]) => f);
  if (missing.length) problems.push(`${missing.length} file(s) in NO shard:\n  ${missing.join("\n  ")}`);
  if (duplicated.length) problems.push(`${duplicated.length} file(s) in MORE THAN ONE shard:\n  ${duplicated.join("\n  ")}`);

  // The Postgres pin. A Pg-dependent file that drifts off PG_SHARD leaves the CI assertion that the
  // ceiling actually ran looking at the wrong job, so the cover goes quiet without anything failing.
  const pgShardFiles = new Set(shards[Math.min(PG_SHARD, total) - 1].files);
  const strays = files.filter(
    (f) => !pgShardFiles.has(f) && readFileSync(f, "utf8").includes(PG_ENV_MARKER),
  );
  if (strays.length) {
    problems.push(
      `${strays.length} file(s) read ${PG_ENV_MARKER} but are not on shard ${PG_SHARD}, which is where the "the Postgres ceiling ran" CI assertion looks — it would stop covering them:\n  ${strays.join("\n  ")}\n` +
        `  Fix: move them under ${PG_PIN_PREFIX}, or widen PG_PIN_PREFIX in this file and give their shard the service.`,
    );
  }

  // Stale weight entries are harmless to correctness but quietly unbalance the split, so say so.
  const stale = [...WEIGHTS.keys()].filter((f) => !files.includes(f));
  if (stale.length) problems.push(`WEIGHTS names ${stale.length} file(s) that no longer exist:\n  ${stale.join("\n  ")}`);

  const summary = shards
    .map((s, i) => `  shard ${i + 1}/${total}: ${String(s.files.length).padStart(3)} files, weight ${s.weight}`)
    .join("\n");
  console.log(`${files.length} test files across ${total} shard(s):\n${summary}`);

  if (problems.length) {
    console.error(`\ntest-shards verification FAILED:\n\n${problems.join("\n\n")}`);
    process.exit(1);
  }
  console.log("\nsplit is exhaustive, disjoint, and every Postgres-dependent file is on the serviced shard.");
}

const [a, b] = process.argv.slice(2);
if (a === "--verify") {
  verify(Number(b ?? 3));
} else {
  const shard = Number(a);
  const total = Number(b);
  const shards = shardFiles(total);
  if (!Number.isInteger(shard) || shard < 1 || shard > total) {
    console.error(`usage: node scripts/test-shards.mjs <shard 1..${total}> <total>  |  --verify <total>`);
    process.exit(1);
  }
  console.log(shards[shard - 1].files.join("\n"));
}
