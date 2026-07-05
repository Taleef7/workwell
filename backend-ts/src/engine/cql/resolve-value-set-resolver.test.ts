import { test } from "node:test";
import assert from "node:assert/strict";
import { StoreValueSetResolver } from "./value-set-resolver.ts";
import { CompositeValueSetResolver } from "./composite-value-set-resolver.ts";
import { resolveValueSetResolver } from "./resolve-value-set-resolver.ts";
import type { ValueSetStore } from "../../stores/value-set-store.ts";

// Minimal ValueSetStore stub — only listAll is exercised by the resolvers.
const store = { listAll: () => Promise.resolve([]) } as unknown as ValueSetStore;

test("no VSAC key → plain StoreValueSetResolver (inert; today's behavior)", () => {
  const r = resolveValueSetResolver({}, store);
  assert.ok(r instanceof StoreValueSetResolver);
});

test("blank VSAC key → still inert", () => {
  const r = resolveValueSetResolver({ WORKWELL_VSAC_API_KEY: "   " }, store);
  assert.ok(r instanceof StoreValueSetResolver);
});

test("VSAC key set → CompositeValueSetResolver", () => {
  const r = resolveValueSetResolver({ WORKWELL_VSAC_API_KEY: "abc" }, store);
  assert.ok(r instanceof CompositeValueSetResolver);
});
