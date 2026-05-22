# Security Policy

## Supported versions

Security fixes are applied on the `main` branch and included in active production deployments.

## Reporting a vulnerability

Please do **not** open public issues for security vulnerabilities.

Use one of the following:

1. GitHub Security Advisories (preferred):  
   https://github.com/Taleef7/workwell/security/advisories
2. If advisories are unavailable for your account/session, open a private maintainer contact via GitHub and reference this policy.

Include:

- affected component(s) and endpoint(s)
- impact and exploit scenario
- reproduction steps or proof of concept
- suggested remediation if available

## Response targets

- Initial acknowledgment: within 3 business days
- Triage and severity assessment: within 7 business days
- Patch/release timing: depends on severity and operational risk

## Scope highlights

High-impact areas include:

- authentication and JWT refresh/session handling
- authorization boundaries and role-gated endpoints
- evidence upload/download and file handling
- audit event integrity for compliance actions
- AI integration guardrails and prompt/data exposure
