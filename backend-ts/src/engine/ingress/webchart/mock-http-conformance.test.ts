/**
 * WebChart HTTP transport conformance (#255 → PR-2c verified contract).
 *   node --import tsx --test src/engine/ingress/webchart/mock-http-conformance.test.ts
 *
 * The server here is deliberately an in-test `fetch` shim: no new dependency, no network, no deployed
 * service. It serves the VERIFIED public WebChart FHIR contract (docs/INTEGRATION_RESEARCH_2026-07-13.md):
 * `GET /fhir/Patient` searchset paging, then per-resource `GET /fhir/{type}?patient={id}` searches
 * (there is NO Patient/$everything), optionally behind SMART Backend Services auth. Backing data is the
 * committed WebChart dev-DB patient bundles.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { OutcomeStatus } from "../../evaluate-measure.ts";
import { webChartDataSource, type WebChartConfig } from "../data-source.ts";
import { parseEnrollmentRoster, evaluateSourceWithRoster } from "../enrollment/roster.ts";
import { DEVDB_EXCLUDED as EXCLUDED, DEVDB_WHITELIST as WHITELIST } from "./devdb-cli.ts";
import {
  fixtureWebChartClient,
  httpWebChartClient,
  COMPOSED_RESOURCE_TYPES,
  type HttpWebChartClientOptions,
} from "./webchart-client.ts";

type Json = Record<string, unknown>;
type FetchImpl = NonNullable<HttpWebChartClientOptions["fetch"]>;
type FetchInput = Parameters<FetchImpl>[0];
type FetchInit = Parameters<FetchImpl>[1];

const DIR = fileURLToPath(new URL("../../../../spike/webchart/", import.meta.url));
const payloads = JSON.parse(readFileSync(path.join(DIR, "devdb-patients.json"), "utf8")) as unknown[];
const roster = parseEnrollmentRoster(JSON.parse(readFileSync(path.join(DIR, "enrollment-roster.json"), "utf8")));
const EVAL = "2024-06-01";
const CFG = { baseUrl: "https://webchart.test", apiKey: "test-key" };
const TOKEN_URL = "https://webchart.test/oauth/token/";

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

/** All non-Patient resources of one fixture patient, filtered by resourceType. */
function resourcesOf(patientId: string, resourceType: string): Json[] {
  const bundle = payloadById.get(patientId);
  if (!isObject(bundle) || !Array.isArray(bundle.entry)) return [];
  const out: Json[] = [];
  for (const entry of bundle.entry) {
    const resource = isObject(entry) ? entry.resource : undefined;
    if (isObject(resource) && resource.resourceType === resourceType) out.push(resource);
  }
  return out;
}

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

/** A searchset page over `resources`, with a next link that preserves the request's own params. */
function searchsetPage(resources: Json[], url: URL, defaultCount: number): unknown {
  const count = Number(url.searchParams.get("_count") ?? defaultCount);
  const offset = Number(url.searchParams.get("_offset") ?? 0);
  const slice = resources.slice(offset, offset + count);
  const nextOffset = offset + count;
  const next = new URL(url.toString());
  next.searchParams.set("_count", String(count));
  next.searchParams.set("_offset", String(nextOffset));
  return {
    resourceType: "Bundle",
    type: "searchset",
    entry: slice.map((resource) => ({ resource })),
    link: nextOffset < resources.length ? [{ relation: "next", url: `${next.pathname}${next.search}` }] : [],
  };
}

function fetchShim(handler: (url: URL, init: FetchInit) => Response | Promise<Response>): FetchImpl {
  return ((input: FetchInput, init?: FetchInit) => {
    const url = new URL(inputUrl(input));
    assert.equal(authorization(init), "Bearer test-key");
    return Promise.resolve(handler(url, init));
  }) as FetchImpl;
}

const RESOURCE_ROUTE = new RegExp(`^/fhir/(${COMPOSED_RESOURCE_TYPES.join("|")})$`);

interface DevDbShimOptions {
  pageSize?: number;
  /** Serve malformed JSON for every resource search of this patient. */
  malformedPatientId?: string;
  /** 429 the first resource search of this patient, then succeed. */
  once429PatientId?: string;
  /** Persistently 500 every resource search of this patient. */
  failResourcesPatientId?: string;
}

/** Routes the verified contract over the fixture bundles: population search + per-resource searches. */
function devDbRoutes(opts?: DevDbShimOptions): (url: URL, init: FetchInit) => Response {
  const pageSize = opts?.pageSize ?? 7;
  const attempts = new Map<string, number>();
  return (url) => {
    if (url.pathname === "/fhir/Patient") {
      return jsonResponse(searchsetPage(patientResources, url, pageSize));
    }
    const match = RESOURCE_ROUTE.exec(url.pathname);
    if (match) {
      const patientId = url.searchParams.get("patient") ?? "";
      if (!payloadById.has(patientId)) return new Response("unknown patient", { status: 404 });
      if (opts?.failResourcesPatientId === patientId) return new Response("boom", { status: 500 });
      const seen = attempts.get(patientId) ?? 0;
      attempts.set(patientId, seen + 1);
      if (opts?.once429PatientId === patientId && seen === 0) return new Response("rate limited", { status: 429 });
      if (opts?.malformedPatientId === patientId) {
        return new Response("{", { status: 200, headers: { "content-type": "application/fhir+json" } });
      }
      return jsonResponse(searchsetPage(resourcesOf(patientId, match[1]!), url, pageSize));
    }
    return new Response("not found", { status: 404 });
  };
}

function devDbHttpFetch(opts?: DevDbShimOptions): FetchImpl {
  return fetchShim(devDbRoutes(opts));
}

function httpSource(fetchImpl: FetchImpl, options?: Omit<HttpWebChartClientOptions, "fetch">, cfg: WebChartConfig = CFG) {
  return webChartDataSource(cfg, httpWebChartClient(cfg, {
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

test("per-resource HTTP path is outcome-identical to the fixture WebChart path for dev-DB goldens", async () => {
  for (const measureId of [...WHITELIST, ...EXCLUDED]) {
    const expected = await outcomes(fixtureSource(), measureId);
    const actual = await outcomes(httpSource(devDbHttpFetch()), measureId);
    assert.deepEqual(actual, expected, `${measureId}: per-resource HTTP outcomes must match fixture outcomes`);
    if (EXCLUDED.includes(measureId)) {
      assert.deepEqual([...new Set(actual.map(([, outcome]) => outcome))], ["MISSING_DATA"]);
    }
  }
});

test("SMART mode: one token exchange authorizes the whole batch and outcomes match the fixture path", async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-384" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;

  const routes = devDbRoutes();
  let tokenRequests = 0;
  const fetchImpl: FetchImpl = (async (input: FetchInput, init?: FetchInit) => {
    const url = new URL(inputUrl(input));
    if (url.toString() === TOKEN_URL) {
      tokenRequests++;
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("grant_type"), "client_credentials");
      assert.equal(form.get("scope"), "system/*.rs", "the scope default must survive the client config mapping");
      assert.ok(form.get("client_assertion"));
      return jsonResponse({ access_token: "tok-live", token_type: "bearer", expires_in: 3600 });
    }
    assert.equal(authorization(init), "Bearer tok-live", "every FHIR call must carry the SMART token");
    return routes(url, init);
  }) as FetchImpl;

  const smartCfg = { baseUrl: "https://webchart.test", clientId: "workwell", privateKeyPem: pem, tokenUrl: TOKEN_URL };
  const expected = await outcomes(fixtureSource(), "obesity_bmi");
  const actual = await outcomes(httpSource(fetchImpl, {}, smartCfg), "obesity_bmi");
  assert.deepEqual(actual, expected);
  assert.equal(tokenRequests, 1, "one token exchange must serve the whole batch");
});

test("SMART mode: a 401 invalidates the token, re-exchanges, and retries the request once", async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-384" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;

  const routes = devDbRoutes();
  let tokenRequests = 0;
  let fhirRequests = 0;
  const fetchImpl: FetchImpl = (async (input: FetchInput, init?: FetchInit) => {
    const url = new URL(inputUrl(input));
    if (url.toString() === TOKEN_URL) {
      tokenRequests++;
      return jsonResponse({ access_token: `tok-${tokenRequests}`, token_type: "bearer", expires_in: 3600 });
    }
    fhirRequests++;
    if (fhirRequests === 1) return new Response("expired", { status: 401 });
    assert.equal(authorization(init), `Bearer tok-${tokenRequests}`);
    return routes(url, init);
  }) as FetchImpl;

  const smartCfg = { baseUrl: "https://webchart.test", clientId: "workwell", privateKeyPem: pem, tokenUrl: TOKEN_URL };
  const bundles = await httpSource(fetchImpl, {}, smartCfg).loadBundles();
  assert.equal(bundles.length, patientResources.length);
  assert.equal(tokenRequests, 2, "the 401 must force a token re-exchange");
});

test("timeout: a stalled FIRST population page rejects loudly (an outage is not an empty population)", async () => {
  const stalled = fetchShim((_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
    }),
  );
  await assert.rejects(() => httpSource(stalled, { maxRetries: 0, timeoutMs: 5 }).loadBundles(), /timed out/);
});

test("429 then success: retries the resource search and composes the payload", async () => {
  const target = patientResources[0]?.id as string;
  const fetchImpl = fetchShim((url, init) => {
    if (url.pathname === "/fhir/Patient") {
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [{ resource: patientResources[0]! }], link: [] });
    }
    return devDbRoutes({ once429PatientId: target })(url, init);
  });

  const bundles = await httpSource(fetchImpl, { maxRetries: 1, retryDelaysMs: [0] }).loadBundles();
  assert.equal(bundles.length, 1);
  const bundle = bundles[0] as Json;
  assert.ok(Array.isArray(bundle.entry) && bundle.entry.length > 1, "composed bundle must carry clinical resources");
});

test("partial page: a later population page failure keeps the patients already listed", async () => {
  const first = patientResources[0]!;
  const routes = devDbRoutes();
  const fetchImpl = fetchShim((url, init) => {
    if (url.pathname === "/fhir/Patient" && !url.searchParams.has("_offset")) {
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: first }],
        link: [{ relation: "next", url: "/fhir/Patient?_count=1&_offset=1" }],
      });
    }
    if (url.pathname === "/fhir/Patient") return new Response("page failed", { status: 500 });
    return routes(url, init);
  });

  const bundles = await httpSource(fetchImpl, { maxRetries: 0 }).loadBundles();
  assert.equal(bundles.length, 1);
});

test("malformed resource search: that patient becomes MISSING_DATA while the batch continues", async () => {
  const selected = ["wc-13", "wc-42"];
  const selectedPatients = selected.map((id) => patientResources.find((p) => p.id === id)!);
  const routes = devDbRoutes({ malformedPatientId: "wc-13" });
  const fetchImpl = fetchShim((url, init) => {
    if (url.pathname === "/fhir/Patient") {
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: selectedPatients.map((resource) => ({ resource })), link: [] });
    }
    return routes(url, init);
  });

  const res = await evaluateSourceWithRoster(httpSource(fetchImpl, { maxRetries: 0 }), "obesity_bmi", roster, { evaluationDate: EVAL });
  assert.equal(res.failed, 0);
  const byId = new Map(res.results.filter((r) => r.ok && r.outcome).map((r) => [r.outcome!.subjectId, r.outcome!.outcome]));
  assert.equal(byId.get("wc-13"), "MISSING_DATA");
  assert.equal(byId.get("wc-42"), "COMPLIANT");
});

test("persistent resource failure: that patient degrades to MISSING_DATA (never partial-data compliance)", async () => {
  const selected = ["wc-13", "wc-42"];
  const selectedPatients = selected.map((id) => patientResources.find((p) => p.id === id)!);
  const routes = devDbRoutes({ failResourcesPatientId: "wc-42" });
  const fetchImpl = fetchShim((url, init) => {
    if (url.pathname === "/fhir/Patient") {
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: selectedPatients.map((resource) => ({ resource })), link: [] });
    }
    return routes(url, init);
  });

  const res = await evaluateSourceWithRoster(httpSource(fetchImpl, { maxRetries: 0 }), "obesity_bmi", roster, { evaluationDate: EVAL });
  assert.equal(res.failed, 0);
  const byId = new Map(res.results.filter((r) => r.ok && r.outcome).map((r) => [r.outcome!.subjectId, r.outcome!.outcome]));
  assert.equal(byId.get("wc-42"), "MISSING_DATA");
  assert.equal(byId.get("wc-13"), "OVERDUE", "the unaffected patient keeps its real (fixture-golden) outcome");
});

test("off-origin population next link: refuses to follow it and never fetches the foreign origin", async () => {
  const first = patientResources[0]!;
  let foreignFetchAttempted = false;
  const routes = devDbRoutes();
  const fetchImpl = fetchShim((url, init) => {
    if (url.origin === "https://evil.example") {
      foreignFetchAttempted = true;
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [], link: [] });
    }
    if (url.pathname === "/fhir/Patient" && !url.searchParams.has("_offset")) {
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: first }],
        link: [{ relation: "next", url: "https://evil.example/fhir/Patient?_count=1&_offset=1" }],
      });
    }
    return routes(url, init);
  });

  await assert.rejects(() => httpSource(fetchImpl, { maxRetries: 0 }).loadBundles(), /off-origin|refusing/i);
  assert.equal(foreignFetchAttempted, false, "must not fetch the off-origin pagination link");
});

test("off-origin resource next link: never fetched; that patient degrades to the fallback bundle", async () => {
  const first = patientResources[0]!;
  const id = first.id as string;
  let foreignFetchAttempted = false;
  const fetchImpl = fetchShim((url) => {
    if (url.origin === "https://evil.example") {
      foreignFetchAttempted = true;
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [], link: [] });
    }
    if (url.pathname === "/fhir/Patient") {
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [{ resource: first }], link: [] });
    }
    return jsonResponse({
      resourceType: "Bundle",
      type: "searchset",
      entry: [],
      link: [{ relation: "next", url: `https://evil.example/fhir/Observation?patient=${id}` }],
    });
  });

  const bundles = await httpSource(fetchImpl, { maxRetries: 0 }).loadBundles();
  assert.equal(foreignFetchAttempted, false, "must not fetch the off-origin pagination link");
  assert.equal(bundles.length, 1);
  const entries = (bundles[0] as Json).entry as Json[];
  const hasOutcomeMarker = entries.some((e) => isObject(e.resource) && (e.resource as Json).resourceType === "OperationOutcome");
  assert.equal(hasOutcomeMarker, true, "patient must degrade to the fallback bundle with an OperationOutcome");
});

test("page-boundary duplicate: the same Immunization on two pages composes ONCE (no dose double-count)", async () => {
  const first = patientResources[0]!;
  const id = first.id as string;
  const dose = {
    resourceType: "Immunization",
    id: "imm-dup-1",
    status: "completed",
    patient: { reference: `Patient/${id}` },
    vaccineCode: { coding: [{ system: "http://hl7.org/fhir/sid/cvx", code: "189" }] },
    occurrenceDateTime: "2024-01-01",
  };
  const fetchImpl = fetchShim((url) => {
    if (url.pathname === "/fhir/Patient") {
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [{ resource: first }], link: [] });
    }
    if (url.pathname === "/fhir/Immunization") {
      const offset = url.searchParams.get("_offset");
      // page 1 and page 2 BOTH carry imm-dup-1 (offset-paging boundary shift)
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: dose }],
        link: offset ? [] : [{ relation: "next", url: `/fhir/Immunization?patient=${id}&_count=1&_offset=1` }],
      });
    }
    return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [], link: [] });
  });

  const client = httpWebChartClient(CFG, { fetch: fetchImpl, pageSize: 1, maxRetries: 0, retryDelaysMs: [0], timeoutMs: 50 });
  const payloads = await client.fetchPatientPayloads();
  assert.equal(payloads.length, 1);
  const entries = ((payloads[0] as Json).entry as Json[]).map((e) => e.resource as Json);
  const doses = entries.filter((r) => r.resourceType === "Immunization");
  assert.equal(doses.length, 1, "a page-boundary duplicate must not double-count a dose");
});

test("mis-attributed resource: data referencing a DIFFERENT patient degrades the requested patient", async () => {
  const first = patientResources[0]!;
  const id = first.id as string;
  const fetchImpl = fetchShim((url) => {
    if (url.pathname === "/fhir/Patient") {
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [{ resource: first }], link: [] });
    }
    if (url.pathname === "/fhir/Observation") {
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: { resourceType: "Observation", id: "obs-x", status: "final", subject: { reference: "Patient/SOMEONE-ELSE" } } }],
        link: [],
      });
    }
    return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [], link: [] });
  });

  const client = httpWebChartClient(CFG, { fetch: fetchImpl, maxRetries: 0, retryDelaysMs: [0], timeoutMs: 50 });
  const payloads = await client.fetchPatientPayloads();
  assert.equal(payloads.length, 1);
  const entries = ((payloads[0] as Json).entry as Json[]).map((e) => e.resource as Json);
  assert.ok(entries.some((r) => r.resourceType === "OperationOutcome"), "must degrade to the fallback bundle");
  assert.ok(!entries.some((r) => r.resourceType === "Observation"), "the foreign observation must never be attributed");
});

test("non-match searchset entries (search.mode include/outcome) are skipped, patient evaluates normally", async () => {
  const first = patientResources[0]!;
  const id = first.id as string;
  const routes = devDbRoutes();
  const fetchImpl = fetchShim((url, init) => {
    if (url.pathname === "/fhir/Patient") {
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [{ resource: first }], link: [] });
    }
    if (url.pathname === "/fhir/Observation") {
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [
          { search: { mode: "outcome" }, resource: { resourceType: "OperationOutcome", issue: [{ severity: "warning", code: "processing" }] } },
          { search: { mode: "include" }, resource: { resourceType: "Patient", id: "other-patient" } },
        ],
        link: [],
      });
    }
    return routes(url, init);
  });

  const client = httpWebChartClient(CFG, { fetch: fetchImpl, maxRetries: 0, retryDelaysMs: [0], timeoutMs: 50 });
  const payloads = await client.fetchPatientPayloads();
  const entries = ((payloads[0] as Json).entry as Json[]).map((e) => e.resource as Json);
  assert.ok(!entries.some((r) => r.resourceType === "OperationOutcome"), "an outcome-mode entry must not pollute the composed bundle");
  assert.equal(entries.filter((r) => r.resourceType === "Patient").length, 1, "exactly one Patient in the composed bundle");
});

test("persistent 401: one token re-exchange then a hard failure (never an infinite loop, never an empty 'success')", async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-384" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;

  let tokenRequests = 0;
  const fetchImpl: FetchImpl = (async (input: FetchInput) => {
    const url = new URL(inputUrl(input));
    if (url.toString() === TOKEN_URL) {
      tokenRequests++;
      return jsonResponse({ access_token: `tok-${tokenRequests}`, token_type: "bearer", expires_in: 3600 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as FetchImpl;

  const smartCfg = { baseUrl: "https://webchart.test", clientId: "workwell", privateKeyPem: pem, tokenUrl: TOKEN_URL };
  await assert.rejects(() => httpSource(fetchImpl, { maxRetries: 0 }, smartCfg).loadBundles(), /401/);
  assert.equal(tokenRequests, 2, "exactly one re-exchange, then terminal");
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
