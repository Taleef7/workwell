# Journal

Newest first. A few lines per working day: what changed, and what's next.

Entries before 2026-09-23 are in git history: `git show before-docs-trim:docs/JOURNAL.md` is the last long-form
version, and earlier months were in `docs/archive/` (`git show before-docs-trim:docs/archive/JOURNAL_2026-07.md`).

## 2026-09-24

- **#623: the dashboard says when its numbers are stale.** A failed nightly leaves the previous results in
  place, which is right, and said nothing. /programs now shows a banner when the latest overnight update
  did not finish (naming the update whose numbers are shown), finished with errors for some patients, or
  has not run for 36 hours. The failure alert's webhook body now carries a one-line summary that Slack,
  Teams and Discord accept as it is; which channel it goes to is still to be chosen.

- **#663: a frozen API leaves its evidence behind.** The 22 September hang could never be explained,
  because the self-heal deleted the container and its logs. The watchdog thread, which keeps running
  while the server is stuck, now also writes its report (the requests in flight, how long, memory, the
  build) to a file on the container's disk once a freeze passes 30 s; the next boot shows it on the admin
  runtime view. And both self-heals now restart the container in place first (the platform's restart
  keeps the disk), recreating only if that fails. Recovery still waits for GitHub's slow schedule; a
  faster restart depends on whether the platform restarts an app whose process exits (asked of MIE).

- **`WORKWELL_AUTH_ACCESS_TTL_SECONDS` removed from the five deploy/reconcile workflows.** It set a 30-day
  access token for MCP, but only the Java backend read it; the TypeScript port dropped the reader, so
  tokens have lasted 15 minutes since. Kept that way (a 30-day access token cannot be revoked, and #688
  makes logout a real revocation). `MCP.md` now says 15 minutes and how to re-mint.

- **#615: every dashboard cache warm is now recorded.** The first Programs load after a quiet stretch still
  timed out on the pilot (the overview ran 33 to 60 s), and the nightly's warm had not filled the caches it
  exists to fill, but nothing could say whether it had run. `/health` now shows the last warm (`lastWarm`:
  boot, nightly or after a run, how long, whether it worked) and `/api/admin/runtime` the last ten, with the
  error. Measured on a Neon branch of the pilot's database with its cache emptied: the warm itself failed,
  because the overview's "does this run hold this measure?" check took 26.6 s and the overview passed the
  30 s limit, and the pass then gave up before warming any measure page. It now warms each measure's
  panels even when the overview fails. The `outcomes (run_id, measure_id)` index turns that check into a
  lookup (the cold warm then succeeds, and a measure's drivers load in 0.04 s instead of 16 s); it is added
  (owner DDL, built at boot, about 6 s on the pilot's data). Retention is not the cause (3.5 to 6 s a night).
  Deployed: the index is live. The boot that built it timed out on both warm attempts (the panels warmed
  anyway); the next boot (#688) warmed in 80 s with `ok: true`. Tonight's nightly record is the next evidence.
- **#688: a deploy no longer signs everyone out.** Each login's current refresh-token id was kept in an
  in-memory store that every deploy or restart emptied, so the next refresh was refused and the user was
  sent to the login page. It is now a small database table (`auth_refresh_families`, owner DDL), and
  rotation, reuse detection and logout work as before, across a restart too. Login, logout and a replayed
  token are now audit events (`AUTH_LOGIN`, `AUTH_LOGOUT`, `AUTH_REFRESH_REUSE_DETECTED`, written before the
  store change); the 15-minute rotation inside a login is not (owner decision). Found on the way: the 30-day
  `WORKWELL_AUTH_ACCESS_TTL_SECONDS` the workflows set is read by nothing (tokens last 15 minutes);
  removed above (#703).
- **#604: the nightly no longer freezes the server.** Each 500-patient chunk of an official measure was one
  synchronous `fqm-execution` call (~21 s), so the server could answer nothing for 20 to 25 s at a time
  through the ~80-minute nightly (a sign-in failed this morning). The calculation now runs in one worker
  thread and the main thread keeps serving; results are identical (checked on the Maui corpus for every
  routed measure, CMS137's rates and strata included).
  `WORKWELL_FQM_WORKER=off` puts it back in-process. `/api/admin/runtime` reports the container's cores
  and memory limit, which decide whether a pool could also shorten the run and how to bound the worker.
  Known limit: a single-patient official read during the nightly (`/simulate`, a rerun) still waits
  behind the chunk in flight, no worse than before.
  Verified live the same evening: a manual CMS125 run over 20,000 patients (22:44 to 22:56 UTC) caused no
  event-loop stall at all (the only one since the deploy was the 1 s at boot), and the warm after it
  succeeded.
- **A pool of calculation workers.** The container has 4 cores, and a chunk's six measures were still
  calculated one after another. They now go side by side to a pool of 2 workers (`WORKWELL_FQM_WORKERS`,
  capped at the cores minus one): measured locally on 500 corpus patients, a chunk went from 27.5 s to
  17.9 s (1.5 to 1.7x), so the ~80-minute nightly should take roughly 45 to 55. Each worker holds about
  500 MB while busy and is released after 5 idle minutes; a third worker bought nothing measurable.

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
- **Case managers see findings, not engineering detail.** From a live walk-through of the pilot: the case
  page no longer shows a case manager raw JSON, value-set OIDs or a `why_flagged` heading; the patient page
  drops the FHIR id and its "Recalculate", which started a whole-practice run of every measure; "View
  hierarchy" and a CLI hint on the measure page are gone. Admins keep all of it.
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
- **Links, labels and numbers say what they mean** (live walk-through): "Open Worklist" links that went to
  /cases now say "Open cases"; the patient page links back to the work list; the ACO
  list report and the roster's assign line name the measure (no `cms122`, no id twice); search results
  show the patient ID; /cases says "Loading cases…" instead of "0 cases loaded"; a case with no result
  shows a dash, not "0 days overdue"; the measure trend line is neutral, since green read as good news on
  CMS122.
