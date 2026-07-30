#!/usr/bin/env -S node --import tsx
/**
 * Entrypoint for the pre-flip before/after snapshot (DEPLOY.md §"Flipping a measure to official
 * execution", steps 2 and 4).
 *
 *   pnpm flip-snapshot --measure cms125 [--measure cms122] [--eval 2024-06-01] [--source live|synthetic|fixture]
 *
 * | `--source` | reads | use it to |
 * |---|---|---|
 * | `live` | the tenant configured by `WORKWELL_WEBCHART_*`, over the real ingress path | judge a flip on a WebChart-configured stack — **this is the tenant-facing gate** |
 * | `synthetic` (default) | the corpus roster a seamless stack evaluates | judge a flip on demo/production, which carries no WebChart seam |
 * | `fixture` | the committed 56-patient dev-DB sample | reproduce the recorded baseline offline; **frozen data, tells you nothing about a tenant** |
 *
 * The first version of this flag called the FIXTURE path `webchart`, which was actively misleading:
 * DEPLOY.md sends an operator here to "confirm a non-zero initial population against the tenant's own
 * data", and a tenant whose live mapping omits `us-core-sex` would have received a healthy verdict
 * computed from our committed sample (Codex, #355). A gate that cannot see the thing it gates is the
 * failure this whole tool exists to stop, so the live path is now real and the frozen one is named
 * `fixture` so nobody can reach for it by accident.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { snapshotMeasure, renderSnapshot, type SnapshotSubject, type MeasureSnapshot } from "./official-flip-snapshot.ts";
import { webChartDataSource, webChartConfigFromEnv } from "../../engine/ingress/data-source.ts";
import { fixtureWebChartClient, httpWebChartClient } from "../../engine/ingress/webchart/webchart-client.ts";
import { parseEnrollmentRoster, stampEnrollment, type EnrollmentRoster } from "../../engine/ingress/enrollment/roster.ts";
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
  if (!["synthetic", "live", "fixture"].includes(source)) {
    throw new Error(`--source must be live|synthetic|fixture (got '${source}')`);
  }
  return { measures, evaluationDate, source };
}

/** Shared tail of both WebChart-shaped paths: roster-stamp each bundle and key it by `Patient.id`. */
function stampAll(bundles: readonly unknown[], measureId: string, roster: EnrollmentRoster, evaluationDate: string) {
  return bundles.map((bundle) => {
    const stamped = stampEnrollment(bundle as never, measureId, roster, { evaluationDate });
    const id = ((stamped as { entry: Array<{ resource: { resourceType: string; id?: string } }> }).entry.find(
      (e) => e.resource.resourceType === "Patient",
    )?.resource.id ?? "unknown") as string;
    return { subjectId: id, bundle: stamped };
  });
}

/**
 * The CONFIGURED tenant — the only source that can answer the question DEPLOY.md step 2 asks.
 *
 * Refuses loudly when the seam is unset rather than quietly falling back to the fixture: a silent
 * fallback is precisely how this command would hand an operator a healthy verdict computed from our
 * committed sample while their tenant's roster falls out of the official IPP.
 */
async function liveSubjects(measureId: string, evaluationDate: string): Promise<SnapshotSubject[]> {
  const cfg = webChartConfigFromEnv(process.env as Record<string, string | undefined>);
  if (!cfg) {
    throw new Error(
      "--source live needs the WebChart seam configured (WORKWELL_WEBCHART_BASE_URL + an auth mode). " +
        "Set it to the tenant you are about to flip, or use --source fixture for the committed sample " +
        "(frozen data — it says nothing about a tenant) or --source synthetic for a seamless stack.",
    );
  }
  const roster = readRoster();
  const bundles = await webChartDataSource(cfg, httpWebChartClient(cfg)).loadBundles();
  return stampAll(bundles, measureId, roster, evaluationDate);
}

const SPIKE_DIR = fileURLToPath(new URL("../../../spike/webchart/", import.meta.url));
const readRoster = (): EnrollmentRoster =>
  parseEnrollmentRoster(JSON.parse(readFileSync(path.join(SPIKE_DIR, "enrollment-roster.json"), "utf8")));

/** The committed 56-patient dev-DB sample, through the real ingress path with a fixture transport. */
async function fixtureSubjects(measureId: string, evaluationDate: string): Promise<SnapshotSubject[]> {
  const payloads = JSON.parse(readFileSync(path.join(SPIKE_DIR, "devdb-patients.json"), "utf8")) as unknown[];
  const source = webChartDataSource({ baseUrl: "x", apiKey: "k" }, fixtureWebChartClient(payloads));
  return stampAll(await source.loadBundles(), measureId, readRoster(), evaluationDate);
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
      source === "live"
        ? await liveSubjects(measureId, evaluationDate)
        : source === "fixture"
          ? await fixtureSubjects(measureId, evaluationDate)
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
