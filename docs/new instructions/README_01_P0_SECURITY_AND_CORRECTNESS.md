# P0 Security and Correctness README

## Objective

Complete this file before adding new product features. These are trust-boundary issues. WorkWell cannot claim to be auditable or compliance-safe if MCP is public, audit actors are spoofable, rerun-to-verify fakes compliance, or evidence can be downloaded by unauthorized users.

## Workstream A: Secure MCP routes

### Files to inspect

- `backend/src/main/java/com/workwell/config/SecurityConfig.java`
- `backend/src/main/java/com/workwell/mcp/McpServerConfig.java`

Search for `/mcp/message`, `WebMvcSseServerTransportProvider`, `anyRequest().permitAll()`, `MCP_TOOL_CALLED`.

### Required behavior

All MCP endpoints must require auth and role authorization. Do not rely on `/api/**` matching if MCP uses `/mcp/message`.

Minimum role policy:

- `ROLE_ADMIN`
- `ROLE_CASE_MANAGER`
- optional new `ROLE_MCP_CLIENT`

Target security rule:

```java
.requestMatchers("/mcp/**").hasAnyAuthority("ROLE_ADMIN", "ROLE_CASE_MANAGER", "ROLE_MCP_CLIENT")
```

Update MCP audit so actor is resolved from security context, not hardcoded as `mcp`. Audit fields should include actor, tool name, sanitized arguments or argument hash, returned count/result size, success/failure, sensitivity label, and timestamp.

### Tests

- Unauthenticated MCP call fails.
- Authenticated user without MCP role fails.
- Authorized user succeeds.
- MCP tool call writes `MCP_TOOL_CALLED` with authenticated actor.

## Workstream B: Remove actor spoofing

### Files to inspect

- `backend/src/main/java/com/workwell/web/CaseController.java`
- `backend/src/main/java/com/workwell/web/AiController.java`
- `backend/src/main/java/com/workwell/security/SecurityActor.java`

Search for `@RequestParam(name = "actor"`, `currentActorOr`, `case-manager`, `measure-author`, `operations-user`.

### Required behavior

No public endpoint should accept `actor` as a query parameter. Actor must come from security context:

```java
String actor = SecurityActor.currentActor();
```

If a system action needs a system actor, decide that inside the service. The client must never choose the actor.

### Endpoints to check

- case outreach
- outreach delivery update
- rerun-to-verify
- assign case
- escalate case
- AI draft spec
- AI explain case
- AI run insight

### Tests

- Passing `?actor=spoofed@workwell.dev` has no effect.
- Audit actor equals logged-in user for case and AI actions.

## Workstream C: Fix rerun-to-verify correctness

### Files to inspect

- `CaseFlowService.java`
- `AllProgramsRunService.java`
- `CqlEvaluationService.java`
- `RunPersistenceService.java`
- `CaseController.java`

Search for `rerunToVerify`, `COMPLIANT`, `Demo verification`, `CASE_RESOLVED`, `insertOutcome`.

### Required behavior

Rerun-to-verify must call the real CQL evaluation path for the case employee + measure version + evaluation period. It must not directly insert a `COMPLIANT` outcome.

Target flow:

1. Load case.
2. Load employee, measure version, CQL text, and evaluation period.
3. Create scoped verification run.
4. Evaluate using same CQL evaluator as normal runs.
5. Persist outcome/evidence.
6. Update case from actual outcome.
7. Audit verification action and state transition.

Outcome mapping:

- `COMPLIANT`: resolve case, reason `RERUN_VERIFIED_COMPLIANT`.
- `EXCLUDED`: mark excluded/resolved-excluded; no outreach noise.
- `DUE_SOON`: keep open, medium priority.
- `OVERDUE`: keep open, high priority.
- `MISSING_DATA`: keep open, request missing evidence/data.
- evaluation failure: keep open, add failure log/action/audit.

If scoped evaluation cannot be implemented immediately, remove fake compliance and leave the case open with `VERIFICATION_REQUESTED` or `VERIFICATION_NOT_IMPLEMENTED`. Do not fake success.

### Tests

- Rerun-to-verify does not fake `COMPLIANT`.
- If evaluator returns `OVERDUE`, case stays open.
- If evaluator returns `COMPLIANT`, case resolves.
- Failed verification does not close case.
- Audit includes actor, prior status, new status, run ID, case ID.

## Workstream D: Evidence authorization

### Files to inspect

- `CaseController.java`
- `EvidenceService.java`
- `SecurityConfig.java`

Search for `/api/evidence/{id}/download`, `MultipartFile`, `Content-Disposition`.

### Required behavior

Evidence download must be role-authorized and case-authorized. A user should not be able to download arbitrary evidence by UUID.

Minimum policy:

- upload/download: `ROLE_CASE_MANAGER`, `ROLE_ADMIN`
- optional read access for other roles must be explicit and documented.

Flow:

1. Resolve evidence ID to case ID.
2. Load case.
3. Verify role and case access.
4. Stream file.
5. Write `EVIDENCE_DOWNLOADED` audit event.

Also validate file size, allowed content type, sanitized filename, and safe storage path.

### Tests

- unauthenticated download fails.
- wrong role fails.
- case manager/admin succeeds.
- unknown evidence ID returns 404.
- download writes audit event.
- path traversal filename is sanitized.

## Workstream E: CORS and production startup checks

### Files to inspect

- `SecurityConfig.java`
- `application*.properties` or `application*.yml`
- frontend demo mode env usage.

### Required behavior

Production CORS must use exact origins. Remove wildcard `https://*.vercel.app` from production config.

Add startup validator that fails non-local startup if:

- auth is disabled.
- JWT secret/config missing or weak.
- wildcard CORS configured.
- demo mode enabled without explicit public-demo override.
- MCP route protection disabled.

### Tests

- production profile fails with auth disabled.
- production profile fails with wildcard CORS.
- local profile can allow localhost.

## Workstream F: Docs honesty

Update:

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/DATA_MODEL.md`
- `docs/TODO.md`
- `docs/AI_GUARDRAILS.md`
- MCP docs if present.

Docs must distinguish production behavior from synthetic/demo behavior.

## P0 acceptance checklist

- MCP secured and audited.
- Public actor params removed.
- Rerun-to-verify uses real evaluation or does not close case.
- Evidence download authorized and audited.
- Production CORS exact-origin only.
- Unsafe production config fails startup.
- Tests prove all of the above.

## Implementation Progress

### Status
In progress

### Completed
- [x] Secure MCP routes and transport endpoints with role checks.
- [x] MCP audit now resolves actor from the authenticated security context and records tool metadata.
- [x] Remove spoofable actor query parameters from case and AI endpoints.

### In progress
- [ ] Fix rerun-to-verify so it uses the real evaluation path or refuses to close the case.
- [ ] Add evidence download authorization and audit logging.
- [ ] Tighten production CORS and add startup safety checks.

### Blocked
- Blocker: None.

### Notes from implementation
- `/sse` and `/mcp/**` are now restricted to `ROLE_ADMIN`, `ROLE_CASE_MANAGER`, or `ROLE_MCP_CLIENT`.
- MCP audit payloads now include the tool name, sanitized arguments, argument hash, result size, success flag, sensitivity label, and timestamp.
- Case outreach, assignment, escalation, rerun, and AI helper actions now derive actor identity from the authenticated security context instead of request parameters.

### Tests added/updated
- `backend/src/test/java/com/workwell/mcp/McpSecurityIntegrationTest.java`
- `backend/src/test/java/com/workwell/mcp/McpServerConfigTest.java`
- `backend/src/test/java/com/workwell/web/CaseControllerTest.java`
- `backend/src/test/java/com/workwell/web/AiControllerTest.java`
- Covers unauthenticated/forbidden/authorized MCP transport access and authenticated audit logging metadata.
- Covers actor identity flowing from `@WithMockUser` through case and AI controller actions.

### Docs updated
- `docs/new instructions/README_01_P0_SECURITY_AND_CORRECTNESS.md`
