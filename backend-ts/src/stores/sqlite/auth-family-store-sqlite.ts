/**
 * SQLite floor adapter for `AuthFamilyStore` (#688). ISO-8601 UTC strings compare in time order, so
 * the expiry checks are plain string comparisons, as elsewhere on the floor.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type { AuthFamilyStore } from "../auth-family-store.ts";

export class SqliteAuthFamilyStore implements AuthFamilyStore {
  constructor(private readonly db: CloudDatabase) {}

  async currentJti(family: string, now: string): Promise<string | null> {
    const { results } = await this.db
      .prepare(`SELECT jti FROM auth_refresh_families WHERE family = ? AND expires_at > ?`)
      .bind(family, now)
      .all<{ jti: string }>();
    return (results ?? [])[0]?.jti ?? null;
  }

  async rotate(family: string, jti: string, expiresAt: string, now: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO auth_refresh_families (family, jti, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(family) DO UPDATE SET jti = excluded.jti, expires_at = excluded.expires_at`,
      )
      .bind(family, jti, expiresAt)
      .run();
    await this.db.prepare(`DELETE FROM auth_refresh_families WHERE expires_at <= ?`).bind(now).run();
  }

  async revoke(family: string): Promise<void> {
    await this.db.prepare(`DELETE FROM auth_refresh_families WHERE family = ?`).bind(family).run();
  }

  async consume(family: string, jti: string, now: string): Promise<boolean> {
    const { results } = await this.db
      .prepare(`DELETE FROM auth_refresh_families WHERE family = ? AND jti = ? AND expires_at > ? RETURNING 1 AS ok`)
      .bind(family, jti, now)
      .all<{ ok: number }>();
    return (results ?? []).length === 1;
  }

  async listByPrefix(prefix: string, now: string): Promise<Array<{ family: string; expiresAt: string }>> {
    const { results } = await this.db
      .prepare(`SELECT family, expires_at FROM auth_refresh_families WHERE substr(family, 1, ?) = ? AND expires_at > ? ORDER BY family`)
      .bind(prefix.length, prefix, now)
      .all<{ family: string; expires_at: string }>();
    return (results ?? []).map((r) => ({ family: r.family, expiresAt: r.expires_at }));
  }

  async rotateIf(family: string, oldJti: string, newJti: string, expiresAt: string, now: string): Promise<boolean> {
    const { results } = await this.db
      .prepare(
        `UPDATE auth_refresh_families SET jti = ?, expires_at = ?
         WHERE family = ? AND jti = ? AND expires_at > ? RETURNING 1 AS ok`,
      )
      .bind(newJti, expiresAt, family, oldJti, now)
      .all<{ ok: number }>();
    return (results ?? []).length === 1;
  }
}
