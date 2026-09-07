/**
 * `pnpm outcomes:compact` — run one retention pass by hand (ADR-073).
 *
 * The scheduler runs this after every nightly recompute; this is the operator's version, for a first
 * pass after enabling retention on an instance that has been accumulating rows, or for a one-off after
 * lowering the window. Same function, same audit event, same guarantees — it is not a second
 * implementation, which is the point of it being three lines.
 *
 * Inert without `WORKWELL_OUTCOME_RETENTION_DAYS`: it prints what is missing and exits 0 rather than
 * deleting anything on a deployment that has not opted in.
 */
import { getStores } from "../../stores/factory.ts";
import { compactOutcomes, retentionDaysFromEnv } from "../outcome-compaction.ts";

const env = process.env as Record<string, unknown>;
const retentionDays = retentionDaysFromEnv(env);
if (retentionDays === undefined) {
  console.log("[workwell] WORKWELL_OUTCOME_RETENTION_DAYS is not set — retention is OFF and nothing was deleted.");
  process.exit(0);
}

const stores = await getStores(env as never);
const result = await compactOutcomes(stores, { retentionDays, now: Date.now() });
console.log(
  `[workwell] compacted outcomes older than ${result!.cutoff} (${retentionDays}-day window): ` +
    `${result!.deleted} row(s) deleted in ${result!.durationMs}ms.`,
);
