/**
 * Hardcoded demo-user directory (#105) — TS analogue of the Java `demo_users` seed
 * (migration V003). Accounts are hardcoded by design (no SSO / real directory —
 * CLAUDE hard rule). The four roles mirror the Java seed; the shared password is
 * the documented demo credential `Workwell123!`, re-hashed with PBKDF2 (see
 * password.ts) instead of bcrypt so the TS backend needs no new dependency.
 *
 * The Java/Neon `demo_users` rows (bcrypt) are untouched; this is the TS backend's
 * own store, consistent with the strangler running alongside the JVM during cutover.
 */
import { verifyPassword } from "./password.ts";

export interface DemoUser {
  email: string;
  role: string;
  /** PBKDF2 stored string for `Workwell123!`. */
  passwordHash: string;
}

// PBKDF2(Workwell123!) — all four demo accounts share the documented demo password,
// exactly as the Java seed shares one bcrypt hash across the four rows.
const DEMO_PASSWORD_HASH = "pbkdf2$210000$S7uwh-rbSLMcbPEoD7t9xQ$XVjif5zI_6tzoc7-h9MZCCSowCEI34RQOtLzCrtWyB4";

export const DEMO_USERS: readonly DemoUser[] = [
  { email: "author@workwell.dev", role: "ROLE_AUTHOR", passwordHash: DEMO_PASSWORD_HASH },
  { email: "approver@workwell.dev", role: "ROLE_APPROVER", passwordHash: DEMO_PASSWORD_HASH },
  { email: "cm@workwell.dev", role: "ROLE_CASE_MANAGER", passwordHash: DEMO_PASSWORD_HASH },
  { email: "admin@workwell.dev", role: "ROLE_ADMIN", passwordHash: DEMO_PASSWORD_HASH },
  // ROLE_VIEWER is a read-only role (not in the original Java seed): the public /sandbox signs in as
  // this so anonymous visitors can browse every read surface but cannot mutate shared demo state or
  // trigger compute (authorize.ts blocks all non-GET for VIEWER). Frontend rbac already treats it read-only.
  { email: "viewer@workwell.dev", role: "ROLE_VIEWER", passwordHash: DEMO_PASSWORD_HASH },
];

/** Case-insensitive lookup, matching the Java `LOWER(email) = LOWER(?)` query. */
export function findDemoUser(email: string): DemoUser | null {
  const needle = email.trim().toLowerCase();
  return DEMO_USERS.find((u) => u.email.toLowerCase() === needle) ?? null;
}

/** Validate credentials; returns the user on success, else null. */
export async function authenticate(email: string, password: string): Promise<DemoUser | null> {
  const user = findDemoUser(email);
  if (!user) return null;
  return (await verifyPassword(password, user.passwordHash)) ? user : null;
}
