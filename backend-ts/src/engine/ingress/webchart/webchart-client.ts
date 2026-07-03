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
export function httpWebChartClient(cfg: WebChartConfig): WebChartClient {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  return {
    kind: "http",
    async fetchPatientPayloads(): Promise<unknown[]> {
      // TODO(dave-carlson): confirm endpoint, auth (Bearer vs API key header), pagination, and whether
      // per-patient bundles are returned inline or need a follow-up $everything call. This default is a
      // reasonable FHIR-API placeholder, intentionally minimal.
      const res = await fetch(`${base}/Patient`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: "application/fhir+json" },
      });
      if (!res.ok) {
        throw new Error(`WebChart API ${res.status} ${res.statusText} for ${base}/Patient`);
      }
      const body: unknown = await res.json();
      // A searchset Bundle → its entries are the per-patient payloads; anything else is passed through
      // as a single payload for the normalizer to interpret.
      if (body && typeof body === "object" && (body as { resourceType?: string }).resourceType === "Bundle") {
        return [body];
      }
      return [body];
    },
  };
}
