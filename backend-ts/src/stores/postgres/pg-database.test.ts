/**
 * createPgPool config guard (#109 shadow-deploy fix).
 *
 * The pool must NOT send a libpq `options` startup parameter. Neon's pooled endpoint (PgBouncer)
 * rejects `options=-c search_path=...` with `08P01 unsupported startup parameter in options:
 * search_path`, which failed EVERY DB request on the first shadow deploy (the schema was never
 * even created). The ceiling adapters fully-qualify every table (`workwell_spike.*`), so the
 * search_path is unnecessary — and a per-connection `SET search_path` wouldn't survive PgBouncer
 * transaction pooling anyway. (Reproduced directly against the Neon pooler: with the param →
 * 08P01; without → connects.)
 *
 * node --import tsx --test src/stores/postgres/pg-database.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { classifyDbFailure, createPgPool, withStatementTimeoutDisabled } from "./pg-database.ts";

test("createPgPool sends no `options` startup param (Neon pooler rejects it — 08P01)", async () => {
  // pg.Pool surfaces the config it was constructed with on `.options`; `.options.options` is the
  // libpq startup `options` string (undefined when not set). No connection is opened here.
  const pool = createPgPool("postgresql://u:p@localhost:5432/db");
  try {
    const startupOptions = (pool as unknown as { options?: { options?: string } }).options?.options;
    assert.equal(
      startupOptions,
      undefined,
      "createPgPool must not pass a libpq `options` startup parameter — Neon's pooled (PgBouncer) " +
        "endpoint rejects it (08P01). Tables are schema-qualified (workwell_spike.*), so search_path " +
        "is unnecessary.",
    );
  } finally {
    await pool.end().catch(() => {});
  }
});

test("createPgPool sends NO timeout startup parameter — Neon's proxy drops them silently", async () => {
  // Measured against both Neon projects on 2026-09-18: a `statement_timeout` in the pool config is
  // placed in the startup packet by this driver and then SILENTLY IGNORED — the connection succeeds
  // and `SHOW statement_timeout` still reads `0`, on the pooled AND the direct endpoint. So a pool
  // configured this way looks enforced and enforces nothing, which is why the timeout is a role
  // default instead (`ALTER ROLE … SET statement_timeout`, docs/DEPLOY.md, ADR-084).
  //
  // `query_timeout` is excluded for a different reason and is asserted here beside them: it is a
  // CLIENT-side timer that abandons the caller while the server keeps executing, which under
  // transaction pooling leaves a server connection running a statement nobody awaits.
  const pool = createPgPool("postgresql://u:p@localhost:5432/db");
  try {
    const opts = (pool as unknown as { options?: Record<string, unknown> }).options ?? {};
    for (const param of ["statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout", "query_timeout", "options"]) {
      assert.equal(opts[param], undefined, `createPgPool must not set \`${param}\` — see the comment in pg-database.ts`);
    }
    // The two that ARE set, stated so a silent revert to the driver's defaults fails here.
    assert.equal(opts.max, 10, "the app pool is capped where the queue should form");
    assert.equal(opts.connectionTimeoutMillis, 10_000, "pool starvation must error rather than hang to the gateway cut");
  } finally {
    await pool.end().catch(() => {});
  }
});

test("classifyDbFailure names a cancelled statement and an exhausted pool, and nothing else", () => {
  // 57014 is cancellation IN GENERAL — a client cancel and pg_cancel_backend raise it too — so the
  // timeout label is claimed only when the server's own message says so.
  assert.deepEqual(classifyDbFailure({ code: "57014", message: "canceling statement due to statement timeout" }), {
    error: "statement_timeout",
    reason: "canceling statement due to statement timeout",
  });
  assert.equal(classifyDbFailure({ code: "57014", message: "canceling statement due to user request" })?.error, "query_canceled");
  // pg-pool throws a plain Error with NO `code`, so these match by message or not at all.
  assert.equal(classifyDbFailure(new Error("timeout exceeded when trying to connect"))?.error, "pool_exhausted");
  assert.equal(classifyDbFailure(new Error("Connection terminated due to connection timeout"))?.error, "pool_exhausted");
  // Anything else stays a 500: a classifier that matched broadly would relabel ordinary bugs as
  // infrastructure, and the next incident would be looked for in the wrong place.
  assert.equal(classifyDbFailure(new Error("relation does not exist")), null);
  assert.equal(classifyDbFailure({ code: "23505", message: "duplicate key value" }), null);
  assert.equal(classifyDbFailure(undefined), null);
});

test("withStatementTimeoutDisabled runs on ONE checked-out client, and releases on both paths", async () => {
  // The defect this shape exists to prevent: `SET LOCAL` is transaction-scoped, so if the BEGIN, the
  // SET and the work go through `pool.query` they may land on three different connections — the
  // transaction would not contain the work and the opt-out would apply to nothing.
  const calls: Array<{ on: "client" | "pool"; sql: string }> = [];
  // The ARGUMENT matters, not just the count: `release(err)` destroys the client, `release()` recycles
  // it. A fake that ignored the argument would pass whichever the implementation did — the vacuous
  // shape this suite exists to avoid.
  const releases: unknown[] = [];
  const client = {
    query: async (sql: string) => { calls.push({ on: "client", sql: String(sql).split("\n")[0]!.trim() }); return { rowCount: 0 }; },
    release: (arg?: unknown) => { releases.push(arg); },
  };
  const pool = {
    connect: async () => client,
    query: async (sql: string) => { calls.push({ on: "pool", sql: String(sql) }); return { rowCount: 0 }; },
  } as unknown as pg.Pool;

  const out = await withStatementTimeoutDisabled(pool, async (c) => {
    await c.query("DELETE FROM x");
    return 42;
  });
  assert.equal(out, 42);
  assert.deepEqual(calls.map((c) => c.sql), ["BEGIN", "SET LOCAL statement_timeout = 0", "DELETE FROM x", "COMMIT"]);
  // THE assertion: nothing went through the pool after the client was acquired. A helper that opened
  // the transaction while the real work still used `pool.query` would read as present and protect
  // nothing, and every other assertion here would still pass.
  assert.equal(calls.some((c) => c.on === "pool"), false, "no statement may bypass the checked-out client");
  assert.deepEqual(releases, [undefined], "a clean transaction RECYCLES the client (no argument)");

  // The failure path rolls back and still releases.
  calls.length = 0;
  await assert.rejects(
    withStatementTimeoutDisabled(pool, async () => { throw new Error("boom"); }),
    /boom/,
  );
  assert.deepEqual(calls.map((c) => c.sql), ["BEGIN", "SET LOCAL statement_timeout = 0", "ROLLBACK"]);
  assert.equal(releases.length, 2, "released on the failure path too");
  // THE assertion: a failed transaction's client is DESTROYED, not recycled. The ROLLBACK above is
  // best-effort because the connection may be what broke — recycling it then hands the next caller a
  // session still inside an aborted transaction, answering `25P02` to a request that did nothing
  // wrong, which `classifyDbFailure` does not match and so surfaces as a generic 500.
  assert.ok(releases[1], "the failure path must pass a truthy argument so the pool destroys the client");
  assert.match(String((releases[1] as Error)?.message ?? releases[1]), /boom/, "and it passes the error itself");
});
