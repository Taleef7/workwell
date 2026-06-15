/**
 * SQLite-floor harness for the shared store contract (#103/#104).
 *
 * Proves the RunStore + OutcomeStore contracts hold on the portable floor — a real
 * @mieweb/cloud-local SQLite CloudDatabase, entirely in Node, no JVM. The SAME
 * assertions run against the Postgres ceiling in `../postgres/store-postgres.test.ts`.
 *   node --import tsx --test src/stores/sqlite/run-store-sqlite.test.ts
 */
import { after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "./schema.ts";
import { SqliteRunStore } from "./run-store-sqlite.ts";
import { SqliteOutcomeStore } from "./outcome-store-sqlite.ts";
import { SqliteCaseStore } from "./case-store-sqlite.ts";
import { SqliteCaseEventStore } from "./case-event-store-sqlite.ts";
import { SqliteMeasureStore } from "./measure-store-sqlite.ts";
import { SqliteEvidenceStore } from "./evidence-store-sqlite.ts";
import { SqliteAppointmentStore } from "./appointment-store-sqlite.ts";
import { SqliteValueSetStore } from "./value-set-store-sqlite.ts";
import { SqliteOutreachTemplateStore } from "./outreach-template-store-sqlite.ts";
import { SqliteWaiverStore } from "./waiver-store-sqlite.ts";
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
} from "../store-contract.ts";

const created: string[] = [];

async function freshDb() {
  const dbPath = join(tmpdir(), `workwell-store-${crypto.randomUUID()}.sqlite`);
  created.push(dbPath);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  return db;
}

after(() => {
  for (const p of created) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
});

runStoreContract("sqlite", async () => new SqliteRunStore(await freshDb()));

outcomeStoreContract("sqlite", async () => {
  const db = await freshDb();
  return { runStore: new SqliteRunStore(db), outcomeStore: new SqliteOutcomeStore(db) };
});

caseStoreContract("sqlite", async () => new SqliteCaseStore(await freshDb()));

caseEventStoreContract("sqlite", async () => {
  const db = await freshDb();
  return { caseStore: new SqliteCaseStore(db), eventStore: new SqliteCaseEventStore(db) };
});

measureStoreContract("sqlite", async () => new SqliteMeasureStore(await freshDb()));

evidenceStoreContract("sqlite", async () => new SqliteEvidenceStore(await freshDb()));

appointmentStoreContract("sqlite", async () => new SqliteAppointmentStore(await freshDb()));

valueSetStoreContract("sqlite", async () => new SqliteValueSetStore(await freshDb()));

outreachTemplateStoreContract("sqlite", async () => new SqliteOutreachTemplateStore(await freshDb()));

waiverStoreContract("sqlite", async () => new SqliteWaiverStore(await freshDb()));
