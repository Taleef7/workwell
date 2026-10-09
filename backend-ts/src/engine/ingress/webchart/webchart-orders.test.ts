/**
 * #713: WebChart ingest composes medication orders, referrals and coverage, and a server that does not
 * support one of them loses that type, never the patient.
 *   node --import tsx --test src/engine/ingress/webchart/webchart-orders.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeWebChartBundle } from "./normalize.ts";
import { httpWebChartClient, COMPOSED_RESOURCE_TYPES, type HttpWebChartClientOptions } from "./webchart-client.ts";

type Json = Record<string, unknown>;
type FetchImpl = NonNullable<HttpWebChartClientOptions["fetch"]>;

const CFG = { baseUrl: "https://webchart.test", apiKey: "test-key" };
const OPTIONS = { maxRetries: 1, retryDelaysMs: [0] } as const;
const patient = (id: string): Json => ({ resourceType: "Patient", id, gender: "female", birthDate: "1950-01-01" });
const ref = (id: string) => ({ reference: `Patient/${id}` });
const coding = (system: string, code: string) => ({ coding: [{ system, code }] });
const SNOMED = "http://snomed.info/sct";
const RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm";

/**
 * One resource per path the issue names, coded the way the measures' value sets are, in WebChart's shape:
 * a hospice order (the Hospice library's exclusion), a dementia medication (advanced illness), a depression
 * referral and an antidepressant (CMS2's follow-up), an opioid-use-disorder medication (CMS137), and a
 * Coverage (the payer element).
 */
function ordersFor(id: string): Json[] {
  return [
    { resourceType: "ServiceRequest", id: `${id}-hospice`, status: "active", intent: "order", subject: ref(id), code: coding(SNOMED, "385763009"), authoredOn: "2026-03-01" },
    { resourceType: "MedicationRequest", id: `${id}-dementia`, status: "active", intent: "order", subject: ref(id), medicationCodeableConcept: coding(RXNORM, "997223"), authoredOn: "2026-02-01" },
    { resourceType: "ServiceRequest", id: `${id}-referral`, status: "completed", intent: "order", subject: ref(id), code: coding(SNOMED, "183524004"), authoredOn: "2026-04-01" },
    { resourceType: "MedicationRequest", id: `${id}-ssri`, status: "active", intent: "order", subject: ref(id), medicationCodeableConcept: coding(RXNORM, "310385"), authoredOn: "2026-04-01" },
    { resourceType: "MedicationRequest", id: `${id}-bup`, status: "active", intent: "order", subject: ref(id), medicationCodeableConcept: coding(RXNORM, "1010600"), authoredOn: "2026-05-01" },
    { resourceType: "Coverage", id: `${id}-coverage`, status: "active", beneficiary: ref(id), payor: [{ display: "Medicare" }] },
  ];
}

/**
 * A WebChart answering the population search and per-type patient searches over `PATIENTS`. `status` maps a
 * resource type to the HTTP status every search for it answers instead of 200. Counts every search per type.
 */
function webChart(status: Record<string, number> = {}) {
  const ids = ["p1", "p2"];
  const searches = new Map<string, number>();
  const fetch: FetchImpl = ((input: Parameters<FetchImpl>[0]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const json = (body: unknown, code = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/fhir+json" } }));
    if (url.pathname === "/fhir/Patient") {
      return json({ resourceType: "Bundle", type: "searchset", total: ids.length, entry: ids.map((id) => ({ resource: patient(id), search: { mode: "match" } })) });
    }
    const type = url.pathname.replace(/^\/fhir\//, "");
    const id = url.searchParams.get("patient")!;
    searches.set(type, (searches.get(type) ?? 0) + 1);
    if (status[type]) return json({ resourceType: "OperationOutcome", issue: [{ severity: "error", code: "not-supported" }] }, status[type]);
    const observation = { resourceType: "Observation", id: `${id}-a1c`, status: "final", subject: ref(id), code: coding("http://loinc.org", "4548-4"), valueQuantity: { value: 7.1, unit: "%" } };
    const resources = type === "Observation" ? [observation] : ordersFor(id).filter((resource) => resource["resourceType"] === type);
    return json({ resourceType: "Bundle", type: "searchset", total: resources.length, entry: resources.map((resource) => ({ resource, search: { mode: "match" } })) });
  }) as FetchImpl;
  return { fetch, searches };
}

const entriesOf = (bundle: unknown): Json[] => ((bundle as { entry: Array<{ resource: Json }> }).entry ?? []).map((entry) => entry.resource);
const isFallback = (payload: unknown) => entriesOf(payload).some((resource) => resource["resourceType"] === "OperationOutcome");

/** Runs the client with console.warn captured, so a test can assert what it said. */
async function payloadsWith(server: ReturnType<typeof webChart>, options: HttpWebChartClientOptions = {}) {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => warnings.push(String(message));
  try {
    const payloads = await httpWebChartClient(CFG, { ...OPTIONS, fetch: server.fetch, ...options }).fetchPatientPayloads();
    return { payloads, warnings };
  } finally {
    console.warn = warn;
  }
}

test("#713: medication orders, referrals and coverage reach the evaluation bundle exactly as WebChart sent them", async () => {
  const { payloads } = await payloadsWith(webChart());
  for (const [index, id] of ["p1", "p2"].entries()) {
    const bundle = normalizeWebChartBundle(payloads[index]);
    for (const order of ordersFor(id)) {
      const found = entriesOf(bundle).find((resource) => resource["id"] === order["id"]);
      assert.deepEqual(found, order, `${order["id"]} reaches the bundle unchanged`);
    }
  }
  // The same server without the #713 types composes none of them: the composition is what puts them there.
  const before = await payloadsWith(webChart(), { resourceTypes: COMPOSED_RESOURCE_TYPES.slice(0, 5) });
  const types = new Set(entriesOf(normalizeWebChartBundle(before.payloads[0])).map((resource) => resource["resourceType"]));
  for (const type of ["MedicationRequest", "ServiceRequest", "Coverage"]) assert.ok(!types.has(type), type);
});

test("#713: a server that 404s an optional type loses that type for the run, with one warning, and no patient", async () => {
  for (const type of ["MedicationRequest", "ServiceRequest", "Coverage"]) {
    const server = webChart({ [type]: 404 });
    const { payloads, warnings } = await payloadsWith(server);
    for (const payload of payloads) {
      assert.ok(!isFallback(payload), `${type}: the patient is composed, not degraded`);
      const types = entriesOf(payload).map((resource) => resource["resourceType"]);
      assert.ok(types.includes("Observation"), `${type}: every other type is still there`);
      assert.ok(!types.includes(type));
    }
    assert.equal(server.searches.get(type), 1, `${type}: asked once, then skipped for the rest of the run`);
    assert.deepEqual(warnings, [`WebChart answers 404 for ${type} searches, so this run reads no ${type} for any patient (#713).`]);
  }
});

test("#713: any other failure of an optional type still degrades the patient, as a core type's 404 does", async () => {
  // A 500 is a broken search, not an unsupported type: partial clinical data must never evaluate.
  const broken = await payloadsWith(webChart({ MedicationRequest: 500 }));
  assert.ok(broken.payloads.every(isFallback), "a failing optional search degrades every patient it fails for");
  // Only a 404 means "not supported": a refusal (403) is a failed search like any other.
  const refused = await payloadsWith(webChart({ Coverage: 403 }));
  assert.ok(refused.payloads.every(isFallback), "a 403 on an optional type degrades the patient");
  // The core five keep the strict rule even on a 404.
  const core = await payloadsWith(webChart({ Observation: 404 }));
  assert.ok(core.payloads.every(isFallback), "a core type's 404 is a failed patient, never a skipped type");
});
