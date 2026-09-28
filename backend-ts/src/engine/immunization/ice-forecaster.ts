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
 * - **No history, no forecast (#628):** the dose history is injected, and a source with nothing
 *   for the subject (`null`) returns an empty forecast without dialing ICE. No history source exists
 *   yet, so `resolveForecaster` injects `noIceHistory`; WebChart immunizations are the drop-in (E12).
 * - **Empty on failure:** ANY failure (transport error, non-2xx, timeout, unparseable body, a
 *   vaccine group missing from the response) returns an empty forecast. The advisory panel says it
 *   has no forecast; it never errors the case-detail read, and it never shows one ICE did not make.
 * - **Injected transport + history:** no import cycle, and the sidecar is testable without a
 *   container.
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
  VACCINE_SERIES,
  emptyForecast,
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
 * Every CVX code that COUNTS toward each series, sourced from the WebChart crosswalk — the repo's
 * single authority on vaccine-code membership (2026 currency audit).
 *
 * Why this must be a set and not one representative code per series: ICE scores whatever codes it
 * is given, so a history source that supplies real-world codes — Td `09`/`113`/`196`, any of the 19
 * active seasonal flu codes, Heplisav `189` or HepB `08`/`44`/`45` — produces a correct ICE
 * recommendation. If the display fields only counted one code per series, the panel would claim
 * "no prior dose" for those subjects while ICE's own recommendation was plainly based on them.
 */
export const ICE_SERIES_CVX: Record<VaccineSeries, ReadonlySet<string>> = {
  TDAP: new Set(cvxCodesForMeasure("adult_immunization")),
  INFLUENZA: new Set(cvxCodesForMeasure("flu_vaccine")),
  HEPB: new Set(cvxCodesForMeasure("hepatitis_b_vaccination_series")),
};

/** Heplisav-B — a 2-dose primary series, unlike every other HepB formulation (3 doses). */
const HEPLISAV_CVX = "189";

export interface IceDoseHistory {
  patientId: string;
  dob: string; // YYYY-MM-DD
  gender: "M" | "F";
  doses: IceDose[];
}

/** A subject's dose history, or `null` when the source has none for them (no forecast is made). */
export type IceHistorySource = (subjectId: string) => IceDoseHistory | null;

/**
 * The only history source today: none. WebChart immunizations are the intended source (E12); a
 * network read will need this signature to become async.
 */
export const noIceHistory: IceHistorySource = () => null;

/**
 * Doses required, as ICE would score them — derived from the CVX codes the subject's history
 * ACTUALLY carries.
 *
 * HepB is the one that matters. The `hepatitis_b_vaccination_series` measure defaults to the
 * 2-dose Heplisav model, but the ACIP primary series is **3** doses for every HepB formulation
 * *except* Heplisav-B (CVX 189). Reporting 2 against a traditional 3-dose history renders the
 * self-contradictory card "2 of 2 doses — OVERDUE"; hardcoding 3 would misreport a genuine Heplisav
 * history.
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
  // Count EVERY code that belongs to the series (ICE scored them all) — see ICE_SERIES_CVX.
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
  /** Required, so no caller can end up with a made-up history by leaving it out. */
  historySource: IceHistorySource;
  fetchImpl?: typeof fetch;
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
 * After a failure, stop dialing ICE for this long and answer empty immediately. Without it, an
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
 * set; otherwise `noHistoryForecaster` serves (inert-unless-configured).
 */
export function realIceForecaster(cfg: IceConfig, opts: IceForecasterOptions): ImmunizationForecaster {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const historySource = opts.historySource;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const breakerTtlMs = opts.breakerTtlMs ?? DEFAULT_BREAKER_TTL_MS;
  const now = opts.now ?? (() => Date.now());

  // Circuit breaker: the instant of the last failure. While it is within the TTL, answer empty
  // without dialing — one slow request per TTL instead of one per read.
  let openedAt = 0;

  return {
    async forecast(subjectId: string, asOf: string): Promise<ImmunizationForecast> {
      // Nothing to forecast from: say so, and do not ask ICE to schedule a person with no doses on file
      // as though that were their record.
      let history: IceDoseHistory | null;
      try {
        history = historySource(subjectId);
      } catch (err) {
        // A source that cannot answer must not fail the case read either (the advisory contract above).
        console.warn(`ICE history read failed for ${subjectId}; showing no forecast: ${(err as Error).message}`);
        return emptyForecast(subjectId, asOf, true);
      }
      if (history === null) return emptyForecast(subjectId, asOf, false);
      if (breakerTtlMs > 0 && openedAt !== 0 && now() - openedAt < breakerTtlMs) {
        return emptyForecast(subjectId, asOf, true);
      }
      try {
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
        return { subjectId, asOf, historyAvailable: true, series };
      } catch (err) {
        // Advisory surface — degrade WHOLE, never fail the read (ADR-012), and never to a forecast ICE
        // did not make. Trip the breaker so an unhealthy sidecar costs one timeout per TTL, not one
        // per request.
        openedAt = now();
        console.warn(`ICE forecast failed for ${subjectId}; showing no forecast: ${(err as Error).message}`);
        return emptyForecast(subjectId, asOf, true);
      }
    },
  };
}
