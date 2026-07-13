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
import { cvxCodesForMeasure } from "../ingress/webchart/terminology.ts";
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

/**
 * WorkWell series → the CVX code the SYNTHETIC history emits for a dose (CDC CVX,
 * 2.16.840.1.113883.12.292). This is what we *write*; it is NOT the set we *recognize* — see
 * `ICE_SERIES_CVX`.
 */
export const ICE_DOSE_CVX: Record<VaccineSeries, string> = {
  TDAP: "115", // Tdap
  INFLUENZA: "141", // Influenza, seasonal, injectable
  HEPB: "43", // HepB, adult 3-dose (the traditional adult formulation ICE scores against)
};

/**
 * Every CVX code that COUNTS toward each series, sourced from the WebChart crosswalk — the repo's
 * single authority on vaccine-code membership (2026 currency audit).
 *
 * Why this must be a set and not `ICE_DOSE_CVX`: ICE scores whatever codes it is given, so a history
 * source that supplies real-world codes — Td `09`/`113`/`196`, any of the 19 active seasonal flu
 * codes, Heplisav `189` or HepB `08`/`44`/`45` — produces a correct ICE recommendation. If the
 * display fields only counted the one representative code the synthetic generator happens to emit,
 * the panel would claim "no prior dose" for those subjects while ICE's own recommendation was
 * plainly based on them. That mismatch lands the moment the E12 WebChart history source is injected.
 */
export const ICE_SERIES_CVX: Record<VaccineSeries, ReadonlySet<string>> = {
  TDAP: new Set(cvxCodesForMeasure("adult_immunization")),
  INFLUENZA: new Set(cvxCodesForMeasure("flu_vaccine")),
  HEPB: new Set(cvxCodesForMeasure("hepatitis_b_vaccination_series")),
};

/** Heplisav-B — a 2-dose primary series, unlike every other HepB formulation (3 doses). */
const HEPLISAV_CVX = "189";

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

/**
 * Doses required, as ICE would score them — derived from the CVX codes the subject's history
 * ACTUALLY carries, not from the simulated forecaster's schedule.
 *
 * HepB is the one that matters. `SCHEDULE.HEPB_DOSES_REQUIRED` is **2** (the Heplisav model the
 * simulated forecaster and the `hepatitis_b_vaccination_series` measure default to), but the ACIP
 * primary series is **3** doses for every HepB formulation *except* Heplisav-B (CVX 189). Reporting
 * the simulated 2 against a traditional 3-dose history renders the self-contradictory card
 * "2 of 2 doses — OVERDUE"; hardcoding 3 would misreport a genuine Heplisav history.
 */
function iceDosesRequired(series: VaccineSeries, seriesDoses: IceDose[]): number {
  if (series !== "HEPB") return 1;
  // Heplisav-B is a 2-dose series — but only if that is what the subject actually received.
  const allHeplisav = seriesDoses.length > 0 && seriesDoses.every((d) => d.cvx === HEPLISAV_CVX);
  return allHeplisav ? 2 : 3;
}

/**
 * Map one ICE proposal onto the port's `SeriesForecast`.
 *
 * - `RECOMMENDED`     → due now: OVERDUE if the proposed date has passed as of `asOf`, else DUE.
 * - `FUTURE_RECOMMENDED` → UP_TO_DATE, carrying the future due date.
 * - `NOT_RECOMMENDED` / `CONDITIONAL` → UP_TO_DATE (series complete, immune, or discretionary).
 *
 * **`CONDITIONAL` is deliberately NOT surfaced as DUE.** ICE emits it for risk-conditional
 * recommendations ("recommended for high-risk groups"), and an occupational-health cohort often IS
 * that high-risk group — but we do not send ICE a risk group, so ICE cannot have applied one, and we
 * must not silently assert one on its behalf. Rendering every CONDITIONAL as DUE would manufacture
 * work items ICE did not unconditionally recommend. The recommendation and ICE's own reason codes
 * are surfaced verbatim in `reason` (e.g. `ICE CONDITIONAL (HIGH_RISK)`) so the panel stays honest,
 * and a risk-group-aware mapping is future work — it needs the OH risk cohort in the CDSInput first.
 */
function toSeriesForecast(
  series: VaccineSeries,
  proposal: IceProposal,
  history: IceDoseHistory,
  asOf: string,
): SeriesForecast {
  // Count EVERY code that belongs to the series (ICE scored them all), not just the representative
  // code the synthetic generator emits — see ICE_SERIES_CVX.
  const seriesDoses = history.doses.filter((d) => ICE_SERIES_CVX[series].has(d.cvx));
  const lastDoseDate = seriesDoses[seriesDoses.length - 1]?.date ?? null;
  const reason = `ICE ${proposal.recommendation}${proposal.interpretations.length ? ` (${proposal.interpretations.join(", ")})` : ""}`;

  let status: ForecastStatus;
  if (proposal.recommendation === "RECOMMENDED") {
    status = proposal.proposedDate !== null && proposal.proposedDate < asOf ? "OVERDUE" : "DUE";
  } else {
    status = "UP_TO_DATE";
  }

  // `dosesReceived`/`dosesRequired` mean "progress toward the current requirement", not a lifetime
  // tally — so clamp. A real Td/flu history routinely carries several lifetime boosters against a
  // per-cycle requirement of 1, which would otherwise render the nonsensical card "2 of 1 doses"
  // (and a 4th HepB dose "4 of 3"). `lastDoseDate` and ICE's own `reason` carry the full truth.
  const dosesRequired = iceDosesRequired(series, seriesDoses);

  return {
    series,
    status,
    lastDoseDate,
    nextDueDate: proposal.proposedDate,
    dosesReceived: Math.min(seriesDoses.length, dosesRequired),
    dosesRequired,
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
  /** Per-call budget. Defaults to a REQUEST-path budget — see DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Negative-cache TTL after a failure (ms). 0 disables the breaker. */
  breakerTtlMs?: number;
  /** Injected clock (epoch ms) — only used by the breaker, so it is testable without fake timers. */
  now?: () => number;
}

/**
 * REQUEST-path budget, not a cold-start budget. A warm ICE answers in ~50–300 ms (measured), so 3 s
 * is generous; the sidecar's tens-of-seconds Drools *cold start* must not be charged to an
 * interactive `GET /api/cases/:id`. A caller doing offline/batch work can raise this explicitly.
 */
const DEFAULT_TIMEOUT_MS = 3_000;

/**
 * After a failure, stop dialing ICE for this long and serve the fallback immediately. Without it, an
 * unhealthy sidecar (hung, OOM-thrashing, restarting) costs EVERY case-detail read the full timeout,
 * forever — an interactive-latency incident whose only symptom is a slow page.
 */
const DEFAULT_BREAKER_TTL_MS = 60_000;

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
  const breakerTtlMs = opts.breakerTtlMs ?? DEFAULT_BREAKER_TTL_MS;
  const now = opts.now ?? (() => Date.now());

  // Circuit breaker: the instant of the last failure. While it is within the TTL, serve the fallback
  // without dialing — one slow request per TTL instead of one per read.
  let openedAt = 0;

  return {
    async forecast(subjectId: string, asOf: string): Promise<ImmunizationForecast> {
      if (breakerTtlMs > 0 && openedAt !== 0 && now() - openedAt < breakerTtlMs) {
        return opts.fallback.forecast(subjectId, asOf);
      }
      try {
        const history = historySource(subjectId);
        const cdsInputXml = buildCdsInputXml({
          patientId: history.patientId,
          dob: history.dob,
          gender: history.gender,
          doses: history.doses,
        });
        const request = buildDssRequest({ cdsInputXml, submissionTimeMs: Date.parse(`${asOf}T00:00:00Z`) });

        // ALWAYS pin ICE's clock to `asOf` — even when asOf is today. /evaluate would evaluate at the
        // *container's* clock, so a TZ-skewed or drifting ICE host would shift "today" forecasts by a
        // day while as-of forecasts stayed correct. Verified live: /evaluateAtSpecifiedTime with
        // today's date returns byte-identical proposals to /evaluate, so pinning costs nothing.
        const envelope = await postDss(
          cfg,
          "/api/resources/evaluateAtSpecifiedTime",
          { specifiedTime: asOf, ...request },
          fetchImpl,
          timeoutMs,
        );

        const proposals = parseCdsOutputProposals(parseDssResponse(envelope));
        // First proposal wins per group: if ICE ever emits two for one group (e.g. a Td and a Tdap
        // product), document-order is deterministic — a Map built by last-write would pick arbitrarily.
        const byGroup = new Map<string, IceProposal>();
        for (const p of proposals) if (!byGroup.has(p.groupCode)) byGroup.set(p.groupCode, p);

        const series = VACCINE_SERIES.map((s) => {
          const proposal = byGroup.get(ICE_VACCINE_GROUP[s]);
          if (!proposal) throw new Error(`ICE response carried no proposal for ${s} (group ${ICE_VACCINE_GROUP[s]})`);
          return toSeriesForecast(s, proposal, history, asOf);
        });
        openedAt = 0; // healthy again
        return { subjectId, asOf, series };
      } catch (err) {
        // Advisory surface — degrade WHOLE, never fail the read (ADR-012). Trip the breaker so an
        // unhealthy sidecar costs one timeout per TTL, not one per request.
        openedAt = now();
        console.warn(`ICE forecast failed for ${subjectId}; falling back to simulated: ${(err as Error).message}`);
        return opts.fallback.forecast(subjectId, asOf);
      }
    },
  };
}
