/**
 * Refresh-token revocation (Fable M5) over the database's `AuthFamilyStore` (#688).
 *
 * It lived in the `CACHE` KV binding, which is in-memory on the MIE stacks, so every deploy, self-heal
 * recreate or crash emptied it: the next refresh found no family, answered 401, and every signed-in
 * user was sent to the login page within one access-token lifetime. A store failure throws, which the
 * auth handler already treats as "store unavailable": it degrades to stateless, never to a hard logout.
 */
import type { RefreshTokenRevocation } from "../routes/auth.ts";
import type { AuthFamilyStore } from "../stores/auth-family-store.ts";

export function storeRefreshRevocation(
  store: () => Promise<AuthFamilyStore>,
  now: () => number = Date.now,
): RefreshTokenRevocation {
  return {
    async currentJti(family) {
      return (await store()).currentJti(family, new Date(now()).toISOString());
    },
    async rotate(family, jti, ttlSeconds) {
      const at = now();
      const expiresAt = new Date(at + Math.max(60, Math.floor(ttlSeconds)) * 1000).toISOString();
      await (await store()).rotate(family, jti, expiresAt, new Date(at).toISOString());
    },
    async revoke(family) {
      await (await store()).revoke(family);
    },
  };
}
