# WorkWell Measure Studio - AI Guardrails

## Non-Negotiable Rule
AI never decides compliance.

System-of-record decisions come from CQL evaluation outputs and persisted structured evidence. AI may assist interpretation and drafting, but it cannot replace deterministic measure logic or perform autonomous state changes.

## AI Surfaces (MVP + Phase 4)
1. Draft Spec (load-bearing)
- Input: policy/regulatory text.
- Output: structured spec draft for human review/edit/acceptance.
- Constraint: draft is never auto-applied without explicit user action.

2. Explain Why Flagged (structured-first, AI-optional)
- Base case: render structured `expressionResults` + `evaluatedResource` directly.
- Optional polish: generate natural-language wrap from the same structured payload.
- Constraint: AI explanation is adjunct text, not canonical evidence.

3. Run Summary Insight (load-bearing)
- Input: run summary and outcome distribution.
- Output: concise operational insights for reviewers.
- Constraint: insight text cannot mutate run outcomes or case status.

## Human-Acceptance Contract
All state-changing actions remain human-confirmed:
- activating/deprecating measure versions,
- sending outreach or case actions,
- applying policy/spec changes,
- resolving/closing operational cases.

AI outputs are suggestions unless a human explicitly accepts the action in UI/API flow.

## Audit Requirements for AI Usage
- log AI invocation metadata in `audit_events`.
- retain prompt/response lineage where policy allows.
- preserve linkage to run/case/measure context so explanations are defensible.

## TBD before Phase 4
- Prompt templates and redaction rules for each AI surface.
- UX copy for confidence/limitations messaging.
- Feedback loop rubric for evaluating suggestion quality without granting decision authority.
