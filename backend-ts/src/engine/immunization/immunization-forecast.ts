/**
 * ImmunizationForecast port (#76 E6) — immunization forecasting behind one port. The REAL forecaster
 * (`realIceForecaster`, `ice-forecaster.ts` — ADR-029) talks to a self-hosted ICE sidecar over the
 * OpenCDS DSS REST contract and is selected ONLY when WORKWELL_IMMZ_ICE_BASE_URL is set
 * (inert-unless-configured, mirroring SendGrid/DataChaser). Forecasting is ADVISORY — the CQL Outcome
 * Status remains the sole compliance authority (ADR-012).
 *
 * A forecast is only as real as the dose history it reads, and WorkWell has no source of vaccination
 * history for the forecaster yet (WebChart immunizations are the intended source, E12). Until #628 the default forecaster made one
 * up from a hash of the subject id, and the case page rendered it as the person's record ("Tdap — Last
 * 2021-06-03"); a configured ICE was fed the same invented history. Nothing invents clinical data, so
 * with no history the forecast is empty and says why (`historyAvailable: false`).
 */
export type VaccineSeries = "TDAP" | "INFLUENZA" | "HEPB";
/** `CONTRAINDICATED` and `REFUSED` are measure-level states surfaced via case enrichment / the CQL path. */
export type ForecastStatus = "UP_TO_DATE" | "DUE" | "OVERDUE" | "CONTRAINDICATED" | "REFUSED";

export const VACCINE_SERIES: readonly VaccineSeries[] = ["TDAP", "INFLUENZA", "HEPB"];

export interface SeriesForecast {
  series: VaccineSeries;
  status: ForecastStatus;
  lastDoseDate: string | null; // ISO date (YYYY-MM-DD) or null
  nextDueDate: string | null;  // null when CONTRAINDICATED, or when the primary series is complete
  dosesReceived: number;
  dosesRequired: number;
  reason: string | null;
}

export interface ImmunizationForecast {
  subjectId: string;
  asOf: string; // YYYY-MM-DD
  /**
   * Whether the forecaster had a dose history to read. False means `series` is empty because there
   * is nothing to forecast from, and the case page says so. True with an empty `series` means the
   * forecaster could not answer this time (the ICE sidecar failed).
   */
  historyAvailable: boolean;
  series: SeriesForecast[];
}

export interface ImmunizationForecaster {
  /** Async since ADR-029 — the real ICE adapter is an HTTP call to the sidecar. */
  forecast(subjectId: string, asOf: string): Promise<ImmunizationForecast>;
}

/** A forecast with no series: no history to read (`historyAvailable: false`), or no answer this time. */
export function emptyForecast(subjectId: string, asOf: string, historyAvailable: boolean): ImmunizationForecast {
  return { subjectId, asOf, historyAvailable, series: [] };
}

/** The unconfigured default, and what any forecaster answers without a dose history: nothing. */
export const noHistoryForecaster: ImmunizationForecaster = {
  async forecast(subjectId, asOf) {
    return emptyForecast(subjectId, asOf, false);
  },
};

export interface ForecastEnv {
  WORKWELL_IMMZ_ICE_API_KEY?: string;
  WORKWELL_IMMZ_ICE_BASE_URL?: string;
}

/**
 * Pure predicate for whether the real ICE forecaster is selected — BASE_URL alone (ADR-029: a
 * self-hosted ICE sidecar has no API key; WORKWELL_IMMZ_ICE_API_KEY stays optional and is sent as
 * a bearer token only when a deployment fronts ICE with an authenticating proxy). The single
 * source of truth for `resolveForecaster` and the boot-time seam inventory (#260).
 */
export function isIceConfigured(env: ForecastEnv): boolean {
  return Boolean((env.WORKWELL_IMMZ_ICE_BASE_URL ?? "").trim());
}

// `resolveForecaster` lives in `resolve-forecaster.ts` — the real ICE adapter imports this module
// (for the port types), so selection must sit ABOVE both to avoid an import cycle. Same shape as
// `engine/cql/resolve-value-set-resolver.ts`.
