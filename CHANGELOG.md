# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/) intent for release communication.

## [Unreleased]

### Added
- Scoped-run parity (Sprint 8): `SITE` and `EMPLOYEE` manual runs and same-scope reruns now route through the async run-job path, matching `ALL_PROGRAMS`/`MEASURE`; the `/runs` UI exposes the new scopes.

### Changed
- CI backend test suite ~3.8× faster (44m → 11m30s) via 8-way test sharding plus a per-class population-run fix (PR #57).
- Deployment consolidated onto MIE Create-a-Container; the Vercel + Fly.io public-preview stack is decommissioned. Living docs (README, DEPLOY, ARCHITECTURE, CLAUDE, AGENTS, sprint index) reconciled to the single live MIE TWH stack.
- Repository standards polish: badges, contribution/security/support docs, community templates, and metadata alignment.

### Fixed
- MIE Container Manager deploy migrated to the v1 API contract (`/api/v1` base, `{"data": ...}` envelope, `template`/`services` create body, `.data.status` polling) after the manager API changed (PRs #55, #56).

### Docs
- Synced CLAUDE.md, AGENTS.md, README, DEPLOY, and the sprint index to the post-Sprint-7 / Sprint-8 state (measure catalog 60/49, Next.js 16 + React 19, OpenAI Spring AI starter, MIE-only deployment).

## [2026-05-22]

### Added
- Sprint 7.2 AI test fixture generation endpoint and Studio integration.
- Sprint 7.3 risk outlook analytics endpoint and programs UI widget.
- Sprint 7.4 MAT-compatible FHIR R4 export endpoint and export controls.
- Sprint 7.5 mobile-responsive navigation and caseflow UX updates.

### Fixed
- MAT export authorization boundary enforced to `ROLE_APPROVER` / `ROLE_ADMIN`.
- `risk-outlook` missing-measure handling mapped to `404`.
- MAT ValueSet export omits blank version primitives; export validation hardening.

### Docs
- Sprint 7 implementation closeout reflected across README, sprint docs, and journal.
