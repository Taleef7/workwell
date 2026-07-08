/**
 * CLI: seed the generated population-scale tenant (mhn ~120k) — one COMPLETED MEASURE run per runnable
 * measure with subject_id-encoded generated outcomes, so the rollup + programs KPIs aggregate 120k in
 * SQL (no live CQL evaluation). Owner-run ON DEMAND, NOT on deploy. Local (SQLite floor) or Neon
 * (export DATABASE_URL). Builds the store bundle from `env` via the SAME factory the worker uses.
 *
 *   pnpm seed:scale [--subjects 120000] [--as-of YYYY-MM-DD] [--mode fabricated|evaluate] [--trim-evidence]
 *
 * --mode defaults to `evaluate` (real batch CQL engine via the WebChart-realistic generator); `fabricated`
 * keeps the legacy index-fabricated path one more release. --trim-evidence (evaluate mode) persists minimal
 * `{scale:true}` evidence to protect Neon storage at 120k.
 *
 * ROLLBACK (reversible) — delete tagged OUTCOMES first, then runs (schema-qualify on Postgres):
 *   DELETE FROM workwell_spike.outcomes
 *     WHERE run_id IN (SELECT id FROM workwell_spike.runs WHERE triggered_by = 'seed:scale');
 *   DELETE FROM workwell_spike.runs WHERE triggered_by = 'seed:scale';
 *
 * This module is side-effect-free + importable by tests; `seed-scale-bin.ts` is the runnable entry.
 */
import { getStores, type StoresEnv } from "../../stores/factory.ts";
import { backfillScalePopulation } from "../backfill-scale.ts";
import { batchEvaluateScalePopulation } from "../batch-evaluate-scale.ts";
import { webChartRealisticGenerator } from "../scale-generator.ts";

export const USAGE =
  "Usage: pnpm seed:scale [--subjects <n>] [--as-of YYYY-MM-DD] [--mode fabricated|evaluate] [--trim-evidence]";
const DEFAULT_SUBJECTS = 120_000;

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
  /** Persist minimal `{scale:true}` evidence (evaluate mode only) — protects Neon storage at 120k. */
  trimEvidence?: boolean;
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
    } else if (a === "--help" || a === "-h") {
      throw new SeedCliUsageError(USAGE);
    } else {
      throw new SeedCliUsageError(`unknown argument '${a}'\n${USAGE}`);
    }
  }
  return out;
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
            { subjects, asOf, trimEvidence: parsed.trimEvidence },
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
