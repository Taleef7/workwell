#!/usr/bin/env -S node --import tsx
/**
 * `WORKWELL_INSTANCE=maui pnpm flip-gate --measure cms137 [--evaluation-date 2026-06-30] [--subjects 2000|all] [--content-dir .official-content]`
 *
 * Prints the three readings a flip is judged on and writes `.flip-gate/<id>-<date>.json` for the PR
 * body. Exit code is ALWAYS 0: this is evidence, not a decision (see official-flip-gate.ts).
 *
 * The roster reading is the DEPLOYMENT's own roster — the profile named by `WORKWELL_INSTANCE`, its
 * directory (the 20,000-patient corpus on Maui, sized by `WORKWELL_MAUI_CORPUS_SIZE`) and its bundle
 * source, composed exactly as the run pipeline composes them, with the measure routed as the flip would
 * route it. `--subjects` caps how many are evaluated; the default keeps a corpus-sized roster inside one
 * batch's memory, and `all` lifts it for a deliberate full sweep.
 */
import { resolveDeploymentProfile } from "../../config/deployment-profile.ts";
import { gateMeasure, renderGate, writeGateJson, parseArgs, rosterSubjectsFor, FlipGateUsageError } from "./official-flip-gate.ts";

const DEFAULT_SUBJECT_CAP = 2000;

async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof FlipGateUsageError) {
      console.error(`flip-gate: ${error.message}`);
      console.error("usage: pnpm flip-gate --measure <id> [--evaluation-date YYYY-MM-DD] [--subjects N|all] [--content-dir <path>]");
      return 2;
    }
    throw error;
  }

  const env = process.env as Record<string, unknown>;
  const profile = resolveDeploymentProfile(typeof env.WORKWELL_INSTANCE === "string" ? env.WORKWELL_INSTANCE : undefined);
  const limit = args.subjects === "all" ? undefined : (args.subjects ?? DEFAULT_SUBJECT_CAP);
  if (typeof env.WORKWELL_OFFICIAL_MEASURES !== "string" || env.WORKWELL_OFFICIAL_MEASURES.trim() === "") {
    // The roster is composed under "the deployment's routing plus this measure". With nothing set the
    // report would say `routed as WORKWELL_OFFICIAL_MEASURES=<measure>` — a configuration no flip creates.
    console.warn(
      `flip-gate: WORKWELL_OFFICIAL_MEASURES is not set — the roster is composed as if ${args.measure} were the ` +
        "only routed measure. Pass the deployment's current list (see docs/DEPLOY.md) for a report that matches the flip.",
    );
  }
  let roster;
  try {
    roster = rosterSubjectsFor(args.measure, args.evaluationDate, env, profile, { limit });
  } catch (error) {
    if (error instanceof FlipGateUsageError) {
      console.error(`flip-gate: ${error.message}`);
      return 2;
    }
    throw error;
  }
  const { subjects, source } = roster;
  if (source.evaluated < source.directorySize) {
    console.log(
      `flip-gate: evaluating the first ${source.evaluated} of ${source.directorySize} ${profile.id} subjects` +
        ` (pass --subjects all for the whole directory)`,
    );
  }

  const report = await gateMeasure(args.measure, subjects, args.evaluationDate, { contentDir: args.contentDir, rosterSource: source });
  console.log(renderGate(report));
  const path = writeGateJson(process.cwd(), report);
  console.log(`flip-gate: wrote ${path}`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
