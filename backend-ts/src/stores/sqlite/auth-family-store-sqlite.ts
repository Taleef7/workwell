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
}
