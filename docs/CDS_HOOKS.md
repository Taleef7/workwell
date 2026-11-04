# WorkWell CDS Hooks service — `2.0.1`

*This patient is in front of a clinician right now. What is outstanding?*

WorkWell implements the [CDS Hooks](https://cds-hooks.hl7.org/2.0/) contract so a quality gap can arrive
inside someone else's workflow instead of on a dashboard they would have to visit. We serve the standard's
shapes; we do not redefine them.

---

## Request

```
GET  /cds-services                                              → discovery (public)
POST /cds-services/workwell-compliance-patient-view             → cards
POST /cds-services/workwell-compliance-patient-view/feedback    → 200
```

| | | |
|---|---|---|
| `serviceId` | path, required | An `id` from discovery. Today there is exactly one. An unknown id is a **404** that lists what exists. |
| `hook` | body, required | Must be `patient-view`. A hook this service does not serve is a **400**, not a guess. |
| `hookInstance` | body, required | A UUID for this invocation, per the specification. |
| `context.patientId` | body, required | The FHIR `Patient.id`. A bare WebChart id is also tried in the `wc` namespace — see *Subject resolution*. |
| `context.userId` | body, optional | `Practitioner/abc` or `PractitionerRole/123`. Recorded, not used for gating. |
| `fhirServer`, `fhirAuthorization`, `prefetch` | body, optional | **Accepted and not evaluated.** See *Limits, stated*. |

**Authentication:** discovery is public — it returns service metadata and no patient data. Invoke and
feedback require the standard bearer (login) token with `ROLE_MCP_CLIENT`, `ROLE_CASE_MANAGER` or
`ROLE_ADMIN`. An MCP token is never accepted here: it is valid only on `/mcp` (`docs/MCP.md`). An anonymous
invoke is **401**.

> **This is not the CDS Hooks JWT profile, and that is a stated gap.** The specification defines its own
> scheme — a JWT the *client* signs (RS384/ES384), verified against a JWKS, with `aud` equal to the invoked
> endpoint URL and an allowlist of trusted `iss`/`jku` values — and it **SHALL NOT** be signed with a
> symmetric algorithm. WorkWell's token is HS256 and self-issued, so it can never be a conformant CDS Hooks
> JWT. The profile is deliberately not implemented: `jku` fetching is an SSRF surface by design, and a
> verifier whose allowlist nobody has populated is a control that reads as present and cannot fire. If a real
> CDS client appears, the two things needed from it are its `iss` and its JWKS URL.

## Response

A successful invoke is `200` with a `cards` array, per the specification.

```jsonc
{
  "cards": [
    {
      "summary": "Annual Audiogram Completed — overdue",   // ≤ 140 chars, per the spec
      "indicator": "warning",                              // info | warning — never `critical`
      "source": {
        "label": "WorkWell Measure Studio",
        "url": "https://studio.example.org/measures/audiogram"
      },
      "detail": "**Overdue — last 2025-03-10 (55d over).** Escalate audiogram follow-up immediately.\n\n- Last completed: 2025-03-10\n- Days overdue: 55\n- Compliance window: 365 days\n\n_Computed by CQL and evaluated 2026-06-12T03:00:11.482Z (WorkWell run 7f3a…)._",
      "uuid": "3c1d…",                                     // derived, stable — cite it in feedback
      "links": [
        { "label": "Open in WorkWell", "url": "https://studio.example.org/compliance?subjectId=emp-006", "type": "absolute" }
      ],
      "suggestions": [                                     // only for an APPROVED order code — see below
        {
          "label": "Order Comprehensive audiometry evaluation",
          "uuid": "9b02…",
          "actions": [
            {
              "type": "create",
              "description": "Draft order proposal for Comprehensive audiometry evaluation (Annual Audiogram Completed). Advisory — a clinician reviews and submits; WorkWell orders nothing.",
              "resource": { "resourceType": "ServiceRequest", "intent": "proposal", "status": "draft" }
            }
          ]
        }
      ],
      "selectionBehavior": "at-most-one"
    }
  ]
}
```

The example is an authored measure's card, whose `summary` is the measure and its state. An OVERDUE card on
an official measure leads with what closes the gap instead (#880, `needFor`): `Needs a blood pressure below
140/90 this year (CMS165)` for CMS's artifact, and the need alone, with no CMS identity, for a WorkWell
translation (LOCKED_DECISIONS §4.3). The phrase is fixed per measure (CMS137 per rate) and states no value.

### An empty `cards` array means something specific

| response | meaning |
|---|---|
| `{"cards": []}` | This patient **was** evaluated by a completed run and has no open gap WorkWell will state: none, or only in measures whose data was too thin to trust (below). |
| one `info` card, *"No WorkWell evaluation on record…"* | Nothing has been evaluated for this patient — including the case where the id did not resolve. |

> **These are deliberately not the same answer.** An empty array at the point of care reads as "no gaps",
> which is the confusion ADR-061's 404 exists to prevent. Because a hook's `patientId` is a bare EHR id while
> WorkWell persists live subjects as `wc|<patientId>`, a namespace mismatch would otherwise be
> indistinguishable from a clean bill of health. `412 Precondition Failed` is also not used: it means the
> service could not retrieve FHIR data, and this is a truthful "nothing has been evaluated yet".

### `indicator` never reaches `critical`

The specification orders `indicator` by urgency: `info` < `warning` < `critical`. WorkWell is supplementary
to WebChart and does not raise the loudest available signal inside someone else's encounter, so
`OVERDUE` maps to `warning` and everything else to `info`. This is enforced by the card type, not by
convention.

### Subject resolution

`wc|<patientId>` is tried first, then the bare id. So a WebChart client sending `4821` reaches the subject
WorkWell stored as `wc|4821`, and a synthetic-roster client sending `emp-006` reaches `emp-006`.

### Suggestions: an admin approves each code, and an order is offered only when CQL found nothing

A suggestion is a one-click order into an EHR, and `order-catalog.ts` describes its codes as
"representative (demo, not billing-certified)". So one is offered only where the order code carries an
**`APPROVED`** mapping in `terminology_mappings`, read from the store (`order/approved-codes.ts`). Every
code starts PROPOSED; an admin approves, rejects or revokes each one on Admin → Order codes, audited
(`TERMINOLOGY_MAPPING_REVIEWED`, who and when). A new mapping can only be created PROPOSED (#640, owner
decision 2026-11-04). The owner approves for the sandbox; before the PHI phase the pilot group's clinician
signs off and an admin records it (`OPEN_QUESTIONS.md`).

Each measure has an order set (`ORDER_CATALOG`): **protocol** (one order) or **choice** (the clinician
picks; WorkWell sets no default). A card offers one suggestion per approved option, under
`selectionBehavior: "at-most-one"`, with no option marked recommended. A protocol suggestion keeps its
`(run, subject, measure)` uuid; a choice option's uuid adds `system|code`. The card's `detail` lists the
whole order set by name (B29), approved or not, and states no interval or billing note (those are catalog
text, shown in the app only).

**When an order is offered** (`order/order-applicability.ts`, reading `cqlFindingsOf`, the case page's and
the list report's own reader): only when the measure's CQL found nothing qualifying. A new order does not
close a gap where a result was found but does not qualify, so none is offered there.

| measure | mode | options | offered when |
|---|---|---|---|
| `cms122` | protocol | CPT 83036 HbA1c | CQL found no assessment (`NONE_FOUND`); never for a result over 9% |
| `cms125` | protocol | CPT 77067 screening mammography | any open gap |
| `cms2` | choice | LOINC 73832-8 adult, 73831-0 adolescent screening (labels; no age logic) | no screening found |
| `cms130` | choice | CPT 45378 colonoscopy, 82274 FIT, 81528 FIT-DNA, 45330 sigmoidoscopy, 74263 CT colonography | any open gap |
| `cms165` | choice | CPT 99473 home blood pressure; LOCAL recheck visit (listed, never a suggestion) | no reading found; never for an uncontrolled reading |
| `cms137` | choice | HCPCS H0001 assessment, H0004 counseling | Initiation rate with nothing found; never Engagement |
| TWH measures | protocol | as before (audiogram CPT 92557, TB CPT 86580, flu CVX 141 approved by the demo seed) | any open gap |

A run that recorded nothing a reader can name (authored CQL, a run before #875, an errored row) offers no
order for an evidence-ruled measure: "we cannot tell" never becomes "order it".

**The clinic's own code** (#640 item 2): an APPROVED mapping from a clinic code to an approved national
code adds that code as a second `ServiceRequest.code.coding`. Never a `urn:workwell:*` system, never the
code's own approval row, and at most one approved clinic code per national code (409
`clinic_code_already_approved`).

Two measures sharing one order code (`diabetes_hba1c` and `cms122` both map to CPT 83036) collapse to a
single suggestion, because one order is the correct clinical action; each choice option is deduped on its
own code the same way.

**Accept and dismiss are the client's own UI.** WorkWell returns proposals; the EHR draws the buttons and
decides what accepting does. `CDS_HOOKS_INVOKED` records every suggestion offered (`suggestions: [{uuid,
measureId, system, code}]`), so an accepted id resolves to the order it proposed.

> **The `ServiceRequest` references the id YOU sent, not WorkWell's internal subject id.** On a live tenant
> those differ — we persist `wc|4821`, the hook supplies `4821` — and a reference into the `wc` namespace
> would name nothing the client can resolve (`|` is not a legal FHIR id either). Card identity still uses the
> internal id, so feedback correlation is unaffected.

### A measure on thin data says nothing (#853)

When a measure's latest run found its data too thin to trust (coded encounter types, final blood pressures or
record fetches below their floors, `DATA_MODEL_CONTRACTS` §4), that measure returns **no card**, its
evaluation-failure card included (owner decision, 2026-10-20). Its rate would be low because the data is
missing, and a card would put that into the encounter as a finding. Other measures' cards are unaffected, and
the next run whose data meets the floors brings the measure's cards back.

### A failed evaluation is reported as ours

A run can finish `PARTIAL_FAILURE`, and a subject whose evaluation threw is persisted `MISSING_DATA` with an
`evaluationError`. Such a subject gets a card that says the measure **could not be evaluated**, with `info`
and no suggestion — never "no record on file / collect the missing documentation", which would assert a fact
about the patient when the truth is that our engine failed.

## Feedback

`POST /cds-services/{serviceId}/feedback` reports what a clinician did with a card. Optional in the
specification; implemented here because it is the one leg of guide S7's send/receive reconciliation WorkWell
can build alone.

```jsonc
{
  "feedback": [
    {
      "card": "3c1d…",                                  // card.uuid from the invoke response
      "outcome": "accepted",                            // accepted | overridden — there is no `declined`
      "acceptedSuggestions": [{ "id": "9b02…" }],       // REQUIRED when outcome is `accepted`
      "outcomeTimestamp": "2026-06-12T10:05:31Z"
    }
  ]
}
```

Each entry writes one `CDS_HOOKS_FEEDBACK_RECEIVED` audit event. Nothing else is persisted, and nothing else
needed to be: `card.uuid` is derived from `(runId, subjectId, measureId)`, so correlating a uuid back to a
measure is a recomputation rather than a lookup — which is why this endpoint needs no schema change. The
`CDS_HOOKS_INVOKED` event records each emitted uuid **with its measure and run**, so the join runs from the
ledger in one step. Deterministic ids also mean a client re-firing the hook for an unchanged run gets the same
uuid, so repeat feedback does not fragment across ids.

> **A failed write is a `503`, not a silent `200`.** Because the audit event is the *only* record of the
> action, and the specification gives feedback no response body to signal partial success, reporting success
> on a lost write would tell the client never to retry. `recorded` / `of` say how much of the batch landed.
> Retry is safe — feedback is idempotent by `(card, outcome, outcomeTimestamp)`.

**Bounds.** At most **100** entries per request, and `overrideReason.userComment` is truncated at 8000
characters (truncation-marked). Each entry is an append to an append-only ledger and the caller is a machine
credential, so an unbounded batch would be amplification against our own audit trail.

## Errors

| status | `error` | when |
|---|---|---|
| 400 | `invalid_request` | body is not a JSON object; missing `hook`/`hookInstance`/`context.patientId`; a hook this service does not serve; empty `feedback`; more than 100 feedback entries; an `outcome` other than `accepted`/`overridden`; `accepted` without `acceptedSuggestions` |
| 401 | `unauthenticated` | no bearer token on invoke or feedback |
| 403 | `forbidden` | authenticated, but the role may not invoke a CDS service |
| 404 | `unknown_service` | unknown `serviceId`; the response lists the ids that exist |
| 405 | `method_not_allowed` | non-POST on invoke or feedback; a non-GET on discovery **when authenticated** — see below |
| 503 | `audit_write_failed` | feedback could not be recorded. The audit event is the only record of the action, so this is reported as failed rather than dropped silently. Carries `recorded` / `of` so a retry is informed; retry is safe. |

> **Method vs auth precedence on discovery.** `GET /cds-services` is public, but the *path* is gated for every
> other method, so an anonymous `POST /cds-services` is **401**, not 405 — the auth gate runs before the
> handler. An authenticated `POST` there is 405. Stated because the order is not guessable from the table.

## What this promises

**Stable:** the paths above, the CDS Hooks 2.0.1 response shape, the `indicator` ceiling of `warning`, the
distinction between an empty card list and an informational card, and the derivation of `card.uuid` from
`(runId, subjectId, measureId)`.

**Not stable:** card `summary` and `detail` wording, which measures produce cards, and the set of order codes
eligible for a suggestion — the last of these moves when a terminology mapping is approved, by design.

## Limits, stated

- **`prefetch`, `fhirServer` and `fhirAuthorization` are accepted and NOT evaluated**, and the service says
  so in its own `usageRequirements`. No prefetch template is declared, because declaring one would make a
  client fetch and transmit data we ignore. Honouring it means evaluating a caller-supplied bundle per
  request — a different capability, and the piece guide S7 still calls not built.
- **Cards are as fresh as the last completed run, not as fresh as this encounter.** They render persisted
  outcomes of a FINALIZED run; a mid-run row is never served.
- **An invocation is bounded by the measure count, not the subject's history** (#470, closed). Resolving a
  patient is one per-measure store query (`listLatestFinalizedOutcomePerMeasure` — the newest terminal-run
  row per measure, computed in SQL on both stores) plus a constant-time existence probe that keeps
  "never evaluated" distinguishable from "rows exist, none finalized yet". The former 100,000-row
  evidence-parsing scan is gone from this path; `/api/v1/compliance`, MCP's `check_compliance` and the
  employee profile still use the wide scan (batch/operator surfaces with different semantics — period
  bounds, a pending-run count, no finalization check respectively), and none of them is on the
  point-of-care path.
- **One hook.** `patient-view` is maturity 5 in the CDS Hooks Library IG; `encounter-start` is maturity 1 and
  would return the same cards.
- **`systemActions` is never emitted.** Nothing WorkWell returns may change a chart without a human choosing
  it (see `docs/AI_GUARDRAILS.md`).
- **No `overrideReasons`.** Offering a coded dismissal vocabulary we do not analyse would be decoration.
- **No tenant or site scoping** — a caller with a token may ask about any subject. A known posture, on the
  production-readiness gap list (#269).
- **CORS is an exact-origin allowlist and is not relaxed.** A browser-based CDS client (including the public
  sandbox at `sandbox.cds-hooks.org`) needs its origin added to `WORKWELL_CORS_ALLOWED_ORIGINS`. The
  specification requires CORS support but explicitly declines to specify an allowlist rule.
- **Nothing in WebChart fires this hook today.** A check on 2026-10-02 (the teatea trial, WebChart's docs and
  MIE's dev database) found no CDS Hooks client that could call this service. Whether and how WebChart could
  call it, through a client or an app launched from a chart tab, is an ask to MIE (`OPEN_QUESTIONS.md` §4.1).
- **Conformance is self-graded.** No external CDS Hooks conformance suite exists — the community validator is
  JSON Schemas last touched in 2018, the sandbox is ungraded, and Inferno has no CDS Hooks kit. See
  `docs/STANDARDS_CONFORMANCE.md`.
- **Compliance is computed by CQL and only by CQL** (ADR-008). A card is a rendering of a completed
  evaluation, never a decision.

*Implemented in `backend-ts/src/routes/cds-hooks.ts` and `backend-ts/src/cds/` · ADR-067 · guide
[S7](guide/10-scenarios.md) · proposal P1 (#458).*
