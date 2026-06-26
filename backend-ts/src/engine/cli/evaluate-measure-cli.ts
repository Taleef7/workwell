/**
 * Headless evaluator CLI (#72 / E2): "given this patient bundle and this measure,
 * are they compliant?" — no server, no DB. A thin shell over CqlExecutionEngine
 * (the parity-proven, JVM-free engine); all evaluation lives there. This file is
 * arg-parsing + I/O + delegation only, and has NO top-level side effects so tests
 * can import it freely (bin.ts is the runnable entry).
 *
 *   pnpm evaluate --patient ./bundle.json --measure audiogram [--date 2026-06-18] [--pretty]
 */
import { readFileSync } from "node:fs";
import { evaluateBundle } from "../ingress/evaluate-bundle.ts";
import type { MeasureOutcome } from "../evaluate-measure.ts";

export const USAGE =
  "Usage: pnpm evaluate --patient <bundle.json> --measure <id> [--date YYYY-MM-DD] [--pretty]";

/** Bad invocation (missing/unknown flags, unreadable bundle) — exit code 2. */
export class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

export interface CliArgs {
  patient: string;
  measure: string;
  date?: string;
  pretty: boolean;
}

export function parseArgs(args: string[]): CliArgs {
  const out: Partial<CliArgs> = { pretty: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--patient") out.patient = args[++i];
    else if (a === "--measure") out.measure = args[++i];
    else if (a === "--date") out.date = args[++i];
    else if (a === "--pretty") out.pretty = true;
    else throw new CliUsageError(`unknown argument '${a}'\n${USAGE}`);
  }
  if (!out.patient) throw new CliUsageError(`--patient <bundle.json> is required\n${USAGE}`);
  if (!out.measure) throw new CliUsageError(`--measure <id> is required\n${USAGE}`);
  if (out.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(out.date))
    throw new CliUsageError(`--date must be YYYY-MM-DD\n${USAGE}`);
  return out as CliArgs;
}

/** Read the bundle file + delegate to the engine. Throws CliUsageError on a bad bundle. */
export async function evaluate(parsed: CliArgs): Promise<MeasureOutcome> {
  let bundle: unknown;
  try {
    bundle = JSON.parse(readFileSync(parsed.patient, "utf8"));
  } catch (e) {
    throw new CliUsageError(`cannot read patient bundle '${parsed.patient}': ${e instanceof Error ? e.message : String(e)}`);
  }
  return evaluateBundle(bundle, parsed.measure, { evaluationDate: parsed.date });
}

/** Parse args and evaluate in one call — the same path as the CLI entry point. */
export async function run(args: string[]): Promise<MeasureOutcome> {
  return evaluate(parseArgs(args));
}

/**
 * Full CLI: parse → evaluate → print JSON to stdout. Returns the process exit code.
 * 2 = usage error, 1 = evaluation error (unknown measure / empty bundle), 0 = success.
 * Errors go to stderr; stdout carries only the JSON so `... | jq` is safe.
 */
export async function main(args: string[]): Promise<number> {
  let parsed: CliArgs;
  try {
    parsed = parseArgs(args);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  try {
    const outcome = await evaluate(parsed);
    process.stdout.write(`${JSON.stringify(outcome, null, parsed.pretty ? 2 : 0)}\n`);
    return 0;
  } catch (e) {
    const code = e instanceof CliUsageError ? 2 : 1;
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return code;
  }
}
