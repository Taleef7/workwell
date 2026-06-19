/**
 * Store-selection seam (#109 deploy cutover — Neon/Postgres fallback path).
 *
 * The routes were each constructing `new Sqlite*Store(env.DB)` directly against the SQLite floor.
 * This factory is the SINGLE place that decides floor vs ceiling:
 *   - `DATABASE_URL` (a Postgres connection string) present → every store is the `Pg*Store` ceiling
 *     adapter (proven end-to-end by stores/postgres/store-postgres.test.ts), backed by one pooled
 *     `pg` connection scoped to the `workwell_spike` schema.
 *   - otherwise → the SQLite floor over the `env.DB` CloudDatabase binding (the `local`/dev default).
 *
 * Selection is by configuration only — route/service code sees the shared store INTERFACES, never a
 * concrete driver — so the cutover flips with one env var (`DATABASE_URL=<neon>`) and no route logic
 * changes. Schema init (DDL, + the SQLite migrations) and the pool run once per `env` and are cached.
 * Seeding stays in the routes (it is interface-based, so it runs unchanged on either backend).
 */
import type { CloudDatabase } from "@mieweb/cloud";

import { RUN_STORE_FLOOR_DDL, migrateFloorSchema } from "./sqlite/schema.ts";
import { SqliteRunStore } from "./sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "./sqlite/outcome-store-sqlite.ts";
import { SqliteCaseStore } from "./sqlite/case-store-sqlite.ts";
import { SqliteCaseEventStore } from "./sqlite/case-event-store-sqlite.ts";
import { SqliteMeasureStore } from "./sqlite/measure-store-sqlite.ts";
import { SqliteEvidenceStore } from "./sqlite/evidence-store-sqlite.ts";
import { SqliteAppointmentStore } from "./sqlite/appointment-store-sqlite.ts";
import { SqliteValueSetStore } from "./sqlite/value-set-store-sqlite.ts";
import { SqliteOutreachTemplateStore } from "./sqlite/outreach-template-store-sqlite.ts";
import { SqliteWaiverStore } from "./sqlite/waiver-store-sqlite.ts";

import { createPgPool, type PgPool } from "./postgres/pg-database.ts";
import { RUN_STORE_PG_DDL } from "./postgres/schema-pg.ts";
import { PgRunStore } from "./postgres/run-store-postgres.ts";
import { PgOutcomeStore } from "./postgres/outcome-store-postgres.ts";
import { PgCaseStore } from "./postgres/case-store-postgres.ts";
import { PgCaseEventStore } from "./postgres/case-event-store-postgres.ts";
import { PgMeasureStore } from "./postgres/measure-store-postgres.ts";
import { PgEvidenceStore } from "./postgres/evidence-store-postgres.ts";
import { PgAppointmentStore } from "./postgres/appointment-store-postgres.ts";
import { PgValueSetStore } from "./postgres/value-set-store-postgres.ts";
import { PgOutreachTemplateStore } from "./postgres/outreach-template-store-postgres.ts";
import { PgWaiverStore } from "./postgres/waiver-store-postgres.ts";

import type { RunStore } from "./run-store.ts";
import type { OutcomeStore } from "./outcome-store.ts";
import type { CaseStore } from "./case-store.ts";
import type { CaseEventStore } from "./case-event-store.ts";
import type { MeasureStore } from "./measure-store.ts";
import type { EvidenceStore } from "./evidence-store.ts";
import type { AppointmentStore } from "./appointment-store.ts";
import type { ValueSetStore } from "./value-set-store.ts";
import type { OutreachTemplateStore } from "./outreach-template-store.ts";
import type { WaiverStore } from "./waiver-store.ts";
import type { CampaignStore } from "./campaign-store.ts";
import { AuditBackedCampaignStore } from "./audit-campaign-store.ts";

/** The full set of persistence ports, resolved to one backend (floor or ceiling). */
export interface Stores {
  runs: RunStore;
  outcomes: OutcomeStore;
  cases: CaseStore;
  events: CaseEventStore;
  measures: MeasureStore;
  evidence: EvidenceStore;
  appointments: AppointmentStore;
  valueSets: ValueSetStore;
  outreachTemplates: OutreachTemplateStore;
  waivers: WaiverStore;
  /** Audit-backed demo adapter; production drop-in = PgCampaignStore over outreach_campaigns + outreach_delivery_log. */
  campaigns: CampaignStore;
}

/** Minimal env the factory needs: the SQLite floor binding + an optional Postgres URL (the ceiling). */
export interface StoresEnv {
  DB: CloudDatabase;
  /** Postgres connection string; when set + non-blank, the ceiling adapters are used instead of `DB`. */
  DATABASE_URL?: string;
}

/** True when a Postgres ceiling is configured (a non-blank DATABASE_URL). */
export function usesPostgres(env: StoresEnv): boolean {
  return !!(env.DATABASE_URL ?? "").trim();
}

// One initialized Stores bundle per env object (the host builds env once, reused across requests),
// so the pg pool + schema DDL run exactly once.
const cache = new WeakMap<object, Promise<Stores>>();

/** Resolve the store bundle for this env (cached). Schema init runs once on first call. */
export function getStores(env: StoresEnv): Promise<Stores> {
  const key = env as object;
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = build(env);
  cache.set(key, pending);
  // If init fails (e.g. a transient Neon/D1 error while running the startup DDL), evict the rejected
  // promise so the NEXT request retries a fresh build instead of replaying the failure until restart.
  void pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}

async function build(env: StoresEnv): Promise<Stores> {
  const url = (env.DATABASE_URL ?? "").trim();
  if (url) {
    return buildPostgres(url);
  }
  return buildSqlite(env.DB);
}

let sharedPool: PgPool | undefined;
async function buildPostgres(url: string): Promise<Stores> {
  // One pool per process (the container is single-replica; the host reuses one env). The ceiling DDL
  // is idempotent (CREATE SCHEMA/TABLE IF NOT EXISTS), so applying it on boot is safe + self-creating
  // — parity with the SQLite floor, which also self-creates its schema on first use.
  const pool = (sharedPool ??= createPgPool(url));
  await pool.query(RUN_STORE_PG_DDL);
  const events = new PgCaseEventStore(pool);
  return {
    runs: new PgRunStore(pool),
    outcomes: new PgOutcomeStore(pool),
    cases: new PgCaseStore(pool),
    events,
    measures: new PgMeasureStore(pool),
    evidence: new PgEvidenceStore(pool),
    appointments: new PgAppointmentStore(pool),
    valueSets: new PgValueSetStore(pool),
    outreachTemplates: new PgOutreachTemplateStore(pool),
    waivers: new PgWaiverStore(pool),
    campaigns: new AuditBackedCampaignStore(events),
  };
}

/**
 * The resolved low-level handle for the ACTIVE backend (floor or ceiling). Used by ops that must
 * hit the real data on the SELECTED backend — e.g. demo reset — rather than the always-present
 * `env.DB` SQLite floor binding, which would be a silent no-op when a Postgres ceiling is configured.
 */
export type ActiveBackend =
  | { kind: "sqlite"; db: CloudDatabase }
  | { kind: "postgres"; pool: PgPool };

/** Resolve the active backend handle (ensures schema init / the pg pool has run, exactly once). */
export async function getBackend(env: StoresEnv): Promise<ActiveBackend> {
  await getStores(env); // ensure the floor DDL / pg pool + ceiling DDL have been initialized
  const url = (env.DATABASE_URL ?? "").trim();
  if (url) return { kind: "postgres", pool: (sharedPool ??= createPgPool(url)) };
  return { kind: "sqlite", db: env.DB };
}

async function buildSqlite(db: CloudDatabase): Promise<Stores> {
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  await migrateFloorSchema(db);
  const events = new SqliteCaseEventStore(db);
  return {
    runs: new SqliteRunStore(db),
    outcomes: new SqliteOutcomeStore(db),
    cases: new SqliteCaseStore(db),
    events,
    measures: new SqliteMeasureStore(db),
    evidence: new SqliteEvidenceStore(db),
    appointments: new SqliteAppointmentStore(db),
    valueSets: new SqliteValueSetStore(db),
    outreachTemplates: new SqliteOutreachTemplateStore(db),
    waivers: new SqliteWaiverStore(db),
    campaigns: new AuditBackedCampaignStore(events),
  };
}
