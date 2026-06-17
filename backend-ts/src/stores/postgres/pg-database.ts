/**
 * Postgres connection helper for the ceiling adapters (spike, #104).
 *
 * A tiny seam over `pg.Pool` so the stores depend on a narrow surface, not the
 * whole driver. This is the seed of a future `@mieweb/cloud-postgres` binding;
 * for now it is a direct `pg` pool scoped to the `workwell_spike` schema.
 */
import pg from "pg";

export type PgPool = pg.Pool;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when `id` is a syntactically valid UUID. The ceiling's `id` columns are
 * native `UUID`, so a malformed value (e.g. `foo` from `GET /api/runs/foo`) makes
 * Postgres raise `invalid input syntax for type uuid`. The SQLite floor stores ids
 * as TEXT and simply finds no row, so adapters guard with this to return the
 * contract's `null`/`[]` instead of throwing — keeping floor/ceiling behaviour identical.
 */
export const isUuid = (id: string): boolean => UUID_RE.test(id);

/**
 * Create a `pg` pool for the isolated spike schema.
 *
 * The pool sets NO search_path: the adapters fully-qualify every table (`workwell_spike.*`), so it
 * is unnecessary, and it MUST NOT be set via the libpq `options` startup parameter — Neon's pooled
 * endpoint (PgBouncer) rejects `options=-c search_path=...` with `08P01 unsupported startup parameter
 * in options: search_path`, which fails every connection (this is why the first shadow deploy 500'd
 * on every DB route; direct/unpooled Postgres accepts it, so the store-contract tests didn't catch
 * it). A per-connection `SET search_path` wouldn't survive PgBouncer transaction pooling either — so
 * full qualification in the adapters is the mechanism that keeps us off the canonical `public`
 * tables. See pg-database.test.ts (the regression guard).
 */
export function createPgPool(connectionString: string): PgPool {
  return new pg.Pool({ connectionString });
}
