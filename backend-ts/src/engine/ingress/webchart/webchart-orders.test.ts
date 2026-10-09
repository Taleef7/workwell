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

/** What a search answers instead of a normal page: a status for this (type, patient, page, has `_count`). */
type Override = (search: { type: string; patient: string; page: number; counted: boolean }) => number | undefined;

/**
 * A WebChart answering the population search and per-type patient searches for p1 and p2. It pages like the
 * real contract when `_count` is set (a `next` link per page), and `override` replaces any search's answer
 * with a status. `status` is the shorthand: every search of that type answers that status. Counts searches.
 */
function webChart(status: Record<string, number> = {}, override?: Override, extra: (id: string) => Json[] = () => []) {
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
    const page = Number(url.searchParams.get("page") ?? "1");
    const count = url.searchParams.get("_count");
    searches.set(type, (searches.get(type) ?? 0) + 1);
    const code = status[type] ?? override?.({ type, patient: id, page, counted: count !== null });
    if (code) return json({ resourceType: "OperationOutcome", issue: [{ severity: "error", code: "not-supported" }] }, code);
    const observation = { resourceType: "Observation", id: `${id}-a1c`, status: "final", subject: ref(id), code: coding("http://loinc.org", "4548-4"), valueQuantity: { value: 7.1, unit: "%" } };
    const all = [...(type === "Observation" ? [observation] : ordersFor(id)), ...extra(id)].filter((resource) => resource["resourceType"] === type);
    const size = count === null ? all.length : Math.max(1, Number(count));
    const slice = all.slice((page - 1) * size, page * size);
    const next = new URL(url);
    next.searchParams.set("page", String(page + 1));
    return json({
      resourceType: "Bundle",
      type: "searchset",
      total: all.length,
      entry: slice.map((resource) => ({ resource, search: { mode: "match" } })),
      link: page * size < all.length ? [{ relation: "next", url: next.toString() }] : [],
    });
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

test("#713: once a type has answered this run, a later 404 for it is a failed search, never a skip", async () => {
  // p1's MedicationRequest search answers; p2's 404s. Skipping then would leave p1 with medications and p2
  // (and everyone after) without, while the warning claimed nobody had them.
  const { payloads, warnings } = await payloadsWith(webChart({}, ({ type, patient }) => (type === "MedicationRequest" && patient === "p2" ? 404 : undefined)));
  assert.ok(!isFallback(payloads[0]) && entriesOf(payloads[0]).some((resource) => resource["resourceType"] === "MedicationRequest"));
  assert.ok(isFallback(payloads[1]), "p2 degrades: its search failed");
  assert.ok(!warnings.some((warning) => warning.includes("answers 404 for MedicationRequest searches")), "no type was skipped");
});

test("#713: a 404 on a later page is a failed search, and a 404 on the _count retry is the same 'unsupported' answer", async () => {
  // Paged at one resource a page, p1's three MedicationRequests take three pages; page 2 404s.
  const paged = await payloadsWith(
    webChart({}, ({ type, patient, page }) => (type === "MedicationRequest" && patient === "p1" && page === 2 ? 404 : undefined)),
    { pageSize: 1 },
  );
  assert.ok(isFallback(paged.payloads[0]), "a 404 mid-search degrades the patient instead of dropping the type");
  assert.ok(entriesOf(paged.payloads[1]).some((resource) => resource["resourceType"] === "MedicationRequest"), "p2 still gets its medications");

  // The server refuses `_count` (the trial's quirk), and the retry without it 404s: the type is unsupported.
  const server = webChart({}, ({ type, counted }) => (type === "Coverage" ? (counted ? 400 : 404) : undefined));
  const retried = await payloadsWith(server);
  assert.ok(retried.payloads.every((payload) => !isFallback(payload)), "no patient fails");
  assert.ok(retried.warnings.includes("WebChart answers 404 for Coverage searches, so this run reads no Coverage for any patient (#713)."));
});

test("#713: a crosswalk-coded order keeps its own coding, and a Coverage for another patient degrades the patient", async () => {
  // normalize.ts may ADD a coding to a code it recognises; it must never drop or replace WebChart's own.
  const loincOrder = (id: string): Json[] => [
    { resourceType: "ServiceRequest", id: `${id}-a1c-order`, status: "active", intent: "order", subject: ref(id), code: coding("http://loinc.org", "4548-4"), authoredOn: "2026-03-01" },
  ];
  const { payloads } = await payloadsWith(webChart({}, undefined, loincOrder));
  const order = entriesOf(normalizeWebChartBundle(payloads[0])).find((resource) => resource["id"] === "p1-a1c-order")!;
  const codings = (order["code"] as { coding: Json[] }).coding;
  assert.ok(codings.some((c) => c["system"] === "http://loinc.org" && c["code"] === "4548-4"), "WebChart's LOINC coding is kept");

  // Coverage names its patient as `beneficiary`; one naming someone else is mis-attributed data.
  const stray = (id: string): Json[] => (id === "p1" ? [{ resourceType: "Coverage", id: "stray", status: "active", beneficiary: ref("p2") }] : []);
  const misattributed = await payloadsWith(webChart({}, undefined, stray));
  assert.ok(isFallback(misattributed.payloads[0]), "a Coverage for another patient degrades the patient it was served for");
});
