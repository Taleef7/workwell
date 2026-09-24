/**
 * Storage contract — `AuthFamilyStore` (#688). The current refresh-token id (`jti`) of each login
 * family, which is what makes refresh rotation and logout real (Fable M5): a refresh is honoured only
 * for the family's current jti, a replayed older one revokes the family, and logout deletes it.
 *
 * It used to live in the `CACHE` KV binding, which on the MIE stacks is in-memory: every deploy,
 * self-heal recreate or crash emptied it, the next refresh found no family and answered 401, and every
 * signed-in user was sent to the login page within one access-token lifetime. In the database the
 * record survives a restart, and logout stays a revocation rather than an expiry.
 *
 * Holds no credential: a family id, the id of the newest token issued in it, and when it lapses.
 */
export interface AuthFamilyStore {
  /** The family's current jti, or null when it is unknown, revoked or past `expiresAt`. */
  currentJti(family: string, now: string): Promise<string | null>;
  /** Record `jti` as the family's current token until `expiresAt`, and drop families that have lapsed. */
  rotate(family: string, jti: string, expiresAt: string, now: string): Promise<void>;
  /** Revoke the whole family (logout, or a replayed token). */
  revoke(family: string): Promise<void>;
}
