#!/usr/bin/env -S node --import tsx
/**
 * Runnable entry for the headless evaluator CLI (#72). Kept to two lines so the
 * lib (evaluate-measure-cli.ts) stays side-effect-free and importable by tests.
 *   pnpm evaluate --patient ./bundle.json --measure audiogram
 */
import { main } from "./evaluate-measure-cli.ts";

main(process.argv.slice(2)).then((code) => process.exit(code));
