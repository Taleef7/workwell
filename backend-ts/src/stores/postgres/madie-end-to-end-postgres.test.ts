/**
 * #727 — the Postgres twin of `run/madie-end-to-end.test.ts`: the same steward MADiE patients through
 * the same run and read APIs, on the Pg ceiling. The SQLite floor cannot catch Pg-only SQL, and the
 * roster, report and overview all read through store queries that differ between the two.
 *
 * Runs in its OWN database, created and dropped here. The Pg schema name is fixed (`workwell_spike`)
 * and `store-postgres.test.ts` truncates it, so sharing the default database would race it in a local
 * `pnpm test`. Lives under `stores/postgres/` so the shard rule pins it with the other Pg tests.
 *
 * Only `node:` imports and env-independent adapters are static: the deployment profile and the
 * runnable measure set are fixed when their modules load, so the env is set first.
 */
import { after, test } from "node:test";
import pg from "pg";

const SIX = "cms122,cms125,cms2,cms130,cms165,cms137";
process.env.WORKWELL_INSTANCE = "maui";
process.env.WORKWELL_OFFICIAL_MEASURES = SIX;
delete process.env.WORKWELL_VSAC_API_KEY;

const { officialRoutingProblems } = await import("../../wiring/executor-router.ts");
const { __resetSharedFqmWorker } = await import("../../wiring/fqm-worker.ts");
const problems = officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: SIX });
const required = process.env.WORKWELL_REQUIRE_OFFICIAL_TERMINOLOGY === "true";

const url = process.env.WORKWELL_TEST_PG_URL ?? "postgres://workwell:workwell@localhost:5432/workwell";
let reachable = false;
{
  const probe = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await probe.query("SELECT 1");
    reachable = true;
  } catch {
    reachable = false;
  } finally {
    await probe.end().catch(() => {});
  }
}

after(async () => {
  await __resetSharedFqmWorker();
});

// The `[postgres]` prefix is reserved for a test that actually ran against Postgres: CI greps for it to
// prove the ceiling was exercised, so no skip or failure notice below may carry it.
if (problems.length > 0) {
  const why = `the six Maui measures cannot all be routed here:\n  ${problems.join("\n  ")}`;
  if (required) {
    test("MADiE end to end (Postgres): terminology is required in this context", () => {
      throw new Error(why);
    });
  } else {
    test(`MADiE end to end (Postgres) — SKIPPED: ${problems.length} routing problem(s)`, { skip: why }, () => {});
  }
} else if (!reachable && process.env.WORKWELL_TEST_PG_URL) {
  test("MADiE end to end — Postgres UNREACHABLE despite WORKWELL_TEST_PG_URL", () => {
    throw new Error(`WORKWELL_TEST_PG_URL is set (${url}) but Postgres is unreachable; check the postgres service.`);
  });
} else if (!reachable) {
  test(
    "MADiE end to end (Postgres) — SKIPPED (no Postgres reachable)",
    { skip: `start it with: docker compose -f infra/docker-compose.yml up -d postgres (tried ${url})` },
    () => {},
  );
} else {
  const database = `madie_e2e_${process.pid}_${Date.now()}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE DATABASE ${database}`);
  const dbUrl = new URL(url);
  dbUrl.pathname = `/${database}`;
  after(async () => {
    // FORCE: the store factory's process-wide pool still holds connections to it.
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  });

  test("[postgres] MADiE end to end: every deck patient, through the run, the store and the read APIs", { timeout: 15 * 60_000 }, async () => {
    const { runMadieEndToEnd } = await import("../../test-support/madie-end-to-end.ts");
    const env = { DATABASE_URL: dbUrl.toString(), WORKWELL_OFFICIAL_MEASURES: SIX };
    const summary = await runMadieEndToEnd(env);
    console.log(`[madie-e2e] Postgres ${JSON.stringify(summary)}`);
  });
}
