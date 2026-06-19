/**
 * ImmunizationForecast port (#76 E6) — ICE-ready immunization forecasting. The simulated
 * forecaster (default) computes ACIP-style "next dose due" over its OWN deterministic per-subject
 * synthetic immunization history (decoupled from the run pipeline). An inert ICE stub stands in for
 * the real forecaster and is selected ONLY when both WORKWELL_IMMZ_ICE_* env vars are set
 * (inert-unless-configured, mirroring SendGrid/DataChaser). Forecasting is ADVISORY — the CQL
 * Outcome Status remains the sole compliance authority. Doug Q5 (CDS Hooks vs ICE API vs
 * WebChart-ICE bridge) is deferred behind iceForecaster.
 */
export type VaccineSeries = "TDAP" | "INFLUENZA" | "HEPB";
export type ForecastStatus = "UP_TO_DATE" | "DUE" | "OVERDUE" | "CONTRAINDICATED" | "REFUSED";

export const VACCINE_SERIES: readonly VaccineSeries[] = ["TDAP", "INFLUENZA", "HEPB"];

export interface SeriesForecast {
  series: VaccineSeries;
  status: ForecastStatus;
  lastDoseDate: string | null; // ISO date (YYYY-MM-DD) or null
  nextDueDate: string | null;  // null when CONTRAINDICATED
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
  forecast(subjectId: string, asOf: string): ImmunizationForecast;
}

/** Schedule constants — single source of truth, reviewable + testable (AIS-E real windows). */
export const SCHEDULE = {
  TDAP_INTERVAL_DAYS: 3650,    // 10 years
  TDAP_DUE_LEAD_DAYS: 60,
  INFLUENZA_INTERVAL_DAYS: 365,
  INFLUENZA_DUE_LEAD_DAYS: 30,
  HEPB_DOSES_REQUIRED: 3,
  HEPB_DOSE_INTERVAL_DAYS: 30,
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
  forecast(subjectId, asOf) {
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
 * Inert ICE stub — represents the real ICE/CDS-Hooks forecaster. Performs NO HTTP; returns each
 * series with a "not wired" reason. Real transport (Doug Q5) is the only thing that changes here.
 */
export function iceForecaster(_config: { apiKey: string; baseUrl: string }): ImmunizationForecaster {
  return {
    forecast(subjectId, asOf) {
      return {
        subjectId,
        asOf,
        series: VACCINE_SERIES.map((series) => ({
          series,
          status: "DUE" as ForecastStatus,
          lastDoseDate: null,
          nextDueDate: null,
          dosesReceived: 0,
          dosesRequired: SERIES_META[series].dosesRequired,
          reason: "ICE not wired (Doug Q5)",
        })),
      };
    },
  };
}

export function resolveForecaster(env: ForecastEnv): ImmunizationForecaster {
  const apiKey = (env.WORKWELL_IMMZ_ICE_API_KEY ?? "").trim();
  const baseUrl = (env.WORKWELL_IMMZ_ICE_BASE_URL ?? "").trim();
  if (apiKey && baseUrl) return iceForecaster({ apiKey, baseUrl });
  return simulatedForecaster;
}
