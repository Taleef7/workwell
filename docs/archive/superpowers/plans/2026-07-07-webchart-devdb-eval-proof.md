# Plan — WebChart dev-DB evaluation proof (offline E12 PR-2c slice) — #246

## Context

The WebChart→FHIR live-API integration (E12 PR-2c) is blocked pending MIE's WebChart API contract
(Dave Carlson) and any sandbox/live access (Doug). Rather than wait, prove the adapter **end-to-end on
MIE's seeded WebChart dev DB** (`ghcr.io/mieweb/dev-wcdb`, MariaDB 10.3.32, ~72 patients) **offline** —
export it into WebChart-shaped FHIR payloads, run them through the ingress built in PR-2b, and get **real
compliance outcomes** (not all `MISSING_DATA`). Makes the "we ran MIE's own WebChart data through our CQL
engine" story real now; the live HTTP transport stays deferred behind its `WebChartClient` seam.

Honest framing: the seed is sparse on procedures/immunizations but **rich on lab observations** (1,887
`observations_current` with real LOINC). So this is a **targeted evidence run** on the lab/vital measures
(`diabetes_hba1c`, `cholesterol_ldl`, `hypertension`, `obesity_bmi`, `cms125` via one G0202) — not a
blanket all-measures claim; excluded measures are named/logged (no-silent-caps).

Respects the locked decisions (owner 2026-07-03): no MariaDB/MySQL driver in `backend-ts` (export is a
one-time dev tool); the dev DB is a shape reference, never a runtime dependency; immunizations are ICE's;
descriptive only (ADR-008/ADR-017).

## Slices (TDD)

- **PR-1 — OH enrollment roster + enrollment-Condition stamping (DB-independent core).** `EnrollmentRoster`
  + `parseEnrollmentRoster` + pure measure-scoped `stampEnrollment(bundle, measureId, roster)` (reuses
  `MEASURE_BINDINGS[id].enrollment`, idempotent) + thin `evaluateSourceWithRoster` (load → stamp →
  `evaluateBatch`). `node:test` inline fixtures. Closes the enrollment gap (WebChart carries no
  `urn:workwell:vs:*` enrollment Condition). Kept out of `normalize`/a generic decorator. No schema/deps.
- **PR-2 — dev-DB export tool + committed fixtures + e2e proof.** Driver-free dev-only export
  (`docker exec … mysql`; JSON serialized/validated in Node) → committed WebChart-shaped fixtures under
  `backend-ts/spike/webchart/` + a deterministic `pat_id`-hash demo roster; a **deterministic per-measure**
  e2e test over the whitelisted lab/vital measures; seed content-check for the target LOINC codes; docs
  (`WEBCHART_FHIR_MAPPING.md` §8). Gate: needs the local `wcdb` container (GHCR image re-privated).
- **PR-3 — `pnpm evaluate:webchart-devdb` demo CLI + writeup.** Per-measure outcome summary over the
  committed sample (incl. named-excluded measures); JOURNAL/docs narrative.

## Key decisions

- Enrollment roster is a **WorkWell-side** input, deterministically assigned by `pat_id` hash.
- Enrollment stamping is a **pure, measure-scoped pre-evaluation transform** (Codex P1) — not in
  `normalize`, not a generic data-source decorator.
- Export **serializes/validates FHIR JSON in Node** (Codex P2), not via brittle DB line-output.
- e2e assertions are **deterministic per-measure** (Codex P1), not a loose "≥1 of each".

## Verification

`cd backend-ts; pnpm typecheck; pnpm test` (new roster + e2e green; full suite green). PR-3:
`pnpm evaluate:webchart-devdb` prints the per-measure summary. Regeneration (owner, occasional):
`pnpm tsx scripts/webchart-devdb-export.ts` with Docker + `wcdb` up.

Descriptive-only throughout; CQL `Outcome Status` remains the sole compliance authority (ADR-008/ADR-017).
