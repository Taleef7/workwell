#!/usr/bin/env -S node --import tsx
/**
 * Runnable entry for the quality-history seeder (mirrors seed-trend-history-bin.ts). Two lines so the
 * lib (seed-quality-history.ts) stays side-effect-free + importable by tests.
 *   pnpm seed:quality-history [--months 12] [--as-of YYYY-MM]
 *
 * Rollback (reversible cache): DELETE FROM quality_snapshots; (schema-qualify on the Pg ceiling).
 */
import { main } from "./seed-quality-history.ts";

main(process.argv.slice(2)).then((code) => process.exit(code));
