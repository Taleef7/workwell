# WorkWell Measure Studio - AI Guardrails

## 1) Non-Negotiable Rule
AI never decides compliance.

Authoritative compliance state is computed by CQL evaluation (`Outcome Status`) and persisted structured evidence (`outcomes.evidence_json`). AI outputs are assistive text only.

## 2) Active AI Surfaces and Prompt Templates
All current prompts are implemented in `com.workwell.ai.AiAssistService`.

### 2.1 Draft Spec (`POST /api/measures/{id}/ai/draft-spec`)
System prompt:
```text
You are a compliance measure assistant.
Return ONLY a valid JSON object matching:
{
  "description": string,
  "eligibilityCriteria": {
    "roleFilter": string,
    "siteFilter": string,
    "programEnrollmentText": string
  },
  "exclusions": [{"label": string, "criteriaText": string}],
  "complianceWindow": string,
  "requiredDataElements": [string]
}
You must NOT make any compliance determination about specific employees.
Output is a draft for human review only.
```

User prompt template:
```text
Measure: {measureName}
Policy text:
{policyText}
```

Success contract:
- Response returns parsed JSON suggestion fields for UI population.
- UI must display review banner (`AI-generated draft - review and edit before saving.`).

Failure contract:
- Returns success=false payload with fallback message:
  - `AI temporarily unavailable. Please fill the spec manually.`
- HTTP response remains non-fatal to authoring flow.

### 2.2 Explain Why Flagged (`POST /api/cases/{id}/ai/explain`)
System prompt:
```text
You are a clinical quality measure analyst. Based only on provided structured evidence, explain in 2-3 plain English sentences why the employee was flagged. Do not add information not present. Do not make compliance recommendations.
```

User prompt template:
```text
Outcome status: {currentOutcomeStatus}
Evidence JSON:
{caseEvidenceJson}
```

Failure contract:
- Deterministic rule-based fallback explanation is generated from `why_flagged` + `expressionResults` fields.
- Fallback is labeled via provider metadata (`fallback-rules`).

Cache behavior:
- Case explanation responses are cached per `(caseId, measureVersion)` and invalidated when case `updatedAt` changes.

### 2.3 Run Summary Insight (`POST /api/runs/{id}/ai/insight`)
System prompt:
```text
You are an operations analyst. Return exactly 3 to 5 concise bullet points. Verify before acting. No markdown headings.
```

User prompt template:
```text
Run summary:
measure={measureName}
version={measureVersion}
status={status}
evaluated={totalEvaluated}
compliant={compliantCount}
nonCompliant={nonCompliantCount}
passRate={passRate}
outcomeCounts={outcomeCounts}
```

Failure contract:
- Response returns fallback=true and empty insight list (safe no-op).

## 3) Model, Options, and Fallback Model
Configured in `application.yml` and `AiAssistService`:
- Primary model: `gpt-5.4-nano`
- Fallback model: `gpt-4o-mini`
- Temperature: `0.3`
- Max tokens: `1000`

Invocation behavior:
1. Call primary model.
2. On failure, call fallback model.
3. If both fail, use deterministic per-surface fallback behavior.

## 4) Audit Event Schemas
All AI calls write `audit_events` with `entity_type='ai'`, random AI entity UUID, actor, and payload wrapper:
```json
{
  "timestamp": "ISO-8601",
  "payload": { ...surface-specific fields... }
}
```

### 4.1 `AI_DRAFT_SPEC_GENERATED`
Payload fields:
- `measureName`
- `measureId`
- `promptLength`
- `outputLength`
- `model`
- `tokensUsed` (currently `-1` placeholder)
- `provider` (`openai` or `fallback-rules`)
- `fallbackUsed` (boolean)

### 4.2 `AI_CASE_EXPLANATION_GENERATED`
Payload fields:
- `measureName`
- `outcomeStatus`
- `provider` (`openai` or `fallback-rules`)
- `fallbackUsed` (boolean)

References:
- `ref_run_id = case.lastRunId`
- `ref_case_id = caseId`

### 4.3 `AI_RUN_INSIGHT_GENERATED`
Payload fields:
- `runId`
- `measureName`
- `model`
- `fallbackUsed`
- `bulletCount`

References:
- `ref_run_id = runId`

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
