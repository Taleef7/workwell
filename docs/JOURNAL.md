# Journal

Newest first. A few lines per working day: what changed, and what's next.

Entries before 2026-09-23 are in git history: `git show before-docs-trim:docs/JOURNAL.md` is the last long-form
version, and earlier months were in `docs/archive/` (`git show before-docs-trim:docs/archive/JOURNAL_2026-07.md`).

## 2026-09-30

- **A measure's trend is warm in every time zone (#615).** The measure page asks for its trend in the
  browser's zone, and the trend memo was keyed by it, so the nightly warm (no zone) never served that
  page: on Maui the first visitor after a run waited 19 s for cms130's trend, and 0.2 s without the zone.
  The memo now holds the zone-free per-run points and each request collapses them to one point per day
  in its own zone; a zone that merges the memo's runs into fewer than ten days reads further back.
  Live after the deploy, four of the six were still 6-7 s in US Eastern: warmed in UTC, a late-evening
  manual run sat on its own UTC day but shared a local day with a nightly. The warm now asks in the
  deployment's practice zone (`practiceTimeZone`, US Eastern on Maui).
- **A deploy no longer signs out whoever's access token lapses during it.** #688 kept the login itself
  across a restart, but the browser still treated any failed refresh as a logout: a 502 or a dropped
  connection while the backend restarted sent the page to /login, and a failed request called
  `logout()`, which ends the login on the server. The audit log showed it on Maui on 2026-09-30: a
  sign-in 17 minutes before a deploy, a new sign-in during its boot, and no logout or token-reuse event
  between them. Only a 401 from the refresh route now ends the session; anything else is retried for
  about two minutes (`lib/api/session-refresh.ts`), with a "Reconnecting" notice and a "Sign in again"
  link. Left open: a refresh whose response is lost after the server rotated the cookie still trips
  reuse detection; that needs a short server-side grace window.
- **Monthly quality snapshots leave out-of-population patients out of the denominator (#676).** They were
  counted in, so every official measure's monthly rate read low and the screens refused the whole series.
  A new `not_in_population` column (owner-approved) records how many a row left out, NULL on an old row;
  the screens now refuse per row. `pnpm rebuild:quality-snapshots` replays each month's runs to rebuild
  the history. It replays only each month's runs that are some measure's newest (Maui's database is
  metered), and a manual workflow runs it against Maui with the deployment's own settings.

## 2026-09-29

- **The steward's MADiE patients end to end (#727).** The gate proved the calculation in memory; the
  pilot-trust defects all sat after it. A new test runs the six Maui decks (334 patients) through the
  nightly's run, both stores and the read APIs (report, roster, cases, programs overview,
  reconciliation, and an idempotent second run) against an oracle written from the population table.
  All 334 agree on SQLite and Postgres; cms165's `trustMetaProfile` and `preparedForQiCore` changed
  nothing. Runs in the official-cases job, which now has a Postgres service. Evidence:
  `docs/evidence/MADIE_END_TO_END_2026-09.md`.
- **An exception no longer excuses a patient who met the numerator** (owner decision). The rate already
  counted them as met (the QI-Core IG's Denominator Membership) while the bucket said Excluded, so one
  patient could be a met numerator in the rate and Excluded on the roster. `outcomeFromPopulations` and
  the multi-rate wording now read an exception only outside the numerator, and met-or-missed now honours a
  numerator exclusion as the rate does. No steward deck holds either shape, so no current result moves.
- **A failing backend test failed nothing in CI.** The sharded test step piped into `tee` under GitHub's
  default `bash -e` (no `pipefail`), so the step took tee's status: run 36158859048 logged `fail 1` and
  went green. `shell: bash` restores `pipefail`; it was the only such step.
- **No page scrolls sideways on a phone or tablet (#700, part 1 of 3).** At 375px Programs slid sideways
  by 506px (121 at 768), Campaigns 316, Hierarchy 300, Runs 211, the patient page 113, Cases 80: chart
  tables hidden with `sr-only` still sized to their content, rows that did not wrap, selects as wide as
  their longest option. Wide tables now scroll inside a labelled `ScrollRegion` with edge shadows; content
  caps at 1600px. A Playwright spec checks every main route at 375 and 768 (e2e ran only at 1280).
- **Phone and tablet workflows (#700, part 2).** The case page is one layout at every width: its phone
  accordion drew Preview into the hidden desktop panel, sent without a preview, and had no Mark Resolved,
  scheduling or upload. Work list rows become cards by container query (one table, same cells) and the
  filters fold behind "Filters · N active"; roster and Cases cards take selection, so a phone can assign.
- **The shell on a phone or tablet (#700, part 3).** The closed nav drawer kept its twelve links in the
  tab order and ignored Escape; it is now `inert` when closed, focus moves to the current page on open and
  back to the menu button on close, and the current page carries `aria-current`. Search shows on phones
  (16px, so iOS does not zoom); header filters start at xl, where 1024–1279px no longer overflowed; the
  menu button, nav rows, Log out and the password toggle are 44px targets. A WebKit (Safari engine) sweep
  on iPhone SE/15 and iPad profiles found the case page's Assignee row and the Runs filters still ran past
  a 320px screen; both fixed, and the responsive spec now measures 320 too.

## 2026-09-28

- **No invented vaccination history (#628).** The immunization forecast made up each person's doses from a
  hash of their id; on TWH a Td/Tdap case CQL scored Overdue showed a 2022 dose and "Up To Date" beside it,
  and a configured ICE was fed the same invented history. No history source is connected to the forecaster
  yet, so the forecast is empty and the case page says so. ICE waits for WebChart immunizations (E12).
- **Admin integration tiles are status only (#627).** Manual Sync contacted nothing and reported
  "Manual sync completed", and every "Last sync" was the container's boot time. The button is gone; the
  tiles are built from configuration, a WebChart tile says Maui is not connected, and a time appears only
  where one is real (the newest run's WebChart fetch).
- **People page (#655 items).** Same-named patients now show id, birth date and clinic. A person's history
  keeps only finished runs and the measures the deployment runs; each row shows its time and run (nightly,
  manual, one patient, rerun to verify, synthetic seed), and reads "Not in population" as the patient page
  does. Its runs come from one read (`RunStore.getRunsByIds`), not one per run.
- **Programs has no date range (#699).** The range scoped each card's "Open cases" but not the rate or
  chips beside it ("Overdue 1,643" by "Open cases (364)"). Rates are measurement-year figures, so Programs
  and the hierarchy ignore the range and the header hides it there. "Open cases" now carries the site, so
  Cases shows the card's count for a chosen clinic.
- **The hierarchy shows what its rate is made of (#643).** In population replaces Evaluated, and each row's
  rate is the Programs card's (`displayRate`); one lower-is-better measure reads Poor control, as its card
  does (CMS122 showed Compliance 53.9% beside a card reading Poor control 46.1%).
- **One name per measure (#648).** Every measure picker (Cases, Orders, Campaigns, the hierarchy, groups,
  Admin waivers), the campaign history, a person's history and the roster's "Scoped to" line use the card's label, `MIPS 113 · CMS130 · Colorectal
  Cancer Screening` (the roster printed the id twice). Work list gap chips carry the short form
  `MIPS 113 · CMS130`, the full label as tooltip and accessible name. Patient links are `/patients/<id>` on
  a patient deployment; `/employees/<id>` still opens.
- Run History checked live after #719: 4.9 s on the first visit a minute after a deploy, 0.2 s after (was 48.8 s).

## 2026-09-26

- **Run History opens warm.** The list counts each run's outcomes. A finished run's counts were kept for only
  ten minutes, so nearly every visit was a cold one: 48.8 s for the first page on the pilot, against 0.48 s
  kept. They are now kept until compaction resets them, or a restart; two loads asking at once (the grid and
  the app-wide run-status check) share one read; and the read-model warm (boot, and after every run) counts
  the first page, so after a nightly only the new run is read. #655 checklist item.

## 2026-09-25

- **Run History no longer has a second scrollbar into empty space.** The outcomes grid's hidden
  "Skip to table" link, absolutely positioned with no positioned ancestor, was placed against the document,
  escaped the scrolling content area and stretched the page to 3,099px in a 900px window. The grid wrapper is
  now a positioned box; checked in the browser (3,099px to 900px). Admin and Measures use the same grid and
  are covered. The grid's loading overlay had the same fault and dimmed the top of the page rather than the
  grid; it now covers the grid. Its tooltips are portals and are unaffected.
- **#650: no window where a measure has none.** A CMS130 case's evidence read "Window (days): 365", the
  authored default, though CMS130 qualifies on FIT yearly, FIT-DNA at 3 years or a colonoscopy at 10. The
  same number reached the clinician's CDS card ("Compliance window: 365 days"), the outcomes CSV and the
  AI fallback explanation. An outcome with official evidence now carries no window, and all four say
  nothing about one. The case and patient pages show the "Why flagged" summary and the exclusion status,
  without the window, days-overdue and "Last result date: None" rows (official evidence records no result
  date, so "None" contradicted a patient flagged by a reading). Checked live first on the desktop layout.
- **#617: no forecast where there is nothing to forecast.** The measure page's "Risk outlook (next 90
  days)" projects from a last-exam date and a window. Official evidence has neither, so on all six Maui
  measures it showed "Upcoming due soon: 0" and a "Predicted 90d" column equal to "Current". The outlook
  now reports `forecastable`. For such a measure the panel says why there is no 90-day forecast (the
  official result records whether a patient met the measure, not when the qualifying test was done) and
  keeps only the real per-site current rate. The case the issue missed: with nobody compliant yet
  (early January), the evidence was never looked at, so the zeros read as a forecast there too. One row
  is now peeked either way, named by subject so it stays an indexed lookup. Deriving real expiries from
  the measure logic stays the follow-up.
- **#621: the Orders page names the measures it cannot propose for.** The patient-page simulation already
  named the four measures it cannot replay (#671). The order catalog still dropped them silently: CMS2,
  CMS130, CMS165 and CMS137 have no catalog order, so their at-risk patients got no proposal, and
  filtering to one showed "No order proposals", which reads as nobody at risk. The route now returns
  `measuresWithoutOrder`, and the page names those measures and says their gaps are tracked as cases on
  the work list. No order codes were invented for them: which gaps may be ordered by protocol is the open
  question in #640.
- **#616: Order Proposals no longer invents standing orders.** With no order source connected, the
  default made up a standing order for about one patient in five from a hash of the ID. When it matched a
  patient's own gap, their proposal was hidden under "standing order on file" and left out of the FHIR
  bundle. That hid 46 of 2,509 at-risk patients on the pilot, all CMS122 or CMS125, the only two routed
  measures with an order. Nothing is invented now, and every at-risk patient is proposed. Because
  WorkWell cannot see orders already placed in WebChart, the page says a proposal may repeat one; the API
  reports this as `standingOrdersChecked`. The deduplication itself stays, for when a WebChart order
  source is connected.
- **#623: Maui's failure alerts now reach the owner by email.** The webhook URL is a secret that both the
  deploy and the self-heal pass to the container (a test holds the two together). It points at a small
  Google Apps Script that emails the alert's one-line summary. TWH still alerts nobody. Review found the
  request carried the whole alert, including a single-patient run's "Patient: <id>" label and raw error
  text, although only the summary is shown. It is now limited to fields that cannot name a patient. A
  webhook that answers with an error is now logged as a failed delivery. A value that is not an https URL
  turns the webhook off and is never printed into the log.

## 2026-09-24

- **#623: the dashboard says when its numbers are stale.** A failed nightly leaves the previous results in
  place, which is right, and said nothing. /programs now shows a banner when the latest overnight update
  did not finish (naming the last complete one), finished with errors for some patients, or has not run
  for 36 hours. The failure alert's webhook body now carries a one-line summary that Slack, Teams and
  Discord accept as it is, built only from fields that cannot name a patient; which channel it goes to is
  still to be chosen.
- **#644: Run History no longer takes every database connection.** Loading the list counted every listed
  run's results at once (38 runs, each a count over up to 120,000 rows): 9.3 s cold, and during an
  all-programs run it used up all ten connections, so the page said "No database connection was available
  in time". A finished run's counts cannot change, so they are now kept (reset by outcome compaction, and
  expired after 10 minutes in case a maintenance script changed them from another process); the rest are
  read three at a time. A running run's duration shows its elapsed time instead of "0s".
- **The worker pool, measured live:** an all-programs run (the nightly's 120,000 evaluations) took 48.7
  minutes, against 88 for the in-process nightly, with no stall over 1.5 s.

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
