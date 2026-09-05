#!/usr/bin/env -S node --import tsx
/**
 * `pnpm flip-gate --measure cms165 [--evaluation-date 2027-06-30] [--content-dir .official-content]`
 *
 * Prints the three readings a flip is judged on and writes `.flip-gate/<id>-<date>.json` for the PR
 * body. Exit code is ALWAYS 0: this is evidence, not a decision (see official-flip-gate.ts).
 */
import { EMPLOYEES } from "../../engine/synthetic/employee-catalog.ts";
import { officialOnlyBundleSource } from "../../wiring/subject-bundle-source.ts";
import { gateMeasure, renderGate, writeGateJson, parseArgs, FlipGateUsageError } from "./official-flip-gate.ts";
import type { OfficialOnlyMeasureId } from "../../engine/synthetic/official-only-bundles.ts";
import type { SnapshotSubject } from "./official-flip-snapshot.ts";

async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof FlipGateUsageError) {
      console.error(`flip-gate: ${error.message}`);
      console.error("usage: pnpm flip-gate --measure <id> [--evaluation-date YYYY-MM-DD] [--content-dir <path>]");
      return 2;
    }
    throw error;
  }

  // The deployment's own subjects, built through the SAME seam the run pipeline uses (U1 T2), so the
  // roster reading is a shadow of the real path rather than a bundle shape invented for this report.
  const source = officialOnlyBundleSource();
  const tenant = EMPLOYEES.filter((e) => e.tenantId === "maui");
  const subjects: SnapshotSubject[] = tenant.map((employee) => {
    const target = source.targetFor(tenant, args.measure, employee.externalId);
    return {
      subjectId: employee.externalId,
      bundle: source.bundleFor(employee, args.measure as OfficialOnlyMeasureId, target ?? "COMPLIANT", args.evaluationDate),
    };
  });

  const report = await gateMeasure(args.measure, subjects, args.evaluationDate, { contentDir: args.contentDir });
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
