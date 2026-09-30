/**
 * #676 — rebuild the stored monthly quality snapshots on the population basis, by replaying the runs
 * that are some measure's newest in their month (`rebuildSnapshotHistory`). One-shot, owner-run, idempotent:
 *   DATABASE_URL=... pnpm rebuild:quality-snapshots
 * Without DATABASE_URL it uses the local SQLite floor (WORKWELL_SQLITE_PATH, default ./.workwell-local.sqlite).
 * WORKWELL_INSTANCE must match the deployment's, so subjects resolve to the right directory.
 *
 * No shebang: with one, tsx's import scanner fails to parse this file's top-level await and dynamic
 * import ("Parse error …:2:113"); `pnpm rebuild:quality-snapshots` runs it through tsx anyway.
 */
import { getStores, type StoresEnv } from "../../stores/factory.ts";
import { rebuildSnapshotHistory } from "../../quality/materialize-run.ts";

async function buildEnv(): Promise<StoresEnv> {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (databaseUrl) return { DATABASE_URL: databaseUrl };
  // @ts-expect-error — @mieweb/cloud-local ships .mjs without types
  const { createSqliteD1 } = await import("@mieweb/cloud-local");
  return { DB: await createSqliteD1(process.env.WORKWELL_SQLITE_PATH ?? "./.workwell-local.sqlite") };
}

const stores = await getStores(await buildEnv());
const result = await rebuildSnapshotHistory({
  runStore: stores.runs,
  outcomeStore: stores.outcomes,
  qualitySnapshots: stores.qualitySnapshots,
  events: stores.events,
});
for (const m of result.rebuilt) console.log(`rebuilt ${m.period} from run ${m.runId}: ${m.rows} rows`);
for (const m of result.skipped) console.log(`skipped ${m.period} (run ${m.runId}): ${m.reason}`);
console.log(`rebuild:quality-snapshots — ${result.rebuilt.length} run(s) replayed, ${result.skipped.length} skipped`);
process.exit(0);
