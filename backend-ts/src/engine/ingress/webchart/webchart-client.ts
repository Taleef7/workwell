/**
 * WebChart transport seam (E12 PR-2).
 *
 * The integration path is WebChart's HTTP/FHIR API. The exact endpoints, auth scheme, pagination, and
 * response envelope are being confirmed with Dave Carlson (MIE) — so the transport is isolated behind
 * this small port. The value-carrying core (terminology reconciliation + bundle normalization) is
 * transport-agnostic and fully tested via the fixture client; swapping in the confirmed real request
 * shaping is then a localized change to `httpWebChartClient` only.
 *
 * No new dependency: the HTTP client uses the global `fetch` (available on the node-24 host and every
 * @mieweb/cloud target). Transport lives here at the ingress edge, keeping `evaluate-bundle.ts` /
 * `normalize.ts` I/O-free and portable.
 */
import type { WebChartConfig } from "../data-source.ts";

/** Yields one raw per-patient payload per element (a FHIR Bundle or resource list — normalized upstream). */
export interface WebChartClient {
  readonly kind: string;
  fetchPatientPayloads(): Promise<unknown[]>;
}

/** In-memory client for tests + offline fixtures — the transport-agnostic core runs against this. */
export function fixtureWebChartClient(payloads: unknown[]): WebChartClient {
  return { kind: "fixture", fetchPatientPayloads: () => Promise.resolve(payloads) };
}

/**
 * PROVISIONAL HTTP client — pending the confirmed WebChart API contract (Dave Carlson).
 *
 * Working assumption: a FHIR R4 endpoint that returns a searchset `Bundle` of the population's
 * patients, then per-patient clinical data. The concrete request shaping below (path, auth header,
 * pagination) is the single place to update once the real API is known; the rest of the adapter is
 * contract-independent. Until then this is selected only when the WebChart env vars are set
 * (inert-unless-configured) and is not exercised by the demo stack.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export function httpWebChartClient(cfg: WebChartConfig): WebChartClient {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  return {
    kind: "http",
    async fetchPatientPayloads(): Promise<unknown[]> {
      // ── PROVISIONAL — do NOT ship as-is ────────────────────────────────────────────────────────
      // TODO(dave-carlson, PR-2c): the real request shaping is unknown until the API contract is
      // confirmed. Specifically:
      //   • endpoint(s) + how to enumerate the WORKER POPULATION (this hits a single `/Patient` and
      //     returns ONE payload — so `normalizeWebChartBundle` would fold every patient into ONE
      //     engine bundle, collapsing them to a single subject. The real path must yield ONE payload
      //     PER PATIENT — e.g. map a searchset Bundle's entries, or a per-patient `$everything`).
      //   • auth scheme (Bearer vs an API-key header vs OAuth client-credentials).
      //   • pagination.
      //   • whether a patient's clinical data comes inline or needs a follow-up call.
      // Until then this is inert-unless-configured and never runs on the demo stack.
      const res = await fetch(`${base}/Patient`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: "application/fhir+json" },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS), // a hung endpoint must not hang the run
      });
      if (!res.ok) {
        throw new Error(`WebChart API ${res.status} ${res.statusText} for ${base}/Patient`);
      }
      // Returned as a single payload for the normalizer; per-patient fan-out lands with the real
      // contract (see the TODO above).
      return [await res.json()];
    },
  };
}
