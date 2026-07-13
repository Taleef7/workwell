/**
 * ImmunizationForecast port (#76 E6) — immunization forecasting behind one port. The simulated
 * forecaster (default) computes ACIP-style "next dose due" over its OWN deterministic per-subject
 * synthetic immunization history (decoupled from the run pipeline). The REAL forecaster
 * (`realIceForecaster`, `ice-forecaster.ts` — ADR-029) talks to a self-hosted ICE sidecar over the
 * OpenCDS DSS REST contract and is selected ONLY when WORKWELL_IMMZ_ICE_BASE_URL is set
 * (inert-unless-configured, mirroring SendGrid/DataChaser); it falls back to the simulated
 * forecaster on any failure. Forecasting is ADVISORY — the CQL Outcome Status remains the sole
 * compliance authority (ADR-012).
 */
export type VaccineSeries = "TDAP" | "INFLUENZA" | "HEPB";
/** `CONTRAINDICATED` and `REFUSED` are measure-level states surfaced via case enrichment / the CQL path — not produced by `simulatedForecaster`'s own synthetic history. */
export type ForecastStatus = "UP_TO_DATE" | "DUE" | "OVERDUE" | "CONTRAINDICATED" | "REFUSED";

export const VACCINE_SERIES: readonly VaccineSeries[] = ["TDAP", "INFLUENZA", "HEPB"];

export interface SeriesForecast {
  series: VaccineSeries;
  status: ForecastStatus;
  lastDoseDate: string | null; // ISO date (YYYY-MM-DD) or null
  nextDueDate: string | null;  // null when CONTRAINDICATED, when the primary series is complete, or when the forecaster cannot compute (ICE stub)
  dosesReceived: number;
  dosesRequired: number;
  reason: string | null;
}

export interface ImmunizationForecast {
  subjectId: string;
  asOf: string; // YYYY-MM-DD
  series: SeriesForecast[];
}

export interface ImmunizationForecaster {
  /** Async since ADR-029 — the real ICE adapter is an HTTP call to the sidecar. */
  forecast(subjectId: string, asOf: string): Promise<ImmunizationForecast>;
}

/** Schedule constants — single source of truth, reviewable + testable (AIS-E real windows). */
export const SCHEDULE = {
  TDAP_INTERVAL_DAYS: 3650,    // 10 years
  TDAP_DUE_LEAD_DAYS: 60,
  INFLUENZA_INTERVAL_DAYS: 365,
  INFLUENZA_DUE_LEAD_DAYS: 30,
  // E11.2c — Hep B primary series is brand-dependent (Heplisav-B 2-dose ≥28d OR traditional 3-dose).
  // The advisory forecaster models the modern 2-dose Heplisav default (≥2 doses ⇒ complete); the
  // measure's CQL Outcome Status remains the sole compliance authority (ADR-012).
  HEPB_DOSES_REQUIRED: 2,
  HEPB_DOSE_INTERVAL_DAYS: 28,
  HEPB_DUE_LEAD_DAYS: 7,
} as const;

const SERIES_META: Record<VaccineSeries, { intervalDays: number; leadDays: number; dosesRequired: number }> = {
  TDAP: { intervalDays: SCHEDULE.TDAP_INTERVAL_DAYS, leadDays: SCHEDULE.TDAP_DUE_LEAD_DAYS, dosesRequired: 1 },
  INFLUENZA: { intervalDays: SCHEDULE.INFLUENZA_INTERVAL_DAYS, leadDays: SCHEDULE.INFLUENZA_DUE_LEAD_DAYS, dosesRequired: 1 },
  HEPB: { intervalDays: SCHEDULE.HEPB_DOSE_INTERVAL_DAYS, leadDays: SCHEDULE.HEPB_DUE_LEAD_DAYS, dosesRequired: SCHEDULE.HEPB_DOSES_REQUIRED },
};

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

export interface SyntheticDose {
  series: VaccineSeries;
  lastDoseDate: string; // YYYY-MM-DD
  dosesReceived: number;
}

/**
 * Deterministic per-subject immunization history covering all 3 series. Decoupled from the run
 * pipeline / measure synthetic bundle — this is the forecaster's own source so the forecast stays
 * rich (3 series) while the measure remains single-event. Dates are anchored to a fixed epoch so
 * forecasts are stable.
 */
export function syntheticImmunizationHistory(subjectId: string): SyntheticDose[] {
  const h = hash(subjectId);
  const EPOCH = "2020-01-01";
  return VACCINE_SERIES.map((series, i) => {
    const lastDoseDate = addDays(EPOCH, (h + i * 97) % 900);
    const dosesReceived = series === "HEPB" ? 1 + (h % 3) : 1; // 1..3 for HepB
    return { series, lastDoseDate, dosesReceived };
  });
}

function forecastSeries(dose: SyntheticDose, asOf: string): SeriesForecast {
  const meta = SERIES_META[dose.series];
  if (dose.series === "HEPB" && dose.dosesReceived >= meta.dosesRequired) {
    return {
      series: dose.series,
      status: "UP_TO_DATE",
      lastDoseDate: dose.lastDoseDate,
      nextDueDate: null, // primary series complete — lifetime immunity, no booster modeled
      dosesReceived: dose.dosesReceived,
      dosesRequired: meta.dosesRequired,
      reason: "primary series complete",
    };
  }
  if (dose.series === "HEPB" && dose.dosesReceived < meta.dosesRequired) {
    const nextDueDate = addDays(dose.lastDoseDate, meta.intervalDays);
    const overdue = daysBetween(nextDueDate, asOf) > 0;
    return {
      series: dose.series,
      status: overdue ? "OVERDUE" : "DUE",
      lastDoseDate: dose.lastDoseDate,
      nextDueDate,
      dosesReceived: dose.dosesReceived,
      dosesRequired: meta.dosesRequired,
      reason: `dose ${dose.dosesReceived + 1} of ${meta.dosesRequired}`,
    };
  }
  const nextDueDate = addDays(dose.lastDoseDate, meta.intervalDays);
  const daysToDue = daysBetween(asOf, nextDueDate);
  const status: ForecastStatus = daysToDue < 0 ? "OVERDUE" : daysToDue <= meta.leadDays ? "DUE" : "UP_TO_DATE";
  return {
    series: dose.series,
    status,
    lastDoseDate: dose.lastDoseDate,
    nextDueDate,
    dosesReceived: dose.dosesReceived,
    dosesRequired: meta.dosesRequired,
    reason: null,
  };
}

export const simulatedForecaster: ImmunizationForecaster = {
  async forecast(subjectId, asOf) {
    return {
      subjectId,
      asOf,
      series: syntheticImmunizationHistory(subjectId).map((d) => forecastSeries(d, asOf)),
    };
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
// (for the port types + the synthetic history), so selection must sit ABOVE both to avoid an
// import cycle. Same shape as `engine/cql/resolve-value-set-resolver.ts`.
