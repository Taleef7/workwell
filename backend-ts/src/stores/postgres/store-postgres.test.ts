/**
 * Postgres-ceiling harness for the shared store contract (#104).
 *
 * Runs the EXACT SAME assertions as the SQLite floor harness against a real
 * Postgres (the `infra/docker-compose.yml` `postgres:16`), proving the ports hold
 * on both the floor and the ceiling. The ceiling's queue-claim uses
 * `FOR UPDATE SKIP LOCKED`, so the concurrent-claim case actually exercises
 * parallel transactions.
 *
 * Gated on reachability: with no Postgres up, the suite registers a single skipped
 * test so CI (no Postgres) stays green. Locally:
 *   docker compose -f infra/docker-compose.yml up -d postgres
 *   node --import tsx --test src/stores/postgres/store-postgres.test.ts
 * Override the target with WORKWELL_TEST_PG_URL.
 */
import test, { after } from "node:test";
import pg from "pg";
import { createPgPool } from "./pg-database.ts";
import { RUN_STORE_PG_DDL, SPIKE_SCHEMA } from "./schema-pg.ts";
import { PgRunStore } from "./run-store-postgres.ts";
import { PgOutcomeStore } from "./outcome-store-postgres.ts";
import { PgCaseStore } from "./case-store-postgres.ts";
import { runStoreContract, outcomeStoreContract, caseStoreContract } from "../store-contract.ts";

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

if (!reachable) {
  test(
    "[postgres] store contract — SKIPPED (no Postgres reachable)",
    { skip: `start it with: docker compose -f infra/docker-compose.yml up -d postgres (tried ${url})` },
    () => {},
  );
} else {
  const pool = createPgPool(url);
  await pool.query(RUN_STORE_PG_DDL);
  after(async () => {
    await pool.end();
  });

  const truncate = () =>
    pool.query(
      `TRUNCATE ${SPIKE_SCHEMA}.cases, ${SPIKE_SCHEMA}.outcomes, ${SPIKE_SCHEMA}.run_logs, ${SPIKE_SCHEMA}.runs RESTART IDENTITY CASCADE`,
    );

  runStoreContract("postgres", async () => {
    await truncate();
    return new PgRunStore(pool);
  });

  outcomeStoreContract("postgres", async () => {
    await truncate();
    return { runStore: new PgRunStore(pool), outcomeStore: new PgOutcomeStore(pool) };
  });

  caseStoreContract("postgres", async () => {
    await truncate();
    return new PgCaseStore(pool);
  });
}
