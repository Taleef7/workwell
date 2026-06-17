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
import { createPgPool } from "./pg-database.ts";

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
