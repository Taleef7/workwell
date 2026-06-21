#!/usr/bin/env -S node --import tsx
/**
 * Runnable entry for the synthetic trend-history seeder (mirrors engine/cli/bin.ts). Kept to two
 * lines so the lib (seed-trend-history.ts) stays side-effect-free and importable by tests.
 *   pnpm seed:trend-history [--weeks 12] [--as-of YYYY-MM-DD]
 *
 * Rollback: delete the tagged OUTCOMES first, THEN the runs (the outcomes.run_id FK is not
 * ON DELETE CASCADE; schema-qualify on the Postgres ceiling) — see the full SQL in the header of
 * ./seed-trend-history.ts.
 */
import { main } from "./seed-trend-history.ts";

main(process.argv.slice(2)).then((code) => process.exit(code));
