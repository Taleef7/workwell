# WorkWell Compliance API — `v1`

*Given a patient and a measure, are they compliant?*

One subject, one measure, one stable answer. This is the contract an integrator builds against; everything
else under `/api/` is internal and moves with the frontend.

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
  "period": { "start": "2026-01-01", "end": "2026-12-31" },

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

### `populationsSource` — read this before trusting `populations`

| value | what the population booleans are |
|---|---|
| `official-evidence` | The measure ran CMS's published artifact and these are **the executor's own population vector**, persisted verbatim. Measured. |
| `status-derived` | The measure ran WorkWell-authored logic. Only `initialPopulation` is measured; **the other four are inferred from `status`.** |

This field exists because the two cases are indistinguishable from the numbers alone, and treating the
second as measured eCQM membership would be wrong. If your integration depends on true population
membership, require `populationsSource == "official-evidence"`.

## Modes

### `mode=latest` (default)

The most recent **persisted** outcome from a completed run. Audit-backed and traceable.

**When no run has covered this subject, the response is `404 no_outcome`** — never a cheerful empty 200.
The absence of an evaluation is not a compliance answer, and an integrator must be able to tell the
difference:

```json
{ "error": "no_outcome",
  "message": "no evaluated outcome for subject 'emp-999' and measure 'cms125'. This is the absence of a run, not a compliance answer — use ?mode=preview to evaluate now." }
```

### `mode=preview`

Evaluates **now** and **persists nothing**. `provenance.runId` is `null` and `provenance.persisted` is
`false`; `provenance.engine` carries the engine's declared logic identity.

Use it for a subject no run has covered. It routes through the *same* engine a run would use, so on a
stack where a measure runs CMS's official artifact, preview runs it too — a preview that answered from
different logic than production would be a confidently wrong answer.

## Errors

| status | `error` | when |
|---|---|---|
| 400 | `unknown_measure` | the measure id is not in the catalog (the body lists valid ids) |
| 400 | `invalid_request` | malformed date, `start` after `end`, or an unknown `mode` |
| 400 | `measure_not_runnable` | preview requested for a measure with no evaluation binding |
| 401 | — | no/invalid token |
| 404 | `no_outcome` | `latest` with nothing persisted in range |
| 404 | `unknown_subject` | preview for a subject not in the directory |
| 405 | `method_not_allowed` | anything but `GET` |

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
- **Compliance is computed by CQL and only by CQL** (ADR-008). No AI, no heuristic, and no part of this
  response is generated text.

*Implemented in `backend-ts/src/routes/compliance-api.ts` · ADR-061 · roadmap M-C / C3.*
