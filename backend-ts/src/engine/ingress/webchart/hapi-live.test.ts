/**
 * LIVE HAPI "fake WebChart" test (ADR-032) — proves `httpWebChartClient` over REAL HTTP: genuine
 * server-minted searchset pagination (`link[next]`), the off-origin guard, per-resource
 * `?patient=` composition, and the Authorization-header path. Self-skips unless the DEDICATED
 * test var is set (deliberately NOT `WORKWELL_WEBCHART_BASE_URL` — a runtime `.env` pointing at
 * the remote teatea trial must never turn `pnpm test` into a remote-network suite):
 *
 *   docker compose -f ../infra/docker-compose.yml up -d hapi-fhir
 *   pnpm load:hapi
 *   WORKWELL_WEBCHART_LIVE_TEST_BASE_URL=http://localhost:8081 pnpm test
 *
 * Gate on REACHABLE, not merely SET (the ice-live.test.ts precedent): a stale var must skip, not
 * fail after timeouts. The headline is the PARITY assertion — evaluating over live HTTP yields
 * bucket counts deep-equal to the committed-fixture path (`evaluateDevDb`): HTTP in, identical
 * outcomes out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureWebChartClient, httpWebChartClient } from "./webchart-client.ts";
import { webChartDataSource } from "../data-source.ts";
import { evaluateDevDb, DEVDB_WHITELIST } from "./devdb-cli.ts";
import { parseEnrollmentRoster, evaluateSourceWithRoster } from "../enrollment/roster.ts";
import { BUCKETS, type MeasureSummary } from "./report-table.ts";
import type { OutcomeStatus } from "../../evaluate-measure.ts";

const BASE_URL = (process.env.WORKWELL_WEBCHART_LIVE_TEST_BASE_URL ?? "").trim().replace(/\/+$/, "");
const PARITY_DATE = "2024-06-01"; // the devdb CLI's data-contemporaneous default

async function hapiReachable(): Promise<boolean> {
  if (!BASE_URL) return false;
  try {
    const res = await fetch(`${BASE_URL}/fhir/metadata`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

const skip = (await hapiReachable())
  ? false
  : BASE_URL
    ? `HAPI at ${BASE_URL} is not reachable — skipping the live suite`
    : "WORKWELL_WEBCHART_LIVE_TEST_BASE_URL not set — live HAPI not available";

const cfg = { baseUrl: BASE_URL, apiKey: "live-test" };

test("live HAPI: population fetch composes 56 unique patient bundles", { skip }, async () => {
  const payloads = await httpWebChartClient(cfg).fetchPatientPayloads();
  assert.equal(payloads.length, 56);
  const ids = new Set<string>();
  for (const p of payloads) {
    const entry = (p as { entry?: { resource?: { resourceType?: string; id?: string } }[] }).entry ?? [];
    const patient = entry.find((e) => e.resource?.resourceType === "Patient")?.resource;
    assert.ok(patient?.id, "composed bundle carries its Patient");
    ids.add(patient!.id!);
  }
  assert.equal(ids.size, 56);
});

test("live HAPI: wc-5's composed bundle carries its real-LOINC Observations", { skip }, async () => {
  const payloads = await httpWebChartClient(cfg).fetchPatientPayloads();
  const wc5 = payloads.find((p) => {
    const entry = (p as { entry?: { resource?: { resourceType?: string; id?: string } }[] }).entry ?? [];
    return entry.some((e) => e.resource?.resourceType === "Patient" && e.resource.id === "wc-5");
  }) as { entry: { resource: Record<string, any> }[] } | undefined;
  assert.ok(wc5, "wc-5 present in the live population");
  const obs = wc5!.entry.map((e) => e.resource).filter((r) => r.resourceType === "Observation");
  assert.ok(obs.length >= 1, "per-resource ?patient= search returned wc-5's Observations");
  assert.ok(
    obs.some((o) => o.code?.coding?.some((c: any) => c.system === "http://loinc.org")),
    "Observations carry real LOINC codings",
  );
});

test("live HAPI: a small --page-size still yields all 56 (real link[next] paging + origin guard)", { skip }, async () => {
  const payloads = await httpWebChartClient(cfg, { pageSize: 10 }).fetchPatientPayloads();
  assert.equal(payloads.length, 56);
});

test("live HAPI PARITY: HTTP-fetched evaluation == committed-fixture evaluation, bucket for bucket", { skip }, async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const rosterFile = fileURLToPath(new URL("../../../../spike/webchart/enrollment-roster.json", import.meta.url));
  const roster = parseEnrollmentRoster(JSON.parse(readFileSync(rosterFile, "utf8")));

  // one live HTTP fetch, replayed per measure (mirrors the live CLI)
  const payloads = await httpWebChartClient(cfg, { pageSize: 10 }).fetchPatientPayloads();
  const live: MeasureSummary[] = [];
  for (const measureId of DEVDB_WHITELIST) {
    const src = webChartDataSource(cfg, fixtureWebChartClient(payloads));
    const res = await evaluateSourceWithRoster(src, measureId, roster, { evaluationDate: PARITY_DATE });
    const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<OutcomeStatus, number>;
    for (const r of res.results) if (r.ok && r.outcome) counts[r.outcome.outcome]++;
    live.push({ measureId, total: res.results.filter((r) => r.ok).length, counts });
  }

  const fixture = await evaluateDevDb({ evaluationDate: PARITY_DATE });
  assert.deepEqual(live, fixture.whitelist, "live-HTTP outcomes must equal committed-fixture outcomes");
});
