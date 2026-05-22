# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/) intent for release communication.

## [Unreleased]

### Changed
- Repository standards polish: badges, contribution/security/support docs, community templates, and metadata alignment.

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
