# Journal

Newest first. A few lines per working day: what changed, and what's next.

Entries before 2026-09-23 are in git history: `git show a387cb52:docs/JOURNAL.md` is the last long-form
version, and earlier months were in `docs/archive/` (`git show a387cb52:docs/archive/JOURNAL_2026-07.md`).

## 2026-09-23

- **The work is now one GitHub milestone, "Ready for January"** (24 issues): the Maui sandbox's numbers
  agree on every screen, it stays up, nothing simulated is shown on Maui screens, the ACO's attributed-list
  report can be demonstrated, and PY2027 is ready. Asks blocked on MIE, the practice or the ACO carry the
  `waiting` label; minor findings are one checklist in #655. Open issues went from 108 to 52.
- **Docs trimmed.** `docs/archive/`, finished plans, proposals, the July trial runbook and the stale
  `DATA_MODEL.md` were deleted (git history keeps them). ADRs, `ARCHITECTURE.md`, `DEPLOY.md` and
  `DATA_MODEL_CONTRACTS.md` were condensed.
- **#677 (#642)** was failing CI because VSAC intermittently answers 401 for a valid key and the vendoring
  script treated that as final. 401 and 429 are now retried.
- **Next:** merge #677, then #637 (prior-year history for the corpus before 2027-01-01).
