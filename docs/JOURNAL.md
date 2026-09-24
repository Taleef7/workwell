# Journal

Newest first. A few lines per working day: what changed, and what's next.

Entries before 2026-09-23 are in git history: `git show before-docs-trim:docs/JOURNAL.md` is the last long-form
version, and earlier months were in `docs/archive/` (`git show before-docs-trim:docs/archive/JOURNAL_2026-07.md`).

## 2026-09-23

- **The work is now one GitHub milestone, "Ready for January"** (24 issues): the Maui sandbox's numbers
  agree on every screen, it stays up, nothing simulated is shown on Maui screens, the ACO's attributed-list
  report can be demonstrated, and PY2027 is ready. Asks blocked on MIE, the practice or the ACO carry the
  `waiting` label; minor findings are one checklist in #655. Open issues went from 108 to 52.
- **Docs trimmed.** `docs/archive/`, finished plans, proposals, the July trial runbook and the stale
  `DATA_MODEL.md` were deleted (git history keeps them). `ARCHITECTURE.md`, `DEPLOY.md` and
  `DATA_MODEL_CONTRACTS.md` were condensed. **The ADRs were retired**: `DECISIONS.md` and `ADR_INDEX.md`
  are deleted, the three rules that governed and lived nowhere else moved to CLAUDE.md, AI_GUARDRAILS §7
  and LOCKED_DECISIONS §4A.7, and an old `ADR-0NN` id resolves with `git show fd243d34:docs/DECISIONS.md`.
- **#677 (#642)** was failing CI because VSAC intermittently answers 401 for a valid key and the vendoring
  script treated that as final. 401 and 429 are now retried.
- **#637 decided: no prior-year history.** The corpus stays current-year only; 1 January starts near
  zero, as a real year-to-date report does. The work became "January readiness": no rate (not 0.0%)
  when nobody is counted, a year line on the programs page, trends and "from previous" kept within one
  measurement year (read from the run's own record, so a January rerun of the old year is labelled
  the old year), and a "based on N patients so far" note under 20 (CMS's case minimum).
- **Programs cards streamlined**: one rate, the chips (no "Not in population"), the trend and the
  worklist link. The CMS measure rate and the staff-closed link moved to the measure page; the
  drivers were already there. The attributed-list report keeps its "Not measured" column.
- **CI made faster and quieter.** About ten oversized backend tests evaluated far more patients than their
  assertions needed, or recomputed the same result per test; they now use a handful or compute once, with
  every check kept (the slowest file went from ~346 s to ~120 s alone). CI runs once per push (the
  duplicate `pull_request` run is gone), a hung VSAC request is abandoned after 90 s instead of 300, and
  docs-only merges no longer redeploy both stacks. The Maui Playwright suite now runs on every push.
  Deleted: the stale TWH Playwright suite (it targeted a July staging build), the weekly stub-engine
  scale job, the never-run redirect workflow, and the always-failing frontend Dependabot entry.
- **Security cleanup.** Next.js 16.3.0 -> 16.3.6 closes two critical advisories (remote code execution via
  the AVIF image optimizer; the other applies only to Windows hosts), and patched versions of sharp,
  dompurify, undici, js-yaml, brace-expansion, browserslist, Babel, Vitest, immutable and the Hono server
  adapter close most of the rest (68 open alerts -> ~14). Left on purpose: hono and vite (installed as
  peers, which pnpm will not move; their advisories are in features we do not use), and csv-parse and
  uuid (major bumps the pinned engine libraries do not allow).
- **#618: the pilot's case managers can escalate and rerun a case.** Rerun to Verify, Escalate and the
  next-step "Rerun to verify" were behind an admin-only gate, so both pilot accounts lost them and the
  next-step panel went blank once outreach was sent. They now show wherever the case actions do; only
  the simulated delivery-state controls stay admin-only. The next step follows the delivery state: verify
  after a send, retry a failed one, nothing while queued.
  Escalating a closed, resolved or excluded case is refused (it used to reopen it silently) and not offered.
- **Two tabs no longer sign the user out.** A refresh rotates the login cookie and the server ends the login
  on a replayed one; two tabs refreshing at once (the work list in one, a patient in another) did exactly
  that. Every refresh now takes a cross-tab lock (Web Locks API), so the second tab sends the new cookie.
- **The AI surfaces now ask `gpt-6-luna` first and `gpt-5.4-nano` second.** The client sent `max_tokens`
  and a temperature, both rejected by GPT-5-era models, so the old primary most likely failed on every
  call and `gpt-4o-mini` answered. It now turns reasoning off and sends `max_completion_tokens`. The
  audit records the model that answered, not the one configured.
- **#644 (first part): "Run This Measure" asks first.** One click used to start a whole-practice run that
  slowed every page for about 15 minutes. A confirmation now says what it costs; the nightly run already
  covers it. The polling bursts in #644 remain.
- **#671: the patient page agrees with itself.** Its posture and Measure Details now read an outcome the way
  its table does (out of population is "Not in population", not "Missing Data"), list only the measures the
  deployment runs (no old Hypertension on Maui), and name the official-only measures instead of `cms130`.
  The simulation runs only when asked, and names the four measures it cannot replay.
- **#668: Run History says what a run is and what its numbers mean.**
  - A measure run is titled by its measure. It used to say "All Programs" for the four official-only
    measures, and for site and patient runs too.
  - The two rates are labelled: compliant of everyone evaluated, and the CMS measure rate of the measure's
    population.
  - Patients outside the population are counted on their own line and shown that way row by row, where
    they used to read "Missing Data".
  - The outcomes table says "Showing 5,000 of 20,000", and runs over an hour show their duration.
  - A failed load, and filters that exclude every run, no longer read "No runs yet", and a run the filters
    remove no longer leaves its detail behind.
  - The global site filter no longer empties the list; the list says it isn't filtered by site.
- **#659, #660: the work list names the measure and the patient.** Four of the six measures read as raw
  ids (`cms130`) on the work list and case page, and in the cases CSV, two MCP tools and the People page;
  every one now uses the catalog name. Each work-list row shows the patient's ID beside the name, since
  two patients can share a name, clinic and provider.
