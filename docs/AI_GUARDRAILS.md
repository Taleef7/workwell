# WorkWell Measure Studio - AI Guardrails

> Always-loaded. This file carries the RULES. The verbatim prompt templates, the model configuration
> and the audit payload field lists moved to `docs/AI_PROMPTS.md` (on demand) on 2026-09-06; section
> numbers here are unchanged because source comments cite them (§1, §2.2, §4).

## 1) Non-Negotiable Rule
AI never decides compliance.

Authoritative compliance state is computed by CQL evaluation (`Outcome Status`) and persisted structured evidence (`outcomes.evidence_json`). AI outputs are assistive text only.

### 1.1 CDS Hooks cards are a rendering, and carry nothing from an AI surface (ADR-067)

The CDS Hooks service (`docs/CDS_HOOKS.md`) returns cards into someone else's clinical workflow, which makes
it the surface where the non-negotiable rule matters most. Three consequences, all enforced in code:

- **Every clinical statement in a card is the CQL outcome verbatim** — the status, the display method and the
  next-action line come from `deriveCell` / `deriveWhyFlagged` / `nextActionFor`, the same readers the roster
  and case detail use. **No AI surface contributes to a card**, and none may: an `AiAssistService` explanation
  is assistive text for an operator reading a case, not something to put in front of a clinician mid-encounter
  as a finding.
- **`systemActions` is never emitted.** In CDS Hooks it is the array a client auto-applies with no user
  interaction. Nothing WorkWell returns may change a chart without a human choosing it, which is the
  human-in-the-loop contract of §7 applied to an outbound integration.
- **`critical` is never emitted**, and is unrepresentable in the card type. It means *the user must not
  proceed*; WorkWell is supplementary to WebChart and is not entitled to say that about someone else's
  encounter.

A card `suggestion` is a *proposal* — a `ServiceRequest` with `intent=proposal`, `status=draft`, offered only
where the order code carries an APPROVED terminology mapping, and accepted only by a clinician's explicit
action.

## 2) Active AI Surfaces
All prompts are implemented in `backend-ts/src/ai/ai-assist.ts`; endpoint wiring lives in
`backend-ts/src/routes/ai.ts`. Every system prompt is built from the deployment's subject term
(`DEPLOYMENT_PROFILE.subjectTerm`: "employee" by default, "patient" on `WORKWELL_INSTANCE=maui`); the
JSON schema keys are contract on both profiles and never change. Templates: `docs/AI_PROMPTS.md`.
The two Studio authoring aids (draft CQL from a spec, test-fixture generation) are drafts-for-human-review
under the same §1 rule.

### 2.1 Draft Spec (`POST /api/measures/{id}/ai/draft-spec`)
- The prompt forbids any compliance determination about specific subjects; the output is a draft for human review only.
- Success: parsed JSON suggestion fields for UI population. The UI must display the review banner (`AI-generated draft - review and edit before saving.`).
- Failure: `success=false` payload with the fallback message `AI temporarily unavailable. Please fill the spec manually.` The HTTP response stays non-fatal to the authoring flow.

### 2.2 Explain Why Flagged (`POST /api/cases/{id}/ai/explain`)
- The model explains, from the provided structured evidence only, why the subject was flagged; it adds nothing and makes no compliance recommendation.
- **Prompt-injection guard (L14):** the evidence JSON is interpolated only inside **per-request nonce'd**
  BEGIN/END markers — an evidence value cannot forge the unguessable closing marker to break out of the
  fence — the system and user prompts both instruct the model to treat it as data (never instructions), and
  the serialized evidence is size-capped (8000 chars, truncation-marked) to bound prompt size. Built via the
  pure `buildExplainUserPrompt(currentOutcomeStatus, evidenceJson)`. This is the defense-in-depth for
  real WebChart-derived strings in the evidence; the CDS surface applies the same bound to clinician free text.
- Failure: a deterministic rule-based fallback explanation is generated from `why_flagged` + `expressionResults`, labeled via provider metadata (`fallback-rules`).
- Cache: responses are cached per `(caseId, measureVersion)` and invalidated when the case `updatedAt` changes.

### 2.3 Run Summary Insight (`POST /api/runs/{id}/ai/insight`)
- Returns 3–5 concise bullet points about a run summary; "verify before acting".
- Failure: `fallback=true` and an empty insight list (safe no-op).

## 3) Model, Options, and Fallback Model
Primary model, then fallback model, then the deterministic per-surface fallback (§5). Model ids and
options are in `docs/AI_PROMPTS.md` §3 and `backend-ts/src/routes/ai.ts`.

## 4) Audit Event Schemas
All AI calls write `audit_events` with `entity_type='ai'`, a random AI entity UUID, the actor, and the payload wrapper:
```json
{
  "timestamp": "ISO-8601",
  "payload": { ...surface-specific fields... }
}
```
Event types: `AI_DRAFT_SPEC_GENERATED`, `AI_CASE_EXPLANATION_GENERATED` (`ref_run_id = case.lastRunId`,
`ref_case_id = caseId`), `AI_RUN_INSIGHT_GENERATED` (`ref_run_id = runId`). Every payload records the
`provider`/`model` and whether the fallback was used, so the ledger proves invocation and fallback
behavior. Field lists: `docs/AI_PROMPTS.md` §4.

## 5) Deterministic Fallback Matrix
- Draft Spec unavailable -> explicit manual-authoring fallback message.
- Case explanation unavailable -> deterministic explanation from structured evidence.
- Run insight unavailable -> empty insight payload with fallback flag.

All fallback branches keep core workflows functional and do not mutate compliance state.

## 6) Data Handling and Persistence Rules
- AI output is never persisted as canonical compliance data.
- Canonical compliance records remain:
  - CQL outcomes (`outcomes.status`)
  - CQL define evidence (`outcomes.evidence_json.expressionResults`)
  - Operational state (`cases`, `case_actions`)
- Persisted AI data is limited to:
  - user-visible transient response payloads,
  - audit metadata proving invocation and fallback behavior.

## 7) Human-in-the-Loop Contract
The following actions remain explicitly human-controlled:
- Measure activation/deprecation.
- Outreach send/escalate/assign/rerun case actions.
- Spec edits and save decisions.

AI suggestions can inform operator decisions but cannot execute compliance decisions or state transitions autonomously.
