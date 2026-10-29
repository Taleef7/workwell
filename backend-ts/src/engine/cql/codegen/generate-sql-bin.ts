#!/usr/bin/env -S node --import tsx
/**
 * Runnable entry for the CQL→SQL codegen (mirrors seed-scale-bin.ts). Two lines so the lib
 * (generate-sql-cli.ts) stays side-effect-free + importable by the freshness test.
 *   pnpm generate:sql
 */
import "../../utc.ts"; // first: pins the process to UTC before anything reads a date (#845)
import { main } from "./generate-sql-cli.ts";

process.exit(main());
