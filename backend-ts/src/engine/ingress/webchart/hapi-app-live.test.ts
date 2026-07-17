/**
 * App-level live HAPI coverage for the WebChart tenant. The external target is selected ONLY by
 * WORKWELL_WEBCHART_LIVE_TEST_BASE_URL; runtime WebChart env is constructed locally inside the test.
 * A stale or absent dedicated target self-skips after a bounded metadata probe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { handleRuns } from "../../../routes/runs.ts";
import { handleCompliance } from "../../../routes/compliance.ts";
import { handleHierarchy } from "../../../routes/hierarchy.ts";
import { handleQuality } from "../../../routes/quality.ts";
import { replaceLiveDirectory } from "./live-directory.ts";

const LIVE_TEST_BASE_URL = (process.env.WORKWELL_WEBCHART_LIVE_TEST_BASE_URL ?? "").trim().replace(/\/+$/, "");

async function hapiReachable(): Promise<boolean> {
  if (!LIVE_TEST_BASE_URL) return false;
  try {
    const response = await fetch(`${LIVE_TEST_BASE_URL}/fhir/metadata`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

const skip = (await hapiReachable())
  ? false
  : LIVE_TEST_BASE_URL
    ? `HAPI at ${LIVE_TEST_BASE_URL} is not reachable — skipping the app live suite`
    : "WORKWELL_WEBCHART_LIVE_TEST_BASE_URL not set — live HAPI not available";

test("live HAPI app: run surfaces 56 wc subjects and restart-safe read models", { skip }, async () => {
  const dbPath = join(tmpdir(), `workwell-hapi-app-${crypto.randomUUID()}.sqlite`);
  try {
    replaceLiveDirectory([]);
    const env = {
      DB: await createSqliteD1(dbPath),
      WORKWELL_WEBCHART_BASE_URL: LIVE_TEST_BASE_URL,
      WORKWELL_WEBCHART_API_KEY: "live-test",
    };
    const background: Promise<unknown>[] = [];
    const created = await handleRuns(
      new Request("http://app/api/runs/manual", {
        method: "POST",
        body: JSON.stringify({ scopeType: "ALL_PROGRAMS", evaluationDate: "2024-06-01", triggeredBy: "hapi-app-live" }),
      }),
      env as never,
      "hapi-app-live",
      (promise) => background.push(promise),
    );
    assert.equal(created?.status, 201);
    const started = (await created!.json()) as { runId: string; status: string };
    assert.equal(started.status, "RUNNING");
    const settled = await Promise.allSettled(background);
    assert.ok(settled.every((result) => result.status === "fulfilled"), "background run completed without rejection");

    const rosterResponse = await handleCompliance(
      new Request("http://app/api/compliance/roster?panel=osha&tenant=wc&pageSize=200"),
      env as never,
    );
    const roster = (await rosterResponse!.json()) as { rows: Array<{ subject: { externalId: string; name: string } }> };
    assert.equal(roster.rows.length, 56);
    assert.ok(roster.rows.every((row) => row.subject.externalId.startsWith("wc|")));
    assert.ok(roster.rows.some((row) => row.subject.name !== row.subject.externalId.slice(3)), "registry supplies at least one full Patient name");

    const hierarchyResponse = await handleHierarchy(new Request("http://app/api/hierarchy/rollup"), env as never);
    const hierarchy = (await hierarchyResponse!.json()) as { totals: { evaluated: number }; children: Array<{ id: string; totals: { evaluated: number } }> };
    assert.ok(hierarchy.children.some((node) => node.id === "wc"));
    assert.equal(hierarchy.totals.evaluated, hierarchy.children.reduce((sum, tenant) => sum + tenant.totals.evaluated, 0));

    const qualityResponse = await handleQuality(
      new Request("http://app/api/quality/history?measureId=audiogram&scopeLevel=tenant&scopeId=wc"),
      env as never,
    );
    const quality = (await qualityResponse!.json()) as Array<Record<string, number | string>>;
    assert.equal(quality.length, 1);
    const q = quality[0]!;
    assert.equal(Number(q.compliant) + Number(q.dueSoon) + Number(q.overdue) + Number(q.missingData) + Number(q.excluded), 56);

    // Simulate a new worker: only persisted latest outcome rows remain. The same app reads must retain
    // all wc subjects, using raw Patient ids until the next successful population refresh.
    replaceLiveDirectory([]);
    const restartedResponse = await handleCompliance(
      new Request("http://app/api/compliance/roster?panel=osha&tenant=wc&pageSize=200"),
      env as never,
    );
    const restarted = (await restartedResponse!.json()) as { rows: Array<{ subject: { externalId: string; name: string } }> };
    assert.equal(restarted.rows.length, 56);
    assert.ok(restarted.rows.every((row) => row.subject.name === row.subject.externalId.slice(3)));

    const restartedHierarchyResponse = await handleHierarchy(new Request("http://app/api/hierarchy/rollup?tenant=wc"), env as never);
    const restartedHierarchy = (await restartedHierarchyResponse!.json()) as { id: string; totals: { evaluated: number } };
    assert.equal(restartedHierarchy.id, "wc");
    assert.ok(restartedHierarchy.totals.evaluated > 0);
  } finally {
    replaceLiveDirectory([]);
    try { rmSync(dbPath, { force: true }); } catch { /* best effort on Windows SQLite handles */ }
  }
});
