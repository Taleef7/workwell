# E6 — Immunization & Forecasting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add immunization forecasting behind an ICE-ready port plus a real adult-immunization (AIS-E Td/Tdap) measure with contraindication/refusal handling, surfaced via an endpoint and an advisory case-detail panel.

**Architecture:** Mirror E5's `OutreachChannel` pattern — an `ImmunizationForecast` port with a simulated forecaster by default and an inert ICE stub selected only when configured (Doug Q5 deferred). The forecaster owns its own deterministic per-subject 3-series immunization synthesis, so it stays decoupled from the single-event measure path. The measure `adult_immunization` (Td/Tdap, 10-year window) runs through the existing CQL→ELM + synthetic-bundle pipeline. No schema change; forecast is read-time, advisory; CQL still owns compliance.

**Tech Stack:** TypeScript on `@mieweb/cloud`, `cql-execution` + `cql-exec-fhir` (build-time CQL→ELM via `scripts/compile-measures.mjs`), Node test runner (`node --import tsx --test`), Next.js 16 frontend.

**Spec:** `docs/superpowers/specs/2026-06-19-e6-immunization-forecasting-design.md`

**Conventions observed in this repo:**
- Tests are `*.test.ts` colocated with source; run all with `cd backend-ts; pnpm test`; run one file with `cd backend-ts; node --import tsx --test src/path/file.test.ts`.
- Route handlers are `handleX(req, env): Promise<Response | null>` (return `null` to fall through), mounted in `backend-ts/src/worker.ts`.
- Commit per task; conventional commits scoped `(engine|routes|measure|frontend|docs): #76 E6 — …`.
- Append `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and `Claude-Session:` trailer to commit messages (match existing history).

---

## File Structure

**W1 — Forecast port + endpoint**
- Create `backend-ts/src/engine/immunization/immunization-forecast.ts` — port types, schedule constants, `syntheticImmunizationHistory`, `simulatedForecaster`, `iceForecaster`, `resolveForecaster`.
- Create `backend-ts/src/engine/immunization/immunization-forecast.test.ts`.
- Create `backend-ts/src/routes/immunization.ts` — `handleImmunizationForecast`.
- Create `backend-ts/src/routes/immunization.test.ts`.
- Modify `backend-ts/src/worker.ts` — mount the handler.

**W2 — AIS-E Td/Tdap measure**
- Create `backend-ts/measures/adult_immunization.cql` + `adult_immunization.yaml`.
- Regenerate `backend-ts/src/engine/cql/elm/AdultImmunizationTdap-1.0.0.elm.json` + `elm/index.ts` (via `compile-measures.mjs`).
- Regenerate `backend-ts/src/engine/synthetic/measure-bindings.ts` (via `gen-measure-bindings.mjs`).
- Modify `backend-ts/src/engine/synthetic/measure-bindings.ts` type — add optional `refusal?: CodeBinding` to `MeasureBinding` (and the generator).
- Modify `backend-ts/src/engine/cql/measure-registry.ts` — add `adult_immunization` entry.
- Modify `backend-ts/src/measure/measure-catalog.ts` — seed Active.
- Modify `backend-ts/src/engine/synthetic/exam-config.ts` — add `refused` to `ExamConfig` + a setter helper.
- Modify `backend-ts/src/engine/synthetic/fhir-bundle-builder.ts` — emit refusal `Condition`.
- Modify `backend-ts/src/engine/cql/cql-execution-engine.test.ts` — golden scenarios.

**W3 — Forecast surfacing**
- Modify `backend-ts/src/case/case-detail-read-model.ts` — add optional `immunizationForecast` to `CaseDetail`.
- Modify the case-detail route assembly (where `toCaseDetail` is called) — compute + attach forecast.
- Modify `frontend/app/(dashboard)/cases/[id]/…` — advisory forecast panel.

**Docs**
- `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/MEASURES.md`, `docs/DECISIONS.md` (ADR-012), `docs/JOURNAL.md`, `README.md`.

---

## Phase W1 — ImmunizationForecast port

### Task 1: Forecast port types + schedule constants + synthetic history

**Files:**
- Create: `backend-ts/src/engine/immunization/immunization-forecast.ts`
- Test: `backend-ts/src/engine/immunization/immunization-forecast.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend-ts/src/engine/immunization/immunization-forecast.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  syntheticImmunizationHistory,
  simulatedForecaster,
  resolveForecaster,
  iceForecaster,
  VACCINE_SERIES,
} from "./immunization-forecast.ts";

test("synthetic history is deterministic per subject and covers all 3 series", () => {
  const a = syntheticImmunizationHistory("emp-006");
  const b = syntheticImmunizationHistory("emp-006");
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.map((h) => h.series).sort(),
    [...VACCINE_SERIES].sort(),
  );
});

test("simulated forecaster returns a forecast for all 3 series with computed nextDueDate", () => {
  const f = simulatedForecaster.forecast("emp-006", "2026-06-19");
  assert.equal(f.subjectId, "emp-006");
  assert.equal(f.asOf, "2026-06-19");
  assert.equal(f.series.length, 3);
  for (const s of f.series) {
    assert.ok(["UP_TO_DATE", "DUE", "OVERDUE", "CONTRAINDICATED", "REFUSED"].includes(s.status));
  }
});

test("Td/Tdap is OVERDUE when last dose > 10 years before asOf", () => {
  // subject whose synthetic TDAP last dose is forced old via asOf far in the future
  const f = simulatedForecaster.forecast("emp-006", "2099-01-01");
  const tdap = f.series.find((s) => s.series === "TDAP")!;
  assert.equal(tdap.status, "OVERDUE");
});

test("resolveForecaster returns simulated by default", () => {
  assert.equal(resolveForecaster({}), simulatedForecaster);
});

test("resolveForecaster returns the ICE stub only when both env vars set; stub is inert", () => {
  const env = { WORKWELL_IMMZ_ICE_API_KEY: "k", WORKWELL_IMMZ_ICE_BASE_URL: "https://ice.example" };
  const f = resolveForecaster(env);
  assert.notEqual(f, simulatedForecaster);
  const out = f.forecast("emp-006", "2026-06-19");
  // inert: every series carries the not-wired reason and no real call happened
  assert.ok(out.series.every((s) => (s.reason ?? "").includes("ICE not wired")));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/engine/immunization/immunization-forecast.test.ts`
Expected: FAIL — cannot find module `./immunization-forecast.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// backend-ts/src/engine/immunization/immunization-forecast.ts
/**
 * ImmunizationForecast port (#76 E6) — ICE-ready immunization forecasting. The simulated
 * forecaster (default) computes ACIP-style "next dose due" over its OWN deterministic per-subject
 * synthetic immunization history (decoupled from the run pipeline). An inert ICE stub stands in for
 * the real forecaster and is selected ONLY when both WORKWELL_IMMZ_ICE_* env vars are set
 * (inert-unless-configured, mirroring SendGrid/DataChaser). Forecasting is ADVISORY — the CQL
 * Outcome Status remains the sole compliance authority (see docs/AI_GUARDRAILS.md analog). Doug Q5
 * (CDS Hooks vs ICE API vs WebChart-ICE bridge) is deferred behind iceForecaster.
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
  TDAP_DUE_LEAD_DAYS: 60,      // "DUE" when within 60 days of the 10y mark
  INFLUENZA_INTERVAL_DAYS: 365,
  INFLUENZA_DUE_LEAD_DAYS: 30,
  HEPB_DOSES_REQUIRED: 3,
  HEPB_DOSE_INTERVAL_DAYS: 30, // simplified inter-dose interval for the simulated forecaster
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
 * forecasts are stable regardless of "today".
 */
export function syntheticImmunizationHistory(subjectId: string): SyntheticDose[] {
  const h = hash(subjectId);
  const EPOCH = "2020-01-01";
  return VACCINE_SERIES.map((series, i) => {
    const meta = SERIES_META[series];
    // spread last-dose ages deterministically across subjects
    const ageDays = (h >> (i * 4)) % (meta.intervalDays + 400);
    const lastDoseDate = addDays(EPOCH, ((h + i * 97) % 900)); // a date near the epoch
    const dosesReceived = series === "HEPB" ? 1 + (h % 3) : 1; // 1..3 for HepB
    return { series, lastDoseDate, dosesReceived, _ageDays: ageDays } as SyntheticDose;
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
```

Note: remove the `_ageDays` helper field if `tsc` objects to the cast — it is illustrative; the
deterministic spread can also be folded into `lastDoseDate`. Keep `SyntheticDose` to its three
declared fields if so.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/engine/immunization/immunization-forecast.test.ts`
Expected: PASS (5 tests). If the "OVERDUE at 2099" assertion fails, widen the `asOf` or confirm `nextDueDate` math — the intent is any realistic last-dose + 10y is far before 2099.

- [ ] **Step 5: Typecheck**

Run: `cd backend-ts && pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend-ts/src/engine/immunization/
git commit -m "feat(engine): #76 E6 — ImmunizationForecast port (simulated default, inert ICE stub)"
```

### Task 2: Forecast endpoint `GET /api/immunization/forecast`

**Files:**
- Create: `backend-ts/src/routes/immunization.ts`
- Test: `backend-ts/src/routes/immunization.test.ts`
- Modify: `backend-ts/src/worker.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend-ts/src/routes/immunization.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleImmunizationForecast } from "./immunization.ts";

const env = {} as never;
const get = (qs: string) =>
  handleImmunizationForecast(new Request(`http://x/api/immunization/forecast${qs}`, { method: "GET" }), env);

test("returns a forecast for a subject", async () => {
  const res = await get("?subjectId=emp-006");
  assert.equal(res!.status, 200);
  const body = await res!.json();
  assert.equal(body.subjectId, "emp-006");
  assert.equal(body.series.length, 3);
});

test("400 on missing subjectId", async () => {
  const res = await get("");
  assert.equal(res!.status, 400);
});

test("400 on malformed asOf", async () => {
  const res = await get("?subjectId=emp-006&asOf=2026-13-99");
  assert.equal(res!.status, 400);
});

test("falls through (null) on non-matching path/method", async () => {
  const res = await handleImmunizationForecast(new Request("http://x/api/other", { method: "GET" }), env);
  assert.equal(res, null);
  const post = await handleImmunizationForecast(new Request("http://x/api/immunization/forecast", { method: "POST" }), env);
  assert.equal(post, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/routes/immunization.test.ts`
Expected: FAIL — cannot find module `./immunization.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// backend-ts/src/routes/immunization.ts
/**
 * Immunization forecast route (#76 E6) — advisory ICE-ready forecasting behind the unchanged
 * frontend contract. Authenticated under /api/** by the worker's security matrix. Read-time over
 * the forecaster's synthetic history; no schema.
 *
 *   GET /api/immunization/forecast?subjectId=&asOf=  → ImmunizationForecast
 */
import { resolveForecaster, type ForecastEnv } from "../engine/immunization/immunization-forecast.ts";
import { parseQueryDate, QueryDateError } from "./query-dates.ts";

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handleImmunizationForecast(req: Request, env: ForecastEnv): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  if (url.pathname !== "/api/immunization/forecast") return null;

  const subjectId = (url.searchParams.get("subjectId") ?? "").trim();
  if (!subjectId) return json({ error: "invalid_request", message: "subjectId is required" }, 400);

  let asOf: string | undefined;
  try {
    asOf = parseQueryDate(url.searchParams.get("asOf"), "asOf");
  } catch (err) {
    if (err instanceof QueryDateError) return json({ error: "invalid_request", message: err.message }, 400);
    throw err;
  }
  const today = new Date().toISOString().slice(0, 10);
  const forecast = resolveForecaster(env).forecast(subjectId, asOf ?? today);
  return json(forecast);
}
```

Verify `parseQueryDate(null, name)` returns `undefined` (it does for the hierarchy route's optional
`from`/`to`); if it throws on null, pass through only when the param is present.

- [ ] **Step 4: Mount in worker.ts**

In `backend-ts/src/worker.ts`, add the import near the other route imports (by `handleHierarchy`, line ~27):

```ts
import { handleImmunizationForecast } from "./routes/immunization.ts";
```

And add the dispatch near the `handleHierarchy` dispatch (line ~188), following the exact same shape:

```ts
  const immunizationResponse = await handleImmunizationForecast(req, env);
  if (immunizationResponse) return immunizationResponse;
```

Place it inside the same authenticated `/api/**` block as `handleHierarchy` so the security matrix applies.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd backend-ts && node --import tsx --test src/routes/immunization.test.ts && pnpm typecheck`
Expected: PASS (4 tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add backend-ts/src/routes/immunization.ts backend-ts/src/routes/immunization.test.ts backend-ts/src/worker.ts
git commit -m "feat(routes): #76 E6 — GET /api/immunization/forecast endpoint"
```

---

## Phase W2 — AIS-E Td/Tdap measure

### Task 3: Author the CQL + YAML

**Files:**
- Create: `backend-ts/measures/adult_immunization.cql`
- Create: `backend-ts/measures/adult_immunization.yaml`

- [ ] **Step 1: Write the CQL** (mirrors `flu_vaccine.cql` structure; recency-based, 10-year window)

```cql
-- backend-ts/measures/adult_immunization.cql
library AdultImmunizationTdap version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

valueset "Tdap Vaccines": 'urn:workwell:vs:tdap-vaccines'
valueset "Adult Immunization Enrollment": 'urn:workwell:vs:adult-immz-enrollment'
valueset "Tdap Contraindication": 'urn:workwell:vs:tdap-contraindication'
valueset "Tdap Refusal": 'urn:workwell:vs:tdap-refusal'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "Enrolled Adult":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:adult-immz-enrollment' and x.code = 'adult-immz-enrolled'))

define "Has Contraindication":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:tdap-contraindication' and x.code = 'tdap-contraindication'))

define "Refused":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:tdap-refusal' and x.code = 'tdap-refusal'))

define "Most Recent Tdap Date":
  Last(
    [Immunization] I
      where exists(I.vaccineCode.coding C where C.system = 'urn:workwell:vs:tdap-vaccines' and C.code = 'tdap-vaccine')
      sort by (occurrence as FHIR.dateTime)
  ).occurrence as FHIR.dateTime

define "Days Since Last Tdap":
  difference in days between
    Coalesce("Most Recent Tdap Date", @1900-01-01T00:00:00.0)
    and Now()

define "Up To Date":
  "Enrolled Adult" and not "Has Contraindication"
    and "Most Recent Tdap Date" is not null
    and "Days Since Last Tdap" <= 3650

define "Due Soon":
  "Enrolled Adult" and not "Has Contraindication"
    and "Most Recent Tdap Date" is not null
    and "Days Since Last Tdap" > 3590
    and "Days Since Last Tdap" <= 3650

define "Overdue":
  "Enrolled Adult" and not "Has Contraindication"
    and "Most Recent Tdap Date" is not null
    and "Days Since Last Tdap" > 3650

define "Missing Data":
  "Enrolled Adult" and not "Has Contraindication"
    and "Most Recent Tdap Date" is null

define "Excluded": "Has Contraindication"

define "Initial Population": "Enrolled Adult" or "Has Contraindication"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Up To Date" then 'COMPLIANT'
  else if "Overdue" then 'OVERDUE'
  else if "Due Soon" then 'DUE_SOON'
  else if "Missing Data" then 'MISSING_DATA'
  else 'MISSING_DATA'
```

Note: `"Up To Date"` excludes the DUE_SOON band only via ordering in `Outcome Status`
(COMPLIANT is checked first, so an employee in 3591..3650 days is both "Up To Date" and "Due Soon"
but resolves COMPLIANT). To make DUE_SOON reachable, change `"Up To Date"` upper bound to `< 3590`
OR check "Due Soon" before "Up To Date" in `Outcome Status`. **Choose: check Due Soon before Up To
Date** — update `Outcome Status` accordingly:

```cql
define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Overdue" then 'OVERDUE'
  else if "Due Soon" then 'DUE_SOON'
  else if "Up To Date" then 'COMPLIANT'
  else if "Missing Data" then 'MISSING_DATA'
  else 'MISSING_DATA'
```

`"Refused"` is intentionally NOT in `Outcome Status` (refusal keeps the case open — its bucket is
whatever the recency yields, e.g. OVERDUE) but IS exposed as an evidence define for `why_flagged`.

- [ ] **Step 2: Write the YAML** (mirrors `flu_vaccine.yaml`; adds the optional `refusal` binding)

```yaml
# backend-ts/measures/adult_immunization.yaml
id: adult_immunization
name: Adult Immunization Status (Td/Tdap)
version: 1.0.0
title: Adult Immunization Status — Td/Tdap (AIS-E)
policyRef: NCQA HEDIS Adult Immunization Status (AIS-E)
tags: [wellness, immunization, adult, hedis]
cql: adult_immunization.cql
bindings:
  rateKey: adult_immunization
  complianceWindowDays: 3650
  enrollment: { code: adult-immz-enrolled, valueSet: "urn:workwell:vs:adult-immz-enrollment" }
  waiver:     { code: tdap-contraindication, valueSet: "urn:workwell:vs:tdap-contraindication" }
  event:      { code: tdap-vaccine, valueSet: "urn:workwell:vs:tdap-vaccines", type: immunization }
  refusal:    { code: tdap-refusal, valueSet: "urn:workwell:vs:tdap-refusal" }
```

Confirm the existing YAMLs' binding key name for the window (`complianceWindowDays`) matches what
`gen-measure-bindings.mjs` reads — check `flu_vaccine.yaml` does not set it explicitly (it is
derived). If the generator derives the window elsewhere, set it the same way the other 365-day
measures do and hard-code 3650 in the generated binding via the yaml field the generator supports.

- [ ] **Step 3: Commit (CQL + YAML only; generated artifacts next task)**

```bash
git add backend-ts/measures/adult_immunization.cql backend-ts/measures/adult_immunization.yaml
git commit -m "feat(measure): #76 E6 — AIS-E Td/Tdap CQL + YAML binding"
```

### Task 4: Add optional `refusal` to the binding model + generator

**Files:**
- Modify: `backend-ts/src/engine/synthetic/measure-bindings.ts` (the `MeasureBinding` interface — note the data block is regenerated)
- Modify: `backend-ts/scripts/gen-measure-bindings.mjs`

- [ ] **Step 1: Read the generator**

Run: `cat backend-ts/scripts/gen-measure-bindings.mjs` and identify where it maps each yaml `bindings`
block to the emitted object literal.

- [ ] **Step 2: Add the optional `refusal` field to the emitted shape**

In `gen-measure-bindings.mjs`, where it emits `enrollment`/`waiver`/`event`, conditionally append
`refusal` when present in the yaml:

```js
// inside the per-measure emit, after event:
const refusal = b.refusal ? `, refusal: ${JSON.stringify(b.refusal)}` : "";
// include `${refusal}` in the emitted object literal
```

And add to the interface in the generator's header template (the `MeasureBinding` interface that the
script writes at the top of `measure-bindings.ts`):

```ts
  event: CodeBinding & { type: EventType };
  refusal?: CodeBinding;
```

- [ ] **Step 3: Regenerate bindings**

Run: `cd backend-ts && node scripts/gen-measure-bindings.mjs`
Expected: `src/engine/synthetic/measure-bindings.ts` now includes an `adult_immunization` entry with
`refusal`, and the interface has the optional `refusal?` field. The other 9 measures are byte-identical
except formatting — verify with `git diff` that no existing measure's codes changed.

- [ ] **Step 4: Typecheck**

Run: `cd backend-ts && pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add backend-ts/scripts/gen-measure-bindings.mjs backend-ts/src/engine/synthetic/measure-bindings.ts
git commit -m "feat(engine): #76 E6 — optional refusal binding + regenerate measure-bindings"
```

### Task 5: Compile CQL → ELM + register the measure

**Files:**
- Generated: `backend-ts/src/engine/cql/elm/AdultImmunizationTdap-1.0.0.elm.json`, `elm/index.ts`
- Modify: `backend-ts/src/engine/cql/measure-registry.ts`

- [ ] **Step 1: Compile measures**

Run: `cd backend-ts && node scripts/compile-measures.mjs`
Expected: a new `AdultImmunizationTdap-1.0.0.elm.json` appears under `src/engine/cql/elm/`, and
`elm/index.ts` is regenerated to import + register it. Confirm with `git status`. If the script
errors on the CQL, fix the CQL syntax (compare against `flu_vaccine.cql`) and re-run.

- [ ] **Step 2: Register the measure**

In `backend-ts/src/engine/cql/measure-registry.ts`, add to `MEASURES` (after `flu_vaccine`):

```ts
  adult_immunization: { id: "adult_immunization", name: "Adult Immunization Status (Td/Tdap)", library: "AdultImmunizationTdap-1.0.0", periodMonths: 0 },
```

The `name` MUST exactly match the seed name in `measure-catalog.ts` (Task 6) — the engine binds CQL
by measure name (`forMeasure`).

- [ ] **Step 3: Typecheck**

Run: `cd backend-ts && pnpm typecheck`
Expected: no errors (the generated ELM json import resolves).

- [ ] **Step 4: Commit**

```bash
git add backend-ts/src/engine/cql/elm/ backend-ts/src/engine/cql/measure-registry.ts
git commit -m "feat(engine): #76 E6 — compile AIS-E Td/Tdap ELM + register measure"
```

### Task 6: Seed the measure Active

**Files:**
- Modify: `backend-ts/src/measure/measure-catalog.ts`

- [ ] **Step 1: Add the Active seed entry**

In `backend-ts/src/measure/measure-catalog.ts`, add an entry alongside the other Active HEDIS
wellness measures (after the `hypertension` entry), matching the existing JSON shape exactly. Name
MUST equal the registry name from Task 5:

```ts
  {"id":"adult_immunization","name":"Adult Immunization Status (Td/Tdap)","policyRef":"NCQA HEDIS Adult Immunization Status (AIS-E)","version":"v1.0","status":"Active","owner":"system","tags":["wellness","immunization","adult","hedis"],"compileStatus":"COMPILED","spec":{"description":"Adult Td/Tdap immunization status (within 10 years), modeled on NCQA HEDIS AIS-E. Contraindication excludes; documented refusal keeps the case open and flagged.","eligibilityCriteria":{"roleFilter":"All","siteFilter":"All Sites","programEnrollmentText":"Adult Immunization Program"},"exclusions":[{"label":"Clinical Contraindication","criteriaText":"Documented Td/Tdap contraindication on file"}],"complianceWindow":"10 years","requiredDataElements":["Last Td/Tdap date","Program enrollment","Contraindication status","Refusal status"],"testFixtures":[]}},
```

- [ ] **Step 2: Run the measure-catalog tests**

Run: `cd backend-ts && node --import tsx --test src/measure/*.test.ts`
Expected: PASS. If a test asserts the exact catalog count (was 60), update that expectation to 61.

- [ ] **Step 3: Commit**

```bash
git add backend-ts/src/measure/measure-catalog.ts
git commit -m "feat(measure): #76 E6 — seed Adult Immunization (Td/Tdap) Active"
```

### Task 7: Refusal in the synthetic path

**Files:**
- Modify: `backend-ts/src/engine/synthetic/exam-config.ts`
- Modify: `backend-ts/src/engine/synthetic/fhir-bundle-builder.ts`
- Test: `backend-ts/src/engine/synthetic/fhir-bundle-builder.test.ts`

- [ ] **Step 1: Add `refused` to `ExamConfig`**

In `exam-config.ts`, extend the interface and default it in `deriveExamConfig`:

```ts
export interface ExamConfig {
  binding: MeasureBinding;
  daysSinceLastExam: number | null;
  hasWaiver: boolean;
  programEnrolled: boolean;
  observationValue: number | null;
  refused: boolean;
}
```

In every `return { ... }` of `deriveExamConfig`, add `refused: false,`. Then add a tiny helper:

```ts
/** Mark a config as a documented refusal (does not change the target bucket). */
export function withRefusal(config: ExamConfig): ExamConfig {
  return { ...config, refused: true };
}
```

- [ ] **Step 2: Emit the refusal Condition in the bundle builder**

In `fhir-bundle-builder.ts`, after the `config.hasWaiver` block (line ~78), add:

```ts
  if (config.refused && binding.refusal) {
    entries.push({ resource: condition(externalId, binding.refusal.code, binding.refusal.valueSet) });
  }
```

- [ ] **Step 3: Write the failing test**

Add to `fhir-bundle-builder.test.ts`:

```ts
test("emits a refusal Condition when config.refused and binding.refusal present", () => {
  const binding = MEASURE_BINDINGS["adult_immunization"]; // import MEASURE_BINDINGS at top
  const base = deriveExamConfig(binding, "OVERDUE");
  const bundle = buildSyntheticBundle(
    { externalId: "emp-006", name: "Omar Siddiq", role: "Welder", site: "Plant A", providerId: "prov-001" },
    withRefusal(base),
    "2026-06-19",
  );
  const codes = bundle.entry
    .map((e) => (e.resource as { code?: { coding?: { code?: string }[] } }).code?.coding?.[0]?.code)
    .filter(Boolean);
  assert.ok(codes.includes("tdap-refusal"));
});
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd backend-ts && node --import tsx --test src/engine/synthetic/fhir-bundle-builder.test.ts && pnpm typecheck`
Expected: PASS. Fix imports (`withRefusal`, `MEASURE_BINDINGS`) as needed.

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/engine/synthetic/exam-config.ts backend-ts/src/engine/synthetic/fhir-bundle-builder.ts backend-ts/src/engine/synthetic/fhir-bundle-builder.test.ts
git commit -m "feat(engine): #76 E6 — refusal Condition in synthetic bundle"
```

### Task 8: CQL golden scenarios for the measure

**Files:**
- Modify: `backend-ts/src/engine/cql/cql-execution-engine.test.ts`

- [ ] **Step 1: Read the existing golden test**

Run: `sed -n '1,80p' backend-ts/src/engine/cql/cql-execution-engine.test.ts` to learn how a measure
is evaluated end-to-end (it builds a synthetic bundle for a target and asserts the engine's
`Outcome Status`). Follow that exact harness.

- [ ] **Step 2: Add golden assertions for `adult_immunization`**

Add a test that, for each target, builds the bundle via `deriveExamConfig(MEASURE_BINDINGS["adult_immunization"], target)` + `buildSyntheticBundle`, evaluates through the engine, and asserts the canonical outcome:

```ts
test("adult_immunization golden outcomes", async () => {
  const binding = MEASURE_BINDINGS["adult_immunization"];
  const cases: Array<[TargetOutcome, string]> = [
    ["COMPLIANT", "COMPLIANT"],
    ["DUE_SOON", "DUE_SOON"],
    ["OVERDUE", "OVERDUE"],
    ["MISSING_DATA", "MISSING_DATA"],
    ["EXCLUDED", "EXCLUDED"],
  ];
  for (const [target, expected] of cases) {
    const cfg = deriveExamConfig(binding, target);
    const outcome = await evaluateThroughEngine("adult_immunization", "emp-006", cfg, "2026-06-19"); // use the harness's actual helper
    assert.equal(outcome, expected, `target ${target}`);
  }
});

test("adult_immunization refusal keeps the case non-excluded (OVERDUE), Refused define true", async () => {
  const binding = MEASURE_BINDINGS["adult_immunization"];
  const cfg = withRefusal(deriveExamConfig(binding, "OVERDUE"));
  const { status, expressionResults } = await evaluateThroughEngineFull("adult_immunization", "emp-006", cfg, "2026-06-19");
  assert.equal(status, "OVERDUE");
  assert.equal(expressionResults.find((e) => e.define === "Refused")?.result, true);
});
```

Replace `evaluateThroughEngine` / `evaluateThroughEngineFull` with the harness's real helpers from
Step 1. The DUE_SOON target produces `daysSinceLastExam = w - 10 = 3640`, which falls in the
3591..3650 Due Soon band — confirm and adjust the band/`deriveExamConfig` if the engine returns
COMPLIANT (then narrow the band or the COMPLIANT upper bound so DUE_SOON is reachable, matching the
ordering note in Task 3).

- [ ] **Step 3: Run + commit**

Run: `cd backend-ts && node --import tsx --test src/engine/cql/cql-execution-engine.test.ts`
Expected: PASS.

```bash
git add backend-ts/src/engine/cql/cql-execution-engine.test.ts
git commit -m "test(engine): #76 E6 — AIS-E Td/Tdap golden outcomes + refusal"
```

- [ ] **Step 4: Full backend suite**

Run: `cd backend-ts && pnpm test`
Expected: all green (~430+ tests; +new). Fix any catalog-count or snapshot assertions the new
measure shifts.

---

## Phase W3 — Forecast surfacing on case detail

### Task 9: Attach the forecast to case detail (backend)

**Files:**
- Modify: `backend-ts/src/case/case-detail-read-model.ts`
- Modify: the case-detail route (find with `grep -rn "toCaseDetail" backend-ts/src/routes`)
- Test: the case-detail route test (colocated)

- [ ] **Step 1: Add the optional field to `CaseDetail`**

In `case-detail-read-model.ts`, add to the `CaseDetail` interface:

```ts
import type { ImmunizationForecast } from "../engine/immunization/immunization-forecast.ts";
// ...inside interface CaseDetail:
  immunizationForecast?: ImmunizationForecast;
```

Keep `toCaseDetail` pure: add an optional parameter rather than calling the forecaster inside it:

```ts
export function toCaseDetail(/* existing args */, immunizationForecast?: ImmunizationForecast): CaseDetail {
  // ...existing assembly...
  return { /* ...existing fields..., */ ...(immunizationForecast ? { immunizationForecast } : {}) };
}
```

- [ ] **Step 2: Compute + pass the forecast in the route**

In the case-detail route handler, after resolving the case's `subjectId` and measure, compute the
forecast only for the immunization measure (advisory; never affects status):

```ts
import { resolveForecaster } from "../engine/immunization/immunization-forecast.ts";
// ...
const today = new Date().toISOString().slice(0, 10);
const forecast =
  measureId === "adult_immunization" ? resolveForecaster(env).forecast(subjectId, today) : undefined;
const detail = toCaseDetail(/* existing args */, forecast);
```

Use the route's actual variable names for `measureId`/`subjectId`/`env`.

- [ ] **Step 3: Test**

Add to the case-detail route test: a case on `adult_immunization` returns `immunizationForecast`
with 3 series; a case on another measure does not. Assert the case `status` is unchanged by the
presence of the forecast.

- [ ] **Step 4: Run + commit**

Run: `cd backend-ts && pnpm test && pnpm typecheck`
Expected: green.

```bash
git add backend-ts/src/case/case-detail-read-model.ts backend-ts/src/routes/ 
git commit -m "feat(case): #76 E6 — advisory immunization forecast on case detail"
```

### Task 10: Forecast panel on `/cases/[id]` (frontend)

**Files:**
- Modify: `frontend/app/(dashboard)/cases/[id]/` page/components (find with `grep -rln "why_flagged\|evidence" frontend/app/\(dashboard\)/cases`)

- [ ] **Step 1: Add the panel**

In the case-detail page, when the case payload includes `immunizationForecast`, render a small
advisory panel (follow the existing evidence/why-flagged panel styling — `@mieweb/ui` card +
table). Columns: Series, Status, Last dose, Next due. Label it "Immunization forecast (advisory)".
Each row from `immunizationForecast.series`. Map status → existing badge styles
(UP_TO_DATE→green, DUE→amber, OVERDUE→red, CONTRAINDICATED/REFUSED→neutral).

- [ ] **Step 2: Lint + build**

Run: `cd frontend && npm run lint && npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/
git commit -m "feat(frontend): #76 E6 — advisory immunization forecast panel on case detail"
```

---

## Phase Docs — documentation + ADR

### Task 11: Docs + ADR-012

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/MEASURES.md`, `docs/DECISIONS.md`, `docs/JOURNAL.md`, `README.md`

- [ ] **Step 1: ARCHITECTURE.md** — add the `engine.immunization` module to §3 (port + simulated/ICE adapters + `syntheticImmunizationHistory`), the endpoint to §7 External Interfaces (`GET /api/immunization/forecast`), the `/cases/[id]` advisory panel note to §4, and a §5 data-flow line (advisory, CQL still owns outcome).

- [ ] **Step 2: DATA_MODEL.md** — add a §3.18 note: no new table; refusal/contraindication ride in `evidence_json` (`why_flagged.refused` / contraindication), forecast is read-time; documented production `immunization_forecasts` cache drop-in (mirrors the §3.17 E5 drop-in).

- [ ] **Step 3: MEASURES.md** — add the AIS-E Td/Tdap measure under Category 3 (HEDIS wellness) with the real criteria (Td/Tdap within 10y), outcome mapping, contraindication→EXCLUDED, refusal kept open + flagged, and the §2 sources; bump the catalog summary total to 61 and runnable to 11.

- [ ] **Step 4: DECISIONS.md** — add **ADR-012 — ImmunizationForecast port (ICE-ready, simulated by default)**, dated 2026-06-19: port shape; simulated-default + inert-ICE-when-configured (mirrors ADR-011); read-time/no-schema; advisory-not-authoritative; measure-vs-forecast split (single-event synthetic model); Doug Q5 deferred behind `iceForecaster`.

- [ ] **Step 5: JOURNAL.md** — prepend a dated 2026-06-19 E6 entry (what shipped, the measure-vs-forecast split decision, the real-measure research finding).

- [ ] **Step 6: README.md** — add `GET /api/immunization/forecast` to API highlights and a one-line measure-catalog note (61 measures).

- [ ] **Step 7: Commit**

```bash
git add docs/ README.md
git commit -m "docs: #76 E6 — immunization & forecasting (ARCHITECTURE, DATA_MODEL, MEASURES, ADR-012, JOURNAL, README)"
```

---

## Final verification

- [ ] **Backend:** `cd backend-ts && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test` — all green; idempotency + audit invariants pass.
- [ ] **Frontend:** `cd frontend && npm run lint && npm run build` — clean.
- [ ] **Headless sanity:** `cd backend-ts && pnpm evaluate --measure adult_immunization --patient <a synthetic bundle> --date 2026-06-19 --pretty` returns a Td/Tdap outcome (optional, if a bundle fixture is handy).
- [ ] **Whole-PR code review:** run `superpowers:code-reviewer` on the entire branch diff before opening the PR (per the maintainer's standing rule — never skip the whole-PR pass).
- [ ] **Open PR** referencing #76; let CI go green; merge on maintainer approval (no auto-merge). Deploy triggers on merge to `main`.
- [ ] **Post-deploy:** verify `GET /api/immunization/forecast?subjectId=emp-006` live, and the `/cases/[id]` panel for an `adult_immunization` case in the browser.

---

## Self-review notes (author)

- **Spec coverage:** W1 port+adapters (Task 1), endpoint (Task 2); W2 measure CQL/YAML (3), binding refusal (4), ELM+registry (5), seed (6), refusal synthetic (7), golden (8); W3 backend enrichment (9), UI (10); ADR-012 + docs (11). Contraindication→EXCLUDED (CQL Task 3); refusal kept-open+flagged (Tasks 3,7,8). No schema (Tasks confirm). All spec sections mapped.
- **Type consistency:** `ImmunizationForecast`/`SeriesForecast`/`ForecastStatus`/`VaccineSeries` defined in Task 1 and reused verbatim in Tasks 2, 9. `resolveForecaster(env)` signature consistent across Tasks 1, 2, 9. `ExamConfig.refused` + `withRefusal` defined Task 7, used Tasks 7, 8. Measure `name` "Adult Immunization Status (Td/Tdap)" identical across registry (5), seed (6).
- **Known verify-points flagged inline:** `parseQueryDate(null)` behavior (Task 2); generator field name for `complianceWindowDays`/`refusal` (Tasks 3–4); DUE_SOON band reachability vs COMPLIANT ordering (Tasks 3, 8); golden-harness helper names (Task 8); case-detail route variable names (Task 9). These are codebase-confirmation steps, not placeholders.
