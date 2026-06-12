/**
 * Postgres connection helper for the ceiling adapters (spike, #104).
 *
 * A tiny seam over `pg.Pool` so the stores depend on a narrow surface, not the
 * whole driver. This is the seed of a future `@mieweb/cloud-postgres` binding;
 * for now it is a direct `pg` pool scoped to the `workwell_spike` schema.
 */
import pg from "pg";
import { SPIKE_SCHEMA } from "./schema-pg.ts";

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
 * Create a pool whose connections resolve unqualified names against the isolated
 * spike schema first (`search_path`). The adapters fully-qualify every table
 * (`workwell_spike.*`) so this is belt-and-suspenders — but it guarantees we can
 * never accidentally hit the canonical `public` tables. Set server-side at
 * connection start via libpq `options` (no per-connect query, no pg deprecation).
 */
export function createPgPool(connectionString: string): PgPool {
  return new pg.Pool({
    connectionString,
    options: `-c search_path=${SPIKE_SCHEMA},public`,
  });
}
