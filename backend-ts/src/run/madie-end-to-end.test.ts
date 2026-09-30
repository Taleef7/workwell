/**
 * #727 — the steward's MADiE test patients through the whole pipeline on the SQLite floor: the
 * nightly's ALL_PROGRAMS run, the stores, and the read APIs, against the steward's expected results.
 * The Postgres twin is `stores/postgres/madie-end-to-end-postgres.test.ts`; the harness is
 * `test-support/madie-end-to-end.ts`.
 *
 * Only `node:` imports are static. The deployment profile and the runnable measure set are fixed when
 * their modules load, so the env is set first and everything else is imported after it.
 */
import { after, test } from "node:test";
// Env-independent (a SQLite adapter), so it may load before the env is set.
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";

const SIX = "cms122,cms125,cms2,cms130,cms165,cms137";
process.env.WORKWELL_INSTANCE = "maui";
process.env.WORKWELL_OFFICIAL_MEASURES = SIX;
// The authored engine is never asked here, and a VSAC key would make the pipeline fold a live
// expansion into its logic version; the routed measures read their vendored sidecars either way.
delete process.env.WORKWELL_VSAC_API_KEY;

const { officialRoutingProblems } = await import("../wiring/executor-router.ts");
const { __resetSharedFqmWorker } = await import("../wiring/fqm-worker.ts");
const problems = officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: SIX });
const required = process.env.WORKWELL_REQUIRE_OFFICIAL_TERMINOLOGY === "true";

after(async () => {
  await __resetSharedFqmWorker();
});

if (problems.length > 0) {
  // All six or nothing: with one of them unroutable it stays an AUTHORED measure, the run gets a rolling
  // window instead of the 2026 calendar year, and the report finds no 2026 run to read.
  const why = `the six Maui measures cannot all be routed here:\n  ${problems.join("\n  ")}`;
  if (required) {
    test("MADiE end to end (SQLite): terminology is required in this context", () => {
      throw new Error(why);
    });
  } else {
    test(`MADiE end to end (SQLite) — SKIPPED: ${problems.length} routing problem(s)`, { skip: why }, () => {});
  }
} else {
  test("MADiE end to end (SQLite): every deck patient, through the run, the store and the read APIs", { timeout: 15 * 60_000 }, async () => {
    const { runMadieEndToEnd } = await import("../test-support/madie-end-to-end.ts");
    const env = { DB: await createSqliteD1(":memory:"), WORKWELL_OFFICIAL_MEASURES: SIX };
    const summary = await runMadieEndToEnd(env);
    console.log(`[madie-e2e] SQLite ${JSON.stringify(summary)}`);
  });
}
