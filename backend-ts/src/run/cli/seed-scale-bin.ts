#!/usr/bin/env -S node --import tsx
/**
 * Runnable entry for the population-scale seeder (mirrors seed-trend-history-bin.ts). Two lines so the
 * lib (seed-scale.ts) stays side-effect-free + importable by tests.
 *   pnpm seed:scale [--subjects 120000] [--as-of YYYY-MM-DD]
 *
 * Rollback: delete tagged OUTCOMES first, THEN runs (schema-qualify on the Postgres ceiling) — see the
 * full SQL in the header of ./seed-scale.ts.
 */
import { main } from "./seed-scale.ts";

main(process.argv.slice(2)).then((code) => process.exit(code));
