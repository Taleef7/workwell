/**
 * WebChart transport seam (E12 PR-2).
 *
 * The integration path is WebChart's HTTP/FHIR API. The exact endpoints, auth scheme, pagination, and
 * response envelope are being confirmed with Dave Carlson (MIE) — so the transport is isolated behind
 * this small port. The value-carrying core (terminology reconciliation + bundle normalization) is
 * transport-agnostic and fully tested via the fixture client; the confirmed live HTTP client (PR-2c) is
 * then a localized change to `httpWebChartClient` only.
 *
 * No new dependency: the live HTTP client will use the global `fetch` (available on the node-24 host and
 * every @mieweb/cloud target). Transport lives here at the ingress edge, keeping `evaluate-bundle.ts` /
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
 * DEFERRED HTTP client (E12 PR-2c) — the live transport is NOT implemented until MIE confirms the
 * WebChart API contract (Dave Carlson).
 *
 * It intentionally REJECTS rather than doing a best-effort fetch, because the crucial unknown is how to
 * fan out to ONE payload PER PATIENT: a naive `/Patient` searchset handed to `normalizeWebChartBundle`
 * as a single payload would fold every patient's resources into ONE collection bundle — and
 * `CqlExecutionEngine` evaluates only the first subject of a bundle, so a real WebChart run would
 * silently report a single employee and drop/cross-contaminate the rest (Codex P1). Rather than ship
 * that footgun, the default HTTP client fails loudly; the transport-agnostic core (normalize + reconcile)
 * is fully exercised via `fixtureWebChartClient`. PR-2c implements this against the confirmed contract
 * (endpoints, auth, pagination, per-patient fan-out).
 */
export function httpWebChartClient(cfg: WebChartConfig): WebChartClient {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  return {
    kind: "http",
    fetchPatientPayloads(): Promise<unknown[]> {
      return Promise.reject(
        new Error(
          `WebChart HTTP transport not yet implemented (E12 PR-2c) — pending the confirmed WebChart API ` +
            `contract for ${base} (endpoints/auth/pagination + one-payload-per-patient fan-out). Inject a ` +
            `WebChartClient (e.g. fixtureWebChartClient) until then.`,
        ),
      );
    },
  };
}
