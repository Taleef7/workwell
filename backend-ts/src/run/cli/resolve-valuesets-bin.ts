#!/usr/bin/env -S node --import tsx
/**
 * Runnable entry for the VSAC value-set importer (mirrors seed-scale-bin.ts). The lib
 * (resolve-valuesets.ts) stays side-effect-free + importable by tests.
 *   pnpm resolve-valuesets [--oid <oid> ...] [--measure cms122]
 * Requires WORKWELL_VSAC_API_KEY (+ optional WORKWELL_VSAC_BASE_URL); honors DATABASE_URL for Neon.
 * Rollback: DELETE FROM workwell_spike.value_sets WHERE source = 'VSAC'; (schema-qualify on Postgres).
 */
import { main } from "./resolve-valuesets.ts";

main(process.argv.slice(2)).then((code) => process.exit(code));
