/**
 * CLI: seed real evaluated QUALITY-OVER-TIME HISTORY — materialized `quality_snapshots` for a range of
 * past calendar months (num/denom + the 5 bucket counts per measure × month × scope). Supersedes the
 * synthetic sine-wave `seed:trend-history` for the /programs trend: these rows are actually evaluated,
 * not faked. A thin shell over `backfillQualityHistory` — controlled + on-demand, NOT wired into
 * request-path startup. Run locally (SQLite floor) or against Neon by exporting `DATABASE_URL`.
 *
 *   pnpm seed:quality-history [--months 12] [--as-of YYYY-MM]
 *
 * Idempotent + resumable at the month level (a rerun skips months that already have snapshots).
 *
 * ROLLBACK (reversible) — the whole table is a rebuildable cache; schema-qualify on the Pg ceiling:
 *
 *   DELETE FROM workwell_spike.quality_snapshots;   -- Postgres ceiling (workwell_spike schema)
 *
 * This module is side-effect-free + importable by tests; `seed-quality-history-bin.ts` is the entry.
 */
import { getStores, type StoresEnv } from "../../stores/factory.ts";
import { CqlExecutionEngine } from "../../engine/cql/cql-execution-engine.ts";
import { backfillQualityHistory } from "../backfill-quality-history.ts";

export const USAGE = "Usage: pnpm seed:quality-history [--months <n>] [--as-of YYYY-MM]";

/** Bad invocation (unknown/invalid flags) — exit code 2. */
export class SeedCliUsageError extends Error {
  override readonly name = "SeedCliUsageError";
}

export interface SeedCliArgs {
  months?: number;
  asOf?: string;
}

export function parseArgs(args: string[]): SeedCliArgs {
  const out: SeedCliArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--months") {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n < 1) throw new SeedCliUsageError(`--months must be a positive integer\n${USAGE}`);
      out.months = Math.trunc(n);
    } else if (a === "--as-of") {
      const d = args[++i];
      if (!d || !/^\d{4}-\d{2}$/.test(d)) throw new SeedCliUsageError(`--as-of must be YYYY-MM\n${USAGE}`);
      out.asOf = d;
    } else if (a === "--help" || a === "-h") {
      throw new SeedCliUsageError(USAGE);
    } else {
      throw new SeedCliUsageError(`unknown argument '${a}'\n${USAGE}`);
    }
  }
  return out;
}

/** Build the store env from `process.env` — same selection the worker factory makes (see seed-trend-history). */
async function buildEnv(): Promise<StoresEnv> {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (databaseUrl) return { DATABASE_URL: databaseUrl }; // Postgres ceiling — no SQLite binding needed
  // @ts-expect-error — @mieweb/cloud-local ships .mjs without types
  const { createSqliteD1 } = await import("@mieweb/cloud-local");
  const dbPath = process.env.WORKWELL_SQLITE_PATH ?? "./.workwell-local.sqlite";
  const DB = await createSqliteD1(dbPath);
  return { DB };
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
    const summary = await backfillQualityHistory(
      {
        runStore: stores.runs,
        outcomeStore: stores.outcomes,
        qualitySnapshots: stores.qualitySnapshots,
        auditStore: stores.events,
        engine: new CqlExecutionEngine(),
      },
      parsed,
    );
    const backend = (process.env.DATABASE_URL ?? "").trim() ? "postgres" : "sqlite";
    process.stdout.write(
      `[seed:quality-history] ${backend}: wrote ${summary.monthsWritten} month(s) ` +
        `(${summary.rowsWritten} snapshot rows), skipped ${summary.monthsSkipped} already-materialized. ` +
        `Rollback: DELETE FROM quality_snapshots; (schema-qualify on Postgres).\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
