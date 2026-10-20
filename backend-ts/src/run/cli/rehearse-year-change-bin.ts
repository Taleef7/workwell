#!/usr/bin/env -S node --import tsx
/**
 * Runnable entry for the year-change rehearsal (#854). Two lines so the lib (rehearse-year-change.ts)
 * stays side-effect-free and importable by tests.
 *   pnpm rehearse:year-change --evaluation-date 2027-01-01 --confirm-host <DATABASE_URL's host> [--out <file.json>]
 */
import "../../engine/utc.ts"; // first: pins the process to UTC before anything reads a date (#845)
import { main } from "./rehearse-year-change.ts";

main(process.argv.slice(2)).then((code) => process.exit(code));
