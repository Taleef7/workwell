# WorkWell Compliance API — `v1`

*Given a patient and a measure, are they compliant?*

One subject, one measure, one stable answer. This is the contract an integrator builds against; everything
else under `/api/` is internal and moves with the frontend.

> **Machine-readable and browsable.** This endpoint is described in the OpenAPI 3.1 document at
> `GET /api/v1/openapi.json`, rendered for humans at the frontend's public `/api-docs` (ADR-068). For the
> same answer delivered *into* a clinician's workflow rather than pulled per measure, see
> [`CDS_HOOKS.md`](CDS_HOOKS.md) (ADR-067).

---

## Request

```
GET /api/v1/compliance/{subjectId}/{measureId}?start=YYYY-MM-DD&end=YYYY-MM-DD&mode=latest|preview
```

| | | |
|---|---|---|
| `subjectId` | path, required | The employee/patient external id. Percent-encode it — WebChart ids contain `\|`. |
| `measureId` | path, required | A WorkWell catalog id (`cms125`, `audiogram`, …). An unknown id is a **400** that lists the known ids. |
| `start`, `end` | query, optional | Bound the evaluation period, inclusive. `YYYY-MM-DD`. Omitted ⇒ the most recent outcome regardless of period. |
| `mode` | query, optional | `latest` (default) or `preview`. |

**Authentication:** the standard bearer token. An anonymous request is **401**.

## Response

```jsonc
{
  "subject": { "id": "emp-006" },
  "measure": {
    "id": "cms125",
    "name": "Breast Cancer Screening",
    "ecqmId": "CMS125FHIR",        // present only when the measure ran an official artifact
    "version": "1.0.000"
  },
  "period": { "start": "2026-01-01", "end": "2026-12-31" },   // the ANSWER's measurement window
  "filter": { "start": null, "end": null },                   // the bounds YOU sent, echoed

  "status": "OVERDUE",             // ← THE ANSWER

  "populations": {
    "initialPopulation":    true,
    "denominator":          true,
    "denominatorExclusion": false,
    "denominatorException": false,
    "numerator":            false
  },
  "populationsSource": "official-evidence",   // or "status-derived" — READ THIS

  "provenance": {
    "mode": "latest",
    "runId": "…",
    "evaluatedAt": "2026-06-12T03:00:11.482Z",
    "evaluationPeriod": "2026-06-12",
    "artifactSha256": "…"
  }
}
```

### `status` is the answer

| value | meaning |
|---|---|
| `COMPLIANT` | the measure's requirement is met |
| `DUE_SOON` | met, but inside the window where it is about to lapse |
| `OVERDUE` | not met and past due |
| `MISSING_DATA` | the data needed to decide is absent — **not** a failure |
| `EXCLUDED` | the subject is excluded from the measure (waiver, contraindication, clinical exclusion) |

`populations` is the *evidence* for that answer, not a second answer. Do not recompute `status` from it.

### `period` vs `filter`

`period` is the **measurement window the answer covers** — the run's own measurement period for `latest`,
and the evaluation date for `preview`. `filter` echoes the `start`/`end` you sent (`null` when omitted).
They are separate fields precisely so neither can be mistaken for the other.

### `populationsSource` — read this before trusting `populations`

| value | what the population booleans are |
|---|---|
| `official-evidence` | The measure ran CMS's published artifact and these are **the CQM IG membership derivation (ADR-069) of the executor's persisted population vector**. Measured — the persisted `evidence_json` stays the executor's verbatim output, but the served booleans apply the IG's per-subject interaction formulas (a DENEX'd subject's `numerator` reads `false`; an exception co-true with the numerator reads `false`), so they may differ from the raw vector on flag combinations the formulas fold. |
| `status-derived` | The measure ran WorkWell-authored logic. **None of the five is measured population membership** — `initialPopulation` and `denominator` are constants, and the rest are inferred from `status`. For an *inverse* authored measure, `numerator` is inverted relative to eCQM convention. Treat the whole block as advisory. |

This field exists because the two cases are indistinguishable from the numbers alone, and treating the
second as measured eCQM membership would be wrong. If your integration depends on true population
membership, require `populationsSource == "official-evidence"`.

## Modes

### `mode=latest` (default)

The most recent persisted outcome **from a FINALIZED run** — `COMPLETED` or `PARTIAL_FAILURE`. Audit-backed
and traceable; `provenance.runId` names the run.

Outcome rows exist as soon as a run's evaluation loop writes them, which is *before* the run reaches a
terminal status and before `/finalize` in the QRDA import flow. Those rows are **not** served: a partial
result must not be published as the contract answer, and it would silently become wrong if the run later
failed. When matching rows exist but none is final, the 404 body carries `pendingRuns` and says so.

`PARTIAL_FAILURE` **is** accepted — it is terminal, and a subject whose evaluation failed is persisted
`MISSING_DATA` with an `evaluationError`, which is a truthful answer rather than a missing one.

**When no run has covered this subject, the response is `404 no_outcome`** — never a cheerful empty 200.
The absence of an evaluation is not a compliance answer, and an integrator must be able to tell the
difference:

```json
{ "error": "no_outcome",
  "message": "no FINALIZED outcome for subject 'emp-999' and measure 'cms125'. This is the absence of a run, not a compliance answer — use ?mode=preview to evaluate now." }
```

…and when rows exist but their run has not finalized:

```json
{ "error": "no_outcome",
  "pendingRuns": 1,
  "message": "no FINALIZED outcome for subject 'emp-006' and measure 'cms125'. 1 matching outcome(s) belong to a run that is not finalized — a run in progress is not an answer yet." }
```

### `mode=preview`

> **Not available on a WebChart-configured deployment — `501 preview_unavailable`.** It would compose a
> **synthetic** bundle rather than the patient's real data and report the result as an evaluation. A run
> on such a stack uses the live bundle; preview has no live composition path, so it refuses rather than
> answering from fabricated data. Use `latest`, which reads what a run actually computed.

**Restricted to `ROLE_CASE_MANAGER` and `ROLE_ADMIN`** — the same bar MCP's `check_compliance` sets for the
same question over the same data. `latest` is a read and stays open to any authenticated role; `preview`
runs the measure engine, and a read-only role must not be able to trigger compute with a GET. Other roles
get **403** with a message pointing at `latest`.

Evaluates **now** and **persists nothing**. `provenance.runId` is `null` and `provenance.persisted` is
`false`; `provenance.engine` carries the engine's declared logic identity.

Use it for a subject no run has covered **on a synthetic-roster deployment**. It routes through the *same
engine* a run would use, so a measure running CMS's official artifact is previewed with that artifact —
answering from different logic than production would be a confidently wrong answer. It does **not** use
the same *data* a live run would; that is why it refuses on a live stack rather than pretending otherwise.

`start` does not apply and is a **400** — the evaluation happens as of `end` (or today).

## Errors

| status | `error` | when |
|---|---|---|
| 400 | `unknown_measure` | the measure id is not in the catalog (the body lists valid ids) |
| 400 | `invalid_request` | malformed date, `start` after `end`, an unknown `mode`, `start` with `mode=preview`, or a bad percent-escape in the path |
| 400 | `measure_not_runnable` | preview requested for a measure with no evaluation binding |
| 401 | — | no/invalid token |
| 403 | `forbidden` | `mode=preview` from a role that may not trigger evaluation |
| 404 | `no_outcome` | `latest` with nothing persisted in range |
| 404 | `unknown_subject` | preview for a subject not in the directory |
| 405 | `method_not_allowed` | anything but `GET` |
| 501 | `preview_unavailable` | `mode=preview` on a WebChart-configured deployment |

## What `v1` promises

**Stable:** a field present in this document will not be removed or change type, `status` values come from
the fixed set above, and the meaning of `populationsSource` will not change. A breaking change means
`/api/v2/`.

**Not stable:** new fields may appear — parse permissively and ignore what you do not recognise. Field
*order* is not significant. `provenance` is diagnostic; its contents may grow.

## Limits, stated

- **One subject per request.** There is no cohort endpoint; that is a different contract with different
  performance characteristics.
- **`preview` evaluates against the directory the deployment is configured with.** On the demo stack that
  is the synthetic roster.
- **`latest` returns the most recent matching outcome, not a history.** There is no pagination.
- **Every answered request writes a `COMPLIANCE_API_READ` audit event**, including 404s. Reads of clinical
  status are recorded.
- **No tenant or site scoping.** Any authenticated principal may query any subject × any measure. This
  matches the existing `/api/employees` and roster surfaces; it is a known posture, not an oversight, and
  it is on the production-readiness gap list (#269).
- **Compliance is computed by CQL and only by CQL** (ADR-008). No AI, no heuristic, and no part of this
  response is generated text.

*Implemented in `backend-ts/src/routes/compliance-api.ts` · ADR-061 · roadmap M-C / C3.*
