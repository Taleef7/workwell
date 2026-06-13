/**
 * Production fail-fast tests (#105) — auth/cookie invariants ported from
 * StartupSafetyValidator.
 *   node --import tsx --test src/config/startup-safety.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeStartup, isProductionLike, isWeakJwtSecret } from "./startup-safety.ts";

const STRONG = "x".repeat(40);

test("isProductionLike detects prod profiles, explicit env, and NODE_ENV", () => {
  assert.equal(isProductionLike({ SPRING_PROFILES_ACTIVE: "prod" }), true);
  assert.equal(isProductionLike({ SPRING_PROFILES_ACTIVE: "default,staging" }), true);
  assert.equal(isProductionLike({ WORKWELL_ENVIRONMENT: "Production" }), true);
  assert.equal(isProductionLike({ NODE_ENV: "production" }), true);
  assert.equal(isProductionLike({ NODE_ENV: "development" }), false);
  assert.equal(isProductionLike({}), false);
});

test("isWeakJwtSecret flags blank, short, and known-weak secrets", () => {
  assert.equal(isWeakJwtSecret(undefined), true);
  assert.equal(isWeakJwtSecret("short"), true);
  assert.equal(isWeakJwtSecret("workwell-demo-secret-change-me"), true);
  assert.equal(isWeakJwtSecret(STRONG), false);
});

test("non-prod: weak secret / disabled auth do not throw, but cookie sanity still applies", () => {
  assert.doesNotThrow(() =>
    assertSafeStartup({ WORKWELL_AUTH_ENABLED: "false", WORKWELL_AUTH_JWT_SECRET: "weak", WORKWELL_AUTH_COOKIE_SAME_SITE: "Lax" }),
  );
  // SameSite=None without Secure is invalid even in dev (browsers drop it).
  assert.throws(() => assertSafeStartup({ WORKWELL_AUTH_COOKIE_SAME_SITE: "None", WORKWELL_AUTH_COOKIE_SECURE: "false" }), /Secure/);
  // Unknown SameSite is always rejected.
  assert.throws(() => assertSafeStartup({ WORKWELL_AUTH_COOKIE_SAME_SITE: "Bogus" }), /must be one of/);
});

test("prod: auth disabled throws", () => {
  assert.throws(
    () => assertSafeStartup({ NODE_ENV: "production", WORKWELL_AUTH_ENABLED: "false", WORKWELL_AUTH_JWT_SECRET: STRONG, WORKWELL_AUTH_COOKIE_SAME_SITE: "None", WORKWELL_AUTH_COOKIE_SECURE: "true" }),
    /AUTH_ENABLED=false/,
  );
});

test("prod: weak secret throws", () => {
  assert.throws(
    () => assertSafeStartup({ SPRING_PROFILES_ACTIVE: "prod", WORKWELL_AUTH_JWT_SECRET: "tooshort", WORKWELL_AUTH_COOKIE_SAME_SITE: "None", WORKWELL_AUTH_COOKIE_SECURE: "true" }),
    /at least 32 characters/,
  );
});

test("prod: SameSite must be None and Secure true", () => {
  const base = { SPRING_PROFILES_ACTIVE: "prod", WORKWELL_AUTH_JWT_SECRET: STRONG };
  assert.throws(() => assertSafeStartup({ ...base, WORKWELL_AUTH_COOKIE_SAME_SITE: "Lax" }), /must be 'None'/);
  assert.throws(() => assertSafeStartup({ ...base, WORKWELL_AUTH_COOKIE_SAME_SITE: "None", WORKWELL_AUTH_COOKIE_SECURE: "false" }), /Secure/);
});

test("prod: a fully safe config passes", () => {
  assert.doesNotThrow(() =>
    assertSafeStartup({
      SPRING_PROFILES_ACTIVE: "prod",
      WORKWELL_AUTH_ENABLED: "true",
      WORKWELL_AUTH_JWT_SECRET: STRONG,
      WORKWELL_AUTH_COOKIE_SAME_SITE: "None",
      WORKWELL_AUTH_COOKIE_SECURE: "true",
    }),
  );
});
