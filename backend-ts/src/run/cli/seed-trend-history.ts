/**
 * CLI: seed synthetic TREND HISTORY (backdated weekly COMPLETED runs per runnable measure) so the
 * /programs trend charts show a believable, varied compliance line. A thin shell over
 * `backfillTrendHistory` — controlled + on-demand, NOT wired into request-path startup (avoids slow
 * or accidental backfills). Run locally (SQLite floor) or against Neon by exporting `DATABASE_URL`.
 *
 *   pnpm seed:trend-history [--weeks 12] [--as-of YYYY-MM-DD]
 *
 * It builds the store bundle from `env` via the SAME factory the worker uses (so `DATABASE_URL`
 * selects the Postgres ceiling; otherwise the SQLite floor over a local file). It is idempotent —
 * a second run is a no-op.
 *
 * ROLLBACK (reversible) — delete tagged OUTCOMES first, then the runs. The `outcomes.run_id` FK is
 * NOT ON DELETE CASCADE, and the Pg ceiling lives in the `workwell_spike` schema, so schema-qualify
 * there (cases are never written by the backfill):
 *
 *   -- Postgres ceiling (workwell_spike schema):
 *   DELETE FROM workwell_spike.outcomes
 *     WHERE run_id IN (SELECT id FROM workwell_spike.runs WHERE triggered_by = 'seed:trend-history');
 *   DELETE FROM workwell_spike.runs WHERE triggered_by = 'seed:trend-history';
 *
 * This module is side-effect-free + importable by tests; `bin.ts` is the runnable entry.
 */
import { getStores, type StoresEnv } from "../../stores/factory.ts";
import { CqlExecutionEngine } from "../../engine/cql/cql-execution-engine.ts";
import { backfillTrendHistory } from "../backfill-trend-history.ts";

export const USAGE = "Usage: pnpm seed:trend-history [--weeks <n>] [--as-of YYYY-MM-DD]";

/** Bad invocation (unknown/invalid flags) — exit code 2. */
export class SeedCliUsageError extends Error {
  override readonly name = "SeedCliUsageError";
}

export interface SeedCliArgs {
  weeks?: number;
  asOf?: string;
}

export function parseArgs(args: string[]): SeedCliArgs {
  const out: SeedCliArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--weeks") {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n < 1) throw new SeedCliUsageError(`--weeks must be a positive integer\n${USAGE}`);
      out.weeks = Math.trunc(n);
    } else if (a === "--as-of") {
      const d = args[++i];
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new SeedCliUsageError(`--as-of must be YYYY-MM-DD\n${USAGE}`);
      out.asOf = d;
    } else if (a === "--help" || a === "-h") {
      throw new SeedCliUsageError(USAGE);
    } else {
      throw new SeedCliUsageError(`unknown argument '${a}'\n${USAGE}`);
    }
  }
  return out;
}

/**
 * Build the store env from `process.env`: a local SQLite file binding for the floor, plus an
 * optional `DATABASE_URL` for the Postgres ceiling — the same selection the worker factory makes.
 */
async function buildEnv(): Promise<StoresEnv> {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  // @ts-expect-error — @mieweb/cloud-local ships .mjs without types
  const { createSqliteD1 } = await import("@mieweb/cloud-local");
  const dbPath = process.env.WORKWELL_SQLITE_PATH ?? "./.workwell-local.sqlite";
  const DB = await createSqliteD1(dbPath);
  return { DB, DATABASE_URL: databaseUrl || undefined };
}

/** Parse → build stores → backfill → print a summary line. Returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  let parsed: SeedCliArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  try {
    const env = await buildEnv();
    const stores = await getStores(env);
    const summary = await backfillTrendHistory(
      { runStore: stores.runs, outcomeStore: stores.outcomes, engine: new CqlExecutionEngine() },
      parsed,
    );
    const backend = (process.env.DATABASE_URL ?? "").trim() ? "postgres" : "sqlite";
    if (summary.skipped) {
      process.stdout.write(
        `[seed:trend-history] already seeded (${backend}) — no-op. ` +
          `Rollback (delete tagged outcomes THEN runs; schema-qualify on Postgres) — see this CLI's header for the exact SQL.\n`,
      );
    } else {
      process.stdout.write(
        `[seed:trend-history] ${backend}: created ${summary.runsCreated} backdated runs ` +
          `(${summary.measures} measures × ${summary.weeks} weeks) with ${summary.outcomesCreated} outcomes.\n`,
      );
    }
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
