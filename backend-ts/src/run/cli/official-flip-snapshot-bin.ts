#!/usr/bin/env -S node --import tsx
/**
 * Entrypoint for the pre-flip before/after snapshot (DEPLOY.md §"Flipping a measure to official
 * execution", steps 2 and 4).
 *
 *   pnpm flip-snapshot --measure cms125 [--measure cms122] [--eval 2024-06-01] [--source webchart|synthetic]
 *
 * `--source webchart` reads the committed dev-DB fixture through the real ingress path; `synthetic`
 * (the default) uses the roster a seamless stack evaluates. Choose the one matching the stack you are
 * about to flip — a stack with no `WORKWELL_WEBCHART_*` never sees WebChart data.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { snapshotMeasure, renderSnapshot, type SnapshotSubject, type MeasureSnapshot } from "./official-flip-snapshot.ts";
import { webChartDataSource } from "../../engine/ingress/data-source.ts";
import { fixtureWebChartClient } from "../../engine/ingress/webchart/webchart-client.ts";
import { parseEnrollmentRoster, stampEnrollment } from "../../engine/ingress/enrollment/roster.ts";
import { directSyntheticGenerator } from "../scale-generator.ts";
import type { TargetOutcome } from "../../engine/synthetic/exam-config.ts";

/** The five corpus targets — the same spread `official-corpus-outcomes.test.ts` scores. */
const TARGETS: TargetOutcome[] = ["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"];

function parseArgs(argv: readonly string[]): { measures: string[]; evaluationDate: string; source: string } {
  const measures: string[] = [];
  let evaluationDate = "2024-06-01";
  let source = "synthetic";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--measure") measures.push(argv[++i] ?? "");
    else if (arg === "--eval") evaluationDate = argv[++i] ?? evaluationDate;
    else if (arg === "--source") source = argv[++i] ?? source;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (measures.length === 0) throw new Error("at least one --measure is required");
  if (source !== "synthetic" && source !== "webchart") throw new Error(`--source must be synthetic|webchart`);
  return { measures, evaluationDate, source };
}

async function webChartSubjects(measureId: string, evaluationDate: string): Promise<SnapshotSubject[]> {
  const dir = fileURLToPath(new URL("../../../spike/webchart/", import.meta.url));
  const payloads = JSON.parse(readFileSync(path.join(dir, "devdb-patients.json"), "utf8")) as unknown[];
  const roster = parseEnrollmentRoster(JSON.parse(readFileSync(path.join(dir, "enrollment-roster.json"), "utf8")));
  // The run path's ingress code, reproduced exactly — normalization then roster stamping — with the
  // fixture transport standing in for HTTP. Same construction as `devdb-official-eval.test.ts`.
  const source = webChartDataSource({ baseUrl: "x", apiKey: "k" }, fixtureWebChartClient(payloads));
  const bundles = await source.loadBundles();
  return bundles.map((bundle) => {
    const stamped = stampEnrollment(bundle as never, measureId, roster, { evaluationDate });
    const id = ((stamped as { entry: Array<{ resource: { resourceType: string; id?: string } }> }).entry.find(
      (e) => e.resource.resourceType === "Patient",
    )?.resource.id ?? "unknown") as string;
    return { subjectId: id, bundle: stamped };
  });
}

function syntheticSubjects(measureId: string, evaluationDate: string): SnapshotSubject[] {
  const generator = directSyntheticGenerator();
  return TARGETS.map((target) => {
    const subjectId = `snap-${measureId}-${target.toLowerCase()}`;
    return { subjectId, bundle: generator.bundleFor(subjectId, measureId, target, evaluationDate) };
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const { measures, evaluationDate, source } = parseArgs(argv);
  const snapshots: MeasureSnapshot[] = [];
  for (const measureId of measures) {
    const subjects =
      source === "webchart"
        ? await webChartSubjects(measureId, evaluationDate)
        : syntheticSubjects(measureId, evaluationDate);
    snapshots.push(await snapshotMeasure(measureId, subjects, evaluationDate));
  }
  console.log(renderSnapshot(snapshots));
  // Exit 0 even on a DO-NOT-FLIP verdict: this is a report an operator reads, not a gate. Failing here
  // would invite wiring it into CI as a pass/fail, which is precisely the automated judgement ADR-043
  // established cannot be made from shape alone.
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("official-flip-snapshot-bin.ts")) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
