/**
 * /health reports the routing the worker's boot check found (#768), here for a routing the router refuses.
 * Its own file because the boot check runs once per process: worker.test.ts boots with nothing routed.
 *   node --import tsx --test src/worker-routing-health.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.ts";
import type { Env } from "./worker.ts";

test("#768: /health names what this process routes and how many problems the router found", async () => {
  // cms999 is vendored nowhere, and cms2's translation is shipped without cms2 being routed: both refused.
  const env = {
    WORKWELL_AUTH_JWT_SECRET: "x".repeat(40),
    WORKWELL_OFFICIAL_MEASURES: "cms999, cms122",
    WORKWELL_DERIVED_MEASURES: "cms2",
  } as unknown as Env;
  const res = await worker.fetch(new Request("http://x/health"), env, {} as never);
  const { routing } = (await res.json()) as { routing: { official: string[]; derived: string[]; problems: number } };
  assert.deepEqual(routing.official, ["cms122", "cms999"], "the routed ids, as the router reads them, sorted");
  assert.deepEqual(routing.derived, ["cms2"], "the translations, read from their own list");
  // cms999 alone is 2 (not gated, not vendored) and the stray translation is a 3rd; at least, because a
  // context without the VSAC sidecar adds a terminology problem for cms122.
  assert.ok(routing.problems >= 3, `the router refuses both, so a deploy must not promote this image (got ${routing.problems})`);
});
