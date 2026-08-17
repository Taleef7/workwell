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
| `context.patientId` | body, required | The FHIR `Patient.id`. A bare WebChart id is also tried as `wc|<id>` — see *Subject resolution*. |
| `context.userId` | body, optional | `Practitioner/abc` or `PractitionerRole/123`. Recorded, not used for gating. |
| `fhirServer`, `fhirAuthorization`, `prefetch` | body, optional | **Accepted and not evaluated.** See *Limits, stated*. |

**Authentication:** discovery is public — it returns service metadata and no patient data. Invoke and
feedback require the standard bearer token with `ROLE_MCP_CLIENT`, `ROLE_CASE_MANAGER` or `ROLE_ADMIN`, the
same authority as `/sse` and `/mcp/**`. An anonymous invoke is **401**.

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

### An empty `cards` array means something specific

| response | meaning |
|---|---|
| `{"cards": []}` | This patient **was** evaluated by a completed run and has no open gap. |
| one `info` card, *"No WorkWell evaluation on record…"* | Nothing has been evaluated for this patient — including the case where the id did not resolve. |

> **These are deliberately not the same answer.** An empty array at the point of care reads as "no gaps",
> which is the confusion ADR-061's 404 exists to prevent. Because a hook's `patientId` is a bare EHR id while
> WorkWell persists live subjects as `wc|<patientId>`, a namespace mismatch would otherwise be
> indistinguishable from a clean bill of health. `412 Precondition Failed` is also not used: it means the
> service could not retrieve FHIR data, and this is a truthful "nothing has been evaluated yet".

### `indicator` never reaches `critical`

The specification allows `info | warning | critical`, and `critical` means *the user must not proceed*.
WorkWell is supplementary to WebChart and is not entitled to say that about someone else's encounter, so
`OVERDUE` maps to `warning` and everything else to `info`. This is enforced by the card type, not by
convention.

### Subject resolution

`wc|<patientId>` is tried first, then the bare id. So a WebChart client sending `4821` reaches the subject
WorkWell stored as `wc|4821`, and a synthetic-roster client sending `emp-006` reaches `emp-006`.

### Suggestions are gated on an APPROVED terminology mapping

A suggestion is a one-click order into an EHR, and `order-catalog.ts` describes its codes as
"representative (demo, not billing-certified)". So one is offered only where the order code carries an
**`APPROVED`** mapping in `terminology_mappings`, read from the store — approving a mapping unlocks a
suggestion with no code change.

| measure | order code | offered? |
|---|---|---|
| `audiogram` | CPT 92557 | yes — APPROVED |
| `tb_surveillance` | CPT 86580 | yes — APPROVED |
| `flu_vaccine` | CVX 141 | yes — APPROVED |
| `hazwoper` | internal `hazwoper-exam` | no — mapping is `REVIEWED`, and the code is not a public standard |
| **`cms122`, `cms125`** | CPT 83036 / 77067 | **no — no mapping exists at all** |

> **The consequence is intended, not an oversight.** The two officially-routed CMS measures carry
> information and a link rather than an order. Offering a demo-grade CPT for creation in a certified EHR is
> the harm the rule exists to prevent; giving them a suggestion is a terminology review, not a code change.

Two measures sharing one order code (`diabetes_hba1c` and `cms122` both map to CPT 83036) collapse to a
single suggestion, because one order is the correct clinical action.

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
measure is a recomputation over that subject's outcomes rather than a lookup — which is why this endpoint
needs no schema change. The `CDS_HOOKS_INVOKED` event records the uuids it emitted, so the join runs from the
ledger. Deterministic ids also mean a client re-firing the hook for an unchanged run gets the same uuid, so
repeat feedback does not fragment across ids.

## Errors

| status | `error` | when |
|---|---|---|
| 400 | `invalid_request` | body is not a JSON object; missing `hook`/`hookInstance`/`context.patientId`; a hook this service does not serve; empty `feedback`; an `outcome` other than `accepted`/`overridden`; `accepted` without `acceptedSuggestions` |
| 401 | `unauthenticated` | no bearer token on invoke or feedback |
| 403 | `forbidden` | authenticated, but the role may not invoke a CDS service |
| 404 | `unknown_service` | unknown `serviceId`; the response lists the ids that exist |
| 405 | `method_not_allowed` | non-GET on discovery, non-POST on invoke or feedback |

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
- **Nothing in WebChart fires this hook today.** Whether WebChart acts as a CDS Hooks client is an open
  question with MIE, and there is no public evidence either way.
- **Conformance is self-graded.** No external CDS Hooks conformance suite exists — the community validator is
  JSON Schemas last touched in 2018, the sandbox is ungraded, and Inferno has no CDS Hooks kit. See
  `docs/STANDARDS_CONFORMANCE.md`.
- **Compliance is computed by CQL and only by CQL** (ADR-008). A card is a rendering of a completed
  evaluation, never a decision.

*Implemented in `backend-ts/src/routes/cds-hooks.ts` and `backend-ts/src/cds/` · ADR-067 · guide
[S7](guide/10-scenarios.md) · proposal P1 (#458).*
