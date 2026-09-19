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
import assert from "node:assert/strict";
import { classifyDbFailure, createPgPool, withStatementTimeoutDisabled } from "./pg-database.ts";
import { RUN_STORE_PG_DDL, SPIKE_SCHEMA } from "./schema-pg.ts";
import { PgRunStore } from "./run-store-postgres.ts";
import { PgOutcomeStore } from "./outcome-store-postgres.ts";
import { PgCaseStore } from "./case-store-postgres.ts";
import { OUTREACH_STATUS_CHUNK, PgCaseEventStore } from "./case-event-store-postgres.ts";
import { PgMeasureStore } from "./measure-store-postgres.ts";
import { PgEvidenceStore } from "./evidence-store-postgres.ts";
import { PgAppointmentStore } from "./appointment-store-postgres.ts";
import { PgValueSetStore } from "./value-set-store-postgres.ts";
import { PgOutreachTemplateStore } from "./outreach-template-store-postgres.ts";
import { PgWaiverStore } from "./waiver-store-postgres.ts";
import { PgSegmentStore } from "./segment-store-postgres.ts";
import { PgQualitySnapshotStore } from "./quality-snapshot-store-postgres.ts";
import { PgPersonLinkStore } from "./person-link-store-postgres.ts";
import { PgEvalStateStore } from "./eval-state-store-postgres.ts";
import { PgPanelStore } from "./panel-store-postgres.ts";
import { PgSubjectListStore } from "./subject-list-store-postgres.ts";
import { MEASURE_CATALOG } from "../../measure/measure-catalog.ts";
import { seedMeasureStore } from "../../measure/measure-seed.ts";
import { OFFICIAL_ONLY_PRE_CHANGE } from "../../measure/measure-seed.ts";
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
  evalStateStoreContract,
  panelStoreContract,
  subjectListStoreContract,
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

// The `[postgres]` prefix is RESERVED for tests that actually ran against Postgres, and the two
// branches below deliberately do not carry it. CI asserts the ceiling was exercised by grepping
// shard 1's output for that marker (`ci.yml`, "The Postgres ceiling ran"), and a skip notice wearing
// the same prefix satisfied that grep — so removing WORKWELL_TEST_PG_URL from the workflow would have
// produced a green job reporting one "[postgres] assertion" with nothing behind it, which is the exact
// failure the assertion exists to catch. Naming is the guard here: keep the marker off any test that
// does not connect.
if (!reachable && process.env.WORKWELL_TEST_PG_URL) {
  // CI sets WORKWELL_TEST_PG_URL, so an unreachable Postgres there is a real FAILURE, not a skip —
  // otherwise the backend-ts gate silently degrades to floor-only and misses Postgres-ceiling
  // regressions (Codex #161 P2). Local dev with no Postgres and no env var still skips (below).
  test("store contract — Postgres UNREACHABLE despite WORKWELL_TEST_PG_URL", () => {
    throw new Error(
      `WORKWELL_TEST_PG_URL is set (${url}) but Postgres is unreachable — the ceiling contract must run in CI; check the postgres service.`,
    );
  });
} else if (!reachable) {
  test(
    "store contract — SKIPPED (no Postgres reachable, so nothing from the ceiling ran)",
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
      `TRUNCATE ${SPIKE_SCHEMA}.audit_events, ${SPIKE_SCHEMA}.case_actions, ${SPIKE_SCHEMA}.cases, ${SPIKE_SCHEMA}.outcomes, ${SPIKE_SCHEMA}.run_logs, ${SPIKE_SCHEMA}.runs, ${SPIKE_SCHEMA}.measure_versions, ${SPIKE_SCHEMA}.measures, ${SPIKE_SCHEMA}.evidence_attachments, ${SPIKE_SCHEMA}.scheduled_appointments, ${SPIKE_SCHEMA}.measure_value_set_links, ${SPIKE_SCHEMA}.value_sets, ${SPIKE_SCHEMA}.terminology_mappings, ${SPIKE_SCHEMA}.outreach_templates, ${SPIKE_SCHEMA}.waivers, ${SPIKE_SCHEMA}.segment_overrides, ${SPIKE_SCHEMA}.segment_measures, ${SPIKE_SCHEMA}.segments, ${SPIKE_SCHEMA}.quality_snapshots, ${SPIKE_SCHEMA}.person_links, ${SPIKE_SCHEMA}.eval_state, ${SPIKE_SCHEMA}.panel_assignments, ${SPIKE_SCHEMA}.subject_list_members, ${SPIKE_SCHEMA}.subject_lists RESTART IDENTITY CASCADE`,
    );

  /**
   * The two failures #562 maps to a 503, raised for REAL rather than faked into the right shape.
   *
   * A hand-built `{ code: "57014" }` proves only that the classifier reads the field it was written
   * to read. These make Postgres and pg-pool produce the actual objects, so the codes and the message
   * wording are the ones a live incident will carry.
   */
  test("[postgres] an exhausted pool and a cancelled statement raise what classifyDbFailure claims", async () => {
    // Pool exhaustion: one slot, held, then a short acquire timeout for the SECOND request.
    // The generous timeout on the first connect is not incidental — against a real server the TLS
    // handshake alone outruns a 50 ms budget, so a pool created with the short value fails to start
    // rather than to queue, and the test would pass for the wrong reason.
    const starved = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 20_000 });
    const held = await starved.connect();
    (starved as unknown as { options: Record<string, unknown> }).options.connectionTimeoutMillis = 50;
    try {
      await assert.rejects(
        starved.connect(),
        (err: unknown) => {
          const classified = classifyDbFailure(err);
          assert.equal(classified?.error, "pool_exhausted", `the real acquire error must classify: ${(err as Error).message}`);
          // pg-pool throws a plain Error — this is the assertion that a `code`-based matcher would fail.
          assert.equal((err as { code?: unknown }).code, undefined, "pg-pool carries no SQLSTATE, so the matcher must read the message");
          return true;
        },
      );
    } finally {
      held.release();
      await starved.end().catch(() => {});
    }

    // A real statement timeout: SQLSTATE 57014 with the server's own wording.
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query("SET statement_timeout = 50");
      await assert.rejects(client.query("SELECT pg_sleep(1)"), (err: unknown) => {
        assert.equal((err as { code?: string }).code, "57014");
        assert.equal(classifyDbFailure(err)?.error, "statement_timeout");
        return true;
      });
      // And the same SQLSTATE from a plain cancel is NOT labelled a timeout — the distinction the
      // classifier exists to keep, checked against the server's real message for that case.
      assert.equal(
        classifyDbFailure({ code: "57014", message: "canceling statement due to user request" })?.error,
        "query_canceled",
      );
    } finally {
      await client.end().catch(() => {});
    }
  });

  test("[postgres] withStatementTimeoutDisabled lifts a statement_timeout that is really set", async () => {
    // The opt-out the nightly compaction relies on, against a session that really HAS the timeout —
    // otherwise `SHOW statement_timeout` reads "0" inside the transaction because it was never set,
    // and the assertion passes while proving nothing.
    //
    // ONE connection in the pool, so the session the SET lands on is the session the helper checks
    // out. With the default ten it would usually be a different client, which is the same
    // wrong-connection hazard `SET LOCAL` exists to avoid.
    const single = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 20_000 });
    try {
      await single.query("SET statement_timeout = 7531");
      assert.equal((await single.query<{ statement_timeout: string }>("SHOW statement_timeout")).rows[0]!.statement_timeout, "7531ms", "the fixture really set it");
      const lifted = await withStatementTimeoutDisabled(single, async (client) => {
        const { rows } = await client.query<{ statement_timeout: string }>("SHOW statement_timeout");
        return rows[0]!.statement_timeout;
      });
      assert.equal(lifted, "0", "inside the transaction the timeout is lifted");
      // And `SET LOCAL` is transaction-scoped, so the session gets its timeout back on COMMIT rather
      // than leaking the lifted value to whoever holds this connection next.
      assert.equal((await single.query<{ statement_timeout: string }>("SHOW statement_timeout")).rows[0]!.statement_timeout, "7531ms", "and restored afterwards");
    } finally {
      await single.end().catch(() => {});
    }
  });

  runStoreContract("postgres", async () => {
    await truncate();
    return new PgRunStore(pool);
  });

  outcomeStoreContract("postgres", async () => {
    await truncate();
    return { runStore: new PgRunStore(pool), outcomeStore: new PgOutcomeStore(pool), caseStore: new PgCaseStore(pool) };
  });

  caseStoreContract("postgres", async () => {
    await truncate();
    return new PgCaseStore(pool);
  });

  caseEventStoreContract(
    "postgres",
    async () => {
      await truncate();
      return { caseStore: new PgCaseStore(pool), eventStore: new PgCaseEventStore(pool) };
    },
    OUTREACH_STATUS_CHUNK,
  );

  measureStoreContract("postgres", async () => {
    await truncate();
    return new PgMeasureStore(pool);
  });

  test("[postgres] seedMeasureStore deprecates a legacy official row", async () => {
    await truncate();
    const store = new PgMeasureStore(pool);
    const events = new PgCaseEventStore(pool);
    const catalog = MEASURE_CATALOG.find((m) => m.id === "cms2")!;
    await store.seedMeasure({
      measureId: "cms2v15",
      name: catalog.name,
      policyRef: catalog.policyRef,
      owner: catalog.owner,
      tags: [...catalog.tags],
      versionId: "cms2v15-v1.0",
      version: catalog.version,
      status: "Draft",
      // The legacy row as it ACTUALLY existed before the rename: Draft, NOT_COMPILED, the placeholder
      // spec. It used to be written as `catalog.spec` / `catalog.status` / `catalog.compileStatus`,
      // which was the same thing only while cms2 was still a Draft catalog row. ADR-072 promotes it to
      // Active with real content, so those fields now describe the POST-change row and the seeder
      // correctly declines to deprecate it — `deprecateLegacyOfficialRows` fingerprints against
      // `preChangeCatalog`, and a row that does not look pre-change is one somebody edited.
      spec: OFFICIAL_ONLY_PRE_CHANGE.cms2,
      cqlText: "",
      compileStatus: "NOT_COMPILED",
      createdAt: "2026-02-01T00:00:00.000Z",
      changeSummary: "Seeded measure version",
    });

    await seedMeasureStore(store, () => "", events);
    assert.equal((await store.getLatest("cms2v15"))?.status, "Deprecated");
    const deprecatedEvents = async () =>
      (await events.auditEventsByMeasureVersion("cms2v15-v1.0")).filter((event) => event.eventType === "MEASURE_DEPRECATED").length;
    assert.equal(await deprecatedEvents(), 1);
    // Second seed: the row is already Deprecated and the event exists, so hasAuditEvent must find it and nothing is written.
    await seedMeasureStore(store, () => "", events);
    assert.equal(await deprecatedEvents(), 1);
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

  evalStateStoreContract("postgres", async () => {
    await truncate();
    return new PgEvalStateStore(pool);
  });

  panelStoreContract("postgres", async () => {
    await truncate();
    return new PgPanelStore(pool);
  });

  subjectListStoreContract("postgres", async () => {
    await truncate();
    return new PgSubjectListStore(pool);
  });

  /**
   * The batched compare-and-set losing a race, which is the ONLY path that reaches the per-row
   * fallback in `upsertBatchChunk`. It lives here rather than in the shared contract because the
   * SQLite floor implements `upsertFromOutcomes` as a loop — there is no set-based UPDATE there to
   * lose, and the equivalent single-row race is already covered by the "#538 P2" contract test.
   *
   * The interposition is on `pool.query`: an operator's `patchCase` is slipped in immediately AFTER
   * the batch's `unnest` pre-read and BEFORE its UPDATE, which is exactly the window the batch cannot
   * see. Without it the shared-contract operator test never enters the race at all — it patches before
   * the batch starts, so the pre-read sees OPERATOR and the row is a CAS *winner*.
   */
  test("[postgres] a row whose next_action moves between the batch's pre-read and its write keeps the operator's words, and the rest of the batch still lands", async () => {
    await truncate();
    const store = new PgCaseStore(pool);
    const seedRun = crypto.randomUUID();
    const keys = ["x1", "x2", "x3"];
    const at = (runId: string, subjectId: string, outcomeStatus: string) => ({
      runId,
      subjectId,
      measureId: "audiogram",
      evaluationPeriod: "2026-01-01",
      outcomeStatus,
    });
    for (const subjectId of keys) await store.upsertFromOutcome(at(seedRun, subjectId, "OVERDUE"));
    const x2 = (await store.listCases({ employeeId: "x2", limit: 10 }))[0]!;

    // Fire once, on the pre-read, then restore — so only the batch's own UPDATE sees the moved row.
    // `pool.query` is heavily overloaded, so the interposition is typed through a narrow local alias
    // rather than trying to satisfy every signature.
    type AnyQuery = (...args: unknown[]) => Promise<unknown>;
    const patchable = pool as unknown as { query: AnyQuery };
    const realQuery = patchable.query.bind(pool) as AnyQuery;
    let armed = true;
    patchable.query = async (...args: unknown[]) => {
      const result = await realQuery(...args);
      if (armed && typeof args[0] === "string" && args[0].includes("unnest(")) {
        armed = false;
        patchable.query = realQuery;
        await store.patchCase(x2.id, { nextAction: "Operator called the clinic", nextActionSource: "OPERATOR" });
      }
      return result;
    };

    const runId = crypto.randomUUID();
    try {
      const out = await store.upsertFromOutcomes(keys.map((subjectId) => at(runId, subjectId, "OVERDUE")));
      assert.equal(out.length, 3, "one result per input even when one row takes the fallback");
    } finally {
      patchable.query = realQuery;
    }

    const after = async (subjectId: string) => (await store.listCases({ employeeId: subjectId, limit: 10 }))[0]!;
    const contended = await after("x2");
    assert.equal(contended.nextAction, "Operator called the clinic", "ADR-076 d2: the CAS loser kept the operator's words");
    assert.equal(contended.nextActionSource, "OPERATOR", "and their ownership");
    assert.equal(contended.lastRunId, runId, "while the run still recorded itself on the row");
    for (const subjectId of ["x1", "x3"]) {
      assert.equal((await after(subjectId)).lastRunId, runId, `${subjectId} landed — one contended row does not fail the chunk`);
    }
  });

  /**
   * The same window, but the concurrent write touches NEITHER action column — which is what
   * `scheduleAppointment` does: `patchCase(caseId, { status: "IN_PROGRESS" })` and nothing else
   * (`case/appointment-service.ts`). A compare-and-set guarding only `next_action` and
   * `next_action_source` still matches, so the batch's planned `status: "OPEN"` lands on top and
   * silently undoes the scheduling — against §4's IN_PROGRESS guarantee, the most-cited one.
   *
   * The guard therefore covers every field the plan was made from: `planCaseUpsert` reads `status`,
   * `current_outcome_status` and `closed_by`, and `planNextAction` reads the two action columns plus
   * `current_outcome_status`. Found by Codex on #544.
   */
  test("[postgres] a status changed between the batch's pre-read and its write is not clobbered by the planned status", async () => {
    await truncate();
    const store = new PgCaseStore(pool);
    const seedRun = crypto.randomUUID();
    const at = (runId: string, subjectId: string, outcomeStatus: string) => ({
      runId,
      subjectId,
      measureId: "audiogram",
      evaluationPeriod: "2026-01-01",
      outcomeStatus,
    });
    for (const subjectId of ["y1", "y2"]) await store.upsertFromOutcome(at(seedRun, subjectId, "OVERDUE"));
    const y2 = (await store.listCases({ employeeId: "y2", limit: 10 }))[0]!;
    assert.equal(y2.status, "OPEN");

    type AnyQuery = (...args: unknown[]) => Promise<unknown>;
    const patchable = pool as unknown as { query: AnyQuery };
    const realQuery = patchable.query.bind(pool) as AnyQuery;
    let armed = true;
    patchable.query = async (...args: unknown[]) => {
      const result = await realQuery(...args);
      if (armed && typeof args[0] === "string" && args[0].includes("unnest(")) {
        armed = false;
        patchable.query = realQuery;
        // Exactly what scheduling an appointment does: status only.
        await store.patchCase(y2.id, { status: "IN_PROGRESS" });
      }
      return result;
    };

    const runId = crypto.randomUUID();
    try {
      await store.upsertFromOutcomes(["y1", "y2"].map((subjectId) => at(runId, subjectId, "OVERDUE")));
    } finally {
      patchable.query = realQuery;
    }

    const reread = (await store.listCases({ employeeId: "y2", limit: 10 }))[0]!;
    assert.equal(reread.status, "IN_PROGRESS", "§4: the operator's IN_PROGRESS survived the batch's stale plan");
    assert.equal((await store.listCases({ employeeId: "y1", limit: 10 }))[0]!.lastRunId, runId, "y1 still landed");
  });
}
