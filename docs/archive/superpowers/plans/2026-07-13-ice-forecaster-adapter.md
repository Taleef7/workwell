# ICE Forecaster Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inert `iceForecaster` stub with a real HTTP adapter to a self-hosted ICE
(Immunization Calculation Engine) sidecar, behind the unchanged `ImmunizationForecast` port.

**Architecture:** A pure vMR codec (`ice-vmr.ts` — string-template XML build + regex parse, **no new
deps**, mirroring the QRDA stub pattern) + an async adapter (`ice-forecaster.ts`) with an injectable
transport and dose-history source, deterministic fallback to `simulatedForecaster` on any error.
The port's `forecast()` becomes async (`Promise<ImmunizationForecast>`); both route callers await.
Seam predicate relaxes to BASE_URL-only (an ICE sidecar has no API key; key stays optional).
Forecasting remains **advisory only** — CQL `Outcome Status` is the sole compliance authority
(ADR-012); this build is ADR-029.

**Tech Stack:** TypeScript (backend-ts), node:test via `corepack pnpm@10 test`, WebCrypto-free
(plain `fetch` + `AbortController`), golden fixture `backend-ts/spike/ice/dss-response.json`
(captured live 2026-07-13 from `hlnconsulting/ice:latest`).

**Contract facts (all live-verified 2026-07-13 — see `docs/superpowers/specs/2026-07-13-ice-sidecar-spike.md`):**
- `POST {base}/api/resources/evaluate` — body = DSS JSON envelope; patient data = base64 vMR
  `CDSInput` XML in `evaluationRequest.dataRequirementItemData[0].data.base64EncodedPayload`.
- `POST {base}/api/resources/evaluateAtSpecifiedTime` — body = `{specifiedTime: "YYYY-MM-DD",
  interactionId, evaluationRequest}` (verified: asOf 2020-01-18 moved influenza due-date
  2026-07-01 → 2019-07-01).
- Response: `finalKMEvaluationResponse[0].kmEvaluationResultData[0].data.base64EncodedPayload[0]`
  (**array**) → base64 → vMR `CDSOutput` XML.
- Per `<substanceAdministrationProposal>`: `<substance><substanceCode code="{group}">` (ICE vaccine
  group code system `2.16.840.1.113883.3.795.12.100.1`), recommendation in
  `<observationValue><concept code="RECOMMENDED|FUTURE_RECOMMENDED|CONDITIONAL|NOT_RECOMMENDED">`,
  `<interpretation code>` reasons, due date `proposedAdministrationTimeInterval@low`, earliest
  `validAdministrationTimeInterval@low`; timestamps `YYYYMMDDhhmmss.SSS±ZZZZ` (dates in the
  *request* are plain `YYYY-MM-DD`).
- Series ↔ ICE vaccine group: TDAP → `200` (DTP), INFLUENZA → `800`, HEPB → `100`.
- Sidecar ops: ~2–3 GB RAM, tens-of-seconds cold start — long-lived, never per-request.

---

### Task 1: vMR codec — `ice-vmr.ts` (pure, no I/O)

**Files:**
- Create: `backend-ts/src/engine/immunization/ice-vmr.ts`
- Test: `backend-ts/src/engine/immunization/ice-vmr.test.ts`
- Fixture: `backend-ts/spike/ice/dss-response.json` (already copied)

- [x] **Step 1: Failing tests** *(ran red: module absent)* — `buildCdsInputXml` (dob/gender/doses render; XML-escape),
  `buildDssRequest` (envelope shape, base64 payload round-trips), `parseDssResponse` +
  `parseCdsOutputProposals` against the golden fixture (17 proposals; influenza `800` RECOMMENDED
  due `2026-07-01`; DTP `200` RECOMMENDED due `2026-03-15` earliest `2021-03-15`; HepB `100`
  NOT_RECOMMENDED `COMPLETE`), `parseIceTimestamp`.
- [x] **Step 2: Implement** *(11/11 green)* — string-template `CDSInput` (patient id/dob/gender +
  `substanceAdministrationEvents` per dose), DSS envelope builder (submissionTime injected — no
  `Date.now()` inside the pure codec), tolerant regex proposal parser (per-proposal block scan),
  base64 via `atob`/`btoa` (worker-portable).
- [x] **Step 3: Commit** — `feat(immunization): vMR codec for the ICE DSS contract` *(0dec609)*

### Task 2: Real adapter — `ice-forecaster.ts`

**Files:**
- Create: `backend-ts/src/engine/immunization/ice-forecaster.ts`
- Test: `backend-ts/src/engine/immunization/ice-forecaster.test.ts`

- [x] **Step 1: Failing tests** — fixture-transport forecast maps 3 series (TDAP DUE/OVERDUE by
  proposed-vs-asOf, INFLUENZA DUE, HEPB UP_TO_DATE complete); asOf ≠ today routes to
  `evaluateAtSpecifiedTime` with `specifiedTime`; transport error → fallback (simulated result);
  non-200 → fallback; missing group in response → fallback; timeout aborts; apiKey (when set) sent
  as `Authorization: Bearer`; history source injectable.
- [x] **Step 2: Implement** *(14/14 green)* — `IceDoseHistory {dob, gender, doses: [{cvx, date}]}`;
  `syntheticIceHistory(subjectId)` derived deterministically from `syntheticImmunizationHistory`
  (TDAP→CVX 115, INFLUENZA→141, HEPB→189; earlier HepB doses back-spaced 60d; dob/gender from the
  same subject hash); `realIceForecaster(cfg, {fallback, transportFetch?, historySource?, timeoutMs?})`
  — fallback is **injected** (no runtime import cycle); status mapping RECOMMENDED→DUE|OVERDUE,
  FUTURE_RECOMMENDED→UP_TO_DATE(+nextDueDate), NOT_RECOMMENDED/CONDITIONAL→UP_TO_DATE(+reason);
  `reason` carries `ICE {rec} ({interpretations})`.
- [x] **Step 3: Commit** — folded into the adapter commit *(d737020)*

### Task 3: Port async + wiring + seam predicate

**Files:**
- Modify: `backend-ts/src/engine/immunization/immunization-forecast.ts` (port → `Promise`, delete
  inert stub, `resolveForecaster` wires `realIceForecaster` with `simulatedForecaster` fallback,
  `isIceConfigured` = BASE_URL-only)
- Modify: `backend-ts/src/routes/immunization.ts:30` + `backend-ts/src/routes/cases.ts:266` (await)
- Modify: `backend-ts/src/engine/immunization/immunization-forecast.test.ts`,
  `backend-ts/src/case/case-detail-read-model.test.ts` (await), `backend-ts/src/config/seam-inventory.test.ts`
  (ice = BASE_URL-only on; key-only off)

- [x] **Steps: red → green → full suite → commit** *(d737020; selection extracted to `resolve-forecaster.ts` to break the port↔adapter import cycle — a deviation from the plan, which had `resolveForecaster` staying in the port file)*

### Task 4: Live verification + compose + docs

**Files:**
- Create: `backend-ts/src/engine/immunization/ice-live.test.ts` (self-skips unless
  `WORKWELL_IMMZ_ICE_BASE_URL` set — Pg-ceiling pattern)
- Modify: `infra/docker-compose.yml` (ice service: `hlnconsulting/ice:latest`, `restart:
  unless-stopped`, mem limit 3g; backend env `WORKWELL_IMMZ_ICE_BASE_URL=http://ice:8080/opencds-decision-support-service`)
- Modify: `docs/DECISIONS.md` (ADR-029), `docs/DEPLOY.md` (env rows: BASE_URL selects, KEY optional
  + sidecar section), `docs/ARCHITECTURE.md` (engine.immunization paragraph + §10 seam row),
  `.env.example`, `docs/JOURNAL.md`, `README.md`, `docs/superpowers/specs/2026-07-13-ice-sidecar-spike.md`
  (status → built)

- [x] **Steps: live test against localhost:32775 → compose → docs → commit** *(5 live tests pass against a real `hlnconsulting/ice` container; they exposed the two contract bugs recorded in ADR-029)*

### Verification gate (before PR)

- [x] `corepack pnpm@10 typecheck` clean *(exit 0)*
- [x] Full suite `corepack pnpm@10 test` *(1260: 1255 pass / 0 fail / 5 skip)*
- [x] Live test against the running sidecar *(5/5 pass)*
- [ ] Adversarial code review of the whole branch
- [ ] PR with docs current
