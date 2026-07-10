/**
 * Mock-contract WebChart HTTP transport conformance (#255).
 *   node --import tsx --test src/engine/ingress/webchart/mock-http-conformance.test.ts
 *
 * The server here is deliberately an in-test `fetch` shim: no new dependency, no network, no deployed
 * service. It serves the assumed FHIR R4 contract from WEBCHART_API_ASSUMPTIONS_2026-07.md using the
 * committed WebChart dev-DB patient bundles as the backing data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { OutcomeStatus } from "../../evaluate-measure.ts";
import { webChartDataSource } from "../data-source.ts";
import { parseEnrollmentRoster, evaluateSourceWithRoster } from "../enrollment/roster.ts";
import { DEVDB_EXCLUDED as EXCLUDED, DEVDB_WHITELIST as WHITELIST } from "./devdb-cli.ts";
import { fixtureWebChartClient, httpWebChartClient, type HttpWebChartClientOptions } from "./webchart-client.ts";

type Json = Record<string, unknown>;
type FetchImpl = NonNullable<HttpWebChartClientOptions["fetch"]>;
type FetchInput = Parameters<FetchImpl>[0];
type FetchInit = Parameters<FetchImpl>[1];

const DIR = fileURLToPath(new URL("../../../../spike/webchart/", import.meta.url));
const payloads = JSON.parse(readFileSync(path.join(DIR, "devdb-patients.json"), "utf8")) as unknown[];
const roster = parseEnrollmentRoster(JSON.parse(readFileSync(path.join(DIR, "enrollment-roster.json"), "utf8")));
const EVAL = "2024-06-01";
const CFG = { baseUrl: "https://webchart.test", apiKey: "test-key" };

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function patientResource(bundle: unknown): Json {
  if (!isObject(bundle) || !Array.isArray(bundle.entry)) throw new Error("fixture bundle has no entry");
  for (const entry of bundle.entry) {
    const resource = isObject(entry) ? entry.resource : undefined;
    if (isObject(resource) && resource.resourceType === "Patient" && typeof resource.id === "string") return resource;
  }
  throw new Error("fixture bundle has no Patient");
}

const patientResources = payloads.map(patientResource);
const payloadById = new Map(patientResources.map((p, i) => [p.id as string, payloads[i]]));

function inputUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function authorization(init: FetchInit): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get("Authorization") ?? undefined;
  if (Array.isArray(headers)) return headers.find(([k]) => k.toLowerCase() === "authorization")?.[1];
  const record = headers as Record<string, string>;
  return record.Authorization ?? record.authorization;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/fhir+json", ...(init?.headers ?? {}) },
  });
}

function searchsetPage(patients: Json[], count: number, offset: number): unknown {
  const slice = patients.slice(offset, offset + count);
  const nextOffset = offset + count;
  return {
    resourceType: "Bundle",
    type: "searchset",
    entry: slice.map((resource) => ({ resource })),
    link: nextOffset < patients.length
      ? [{ relation: "next", url: `/fhir/Patient?_count=${count}&_offset=${nextOffset}` }]
      : [],
  };
}

function fetchShim(handler: (url: URL, init: FetchInit) => Response | Promise<Response>): FetchImpl {
  return ((input: FetchInput, init?: FetchInit) => {
    const url = new URL(inputUrl(input));
    assert.equal(authorization(init), "Bearer test-key");
    return Promise.resolve(handler(url, init));
  }) as FetchImpl;
}

function devDbHttpFetch(opts?: { pageSize?: number; malformedPatientId?: string; once429PatientId?: string }): FetchImpl {
  const pageSize = opts?.pageSize ?? 7;
  const attempts = new Map<string, number>();
  return fetchShim((url) => {
    if (url.pathname === "/fhir/Patient") {
      const count = Number(url.searchParams.get("_count") ?? pageSize);
      const offset = Number(url.searchParams.get("_offset") ?? 0);
      return jsonResponse(searchsetPage(patientResources, count, offset));
    }
    const match = /^\/fhir\/Patient\/([^/]+)\/\$everything$/.exec(url.pathname);
    if (match) {
      const id = decodeURIComponent(match[1] ?? "");
      const seen = attempts.get(id) ?? 0;
      attempts.set(id, seen + 1);
      if (opts?.once429PatientId === id && seen === 0) return new Response("rate limited", { status: 429 });
      if (opts?.malformedPatientId === id) return new Response("{", { status: 200, headers: { "content-type": "application/fhir+json" } });
      const payload = payloadById.get(id);
      return payload ? jsonResponse(payload) : new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  });
}

function httpSource(fetchImpl: FetchImpl, options?: Omit<HttpWebChartClientOptions, "fetch">) {
  return webChartDataSource(CFG, httpWebChartClient(CFG, {
    fetch: fetchImpl,
    pageSize: 7,
    maxRetries: 1,
    retryDelaysMs: [0],
    timeoutMs: 50,
    ...options,
  }));
}

function fixtureSource() {
  return webChartDataSource(CFG, fixtureWebChartClient(payloads));
}

async function outcomes(source: ReturnType<typeof webChartDataSource>, measureId: string): Promise<[string, OutcomeStatus][]> {
  const res = await evaluateSourceWithRoster(source, measureId, roster, { evaluationDate: EVAL });
  assert.equal(res.failed, 0, `${measureId}: no evaluation should error (${res.failed} failed)`);
  return res.results
    .filter((r) => r.ok && r.outcome)
    .map((r) => [r.outcome!.subjectId, r.outcome!.outcome] as [string, OutcomeStatus])
    .sort(([a], [b]) => a.localeCompare(b));
}

test("mock HTTP path is outcome-identical to the fixture WebChart path for dev-DB goldens", async () => {
  for (const measureId of [...WHITELIST, ...EXCLUDED]) {
    const expected = await outcomes(fixtureSource(), measureId);
    const actual = await outcomes(httpSource(devDbHttpFetch()), measureId);
    assert.deepEqual(actual, expected, `${measureId}: mock HTTP outcomes must match fixture outcomes`);
    if (EXCLUDED.includes(measureId)) {
      assert.deepEqual([...new Set(actual.map(([, outcome]) => outcome))], ["MISSING_DATA"]);
    }
  }
});

test("timeout: population fetch resolves to an empty bucket within the configured timeout", async () => {
  const stalled = fetchShim((_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
    }),
  );
  const bundles = await httpSource(stalled, { maxRetries: 0, timeoutMs: 5 }).loadBundles();
  assert.deepEqual(bundles, []);
});

test("429 then success: retries the patient fetch and returns the payload", async () => {
  const target = patientResources[0]?.id as string;
  let patientRequests = 0;
  const fetchImpl = fetchShim((url) => {
    if (url.pathname === "/fhir/Patient") return jsonResponse(searchsetPage([patientResources[0]!], 1, 0));
    if (url.pathname === `/fhir/Patient/${target}/$everything`) {
      patientRequests++;
      return patientRequests === 1 ? new Response("rate limited", { status: 429 }) : jsonResponse(payloadById.get(target));
    }
    return new Response("not found", { status: 404 });
  });

  const bundles = await httpSource(fetchImpl, { maxRetries: 1, retryDelaysMs: [0] }).loadBundles();
  assert.equal(bundles.length, 1);
  assert.equal(patientRequests, 2);
});

test("partial page: a later population page failure keeps the patients already listed", async () => {
  const first = patientResources[0]!;
  const fetchImpl = fetchShim((url) => {
    if (url.pathname === "/fhir/Patient" && !url.searchParams.has("_offset")) {
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: first }],
        link: [{ relation: "next", url: "/fhir/Patient?_count=1&_offset=1" }],
      });
    }
    if (url.pathname === "/fhir/Patient") return new Response("page failed", { status: 500 });
    if (url.pathname === `/fhir/Patient/${first.id as string}/$everything`) return jsonResponse(payloadById.get(first.id as string));
    return new Response("not found", { status: 404 });
  });

  const bundles = await httpSource(fetchImpl, { maxRetries: 0 }).loadBundles();
  assert.equal(bundles.length, 1);
});

test("malformed resource: one bad patient becomes MISSING_DATA while the batch continues", async () => {
  const selected = ["wc-13", "wc-42"];
  const selectedPatients = selected.map((id) => patientResources.find((p) => p.id === id)!);
  const fetchImpl = fetchShim((url) => {
    if (url.pathname === "/fhir/Patient") return jsonResponse(searchsetPage(selectedPatients, 2, 0));
    const match = /^\/fhir\/Patient\/([^/]+)\/\$everything$/.exec(url.pathname);
    if (match?.[1] === "wc-13") return new Response("{", { status: 200, headers: { "content-type": "application/fhir+json" } });
    if (match?.[1] === "wc-42") return jsonResponse(payloadById.get("wc-42"));
    return new Response("not found", { status: 404 });
  });

  const res = await evaluateSourceWithRoster(httpSource(fetchImpl, { maxRetries: 0 }), "obesity_bmi", roster, { evaluationDate: EVAL });
  assert.equal(res.failed, 0);
  const byId = new Map(res.results.filter((r) => r.ok && r.outcome).map((r) => [r.outcome!.subjectId, r.outcome!.outcome]));
  assert.equal(byId.get("wc-13"), "MISSING_DATA");
  assert.equal(byId.get("wc-42"), "COMPLIANT");
});

test("off-origin next link: refuses to follow it and never fetches the foreign origin", async () => {
  const first = patientResources[0]!;
  let foreignFetchAttempted = false;
  const fetchImpl = fetchShim((url) => {
    if (url.origin === "https://evil.example") {
      foreignFetchAttempted = true;
      return jsonResponse(searchsetPage([], 1, 0));
    }
    if (url.pathname === "/fhir/Patient" && !url.searchParams.has("_offset")) {
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: first }],
        link: [{ relation: "next", url: "https://evil.example/fhir/Patient?_count=1&_offset=1" }],
      });
    }
    if (url.pathname === `/fhir/Patient/${first.id as string}/$everything`) return jsonResponse(payloadById.get(first.id as string));
    return new Response("not found", { status: 404 });
  });

  await assert.rejects(() => httpSource(fetchImpl, { maxRetries: 0 }).loadBundles(), /off-origin|refusing/i);
  assert.equal(foreignFetchAttempted, false, "must not fetch the off-origin pagination link");
});

test("empty population: resolves to an empty bucket and evaluates without throwing", async () => {
  const fetchImpl = fetchShim((url) => {
    assert.equal(url.pathname, "/fhir/Patient");
    return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [], link: [] });
  });

  const source = httpSource(fetchImpl);
  assert.deepEqual(await source.loadBundles(), []);
  const res = await evaluateSourceWithRoster(source, "diabetes_hba1c", roster, { evaluationDate: EVAL });
  assert.equal(res.total, 0);
  assert.equal(res.failed, 0);
});
