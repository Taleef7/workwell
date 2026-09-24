/**
 * Postgres ceiling adapter for `AuthFamilyStore` (#688). One row per login family; a rotation is an
 * upsert on the family key, so a family never has two current tokens. Schema-qualified to
 * workwell_spike.
 */
import type { PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import type { AuthFamilyStore } from "../auth-family-store.ts";

const T = `${SPIKE_SCHEMA}.auth_refresh_families`;

export class PgAuthFamilyStore implements AuthFamilyStore {
  constructor(private readonly pool: PgPool) {}

  async currentJti(family: string, now: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ jti: string }>(
      `SELECT jti FROM ${T} WHERE family = $1 AND expires_at > $2::timestamptz`,
      [family, now],
    );
    return rows[0]?.jti ?? null;
  }

  async rotate(family: string, jti: string, expiresAt: string, now: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${T} (family, jti, expires_at) VALUES ($1, $2, $3::timestamptz)
       ON CONFLICT (family) DO UPDATE SET jti = EXCLUDED.jti, expires_at = EXCLUDED.expires_at`,
      [family, jti, expiresAt],
    );
    // Lapsed families are dead either way (`currentJti` ignores them); this only keeps the table to
    // the logins still inside their refresh window. One row per login, so it stays small.
    await this.pool.query(`DELETE FROM ${T} WHERE expires_at <= $1::timestamptz`, [now]);
  }

  async revoke(family: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${T} WHERE family = $1`, [family]);
  }
}
