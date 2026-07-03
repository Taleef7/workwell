/**
 * The pluggable patient-data ingress (#184 / E12, FHIR-native-first). A PatientDataSource yields the
 * FHIR bundles to evaluate; the engine derives each subject id from its bundle. JSON-bucket is the
 * default, in-memory, DB-less source. The WebChart source is an INERT stub until E12 PR-2
 * (inert-unless-configured, mirroring resolveForecaster / resolveChannel / resolveStandingOrderProvider).
 * NO DB, NO node:fs here — this stays portable across every @mieweb/cloud target.
 */
import { evaluateBatch, type BatchResult, type EvaluateBundleOptions } from "./evaluate-bundle.ts";
import { normalizeWebChartBundle } from "./webchart/normalize.ts";
import { httpWebChartClient, type WebChartClient } from "./webchart/webchart-client.ts";

export interface PatientDataSource {
  /** Diagnostic tag — "json" | "webchart". */
  readonly kind: string;
  /** The bundles ("bucket") to evaluate. DB-less for the JSON source. */
  loadBundles(): Promise<unknown[]>;
}

/** In-memory JSON bucket: one bundle, an array of bundles, or nothing (→ empty bucket). No DB, no fs. */
export function jsonBucketDataSource(input?: unknown | unknown[]): PatientDataSource {
  const bundles = input === undefined ? [] : Array.isArray(input) ? input : [input];
  return { kind: "json", loadBundles: () => Promise.resolve(bundles) };
}

export interface WebChartConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * WebChart data source (E12 PR-2): fetch per-patient payloads from WebChart's HTTP/FHIR API, then
 * normalize + terminology-reconcile each into an engine bundle. The transport is injectable — the
 * default HTTP client is provisional pending the confirmed API contract (Dave Carlson); tests inject a
 * `fixtureWebChartClient`. Selected only when its env vars are set (inert-unless-configured). The real
 * request shaping lives in `webchart/webchart-client.ts`; the reconciliation/normalization core is
 * transport-agnostic and tested. Descriptive only (ADR-008/ADR-017).
 */
export function webChartDataSource(cfg: WebChartConfig, client?: WebChartClient): PatientDataSource {
  const c = client ?? httpWebChartClient(cfg);
  return {
    kind: "webchart",
    async loadBundles() {
      const payloads = await c.fetchPatientPayloads();
      return payloads.map(normalizeWebChartBundle);
    },
  };
}

export interface DataSourceEnv {
  WORKWELL_WEBCHART_BASE_URL?: string;
  WORKWELL_WEBCHART_API_KEY?: string;
}

/**
 * Config-driven ingress selection (mirrors resolveForecaster/resolveChannel): JSON is the default;
 * WebChart is selected only when BOTH env vars are non-blank (inert until PR-2). The JSON source
 * needs the caller's bundles (inherent to JSON ingress), passed as jsonInput.
 */
export function resolveDataSource(env: DataSourceEnv, jsonInput?: unknown | unknown[]): PatientDataSource {
  const baseUrl = (env.WORKWELL_WEBCHART_BASE_URL ?? "").trim();
  const apiKey = (env.WORKWELL_WEBCHART_API_KEY ?? "").trim();
  if (baseUrl && apiKey) return webChartDataSource({ baseUrl, apiKey });
  return jsonBucketDataSource(jsonInput);
}

/** Evaluate every bundle a source yields against a measure (sugar over loadBundles + evaluateBatch). */
export async function evaluateSource(
  source: PatientDataSource,
  measureId: string,
  opts?: EvaluateBundleOptions,
): Promise<BatchResult> {
  return evaluateBatch(await source.loadBundles(), measureId, opts);
}
