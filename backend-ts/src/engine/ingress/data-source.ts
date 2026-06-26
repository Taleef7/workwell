/**
 * The pluggable patient-data ingress (#184 / E12, FHIR-native-first). A PatientDataSource yields the
 * FHIR bundles to evaluate; the engine derives each subject id from its bundle. JSON-bucket is the
 * default, in-memory, DB-less source. The WebChart source is an INERT stub until E12 PR-2
 * (inert-unless-configured, mirroring resolveForecaster / resolveChannel / resolveStandingOrderProvider).
 * NO DB, NO node:fs here — this stays portable across every @mieweb/cloud target.
 */
import { evaluateBatch, type BatchResult, type EvaluateBundleOptions } from "./evaluate-bundle.ts";

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

/** Inert WebChart stub — wired in E12 PR-2. Selected only when its env vars are set. */
export function webChartDataSource(_cfg: WebChartConfig): PatientDataSource {
  return {
    kind: "webchart",
    loadBundles: () => Promise.reject(new Error("WebChart data source not yet wired (E12 PR-2)")),
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
