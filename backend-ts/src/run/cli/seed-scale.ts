/**
 * CLI: seed the generated population-scale tenant (mhn ~120k) — one COMPLETED MEASURE run per runnable
 * measure with subject_id-encoded generated outcomes, so the rollup + programs KPIs aggregate 120k in
 * SQL (no live CQL evaluation). Owner-run ON DEMAND, NOT on deploy. Local (SQLite floor) or Neon
 * (export DATABASE_URL). Builds the store bundle from `env` via the SAME factory the worker uses.
 *
 *   pnpm seed:scale [--subjects 120000] [--as-of YYYY-MM-DD] [--mode fabricated|evaluate]
 *                   [--trim-evidence | --full-evidence] [--workers <n>]
 *
 * --mode defaults to `evaluate` (real batch CQL engine via the WebChart-realistic generator); `fabricated`
 * keeps the legacy index-fabricated path one more release. Evidence policy (#257, evaluate mode): trimming
 * is TIERED by actionability (OVERDUE/DUE_SOON/MISSING_DATA keep full evidence; COMPLIANT/EXCLUDED get
 * `{scale:true}`; a deterministic ~1% subject-index sample keeps full across all buckets) and AUTO-ENGAGES
 * above 20,000 subjects unless --full-evidence explicitly overrides — a forgotten flag on a big run no
 * longer floods Neon. --trim-evidence forces trim at any N; the two flags together are a usage error.
 *
 * ROLLBACK (reversible) — delete tagged OUTCOMES first, then runs (schema-qualify on Postgres):
 *   DELETE FROM workwell_spike.outcomes
 *     WHERE run_id IN (SELECT id FROM workwell_spike.runs WHERE triggered_by = 'seed:scale');
 *   DELETE FROM workwell_spike.runs WHERE triggered_by = 'seed:scale';
 *
 * This module is side-effect-free + importable by tests; `seed-scale-bin.ts` is the runnable entry.
 */
import { availableParallelism } from "node:os";
import { getStores, type StoresEnv } from "../../stores/factory.ts";
import { backfillScalePopulation } from "../backfill-scale.ts";
import { batchEvaluateScalePopulation } from "../batch-evaluate-scale.ts";
import { webChartRealisticGenerator } from "../scale-generator.ts";

export const USAGE =
  "Usage: pnpm seed:scale [--subjects <n>] [--as-of YYYY-MM-DD] [--mode fabricated|evaluate] [--trim-evidence | --full-evidence] [--workers <n>]";
const DEFAULT_SUBJECTS = 120_000;
/** Default worker count for `--mode evaluate` (#256); clamped by `availableParallelism()-1` at run time. */
const DEFAULT_WORKERS = 4;
/** Auto-trim engages STRICTLY ABOVE this subject count when neither --trim-evidence nor --full-evidence
 *  is passed (#257) — full evidence at 120k×14 is GB-scale on the cost-capped Neon. */
export const AUTO_TRIM_THRESHOLD = 20_000;

/** Bad invocation (unknown/invalid flags) — exit code 2. */
export class SeedCliUsageError extends Error {
  override readonly name = "SeedCliUsageError";
}

export interface SeedScaleArgs {
  subjects?: number;
  asOf?: string;
  /** Evaluation strategy. `evaluate` (default) runs the real batch CQL engine; `fabricated` keeps the
   *  legacy index-fabricated `backfillScalePopulation` (reachable one more release). */
  mode?: "fabricated" | "evaluate";
  /** Force the TIERED evidence trim at any N (#257; evaluate mode only) — see `resolveTrimEvidence`. */
  trimEvidence?: boolean;
  /** Explicitly keep FULL evidence on every row, overriding the >20k auto-trim (#257). */
  fullEvidence?: boolean;
  /**
   * Worker-pool size for `--mode evaluate` (#256). Default 4, clamped to `availableParallelism()-1` at
   * run time (leaving one core for the main-thread DB writes). `--workers 1` (or 0) forces the
   * single-threaded sequential path. Ignored by `--mode fabricated`.
   */
  workers?: number;
}

export function parseArgs(args: string[]): SeedScaleArgs {
  const out: SeedScaleArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--subjects") {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n < 1) throw new SeedCliUsageError(`--subjects must be a positive integer\n${USAGE}`);
      out.subjects = Math.trunc(n);
    } else if (a === "--as-of") {
      const d = args[++i];
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new SeedCliUsageError(`--as-of must be YYYY-MM-DD\n${USAGE}`);
      out.asOf = d;
    } else if (a === "--mode") {
      const m = args[++i];
      if (m !== "fabricated" && m !== "evaluate") throw new SeedCliUsageError(`--mode must be fabricated|evaluate\n${USAGE}`);
      out.mode = m;
    } else if (a === "--trim-evidence") {
      out.trimEvidence = true;
    } else if (a === "--full-evidence") {
      out.fullEvidence = true;
    } else if (a === "--workers") {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) throw new SeedCliUsageError(`--workers must be a non-negative integer\n${USAGE}`);
      out.workers = n;
    } else if (a === "--help" || a === "-h") {
      throw new SeedCliUsageError(USAGE);
    } else {
      throw new SeedCliUsageError(`unknown argument '${a}'\n${USAGE}`);
    }
  }
  if (out.trimEvidence && out.fullEvidence) {
    throw new SeedCliUsageError(`--trim-evidence and --full-evidence are mutually exclusive\n${USAGE}`);
  }
  return out;
}

/** How the evidence-trim decision resolved (#257). */
export interface TrimResolution {
  /** Whether the tiered trim is applied to this run. */
  trim: boolean;
  /** True when the trim engaged automatically via the >20k threshold (prints a notice). */
  auto: boolean;
}

/**
 * Resolve the evidence-trim policy for an evaluate run (#257) — pure + unit-tested:
 *   1. `--full-evidence` → NO trim (explicit override, any N);
 *   2. `--trim-evidence` → trim (explicit, any N);
 *   3. neither flag + `subjects > AUTO_TRIM_THRESHOLD` (strictly above 20,000) → AUTO trim + notice —
 *      the "forgotten flag on a big run" failure mode is closed;
 *   4. otherwise → full evidence (small runs keep everything).
 */
export function resolveTrimEvidence(opts: { subjects: number; trimEvidence?: boolean; fullEvidence?: boolean }): TrimResolution {
  if (opts.fullEvidence) return { trim: false, auto: false };
  if (opts.trimEvidence) return { trim: true, auto: false };
  if (opts.subjects > AUTO_TRIM_THRESHOLD) return { trim: true, auto: true };
  return { trim: false, auto: false };
}

/** Build the store env from `process.env` — the same selection the worker factory makes (DATABASE_URL
 *  → Postgres ceiling, no local SQLite; otherwise a local SQLite floor file). */
async function buildEnv(): Promise<StoresEnv> {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (databaseUrl) return { DATABASE_URL: databaseUrl };
  // @ts-expect-error — @mieweb/cloud-local ships .mjs without types
  const { createSqliteD1 } = await import("@mieweb/cloud-local");
  const dbPath = process.env.WORKWELL_SQLITE_PATH ?? "./.workwell-local.sqlite";
  const DB = await createSqliteD1(dbPath);
  return { DB };
}

/** Parse → build stores → seed (evaluate|fabricated) → print a summary line. Returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  let parsed: SeedScaleArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  try {
    const env = await buildEnv();
    const stores = await getStores(env);
    const asOf = parsed.asOf ?? new Date().toISOString().slice(0, 10);
    const mode = parsed.mode ?? "evaluate";
    const subjects = parsed.subjects ?? DEFAULT_SUBJECTS;
    // Resolve the worker pool size (#256): clamp the flag by availableParallelism()-1 (leave one core
    // for the main-thread DB writes). <= 1 → the single-threaded sequential path.
    const workerFlag = parsed.workers ?? DEFAULT_WORKERS;
    const workers = Math.max(1, Math.min(availableParallelism() - 1, workerFlag));
    if (mode === "evaluate" && workers > 1) {
      process.stdout.write(`[seed:scale] parallel evaluate — ${workers} worker(s) (flag ${workerFlag}, cores ${availableParallelism()}).\n`);
    }
    // Evidence policy (#257): tiered trim, auto-engaged above 20k subjects unless --full-evidence.
    const trimResolution = resolveTrimEvidence({ subjects, trimEvidence: parsed.trimEvidence, fullEvidence: parsed.fullEvidence });
    if (mode === "evaluate" && trimResolution.auto) {
      process.stdout.write(
        `[seed:scale] auto-trim engaged: --subjects ${subjects} > ${AUTO_TRIM_THRESHOLD} — tiered evidence ` +
          "(OVERDUE/DUE_SOON/MISSING_DATA + a ~1% audit sample keep full evidence; COMPLIANT/EXCLUDED get {scale:true}). " +
          "Pass --full-evidence to override.\n",
      );
    }
    const summary =
      mode === "fabricated"
        ? await backfillScalePopulation(
            { runStore: stores.runs, outcomeStore: stores.outcomes, auditStore: stores.events },
            { subjects, asOf },
          )
        : await batchEvaluateScalePopulation(
            {
              runStore: stores.runs,
              outcomeStore: stores.outcomes,
              auditStore: stores.events,
              generator: webChartRealisticGenerator(),
            },
            { subjects, asOf, trimEvidence: trimResolution.trim, workers },
          );
    const backend = (process.env.DATABASE_URL ?? "").trim() ? "postgres" : "sqlite";
    process.stdout.write(
      summary.skipped
        ? `[seed:scale] already seeded (${backend} ${mode}) — no-op. Rollback (delete tagged outcomes THEN runs) — see this CLI's header.\n`
        : `[seed:scale] ${backend} ${mode}: ${summary.runsCreated} runs × ${summary.subjects} subjects = ${summary.outcomesCreated} outcomes.\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
