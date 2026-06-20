#!/usr/bin/env -S node --import tsx
/**
 * Runnable entry for the synthetic trend-history seeder (mirrors engine/cli/bin.ts). Kept to two
 * lines so the lib (seed-trend-history.ts) stays side-effect-free and importable by tests.
 *   pnpm seed:trend-history [--weeks 12] [--as-of YYYY-MM-DD]
 *
 * Rollback (one statement): DELETE FROM runs WHERE triggered_by='seed:trend-history';
 */
import { main } from "./seed-trend-history.ts";

main(process.argv.slice(2)).then((code) => process.exit(code));
