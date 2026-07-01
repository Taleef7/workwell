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
import { PgCaseEventStore } from "./case-event-store-postgres.ts";
import { PgMeasureStore } from "./measure-store-postgres.ts";
import { PgEvidenceStore } from "./evidence-store-postgres.ts";
import { PgAppointmentStore } from "./appointment-store-postgres.ts";
import { PgValueSetStore } from "./value-set-store-postgres.ts";
import { PgOutreachTemplateStore } from "./outreach-template-store-postgres.ts";
import { PgWaiverStore } from "./waiver-store-postgres.ts";
import { PgSegmentStore } from "./segment-store-postgres.ts";
import { PgQualitySnapshotStore } from "./quality-snapshot-store-postgres.ts";
import { PgPersonLinkStore } from "./person-link-store-postgres.ts";
import {
  runStoreContract,
  outcomeStoreContract,
  caseStoreContract,
  caseEventStoreContract,
  measureStoreContract,
  evidenceStoreContract,
  appointmentStoreContract,
  valueSetStoreContract,
  outreachTemplateStoreContract,
  waiverStoreContract,
  segmentStoreContract,
  qualitySnapshotStoreContract,
  personLinkStoreContract,
} from "../store-contract.ts";

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

if (!reachable && process.env.WORKWELL_TEST_PG_URL) {
  // CI sets WORKWELL_TEST_PG_URL, so an unreachable Postgres there is a real FAILURE, not a skip —
  // otherwise the backend-ts gate silently degrades to floor-only and misses Postgres-ceiling
  // regressions (Codex #161 P2). Local dev with no Postgres and no env var still skips (below).
  test("[postgres] store contract — Postgres UNREACHABLE despite WORKWELL_TEST_PG_URL", () => {
    throw new Error(
      `WORKWELL_TEST_PG_URL is set (${url}) but Postgres is unreachable — the ceiling contract must run in CI; check the postgres service.`,
    );
  });
} else if (!reachable) {
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
      `TRUNCATE ${SPIKE_SCHEMA}.audit_events, ${SPIKE_SCHEMA}.case_actions, ${SPIKE_SCHEMA}.cases, ${SPIKE_SCHEMA}.outcomes, ${SPIKE_SCHEMA}.run_logs, ${SPIKE_SCHEMA}.runs, ${SPIKE_SCHEMA}.measure_versions, ${SPIKE_SCHEMA}.measures, ${SPIKE_SCHEMA}.evidence_attachments, ${SPIKE_SCHEMA}.scheduled_appointments, ${SPIKE_SCHEMA}.measure_value_set_links, ${SPIKE_SCHEMA}.value_sets, ${SPIKE_SCHEMA}.terminology_mappings, ${SPIKE_SCHEMA}.outreach_templates, ${SPIKE_SCHEMA}.waivers, ${SPIKE_SCHEMA}.segment_overrides, ${SPIKE_SCHEMA}.segment_measures, ${SPIKE_SCHEMA}.segments, ${SPIKE_SCHEMA}.quality_snapshots, ${SPIKE_SCHEMA}.person_links RESTART IDENTITY CASCADE`,
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

  caseEventStoreContract("postgres", async () => {
    await truncate();
    return { caseStore: new PgCaseStore(pool), eventStore: new PgCaseEventStore(pool) };
  });

  measureStoreContract("postgres", async () => {
    await truncate();
    return new PgMeasureStore(pool);
  });

  evidenceStoreContract("postgres", async () => {
    await truncate();
    return new PgEvidenceStore(pool);
  });

  appointmentStoreContract("postgres", async () => {
    await truncate();
    return new PgAppointmentStore(pool);
  });

  valueSetStoreContract("postgres", async () => {
    await truncate();
    return new PgValueSetStore(pool);
  });

  outreachTemplateStoreContract("postgres", async () => {
    await truncate();
    return new PgOutreachTemplateStore(pool);
  });

  waiverStoreContract("postgres", async () => {
    await truncate();
    return new PgWaiverStore(pool);
  });

  segmentStoreContract("postgres", async () => {
    await truncate();
    return new PgSegmentStore(pool);
  });

  qualitySnapshotStoreContract("postgres", async () => {
    await truncate();
    return new PgQualitySnapshotStore(pool);
  });

  personLinkStoreContract("postgres", async () => {
    await truncate();
    return new PgPersonLinkStore(pool);
  });
}
