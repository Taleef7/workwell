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
import {
  parseEnrollmentRoster,
  stampEnrollment,
  isEnrolled,
  type EnrollmentRoster,
} from "../../engine/ingress/enrollment/roster.ts";
import { directSyntheticGenerator } from "../scale-generator.ts";
import type { TargetOutcome } from "../../engine/synthetic/exam-config.ts";

/** The five corpus targets — the same spread `official-corpus-outcomes.test.ts` scores. */
const TARGETS: TargetOutcome[] = ["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"];

/** Printed under each measure so a distribution is never mistaken for a roster forecast it is not. */
const SOURCE_LABELS: Record<string, string> = {
  live: "Source: the CONFIGURED TENANT via WORKWELL_WEBCHART_*, with the supplied --roster. A real roster forecast.",
  fixture:
    "Source: the committed 56-patient dev-DB sample. FROZEN DATA — reproduces the recorded baseline and says nothing about any tenant.",
  synthetic:
    "Source: 5 designed corpus probes, one per intended outcome. An AGREEMENT check across the outcome space — NOT the roster distribution of the demo/production stack, which evaluates the full synthetic employee directory through the run pipeline.",
};

export interface SnapshotArgs {
  measures: string[];
  evaluationDate: string;
  source: string;
  rosterPath?: string;
}

export function parseArgs(argv: readonly string[]): SnapshotArgs {
  const measures: string[] = [];
  let evaluationDate = "2024-06-01";
  let source = "synthetic";
  let rosterPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--measure") measures.push(argv[++i] ?? "");
    else if (arg === "--eval") evaluationDate = argv[++i] ?? evaluationDate;
    else if (arg === "--source") source = argv[++i] ?? source;
    else if (arg === "--roster") rosterPath = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (measures.length === 0) throw new Error("at least one --measure is required");
  if (!["synthetic", "live", "fixture"].includes(source)) {
    throw new Error(`--source must be live|synthetic|fixture (got '${source}')`);
  }
  // A tenant's roster is NOT optional, and defaulting it was a critical defect (review, #355). The
  // committed `enrollment-roster.json` is keyed by the dev-DB's `wc-N` ids, and `stampEnrollment` is a
  // silent NO-OP for any subject absent from the roster. Against a real tenant nobody would be enrolled,
  // so the OH roster's synthesized CPT-99213 Encounter — the conjunct authored cms125's `Has Qualifying
  // Visit` depends on — would never be added, `authoredActionable` would collapse to ~0, and the report
  // would print "the flip is inert rather than wrong" for a tenant whose official roster reads empty.
  // A FALSE ALL-CLEAR on precisely the configuration ADR-042/044 document as broken. Mirrors
  // `live-cli.ts`, which has always required `--roster`.
  if (source === "live" && !rosterPath) {
    throw new Error(
      "--source live requires --roster <path> (subjectId → measureIds for THIS tenant). Without it no " +
        "subject is enrolled, the roster's qualifying-visit Encounter is never stamped, and the authored " +
        "side reads as empty — which silently turns a DO-NOT-FLIP into an 'inert' all-clear. Generate a " +
        "template with: pnpm evaluate:webchart-live --list-patients > roster.json",
    );
  }
  return { measures, evaluationDate, source, ...(rosterPath ? { rosterPath } : {}) };
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
async function liveSubjects(
  measureId: string,
  evaluationDate: string,
  rosterPath: string,
): Promise<SnapshotSubject[]> {
  const cfg = webChartConfigFromEnv(process.env as Record<string, string | undefined>);
  if (!cfg) {
    throw new Error(
      "--source live needs the WebChart seam configured (WORKWELL_WEBCHART_BASE_URL + an auth mode). " +
        "Set it to the tenant you are about to flip, or use --source fixture for the committed sample " +
        "(frozen data — it says nothing about a tenant) or --source synthetic for a seamless stack.",
    );
  }
  const roster = parseEnrollmentRoster(JSON.parse(readFileSync(rosterPath, "utf8")));
  const bundles = await webChartDataSource(cfg, httpWebChartClient(cfg)).loadBundles();
  const subjects = stampAll(bundles, measureId, roster, evaluationDate);
  // A roster that matches no subject is indistinguishable downstream from a tenant nobody is enrolled
  // in, and it is the likely shape of a copy-pasted or stale file. Refuse rather than report on it.
  if (subjects.length > 0 && !subjects.some((s) => isEnrolled(roster, s.subjectId, measureId))) {
    throw new Error(
      `--roster ${rosterPath} enrolls none of the ${subjects.length} subject(s) this tenant returned ` +
        `(its ids look like: ${subjects.slice(0, 3).map((s) => s.subjectId).join(", ")}). A roster that ` +
        `matches nobody makes the authored side read empty and the verdict meaningless.`,
    );
  }
  return subjects;
}

const SPIKE_DIR = fileURLToPath(new URL("../../../spike/webchart/", import.meta.url));

/**
 * The committed 56-patient dev-DB sample, through the real ingress path with a fixture transport.
 *
 * This one legitimately uses the committed roster — its subject ids ARE the `wc-N` ids that roster is
 * keyed by. That is exactly why `live` may not share it.
 */
async function fixtureSubjects(measureId: string, evaluationDate: string): Promise<SnapshotSubject[]> {
  const payloads = JSON.parse(readFileSync(path.join(SPIKE_DIR, "devdb-patients.json"), "utf8")) as unknown[];
  const roster = parseEnrollmentRoster(JSON.parse(readFileSync(path.join(SPIKE_DIR, "enrollment-roster.json"), "utf8")));
  const source = webChartDataSource({ baseUrl: "x", apiKey: "k" }, fixtureWebChartClient(payloads));
  return stampAll(await source.loadBundles(), measureId, roster, evaluationDate);
}

/**
 * FIVE designed corpus probes — an AGREEMENT check, not a roster distribution.
 *
 * Named precisely because the first version of this called itself "the corpus roster a seamless stack
 * evaluates", and review (#355) showed that is false twice over. The demo/production stack evaluates the
 * synthetic employee DIRECTORY through the run pipeline — hundreds of subjects with generated exam
 * histories — not these five. And the five do not even land in five buckets: `DUE_SOON` and
 * `MISSING_DATA` both score OVERDUE for these measures, so the printed distribution has three.
 *
 * It is still the right default: one probe per intended outcome is the cheapest way to ask "do the two
 * engines agree across the whole outcome space", which is what a flip turns on. It is simply not a
 * roster forecast, and the report says so rather than letting a reader assume it.
 */
function syntheticSubjects(measureId: string, evaluationDate: string): SnapshotSubject[] {
  const generator = directSyntheticGenerator();
  return TARGETS.map((target) => {
    const subjectId = `snap-${measureId}-${target.toLowerCase()}`;
    return { subjectId, bundle: generator.bundleFor(subjectId, measureId, target, evaluationDate) };
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const { measures, evaluationDate, source, rosterPath } = parseArgs(argv);
  const snapshots: MeasureSnapshot[] = [];
  for (const measureId of measures) {
    const subjects =
      source === "live"
        ? await liveSubjects(measureId, evaluationDate, rosterPath!)
        : source === "fixture"
          ? await fixtureSubjects(measureId, evaluationDate)
          : syntheticSubjects(measureId, evaluationDate);
    const snapshot = await snapshotMeasure(measureId, subjects, evaluationDate);
    snapshots.push({ ...snapshot, sourceLabel: SOURCE_LABELS[source]! });
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
