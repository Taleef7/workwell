/**
 * Hardcoded demo-user directory (#105) — TS analogue of the Java `demo_users` seed
 * (migration V003). Accounts are hardcoded by design (no SSO / real directory —
 * CLAUDE hard rule). The four roles mirror the Java seed; the demo accounts share
 * the documented demo credential `Workwell123!`, re-hashed with PBKDF2 (see
 * password.ts) instead of bcrypt so the TS backend needs no new dependency. The
 * pilot accounts take their own hash on the deployed pilot stack (`pilotPasswordHash`).
 *
 * The Java/Neon `demo_users` rows (bcrypt) are untouched; this is the TS backend's
 * own store, consistent with the strangler running alongside the JVM during cutover.
 */
import { createHash } from "node:crypto";
import { isPasswordHash, verifyPassword } from "./password.ts";
import { DEPLOYMENT_PROFILE, resolveDeploymentProfile } from "../config/deployment-profile.ts";
import { isProductionLike, type StartupEnv } from "../config/startup-safety.ts";

export interface DemoUser {
  email: string;
  role: string;
  /** PBKDF2 stored string for `Workwell123!`. */
  passwordHash: string;
}

// PBKDF2(Workwell123!) — all four demo accounts share the documented demo password,
// exactly as the Java seed shares one bcrypt hash across the four rows.
const DEMO_PASSWORD = "Workwell123!";
const DEMO_PASSWORD_HASH = "pbkdf2$210000$S7uwh-rbSLMcbPEoD7t9xQ$XVjif5zI_6tzoc7-h9MZCCSowCEI34RQOtLzCrtWyB4";

/** A stored value no password verifies against: `verifyPassword` rejects anything not in its format. */
const NO_LOGIN = "disabled";

/**
 * The pilot accounts' password hash. The demo password is printed in this public repository, so the
 * deployed pilot stack sets its own PBKDF2 hash in `WORKWELL_PILOT_PASSWORD_HASH` (the deploy refuses to
 * run without it). Unset on a local run or in CI, the pilot accounts keep the demo password. Unset on a
 * production-like pilot stack, or set to anything that is not a valid hash (or to the demo hash itself,
 * the one PBKDF2 string a copy-paste would most likely pick up from this repo), the pilot accounts cannot
 * sign in at all: a dropped or mangled secret never quietly reopens the stack with the public password.
 * The value itself is never logged.
 */
export function pilotPasswordHash(env: Record<string, unknown> = process.env as Record<string, unknown>): string {
  const raw = typeof env.WORKWELL_PILOT_PASSWORD_HASH === "string" ? env.WORKWELL_PILOT_PASSWORD_HASH.trim() : "";
  if (!raw) {
    // Keyed on the RESOLVED profile, which normalizes the value (`Maui`, ` maui `): a raw comparison would
    // pick the pilot profile and still fall back to the public password.
    const instance = typeof env.WORKWELL_INSTANCE === "string" ? env.WORKWELL_INSTANCE : undefined;
    if (resolveDeploymentProfile(instance).id === "maui" && isProductionLike(env as StartupEnv)) {
      console.error("[workwell] WORKWELL_PILOT_PASSWORD_HASH is unset on a production pilot stack; pilot sign-in is disabled.");
      return NO_LOGIN;
    }
    return DEMO_PASSWORD_HASH;
  }
  if (raw === DEMO_PASSWORD_HASH) {
    console.error("[workwell] WORKWELL_PILOT_PASSWORD_HASH is the public demo password's hash; pilot sign-in is disabled.");
    return NO_LOGIN;
  }
  if (isPasswordHash(raw)) return raw;
  console.error("[workwell] WORKWELL_PILOT_PASSWORD_HASH is not a valid PBKDF2 hash; pilot sign-in is disabled.");
  return NO_LOGIN;
}

const PILOT_PASSWORD_HASH = pilotPasswordHash();

export const DEMO_USERS: readonly DemoUser[] = [
  { email: "author@workwell.dev", role: "ROLE_AUTHOR", passwordHash: DEMO_PASSWORD_HASH },
  { email: "approver@workwell.dev", role: "ROLE_APPROVER", passwordHash: DEMO_PASSWORD_HASH },
  { email: "cm@workwell.dev", role: "ROLE_CASE_MANAGER", passwordHash: DEMO_PASSWORD_HASH },
  { email: "admin@workwell.dev", role: "ROLE_ADMIN", passwordHash: DEMO_PASSWORD_HASH },
  // ROLE_VIEWER is a read-only role (not in the original Java seed): the public /sandbox signs in as
  // this so anonymous visitors can browse every read surface but cannot mutate shared demo state or
  // trigger compute (authorize.ts blocks all non-GET for VIEWER). Frontend rbac already treats it read-only.
  { email: "viewer@workwell.dev", role: "ROLE_VIEWER", passwordHash: DEMO_PASSWORD_HASH },
  // Sandbox logins for the Maui pilot deployment (pseudonymous by policy). DEMO_USERS is shared
  // across deployments, so these rows exist on every instance — but `isDemoAccountRefusedOnProfile`
  // refuses them everywhere except the maui profile, and refuses every other account there (#520).
  { email: "quality-lead@maui.workwell.dev", role: "ROLE_CASE_MANAGER", passwordHash: PILOT_PASSWORD_HASH },
  { email: "quality-staff@maui.workwell.dev", role: "ROLE_CASE_MANAGER", passwordHash: PILOT_PASSWORD_HASH },
  { email: "clinician@maui.workwell.dev", role: "ROLE_VIEWER", passwordHash: PILOT_PASSWORD_HASH },
  { email: "admin@maui.workwell.dev", role: "ROLE_ADMIN", passwordHash: PILOT_PASSWORD_HASH },
];

/** Case-insensitive lookup, matching the Java `LOWER(email) = LOWER(?)` query. */
export function findDemoUser(email: string, profileId = DEPLOYMENT_PROFILE.id): DemoUser | null {
  const needle = email.trim().toLowerCase();
  const user = DEMO_USERS.find((u) => u.email.toLowerCase() === needle) ?? null;
  if (!user) return null;
  if (isDemoAccountRefusedOnProfile(user, profileId)) return null;
  return user;
}

/**
 * The per-request form of the profile rule (worker auth gate). It answers "is this a demo account that
 * belongs to ANOTHER deployment?" — and only that. A signed principal that is not a demo row at all
 * (a `ROLE_MCP_CLIENT` service account, for instance) is NOT refused here: DEMO_USERS is the login
 * directory, not an allowlist for every subject the verifier accepts.
 */
export function isDemoAccountRefusedOnProfile(
  userOrEmail: DemoUser | string,
  profileId = DEPLOYMENT_PROFILE.id,
): boolean {
  const user =
    typeof userOrEmail === "string"
      ? DEMO_USERS.find((u) => u.email.toLowerCase() === userOrEmail.trim().toLowerCase()) ?? null
      : userOrEmail;
  if (!user) return false;
  const isMauiAccount = user.email.toLowerCase().endsWith("@maui.workwell.dev");
  return profileId === "maui" ? !isMauiAccount : isMauiAccount;
}

/**
 * The accounts a case may be assigned to on THIS deployment: the roles that can work cases
 * (CASE_MANAGER, ADMIN), minus the accounts the profile refuses (#520), ordered by email.
 *
 * One definition, two surfaces: `GET /api/users/assignable` offers this list to the UI and the
 * assign route validates against it. When those were separate, the endpoint's list was a suggestion
 * and the route accepted anything — so a case could be parked on an address that cannot sign in and
 * appears in no "assigned to me" view.
 */
export function assignableUsers(profileId = DEPLOYMENT_PROFILE.id): DemoUser[] {
  return DEMO_USERS
    .filter(
      (user) =>
        (user.role === "ROLE_CASE_MANAGER" || user.role === "ROLE_ADMIN") &&
        !isDemoAccountRefusedOnProfile(user, profileId),
    )
    .sort((a, b) => a.email.localeCompare(b.email));
}

/**
 * Resolve an assignee the caller supplied to the account's OWN spelling, or null when no account
 * matches. Case-insensitive like `findDemoUser`, so `CM@WorkWell.dev` and `cm@workwell.dev` are one
 * assignee rather than two rows that never match each other in a filter.
 */
export function resolveAssignable(email: string, profileId = DEPLOYMENT_PROFILE.id): string | null {
  const needle = email.trim().toLowerCase();
  if (!needle) return null;
  return assignableUsers(profileId).find((user) => user.email.toLowerCase() === needle)?.email ?? null;
}

/**
 * The account's credential version: a short digest of its stored password hash, so it changes exactly
 * when the password does. A refresh token records the version its session began under, and the refresh
 * route refuses a token whose version is stale; without that, a session opened with an old password
 * (the public demo one, before the pilot stack got its own) renews itself for as long as it keeps
 * refreshing. Truncated SHA-256 of a salted PBKDF2 string reveals nothing usable about the password.
 */
export function credentialVersion(user: DemoUser): string {
  return createHash("sha256").update(user.passwordHash).digest("base64url").slice(0, 16);
}

/** Validate credentials; returns the user on success, else null. */
export async function authenticate(email: string, password: string): Promise<DemoUser | null> {
  const user = findDemoUser(email);
  if (!user) return null;
  // An account that carries its own hash never accepts the public demo password, however that hash was
  // produced: a fresh PBKDF2 of `Workwell123!` has its own salt, so no comparison of hash strings can
  // catch it. (The demo hash pasted verbatim is refused earlier, in `pilotPasswordHash`.)
  if (user.passwordHash !== DEMO_PASSWORD_HASH && password === DEMO_PASSWORD) return null;
  return (await verifyPassword(password, user.passwordHash)) ? user : null;
}
