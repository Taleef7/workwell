/**
 * Real ICE forecaster (#76 E6 / ADR-029) — the HTTP adapter behind the unchanged
 * `ImmunizationForecast` port, talking to a self-hosted ICE (Immunization Calculation Engine)
 * sidecar over its OpenCDS DSS REST contract (`ice-vmr.ts` carries the codec + the verified
 * contract facts).
 *
 * Design constraints this file honors:
 * - **Advisory only (ADR-012):** a forecast never sets or overrides an `Outcome Status`. CQL stays
 *   the sole compliance authority — this adapter feeds the advisory panel on `/cases/[id]` and
 *   `GET /api/immunization/forecast`, nothing else.
 * - **Deterministic fallback:** ANY failure (transport error, non-2xx, timeout, unparseable body,
 *   a vaccine group missing from the response) falls back to the injected `simulatedForecaster`.
 *   The advisory panel degrades; it never errors the case-detail read.
 * - **Injected fallback + transport + history:** no import cycle, and the sidecar is testable
 *   without a container.
 * - No new deps: plain `fetch` + `AbortController`.
 */
import {
  buildCdsInputXml,
  buildDssRequest,
  parseCdsOutputProposals,
  parseDssResponse,
  type IceDose,
  type IceProposal,
} from "./ice-vmr.ts";
import {
  SCHEDULE,
  VACCINE_SERIES,
  syntheticImmunizationHistory,
  type ForecastStatus,
  type ImmunizationForecast,
  type ImmunizationForecaster,
  type SeriesForecast,
  type VaccineSeries,
} from "./immunization-forecast.ts";

/** WorkWell series → ICE vaccine-group code (codeSystem 2.16.840.1.113883.3.795.12.100.1). */
export const ICE_VACCINE_GROUP: Record<VaccineSeries, string> = {
  TDAP: "200", // DTP Vaccine Group (ICE recommends Tdap/Td within it)
  INFLUENZA: "800",
  HEPB: "100",
};

/** WorkWell series → the CVX code we report historical doses under (CDC CVX, 2.16.840.1.113883.12.292). */
export const ICE_DOSE_CVX: Record<VaccineSeries, string> = {
  TDAP: "115", // Tdap
  INFLUENZA: "141", // Influenza, seasonal, injectable
  HEPB: "43", // HepB, adult 3-dose (the traditional adult formulation ICE scores against)
};

const DOSE_SPACING_DAYS = 60; // back-spacing for earlier doses of a multi-dose series

export interface IceDoseHistory {
  patientId: string;
  dob: string; // YYYY-MM-DD
  gender: "M" | "F";
  doses: IceDose[];
}

export type IceHistorySource = (subjectId: string) => IceDoseHistory;

function addDaysUtc(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * The demo history source: the SAME deterministic per-subject dose history the simulated
 * forecaster uses (`syntheticImmunizationHistory`), re-expressed as CVX-coded dose events ICE can
 * score. A multi-dose series is expanded backwards from its last dose at a fixed spacing, so N
 * doses on file become N dated events. Demographics are derived from the same subject hash (ICE
 * requires a dob + gender to run its schedule).
 *
 * Real WebChart-sourced immunization history is the production drop-in (E12) — swap this source.
 */
export function syntheticIceHistory(subjectId: string): IceDoseHistory {
  const h = hash(subjectId);
  const birthYear = 1965 + (h % 35); // 1965..1999 — an adult working population
  const dob = addDaysUtc(`${birthYear}-01-01`, h % 365);
  const doses: IceDose[] = [];
  for (const d of syntheticImmunizationHistory(subjectId)) {
    for (let i = 0; i < d.dosesReceived; i += 1) {
      // i = 0 is the most recent dose; earlier doses back-space by DOSE_SPACING_DAYS.
      doses.push({ cvx: ICE_DOSE_CVX[d.series], date: addDaysUtc(d.lastDoseDate, -i * DOSE_SPACING_DAYS) });
    }
  }
  doses.sort((a, b) => a.date.localeCompare(b.date));
  return { patientId: subjectId, dob, gender: h % 2 === 0 ? "F" : "M", doses };
}

const DOSES_REQUIRED: Record<VaccineSeries, number> = {
  TDAP: 1,
  INFLUENZA: 1,
  HEPB: SCHEDULE.HEPB_DOSES_REQUIRED,
};

/**
 * Map one ICE proposal onto the port's `SeriesForecast`.
 *
 * - `RECOMMENDED`     → due now: OVERDUE if the proposed date has passed as of `asOf`, else DUE.
 * - `FUTURE_RECOMMENDED` → UP_TO_DATE, carrying the future due date.
 * - `NOT_RECOMMENDED` / `CONDITIONAL` → UP_TO_DATE (series complete, immune, or discretionary);
 *   ICE's reason codes are surfaced verbatim in `reason` so the advisory panel stays honest.
 */
function toSeriesForecast(
  series: VaccineSeries,
  proposal: IceProposal,
  history: IceDoseHistory,
  asOf: string,
): SeriesForecast {
  const cvx = ICE_DOSE_CVX[series];
  const seriesDoses = history.doses.filter((d) => d.cvx === cvx);
  const lastDoseDate = seriesDoses[seriesDoses.length - 1]?.date ?? null;
  const reason = `ICE ${proposal.recommendation}${proposal.interpretations.length ? ` (${proposal.interpretations.join(", ")})` : ""}`;

  let status: ForecastStatus;
  if (proposal.recommendation === "RECOMMENDED") {
    status = proposal.proposedDate !== null && proposal.proposedDate < asOf ? "OVERDUE" : "DUE";
  } else {
    status = "UP_TO_DATE";
  }

  return {
    series,
    status,
    lastDoseDate,
    nextDueDate: proposal.proposedDate,
    dosesReceived: seriesDoses.length,
    dosesRequired: DOSES_REQUIRED[series],
    reason,
  };
}

export interface IceConfig {
  baseUrl: string; // e.g. http://ice:8080/opencds-decision-support-service
  apiKey?: string; // optional — a local sidecar needs none; sent as a bearer token when present
}

export interface IceForecasterOptions {
  /** Required: the forecaster to fall back to on ANY failure (injected — avoids an import cycle). */
  fallback: ImmunizationForecaster;
  fetchImpl?: typeof fetch;
  historySource?: IceHistorySource;
  timeoutMs?: number;
  /** Injected clock (YYYY-MM-DD) so "asOf is today" is decidable under test. */
  today?: () => string;
}

const DEFAULT_TIMEOUT_MS = 15_000; // ICE evaluation is Drools-heavy; a cold engine can take seconds

async function postDss(
  cfg: IceConfig,
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    const res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`ICE ${path} failed: ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The real ICE forecaster. Selected by `resolveForecaster` when `WORKWELL_IMMZ_ICE_BASE_URL` is
 * set; otherwise the simulated forecaster serves (inert-unless-configured).
 */
export function realIceForecaster(cfg: IceConfig, opts: IceForecasterOptions): ImmunizationForecaster {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const historySource = opts.historySource ?? syntheticIceHistory;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const today = opts.today ?? (() => new Date().toISOString().slice(0, 10));

  return {
    async forecast(subjectId: string, asOf: string): Promise<ImmunizationForecast> {
      try {
        const history = historySource(subjectId);
        const cdsInputXml = buildCdsInputXml({
          patientId: history.patientId,
          dob: history.dob,
          gender: history.gender,
          doses: history.doses,
        });
        const request = buildDssRequest({ cdsInputXml, submissionTimeMs: Date.parse(`${asOf}T00:00:00Z`) });

        // An as-of date in the past/future must move ICE's own clock, else every date it proposes
        // is relative to the container's today (verified: /evaluateAtSpecifiedTime shifts them).
        const envelope =
          asOf === today()
            ? await postDss(cfg, "/api/resources/evaluate", request, fetchImpl, timeoutMs)
            : await postDss(
                cfg,
                "/api/resources/evaluateAtSpecifiedTime",
                { specifiedTime: asOf, ...request },
                fetchImpl,
                timeoutMs,
              );

        const proposals = parseCdsOutputProposals(parseDssResponse(envelope));
        const byGroup = new Map(proposals.map((p) => [p.groupCode, p]));
        const series = VACCINE_SERIES.map((s) => {
          const proposal = byGroup.get(ICE_VACCINE_GROUP[s]);
          if (!proposal) throw new Error(`ICE response carried no proposal for ${s} (group ${ICE_VACCINE_GROUP[s]})`);
          return toSeriesForecast(s, proposal, history, asOf);
        });
        return { subjectId, asOf, series };
      } catch (err) {
        // Advisory surface — degrade, never fail the read (ADR-012).
        console.warn(`ICE forecast failed for ${subjectId}; falling back to simulated: ${(err as Error).message}`);
        return opts.fallback.forecast(subjectId, asOf);
      }
    },
  };
}
