# Journal

## 2026-09-11 (later) — the backup had been failing for seventeen nights, and the reason was not the key

Issue #473 lists "rotated/expired credentials" second among its own suspects, and that is what this
looked like. It was not. The dump succeeded every night; the upload answered `InvalidAccessKeyId`, and
the bucket itself answers something more specific:

```
$ curl https://workwell-twh-evidence.s3.us-east-1.amazonaws.com/
<Error><Code>AllAccessDisabled</Code>
       <Message>All access to this object has been disabled</Message>
```

`AllAccessDisabled` is a SUSPENDED ACCOUNT, not a missing bucket and not a bad key. The dates settle
it: `DEPLOY.md` and `BACKUP_DR_RUNBOOK.md` both carried a dated warning that the hosting AWS Free Plan
account **expired 2026-08-24**, that AWS restricts-then-deletes rather than charging, and that the
bucket had to be re-homed before then. The first failure was **2026-08-25**. Rotating a key inside
that account is impossible and would not have helped.

**The second outage was the one nobody had noticed at all.** The same account holds the evidence
bucket, and `deploy-twh-mieweb.yml` sets `WORKWELL_BUCKET_S3_*`, which *selects* the S3 seam. So every
evidence write on TWH has been failing since 2026-08-24 — eighteen days — while the stack booted
clean, logged `bucket-s3=on` and served `/actuator/health` 200. The backup job screamed on night one
because it opens a real connection; the app had no equivalent, so it said nothing. Everything uploaded
in that window is gone.

**Re-homed to Cloudflare R2**, which the runbook had already named as an option and which the seam
already supported: `resolve-bucket.ts` takes an `endpoint` and flips to path-style addressing when one
is set, so the move is env vars and no code. Two buckets — `workwell-evidence-twh` and
`workwell-backups`, one scoped API token each, `db-dumps/` expiring after 30 days. **Two buckets
rather than one with prefix policies is not incidental:** R2 scopes a token per bucket, so what AWS
expressed as "the app user carries an explicit deny on `db-dumps/*`" becomes "the app's token does not
name the backups bucket at all" — strictly stronger, because there is no credential left to mis-police.

**The pilot had never had a backup.** This workflow named `DATABASE_URL_TWH` and nothing else, so the
deployment carrying 20,000 patients since 2026-09-06 had no dump, ever. It is a matrix leg now rather
than a second workflow file, because a copied file drifts from its original and the drift stays
invisible until the day you need the dump; `fail-fast: false`, so a dead TWH database cannot cancel
the pilot's backup. TWH's failure-issue title is kept **byte-identical** on purpose — the success step
closes by title, so a reworded one would leave #473 open forever and quietly open a second issue
beside it.

**What the code learned.** A configured-but-unreachable bucket now announces itself:
`probeEvidenceBucket` runs once per process from the same boot hook as the seam-inventory line and
**lists** under a prefix that matches nothing — read-only, no write permission, creates nothing — so
an empty listing proves credentials, endpoint and bucket name all resolve. Only a throw, or an
8-second timeout, is unreachable.

**The first version of it `get` a key that should not exist and called the miss a success, and that
was wrong in the exact way this module exists to prevent.** The adapter swallows *any* 404 into
`null` (`isNotFound`: `httpStatusCode === 404`) and **`NoSuchBucket` is a 404** — so a `get`-based
probe reports "reachable" for a bucket that does not exist, in a change whose single likeliest defect
is the rename `workwell-twh-evidence` → `workwell-evidence-twh`. A control present, green, and unable
to fire. `list` has no such catch. Found by review, not by me, and it is the third entry in the
vacuous-guard collection.

A second alert covers the half-configured case that the probe structurally cannot see: a deployment
that NAMES a bucket but leaves a credential empty reads as "seam off" and falls back silently to
container-local storage. Naming a bucket is intent; intent that did not take effect is now said out
loud. Both travel the shared alert channel rather than a hand-rolled `console.error`, so they reach
the webhook too — shipping "nobody reads logs" as a log line was the first draft's other mistake —
and the endpoint is redacted to `https://<account>.…`, because the account id is a repo secret and a
log line is not the place to undo that. Fire and forget: no request waits on a storage round trip.

**And the guard that was missing.** `official-flip-config.test.ts` pins deploy-versus-reconciler parity
for corpus size, chunking, anchor and retention — but not for the bucket block, because `shippedValue`
reads string literals out of the `jq` env array and the bucket entries arrive as `--arg` variables
whose values live in the job-level `env:` block. So "keep the reconciler in sync" was prose in
`DEPLOY.md` and nothing else, and a self-heal could silently repoint or unset evidence storage. It is
three tests now, and all four mutations fail them: a diverging bucket name, a dropped endpoint line, a
region reverted to `us-east-1`, and a key bound but never put in the container env array. The
non-vacuity test earns its place for the usual reason — agreement alone is satisfied by both files
omitting a key.

**The lost-evidence question turned out to be three files.** Both reviewers and I had treated the
dangling window — attachments written during the six weeks the AWS bucket worked — as an open
liability needing an owner decision. Counted against both live databases it is **one dangling file,
and 87 bytes across all three rows**, all on the demo stack; the pilot holds **zero**. So the window is
written off rather than recovered, nothing needed migrating into R2 (both buckets start empty), and
turning the pilot's bucket on orphaned nothing. The rows stay: deleting them would be a state change
with no audit event, which is forbidden without exception, to tidy three rows whose read path already
fails legibly. Worth recording mainly as a reminder that an unmeasured unknown recruits opinions —
two reviews and my own docs all reasoned about a risk that a single query dissolved.

The lesson worth keeping is not about S3. **A dated deadline in a runbook is not a control.** The
warning was correct, specific, and sat in two documents, and nothing failed loudly on the day it
lapsed. What replaces it is a probe that speaks when the thing is actually broken.

Verified: backend 2,504 pass, 1 fail, 23 skipped — the failure is `corpus-membership.test.ts`, the
known stale local sparse-checkout of vendored artifacts, green in CI and unrelated. Typecheck clean.
All three workflows parse.

**And the upload path is proven, not assumed** — dispatched on the branch as run 34620942416, both
legs green:

| Leg | Object | Size |
|---|---|---|
| twh | `db-dumps/twh/workwell_spike-2026-09-11T161547Z.dump` | 9.7 MiB |
| maui | `db-dumps/maui/workwell_spike-2026-09-11T161626Z.dump` | 31.8 MiB |

Issue #473 closed itself on the success step, which is the byte-identical-title decision working as
intended; no second issue was opened for the Maui leg, which is the exact-title `select` protecting
against `gh issue list --search` being a substring match.

**The retention window is now a measurement rather than a guess.** 41.5 MiB a night across both
stacks is **1.22 GiB over a 30-day window against a 10 GB free tier — 8.2x headroom**, so 30 days
stands and needs no shortening. Worth rechecking when the pilot's roster or retention window grows,
since the pilot's dump is already three times TWH's.

## 2026-09-11 — the state of things before MM-2, and four documents that still said two measures were routed

A planning session rather than a building one: with #548 deployed and backfilled, the question was
what actually stands between here and MM-2, and the answer turned out to be shorter than expected.

**Nothing in MM-1 blocks MM-2.** Its remaining items are externally blocked or belong to the PHI
phase: MM-1a waits on the CY2027 final rule (~November) to say whether Quality ID 305 survives, and
cms137 comes off by the same workflow edit if it does not; MM-1d's re-vendor waits on CMS publishing
PY2027 artifacts, and its interim guard — the effectivePeriod-versus-measured-year warning — has been
built since ADR-072 and fires on the run log; #533's ingest stamping gates real data, not the sandbox;
and #532's cms165 cross-engine question needs a credentialed sweep, not a decision. MM-1c's
informational tiles were dropped on 09-10 rather than built. What is left before MM-2 is hygiene, one
production-incident-class gap, and a handful of owner-owned asks that do not wait on code.

**Four documents still said two measures were routed**, three days after ADR-078 routed six. The
guide's chapter 9 funnel, its numbers table, chapter 4's routing diagram and its vendored/gated/routed
table, chapter 1's gate row, the guide README and the public README all carried some version of "410
of 410 across 8 vendored measures, 2 routed" — the state of the world on 2026-09-06, before CMS137's
deck joined the gate (455 of 455 across 9, which chapter 4's own table had already recorded) and
before the flip. The public README's measure table had no CMS137 row at all and showed four routed
measures as unrouted. All corrected here, with the sandbox-versus-submission distinction stated on the
README table rather than left to be inferred from a tick.

**The DEPLOY.md restart step was never committed.** `6ef5198f`'s message says the runbook now makes
the post-backfill worker restart a step rather than leaving it to be discovered; the commit touched
DECISIONS, JOURNAL and chapter 9, and the runbook paragraph itself stayed in the working tree. It is
committed here. A runbook that is right in someone's working copy is a runbook that is wrong.

**The nightly backup has been failing for seventeen days, and the pilot has never had one.** Run
34577510354 is the seventeenth consecutive failure since 2026-08-25. The dump itself succeeds; the S3
upload answers `InvalidAccessKeyId`, so the access key is dead rather than the database being
unreachable — which is worth stating because #473's own triage text puts "database unreachable" first,
and that is not this. The larger finding is next to it: `backup-neon-nightly.yml` names
`DATABASE_URL_TWH` and nothing else, so the 20,000-patient pilot database has no backup workflow at
all and never has. A rotated key and a second leg over `DATABASE_URL_MAUI` are the next commit.

**And the Maui JWT rotation did not stick.** It was rotated on the MIE container manager on 09-03, but
`WORKWELL_AUTH_JWT_SECRET_MAUI` is a GitHub repo secret that `deploy-maui-mieweb.yml` writes into the
container environment on every deploy, and the deploy deletes and recreates the container on every push
to main. Roughly a dozen pushes since have restored the old value. The same shape as ADR-045's reason
for putting the routed measure list in the workflow file rather than on the container: anything set by
hand on a container that is recreated on every push is temporary by construction. The rotation has to
be `gh secret set` followed by a deploy, and it logs every live session out once.

Also settled: the 09-03 handover's F2/F3/G1 recovery-alert follow-ups are superseded. Their brief lived
in a worktree that no longer exists and nothing in the repo names them, but their subject — #509's run
recovery claiming to alert where it could fail silently — was reworked in #545, which made exhaustion
alert, refused a sweep once shutdown has begun, and stopped a retry from flipping rows to FAILED
without writing `RUN_RECOVERED`. Ten remote branches, all squash-merged and therefore invisible to
`git branch --merged`, are deleted.

## 2026-09-10 (later) — the dashboard was reporting the wrong rate, because a patient the measure does not describe was being counted as a gap

The read-path work earlier today made the pages load. It did not make them right. With the segment
repair landed and all six measures opening cases, the overview still showed a "Missing Data" chip of
14,872 for CMS125 on a 20,000-patient roster, and a compliance rate of 18.0%.

Both numbers were the same defect. Since ADR-078 an official evaluation persists `MISSING_DATA` for a
subject the measure's logic puts OUTSIDE its initial population — CQL is authoritative, and it is
saying "not this measure's concern", not "we could not find the result". The distinction survived only
in `evidence_json.official`, and only the roster read it. `complianceRateOf` puts `missingData` in its
denominator, so every non-diabetic was dragging CMS122's rate down and every man was dragging
CMS125's.

Measured against the live sandbox before the change, and the arithmetic checks exactly — for all six
measures `missingData` equals `total − initialPopulation` to the row, so in-population missing data
was **zero** and the whole column was out-of-population:

| Measure | Initial population | Rate shown | Rate the population scores |
|---|---|---|---|
| CMS2 | 17,795 | 60.9% | 68.7% |
| CMS130 | 9,257 | 19.5% | 43.3% |
| CMS165 | 6,837 | 20.5% | 62.4% |
| CMS125 | 5,128 | 18.0% | 72.1% |
| CMS122 | 2,103 | 7.4% | 72.4% (inverse — poor control) |
| CMS137 | 599 | 0.4% | 13.5% |

CMS125 checks out by hand: 3,577 compliant + 1,382 overdue + 169 excluded = 5,128, the initial
population exactly. The rate was `3577/18831`; it is `3577/4959`.

**The first cut re-derived the answer from evidence. Two reviewers killed it.** A shared
"latest cells per measure" read, cached per (measure, run), let the overview and the proposals ask the
same question the roster's cell already answered — and issue #546 had suggested exactly that shape.
It worked, and it was wrong in a way neither the tests nor I saw: it could not correct the TREND.
Correcting a trend point needs the membership for every run in the window, which is ten runs'
evidence per measure — the cost this quarter's read-path work exists to remove — and ADR-073
compaction deletes superseded rows, so it would have gone quietly wrong later anyway. What would have
shipped is a corrected headline above an uncorrected sparkline, which the measure detail page renders
as a **+54-point improvement that never happened**. The Gemini lane and my own reviewer found it
independently.

**So the run writes the answer down instead.** `outcomes.out_of_population` (ADR-079, owner-approved),
nullable, set by the pipeline from the `inInitialPopulation` it already computes at
`run-pipeline.ts:899` and previously discarded after deciding the case. Every read model now answers
from the projection it already fetches, at a byte instead of a JSON blob, at any filter granularity,
and it survives compaction because the flag travels with its row. The shared-cell module and its cache
were deleted; the roster keeps the cache it always had.

NULL means "this run did not record it" — the truth for every row written before the column. A
`NOT NULL DEFAULT FALSE` would have asserted that ~90,000 pilot rows are in-population when they are
not. Readers treat NULL as not-out-of-population, so **an un-backfilled deployment reports exactly what
it reported before**, and the one-time backfill in `docs/DEPLOY.md` is what makes history agree.

**Everything that reports a population rate moved together**: overview, both trend paths,
top-drivers, the hierarchy rollup, the risk outlook's site table, and the order proposals (#546 —
proposals read population membership, the owner's choice over deriving them from active cases, which
would have let a human closing a case silently withdraw a clinical order). A half-migrated basis is
worse than the defect: two screens disagree and neither says so. The monthly quality-snapshot trend
has no column for the split, so it is simply **not served for an official-routed measure** any more —
`programTrend` falls through to the per-run points, which read the flag.

Run-level surfaces deliberately did NOT move. The runs list, the runs CSV and the MCP run summary
report what a RUN wrote, and `passRate = compliant / totalEvaluated` is documented as an operational
per-run statistic rather than a population rate. The CSV gains an **appended** `notInPopulation`
column so the two can be reconciled; the documented prefix is byte-identical.

**A divergence found while unifying the predicate.** `deriveCell` read
`official.populationResults`, which on a multi-rate measure holds **rate 1 verbatim** (ADR-074) — so a
CMS137 patient outside Initiation's population read as out-of-population even where Engagement still
admitted them, while the CDS card, which already read every rate, would have carded the same patient.
Both now call one `outsideEveryRate`.

**Two things shipped alongside, because they touch the same screens.**

*The status chips are the navigation.* All six chips on `/programs` deep-link to the patient roster
scoped to that measure's column, carrying site AND tenant — the roster's tenant filter is now
URL-derived, which it had to be for a tenant-scoped chip to reproduce its own count. Three chips used
to land on the cases worklist, a different surface organised around case state. A zero count still
renders and still links; an absent badge reads as broken rather than as "none". Date filters are
deliberately not forwarded: the roster has no date filter, and implying a scope it cannot apply breaks
"the destination reproduces the clicked count" in the other direction.

*The dashboard makes two requests, not thirteen.* It was making 1 + 2N — the overview, then a trend
and a top-drivers call per measure. Concurrent from the client, but a single-process worker serialises
them anyway, so the fan-out bought concurrency it could not spend and paid for it in repeated work.
`GET /api/programs/overview?include=detail` now attaches `trend` and `topDrivers` to each summary,
per-measure failure-isolated so one measure's throw degrades to an empty panel instead of 500-ing the
dashboard. Two rather than one because the overview alone is the cheap half and painting it is what
makes the page feel loaded — collapsing to a single call held the KPIs behind the slowest panel, which
all three reviewers flagged.

And `warmReadModels` fills the run-keyed memos after the nightly (after compaction, so nothing is
cached from rows about to be deleted) and after a manual run — gated on a population run that actually
COMPLETED, since a SITE or CASE run invalidates nothing.

**What review caught, and it was a lot.** Three lanes ran against the reworked change. Four P1s:

- The **backfill SQL was catastrophically wrong.** It read `official.populationResults` as a keyed
  `{ipp: …}` record; the app persists fqm-execution's **array of `{populationType, result}`**. Every
  `rate ->> 'ipp'` would have been SQL NULL, so `NOT EXISTS` would have been true for every row and the
  UPDATE would have marked **100% of official MISSING_DATA outcomes out-of-population** — permanently
  deleting the real missing-data worklist. `official-flip-gate.ts` already carries a scar comment about
  exactly this misreading, written the last time someone made it. Rewritten to unnest twice and match
  `populationType = 'initial-population'`, then **executed against a local Postgres** over seeded rows
  in both shapes, including the multi-rate case where rate 1 excludes and rate 2 admits (that subject
  must stay in-population, and does).
- `listOutcomesForMeasure` — the risk outlook's read — **never projected the new column**, so that
  surface was silently left on the old basis while the card beside it moved. The store-contract test
  said "round-trips on every read" and covered three of the four; the missing assertion is what let it
  through. Now four.
- The widened `GROUP BY (status, out_of_population)` **broke the MCP run histogram**, which did
  `counts[c.status] = c.count` — an assignment where a status can now arrive as up to three rows, so
  the last group won. A run with 3,000 out-of-population and 120 in-population MISSING_DATA rows would
  have reported 120. Every other consumer sums; this one didn't.
- `repeatNonCompliers` counted out-of-population periods as a non-compliance streak, so every
  non-diabetic evaluated for cms122 across three periods appeared in a named "repeat non-compliers"
  list of people nothing can be done about — on the very panel this change exists to clean up.

Also fixed: the `/evaluate` and QRDA-I import writers left the flag unset on runs that CAN be elected
a measure's winner; `monthlyPossible` was not updated alongside the monthly guard, so an
official-routed measure on the default profile was neither served monthly nor memoized (the result
thrown away on every request); the monthly guard now tests what the ROWS say rather than only today's
`WORKWELL_OFFICIAL_MEASURES`, because a rollback after official runs were written is a case the roster
cell already documents as real; the programs page gained a stale-response guard and clears its panels
on a scope change; the scale tenant's chips no longer link (it has counts but no roster, so every chip
would land on an empty grid under a badge reading thousands).

And one that matters for the release: removing the frontend `displayRate` workaround makes an
**un-backfilled** deployment temporarily *worse* for an inverse measure, which contradicts the
"answers exactly what it answered before" guarantee the rest of the change keeps. `docs/DEPLOY.md` now
says the backfill belongs in the same release window rather than being an optional follow-up.

**And a fifth, from Codex's re-review of the fix commit**: the pipeline initialised
`outOfPopulation` to `false` and persisted that on an evaluation failure, a copy-forward reuse and
every authored measure. `false` is a claim — the official logic ran and placed this subject INSIDE
the population — and none of those three established it. The sharp end is that the backfill only
touches `IS NULL` rows, so a `false` written where nothing was evaluated is permanently beyond its
reach. Both earlier reviews read the same code and called it accurate; Codex was right and they were
wrong. All three now persist NULL, and the run-pipeline failure test pins it.

**Verified.** Backend 2,589 pass. The Postgres ceiling ran **locally** for once (Docker up,
`postgres:16`, 101 pass / 0 skipped) rather than in CI alone — which matters, because this is a schema
change and the SQLite floor cannot catch Pg-only SQL. The new store-contract test earned its place
immediately: it caught `listLatestPopulationOutcomes` not projecting the new column, on both adapters,
and then caught `listOutcomesForMeasure` doing the same once review pointed at it.
The one remaining local failure is `corpus-membership.test.ts`, the known stale local sparse-checkout
of the vendored artifacts, green in CI.

**Deployed and backfilled, 2026-09-11.** Merged as `0dde481b`; both stacks auto-deploy on push. The
un-backfilled guarantee held in production exactly as designed — the API came up reporting
`notInPopulation: 0` and the OLD rates, nothing moved on deploy alone. The backfill then ran against
Neon (via `neonctl`, the SQL read out of `DEPLOY.md` itself so what executed is what is documented),
gated on reproducing each measure's measured split inside the transaction before COMMIT. The gate
earned itself on the first attempt: the statement parser dropped every UPDATE (each is introduced by a
comment line), zero rows changed, and the verification rolled back rather than reporting success.
Second attempt: `UPDATE 435556` out-of-population, `UPDATE 212020` in-population, every measure exact.
144 evaluation-error rows and hypertension's 384 authored rows correctly stayed NULL.

**And the memos did not notice.** The API kept serving the old numbers with the database already
corrected, because the read models memoize under the WINNING RUNS' key on the premise that a terminal
run's outcomes are immutable — and the backfill is the one operation that mutates them without minting
a run. Nothing invalidated. A `replace_existing` redeploy (the same delete-and-recreate every push
performs) cleared it, and `DEPLOY.md` now carries that as a required step rather than leaving the next
person to discover it. Verified live afterwards: CMS2 68.7%, CMS130 43.3%, CMS165 62.4%, CMS125 72.1%,
CMS122 72.4%, CMS137 13.5%, with in-population missing data at zero across all six.

**Left open.** Item 4 of the shortlist — informational tiles for the ACO's CMS-calculated/vendor
measures — was **dropped rather than built**: going back to the source material, that category was
named, classified and dropped in the same breath, and nobody asked for anything to be shown for it.
Building tiles would have been inventing a requirement. What is genuinely unbuilt and was genuinely
asked for is health-plan-driven measures outside the ACO set, which is MM-2-sized. Also still open:
`risk-outlook` at ~4 s on the measure detail page, and `GET /api/runs/:id/outcomes` unbounded on the
pilot profile.

## 2026-09-10 — every page read the whole history to show one run, and the segment could not name four of the six measures

The owner sent four screenshots of the sandbox: the programs page a skeleton, the roster "crunching
~1.68M outcomes", the orders page "loading proposals", the cases page a skeleton. Measured before
anything was touched, as the sandbox admin against the live API, warm second pass:

| Read | Time | Bytes |
|---|---|---|
| `GET /api/programs/overview` | 6.3 s | 4.5 KB |
| `GET /api/programs/sites` — the dashboard shell requests this on EVERY page load | 5.8 s | 85 B |
| `GET /api/orders/proposals` | 11.4 s | 10.7 MB (33,963 proposals + 746 suppressed) |
| `GET /api/hierarchy/rollup` | 8.7 s | 4.6 MB |
| `GET /api/compliance/roster?limit=50` | 2.8 s | 1.5 KB |
| `GET /api/programs/cms122/trend`, `/top-drivers`, `/risk-outlook` | 1.8 s, 1.3 s, 3.1 s each, six measures in parallel | — |
| `GET /api/cases?status=open&limit=25` | 0.5 s | 15 KB |

Server time, not transport: the 85-byte site list had a 4.5 s time-to-first-byte on a 70 ms connect.
The frontend HTML served in 0.3 s. A cheap request issued while the site list was in flight was not
starved (`/api/version` stayed at 0.22 s), so this was not the event loop; each endpoint's own cost was
the cost, and every page paid the site list's on top of its own.

**One cause under most of it.** `listLatestPopulationOutcomes` — the "latest terminal population run
per measure" reduction pushed into SQL by perf #233 — was bypassed on every non-default profile:
PR #506 (2026-09-01) gave `programSites`, `programOverview`, the hierarchy rollup and the order
proposals a branch reading `DEPLOYMENT_PROFILE.id === "default" ? listLatestPopulationOutcomes :
listOutcomesWithRun`, and the overview and the orders route used the unbounded read on every profile.
`listOutcomesWithRun` with no run bound is every retained outcome row joined to its run — roughly a
million rows on the pilot, plus 120,000 a night — shipped to the worker, mapped into objects, and
reduced in JavaScript to the six winning runs. The site list did that to produce five clinic names, on
every page. The orders route did it without even `excludeTrendHistory`, then serialized 34,000
proposals for the browser to render as one list. The roster used the SQL reduction, but that reduction
is itself a `DISTINCT ON` over every qualifying outcome row, and it read the whole winning run
(120,000 rows with `evidence_json`) once per column on a cold cache.

The reason for #506's branch is in its tests, not its comments: on a scoped profile, a newer run made
entirely of foreign subjects must not blank an older run made of visible ones. That is a property of a
SHARED database, which the pilot's is not; it cost the pilot the full history on every read.

**What changed.** The question is split in two. `OutcomeStore.listLatestPopulationRuns(measureIds,
filter, perMeasure)` answers WHICH runs win from the runs table: the newest 25 qualifying runs,
walked newest first, each probed once for the still-unsatisfied measures with one `EXISTS` query —
so the common case (the newest ALL_PROGRAMS run holds every routed measure) is two small queries —
and whatever the budget cannot settle (a measure routed today and not yet run; one last evaluated
further back) is resolved by one bounded query over that measure's own index entries, never a probe
per run across the history. `listOutcomesWithRun` gained `runIds` and reads only those runs' rows,
narrowed to the measure where one measure is asked for. One helper, `program/latest-population.ts`,
does both for every roster-wide read model, keeps the rule every caller had implicitly — the winner
is the newest run with a row the CALLER can see, so a newer run with no row at the requested site
falls through to the older run that has one, and #506's foreign-subject case is the profile half of
that — at the cost it deserves (the fallback reads that ONE measure's history, only when it fires; on
the pilot's own database without a site filter it never does), and hands back a `runKey` — every
`measure:runId` pair — under which the programs read models memoize what the winners' immutable
rows determine (`RunKeyedMemo`). A terminal population run's outcomes never change, which is the fact
the roster cell cache already rested on; a nightly that completes changes the key and the next read
recomputes, with no timer. Nothing that reads a mutable table is memoized — the open-case count, the
scale fold and the measure-rate memo run per request as before — and the WebChart seam state is part
of every key, because the first version served a seam-off entry to a seam-on request and a route
test caught it.

Per surface: the site list makes no read at all where the static directory is the answer (the default
profile with the seam off — byte-identical, since `directoryForRows` ignored the rows there), and is
memoized elsewhere. The overview reads the winners' rows once per nightly and lists ACTIVE cases only
(it kept `ACTIVE_CASE_STATUSES` after fetching every case, including the ~15,000 ADR-078 closed in one
pass). The trend reads its newest 10 runs — the cap it already displayed — not the measure's history,
and top-drivers reads one; both were reading the full history twice per programs page. The roster asks
for the winners only and reads each column's run narrowed to that measure in SQL. The hierarchy rollup,
the order proposals and the MCP directory go through the helper. The proposals route takes
`?limit=1..1000&offset=` over both lists with `totals` alongside (the FHIR bundle is never windowed),
and the page reads 100 at a time and no longer fetches the whole programs overview to label a select.

The edges are stated rather than hidden, and the four reviews found more of them than I had. The
trend starts from its newest 10 RUNS and widens the window (20, 40, 80) while fewer than ten
displayable points exist and older runs remain — two runs on one day collapse to one point, and a
run holding the measure but no row at a filtered site forms no group, so the first version's fixed
window showed fewer days than the all-history read; after Codex's PR review it does not, short of
eighty runs of nothing displayable. The site list, the hierarchy
rollup's directory and the MCP directory rehydrate live WebChart subjects from the ACTIVE, RUNNABLE
measures' winning runs, and the roster's from the columns it shows, rather than from every measure
that ever had rows; neither live stack has the seam on. The overview lists active cases before the
100,000-row cap rather than the first 100,000 of any status — different only above the cap, and the
cap was the bug. A run that ties another to the millisecond is broken by run id here, where the old
JavaScript kept whichever arrived first; the oracle's own docstring already accepted that. The order
proposals keep their old filter (no trend-history exclusion — under a date window a seeded run can be
the newest inside the window, and a review caught the first version changing that), and are now in
(subject, measure) order, because a page over an unordered read is not a page.

**Found on the way, fixed here.** The Worklist badge read "50" whatever the true count: the shell
fetched `/api/cases?status=open` with no limit, the server returned the first 50, and the badge
counted gaps over those. `?outreach=none|any` is now a server filter (a bad token is a 400 naming
both) and the badge reads `X-Total-Count` off a one-row request. The roster's four official-only
columns were titled `cms2`, `cms130`, `cms165`, `cms137` — `MEASURES[id]?.name ?? id`, and an
official-only measure has no authored entry; the catalog name is the fallback now. And the slow-load
hint said "Crunching ~1.68M outcomes across the enterprise…" — a hardcoded literal describing a
different deployment's table, shown to the pilot's quality lead; it is number-free now.

**Issue #536 could not be closed by its runbook.** The PUT widening `All Patients` to the five clinics
and the six measures answered `400 unknown measure id(s): cms2, cms130, cms165, cms137`:
`validateMeasureIds` checked the authored registry only, so no segment could ever name the four
official-only measures the sandbox routes — which is why four of six evaluated and opened no case.
The route accepts any catalog id now (tested with the pilot's set); the repair is sent once this is
deployed, and the runbook says so. The seed for a FRESH Maui database already derived its measure set
from the runnable ids, so only the live, already-seeded instance is affected.

**Reviewed before the PR opened, four ways** (the in-house reviewer, Gemini 3.8 Flash high, Codex
Sol xhigh, GLM 5.3 xhigh), and the first version did not survive them. Two majors only one lane
saw: the single-measure callers still read every measure's rows of the winning runs — the trend
would have read 1.2M rows to keep 200,000, MORE than the history it replaced until sixty nightlies
existed — and the winner was chosen before the site and tenant filters where the old code chose it
after. Three lanes found the unbounded runs walk independently; one found the unordered page; one
found the seam-state memo key I had already fixed. Every finding above is in the journal because the
first draft of this entry claimed byte-identity it did not have. **Codex's review of the opened PR
found two more, both real.** A fallback result was memoized under the winners' key, and a visible
run that STARTED before the winner and COMPLETED after it changes the fallback's answer without
changing the winner — so the older run would have been served indefinitely. A fallback result is
now never memoized (`fellBack`); the filtered-view path costs what it did before. And the trend's
fixed ten-run window could show fewer days than the all-history read under a site filter or same-day
reruns; it widens now, as above.

**Verified.** Backend typecheck clean; the store contract now pins, on both stores, that the first
winner `listLatestPopulationRuns` names per measure is the run `listLatestPopulationOutcomes` returns
rows for — under `from` alone, `to` alone, a PARTIAL_FAILURE run and a lowercase-persisted run — that
`perMeasure` walks past a newer run holding no row for the measure, that the past-budget fallback
still equals the oracle (the test seeds more qualifying runs than the budget), and that `runIds` is
exactly the plain filter over the full read (an empty set matches nothing). New tests cover the memo's
key discipline (a new winner invalidates; a seam flip is not served the other state's entry), the
pair filter (a store that ignores `runIds` still yields one run per measure), the narrowed
single-measure read, the visibility fallback, the outreach filter (self-contained), the windowed
proposals in stable order and their 400s, the segment PUT with the pilot's four ids, and the column
titles. Frontend: the touched pages' tests plus the shared hook's other consumers, lint and
`tsc --noEmit` clean. **The Postgres ceiling ran in CI only:** this host had 0–1 GB free the whole
afternoon (a browser held 6 GB), and Docker Desktop was not started into that — the 2026-09-09 entry
says why the floor cannot stand in for it. The full backend suite passes but for one pre-existing
local failure (`corpus-membership.test.ts`: six value sets "referenced by neither vendored artifact"
on this machine — the local vendored artifacts are stale; CI vendors them). The live before/after
timings are recorded below once the deploy is measured, not predicted.

**Left open, named.** 33,963 proposals for 20,000 patients: the proposals engine treats every
MISSING_DATA outcome as at-risk, and under ADR-078 an out-of-population subject's outcome persists as
MISSING_DATA — so the orders page proposes an HbA1c for every non-diabetic. The route reads statuses
without evidence, and the case-model decision ADR-078 made (a subject outside the population is a
result, not a case) has not been made for proposals; that is an owner decision, filed as #546,
not a filter slipped into a performance change. `GET /api/runs/:id/outcomes` stays unbounded on the
pilot profile for the reason the 2026-09-09 entry gave. Issue #534 (the cms137 flip) closed as done by
#542.

## 2026-09-09 — reads proportionate to what they show, and the case pass batched

Two measurements started this, both on the live pilot stack rather than a guess.

**Opening a case took 43 seconds on a cold read and about 4 seconds warm, with no run in flight.** The
route fetched every outcome row of the whole run — `evidence_json` blobs included — and then `.find()`d
the single row the page renders. Roughly 87,000 rows over the wire into a single-replica worker to use
one of them, growing with the roster rather than with anything the page shows. A read-path audit found
the same two lines written out eight times, and several of the copies were worse than the original:
`case-actions` is the detail returned by EVERY case mutation, so assigning a case paid it too;
`case-outreach` paid it twice per send and again on every "Preview message"; `appointment-service` meant
the case page paid it twice per view; and `routes/ai` paid it BEFORE consulting the explanation cache,
so even a cache hit cost four seconds. All eight now call one `outcomeForCase` helper — one row, chosen
in SQL — because the ninth copy needed somewhere to go instead of a ninth edit. `audit-packet.ts` was
invisible to the grep that found the others: it carries two literal NUL bytes as a composite-key joiner,
which makes grep classify it as binary and skip it.

The patient profile had the same shape one level up: `listCases({ limit: 100000 })`, every case in the
tenant, filtered in JavaScript by `employeeId`. `CaseQuery` gained the filter it needed.

**The nightly ran at 9.5 (subject, measure) pairs a second — about three and a half hours.** Outcomes
were already batched properly; the case pass was not. Per pair it awaited a SELECT, then an INSERT or
UPDATE, then an audit insert: roughly 300,000 sequential round trips to Neon. `upsertFromOutcomes` now
takes an evaluation chunk and returns one result per input in input order, null exactly where the
single-row call returns null. Postgres reads the chunk's existing rows in one `unnest` join, plans in
memory with the same pure `planCaseUpsert`/`planNextAction`, then writes one multi-row INSERT and one
set-based UPDATE; `appendAudits` does the same for the ledger.

Measured against a real postgres:16 over 3,000 pairs, with the results asserted identical to the
sequential path: **5,250 round trips to 12**, and 4,151 ms to 553 ms locally — where a local socket pays
none of the ~40 ms Neon charges per trip. At that latency the case pass alone was about 140 minutes of
the nightly, which is most of it.

ADR-076 d2 survives as a compare-and-set in the WHERE of the set-based UPDATE, comparing the
`next_action` the batch READ. A row an operator moved in the meantime matches nothing and falls back to
`upsertFromOutcome` for that row alone — the proven path, with its re-read, its three attempts and its
action-preserving fallback. `planNextAction` stays the single definition of the rule; expressing it as a
SQL `CASE` would have made the pure function dead exactly where it matters. A duplicate key inside one
batch throws rather than resolving arbitrarily, because a set-based UPDATE would apply one of the two
silently where the sequential path applied both in order.

**A local Postgres is what made this safe, and it should have been running months ago.** Every store
change in this repo has carried a "verified only by CI" caveat; `docker compose -f infra/docker-compose.yml
up -d postgres` retires it, and the ceiling now runs 95/95 with nothing skipped. It paid for itself
immediately: both bugs in the new SQL were Postgres-only and passed on the SQLite floor — an INSERT
placeholder computed from a moving `binds.length` inside the row loop, and an ambiguous `RETURNING` once
the UPDATE joined a VALUES alias carrying the same column names. The floor is a loop by design, so it
can catch neither. Every batch-shaped contract test passes there without executing any set-based SQL,
and the store says so in a comment rather than leaving a green floor to be read as evidence.

A third defect was subtler and is worth naming as a shape. The audit flush was written as
`deps.events.appendAudits(audits).catch(...)`. A `.catch()` handles a REJECTION; a synchronous throw —
here, a test double that had not been given the new method — sails straight past it. It escaped the
chunk loop and took the rest of the run with it: the cycle rollover never ran, the last chunk never
persisted, and six invariants failed with no error surfacing anywhere. The old per-row call had the same
latent hole. It is now awaited through `Promise.resolve().then(...)` so the synchronous path lands in
the same handler.

**The 2026-09-08 six-measure run failed, and it was our own deploy.** Its `completedAt` reads 14:29 the
next day, but the log stops at 87,000 pairs — exactly 20:07 to 22:40 at the measured rate, which is when
merging #543 restarted the worker. Two things follow that are not fixed here: a three-and-a-half-hour run
cannot survive a deploy and has no resume, and the orphaned row showed RUNNING for about sixteen hours
before a sweep marked it FAILED, so the UI advertised a run in progress the whole time and hid the Run
button behind it. The batching makes the window much smaller; it does not close it.

**Left alone deliberately.** `GET /api/runs/:id/outcomes` is unbounded on the pilot profile — it fetches
every row to build a directory from them and to report a VISIBLE count, so bounding it means changing
what `X-Total-Count` promises. That is a contract change on an admin surface and belongs in its own
decision. `WORKWELL_INCREMENTAL_EVAL` stays off: a cache hit still persists the copied-forward outcome
and still runs the case upsert, so it would have bought little while the writes dominated. It is the
next lever now that they do not, and it should be turned on as a measured step rather than folded in
here.

### The stuck-run sweep, and two rewrites before it was right

Both of the day's nightly failures had already been diagnosed, and neither was the worker restarting on
its own: 2026-09-08 was a merge redeploying mid-run, and 2026-09-09 was the recovery sweep marking a
HEALTHY run FAILED at 118,430 of 120,000 — 98.7% — at the same instant as an unrelated eighteen-hour-old
orphan. One sweep marked both; the two rows carry the identical `completedAt` of `14:29:19.919Z`.

The cutoff was a flat 30 minutes, justified in a comment as "far beyond the longest real run (~5-6 min
for ALL_PROGRAMS)". That justification expired when the six-measure nightly started taking 88 minutes,
and nothing in the query distinguished a live run from an orphaned one. The sweep also only fired on the
first `/api/runs` access in a process, which is why a genuine orphan had earlier stayed visible as
RUNNING for about sixteen hours — nobody opened the runs page — and why the healthy run died the moment
somebody did.

**The first fix was a net regression, and two reviewers independently refused it.** It kept the 30
minutes as a floor under a process-age term. But a floor can only push the cutoff EARLIER than boot, and
earlier than boot protects nothing — everything after boot is already covered by the age term — so all
it does is suppress legitimate recoveries. Adding a guaranteed boot sweep made it worse by moving the
one sweep to process age ≈ 0, where the floor is entirely in control: a run started 02:00 with a
redeploy at 02:20 gets a cutoff of 01:50, and the orphan is missed. Both triggers are one-shot per
process, so nothing catches it afterwards. For the commonest orphan — a deploy mid-run, the 2026-09-08
incident exactly — the "fix" made a recoverable case permanently unrecoverable.

The rule is now just "created before this process booted", with no floor at all, measured from
`process.uptime()` so a lazily loaded module cannot stamp it at first request instead of at boot.

**The second version was rejected too, by all three reviewers on the same line.** `Math.max(0, …)`
looks like a bounds check and is actually a fail-open: it binds only when the wall clock has moved
BACKWARDS since boot was stamped — an NTP step, a hypervisor correction, a suspend — and in that state
the process cannot tell its own runs from a previous process's. A threshold of 0 makes the store's
cutoff `Date.now()`, and `started_at < now` matches every unclaimed RUNNING row. The clamp reproduced
the very incident it sits inside, triggered by a clock instead of by a stale constant. An untrustworthy
clock now sweeps nothing: missing a sweep costs a stale row until the next restart, while taking the
wrong one kills the nightly.

**Two properties are worth recording because they are traded away deliberately.** The cutoff does not
advance — `now` cancels, leaving `boot - 1s` for the life of the process — so that one second is also
the entire tolerance for clock skew between hosts; a container rescheduled onto a host running more
than a second behind will not sweep the previous container's orphan until the next restart. And a run
whose task dies inside a still-live process is not covered at all, because no timestamp can separate it
from a healthy long run. A progress signal can, and one exists without any schema change:
`outcomes.evaluated_at` is written continuously and `outcomes` is indexed on `run_id`. That is the cheap
follow-up. `run_logs` is not that signal — it is event-driven, and a healthy chunk loop writes almost
nothing to it.

**The test was vacuous three times, which is the fourth instance of that shape this week.** The first
version never called the code under test. The second drove the real store but passed the threshold in
explicitly, so the default path stayed unexercised — it passed with the wiring removed. The third looked
right and still could not fail for either constant it existed to protect: `BOOTED_AT = 0` left it green
while production would sweep nothing ever, and a margin anywhere in `[-5min, +10min)` left it green
while a negative one places the cutoff after boot. Its own comment also described its fixture wrongly —
the "young orphan" was 55 minutes old, so the flat threshold would have swept it too.

The two halves of the incident need opposite fixtures — showing that a flat 30 minutes misses a young
orphan needs a recent boot, showing that it kills a healthy long run needs an old one — so they cannot
share a test. Worth noting that the first mutation run reported the fail-open clamp as caught when it
was not: the `perl` pattern had silently failed to match, so the harness checking for vacuous tests was
itself vacuous. A mutation script must assert that its pattern matched before it reports anything.

**A fourth review, after the PR was open, found three more mutations that were still green** — and the
fix for each is the same shape. `CUTOFF_MARGIN_MS = 0` passed, because the only run placed near the
boundary sat 200ms *after* boot, so nothing required the margin to be non-zero; a run 500ms *before*
boot, which must survive, now pins it. `BOOTED_AT = Date.now()` at module load passed — the exact
regression the source comment warns about — because a band drawn around `process.uptime()` is loose
enough to contain a module-load stamp; what separates them is that this process necessarily spent time
starting before the module loaded, so the test now asserts the derived boot instant precedes the test
file's own load. And `deps.bootedAt ?? Date.now()` passed, because a run created at `now` is spared by
any cutoff at or before now: the live run is now placed just after the REAL boot instant, which only a
cutoff genuinely anchored to boot spares, and the test waits until the process has more uptime than the
margin so that discrimination is deterministic rather than luck. The `BOOTED_AT` arithmetic itself moved
into an exported `bootInstant(nowMs, uptimeSeconds)` so a sign flip or a seconds-for-milliseconds slip
can be caught exactly, which no runtime tolerance loose enough to be stable ever could.

Six mutations, six failures, verified individually.

The same review found the retry loop had three defects of its own, all in code written to satisfy an
earlier review finding: a third backoff that could never be reached (three attempts need two gaps, so
the loop ran 45 seconds while its comment claimed 90), exhaustion that returned silently so a process
could serve traffic with no sweep and nothing anywhere saying so, and no check for shutdown — a retry
waking during the drain window could flip rows to FAILED and be force-exited before their
`RUN_RECOVERED` events were written, a state change with no audit entry. Exhaustion now alerts, the
loop refuses to start a sweep once shutdown has begun, and `stopping` moved above the block rather than
being reachable only by TDZ timing.

Two clock hazards are now stated as residual rather than handled, because the previous comment claimed
the negative-age guard covered them and it does not. After a host suspend the computed age stays
positive and the cutoff lands past boot; and after a backward clock step, a run created during the
stepped-back interval keeps a `started_at` before the cutoff and can be swept while live once real time
advances again. Both are bounded and neither is defended against. What the guard does cover is the
catastrophic case — an age so wrong it would sweep everything.

## 2026-09-08 (evening) — the first six-measure run, a rate that was the wrong measure's, and an e2e suite that had stopped testing the pilot

The flip deployed, and the programs page still read 0.0% on the four new measures. That part was
benign: the nightly runs at 12:00 UTC and had already gone before the merge, so nothing had evaluated
them. A manual ALL_PROGRAMS run confirms the routing is live — `activeMeasuresExecuted: 6`, 120,000
evaluations — and ADR-078 with it: cases are closing under `closed_reason=OUT_OF_POPULATION` with
`closed_by` null, while the outcome itself stays MISSING_DATA. Open cases fell from 16,581 as it ran.

**A measure rate on the overview was the whole run's, not the measure's.** `aggregateOfficialRun`
paged `listOutcomes(runId)` with no measure filter, under a comment asserting that "a run evaluates one
measure with one engine" — true of a MEASURE-scoped run, false of the ALL_PROGRAMS run the pilot
actually runs, which holds a row per (subject, measure) pair. So it summed every measure and served
that one number under whichever measure was asked about: CMS122's card carried `ecqmId: 125FHIR`,
CMS125's initial population and CMS125's 59.2%. The MeasureReport and reconciliation routes were safe —
both refuse a multi-measure run with a 422 — and the programs overview was the one caller with no
guard. The filter is now pushed into SQL in both stores rather than applied after the read; on a
six-measure nightly the app-side alternative would page 120,000 rows once per measure. Guarded by a
store-contract test that pins the narrowing BEFORE the page window (an offset must walk the measure's
rows, not the run's) and by a mixed-run unit test whose fake honours the filter — a fake that ignored
it would pass while the shipped query narrowed.

**The Maui Playwright suite had been green-by-absence since 2026-09-03.** It is dispatch-only, so
nothing ran it across seven merges; a manual dispatch returned 32 passed, 11 failed. None was a backend
regression. Three were the stack: the job ran with `official-measures=off`, so cms2, cms130 and cms165
booted `official-pending` and the specs #528 added for them waited 30s for chips that could not exist.
Two were ADR-078 working as designed — "chip count equals case count" is exactly the fan-out the ADR
removed, so the assertion is now a bound with the gap named. Three were role: `/runs` and `/measures`
are engineering-gated to ADMIN on the pilot profile and the specs signed in as the quality lead, so two
of them had been asserting against an AccessDenied panel and would have passed whatever the catalog
held. One was the export contract — the test wanted `employeeExternalId` where DATA_MODEL_CONTRACTS
§6.3 names `patientExternalId` on a patient deployment, so the stack was right and the test was wrong.
One was a selector collision: the panel filters gave the PCP options names containing clinic names, and
the site filter's option lookup matched one of those inside a closed select.

The job now runs the ROUTED configuration — it vendors the six sidecars with the VSAC credential and
sets `WORKWELL_OFFICIAL_MEASURES` — because a suite that boots a stack nobody deploys is not a pilot
test. The backend's boot line is asserted POSITIVELY: every routed id must read `<id>:official`. The
first version of that guard asserted the ABSENCE of `official-pending` and was close to useless —
`classifyRunnable` returns that kind for one reason only, the id being missing from
WORKWELL_OFFICIAL_MEASURES, and never returns it for cms122/cms125 at all because both are authored and
the `authored` branch is reached first. Dropping those two from the routing list would have printed
`cms122:authored`, passed the guard, and run the pilot's two flagship measures on the wrong engine
while `runs.spec`'s 48 x 6 held either way. Terminology is not part of the classification, so a capped
sidecar still reads `official`; the control for THAT is the `truncated` refusal in the vendor step,
before the backend starts. Caught in review — the first version of this entry credited the wrong
control, and the guard it described could not have fired. On a public repo the credential is scoped to one step, that step runs before the
frontend and e2e trees are installed, and the completed expansions are deliberately NOT cached — an
Actions cache is restorable by a fork pull request, and licensed value-set content should not be
reachable from code we do not control.

The suite went from 43 tests to 26 with more covered: six measures rather than two, and two vacuous
assertions made real. It was never slow — of an 8m24s run the passing tests were about 20 seconds and
the rest was failures burning their timeouts and retrying, so fixing them was the speedup. `workers: 1`
to 4 and one shared sign-in per role instead of about forty were the rest. The roster filter selects
also had no accessible name at all (Chrome computed none from the wrapping label), so Status, PCP, Age,
Sex and Page size now carry `aria-label`s like the three beside them already did.

**Still open:** the live six-measure run is slow — roughly 17 (subject, measure) pairs a second against
Neon, where the in-memory flip gate does 50 subjects a second. The cost looks like per-pair writes
(outcome, case, audit event) rather than CQL, and every nightly now pays it for hours. Not investigated.

## 2026-09-08 (later) — all six measures on the sandbox, and a patient outside a measure is not a case (ADR-078)

The owner looked at the programs page with two measure cards on it and asked why, when the pilot
group sent us six. The honest answer was sequencing: cms2, cms130, cms165 and cms137 were vendored,
gated against MADiE, runnable since ADR-072, and each parked behind a precondition I had set — cms2's
disagreements (diagnosed yesterday), cms130's sweep (done yesterday), cms137's order in the queue and
the final rule on 305, and cms165's WebChart ingest half. The owner's decision is that a sandbox on a
generated corpus should show the pilot group its whole set now, and that the conditions I was holding
the flips on are conditions on real data. Recorded as ADR-078 and a SINCE note in the locked decisions.

**The flip is the workflow edit ADR-045 says it is**, in both Maui workflows, plus CMS137 added to the
deploy's vendor step (it was the one pilot measure the build did not vendor). cms2's gate over all
20,000 corpus patients reads 36/36 MADiE, 17,795 in the initial population, 5,413 actionable, zero
errors (`docs/evidence/FLIP_GATE_2026-09-08_CMS2.md`); cms137's was banked yesterday. cms130 and cms165
pin VSAC-completed sidecars that do not resolve on a laptop, so the gate for them now runs where the
credential is: a manual `flip-gate.yml` workflow that vendors with the secret, sweeps the roster and
uploads the report. That removes a "run it somewhere credentialed" instruction that only existed in
prose.

**Routing six measures made ADR-043's noise the worklist.** An official outcome outside the initial
population persists as MISSING_DATA and opened a MEDIUM case, so 91–97 % of the sandbox's 16,581 open
cases were patients the measure does not concern — every non-diabetic on CMS122, every man on CMS125.
The pipeline now reads the executor's own `inInitialPopulation: false` and treats it as close-only:
no case where none exists, and an active one closed by the system under `OUT_OF_POPULATION`, audited,
reopenable. The CDS card surface applies the same rule. The authored engine never sets the flag, so an
authored MISSING_DATA still means "no record" and still opens a case. The first run after deploy will
close roughly fifteen thousand cases in one pass; that is the ledger doing its job once.

**What the flip does not settle.** cms165's cross-engine number is still an open question (#532), and
its ingest half (#533) now gates the PHI phase rather than the sandbox. cms137 comes off again by the
same edit if the final rule removes 305. The nightly run is now 120,000 pairs; the first one is the
measurement.

## 2026-09-08 — the numbers a quality lead can see are true or refused (ADR-077)

An external review of the Maui sandbox, taken against `564d5d93`, found four ways a number could be
shown with a meaning it did not have, and I reproduced every one before changing anything. Every
MeasureReport variant returned `status: "complete"` for REQUESTED, QUEUED, RUNNING, FAILED and
CANCELLED runs while QRDA refused them, and the UI offered the export for every *terminal* run, FAILED
included. A COMPLETED SITE recheck of one clinic became the whole practice's roster and dashboard. A
retention pass changed a historical run's score from 1/2 to 0/1 while the run's own "total" fell in
step, because that total is a count of the surviving rows. And a FAILED rerun's row evicted the last
finalized answer from the keep set.

**The fix I first proposed for the third one was wrong, and it is worth recording why.** Comparing the
run's evaluated total with its surviving rows can never detect compaction, because the total *is* the
surviving rows. The non-circular evidence already existed: the compaction pass awaits an
`OUTCOMES_COMPACTION_STARTED` intent event before it deletes, and each event carries its cutoff, so
the furthest cutoff any pass has applied bounds what any pass could have reached. A population export
from a run that started before that cutoff is now refused with 409 `run_compacted`. Conservative on
purpose — a run whose rows all survived is refused too — because the alternative is a score wearing an
identity it no longer earns. The first version read only the newest event; a reviewer pointed out that
widening the retention window moves the next cutoff backwards, so it now takes the maximum. Two more of my own contracts were corrected before they shipped: the rate aggregator
already folds numerator exclusions, so applying the proportion formula on top of it would have
subtracted them twice, and an evaluation error on a multi-rate run was already counted "in no rate"
under ADR-074 d11, so it now counts there *and* under its own name.

**What changed** (ADR-077). One reportability predicate, `src/run/reportable.ts`, governs MeasureReport,
QRDA I/III and the export buttons. The keep set protects the newest USABLE row (reportable run, not an
error) as well as the newest row, and never touches an in-flight run. Population winners are an
allowlist — MEASURE and ALL_PROGRAMS — so a SITE run is visible in case detail and never replaces the
snapshot. The programs overview shows the measure's own rate, reduced by the same aggregator the
MeasureReport uses, as a tile *beside* the workflow-status percentage, which now says what it is; the
trend keeps its old data under the name "workflow status history". An evaluation error is in no
population and is counted (`x-workwell-evaluation-errors` on both exports, the dashboard tile, and a
new `GET /api/runs/:id/reconciliation` that states every count in one unit). The roster distinguishes
"evaluated, not in population" from "missing data" and from "evaluation failed".

**Deliberately not in this change.** An out-of-population subject still opens a MISSING_DATA case —
ADR-043 recorded that fan-out as operational noise, and closing it is a case-model contract that
belongs with the worklist slice, not a late addition here; the CDS card mirrors the case for the same
reason. A "newer check available" overlay for SITE rechecks on the roster is also deferred to that
slice. The Postgres keep set now joins `runs` and has not been EXPLAIN-ANALYZEd at pilot scale; the
store's comment says so. Source interpretation (the preparation layer's rewriting of a system-less
`resolved` to `active`, the QRDA-I importer's invented statuses) and the corpus's missing as-of cutoff
are the next two slices. A durable per-run report archive is what would let an old run export again;
that is schema, so it is the owner's.

**Still owner-owned, and worth starting now:** the nightly backup has failed since 2026-08-25 on a dead
S3 access key and the pilot instance has no backup workflow at all; the PY2027 collection-type and
lineage question to MIE, since the 2027 specifications are QDM-only and there may be nothing to
re-vendor; and an hour of the pilot's quality lead's time to adjudicate a small set of sandbox patients,
which is the only ground truth we do not manufacture ourselves.

## 2026-09-07 (later) — the last two measures go through the second engine, and a blood pressure gets its profile

Two of the four issues left open after ADR-076 merged were not the owner's at all. I had written that
the CMS130/CMS165 sweep "needs a human dispatch" when I had built the workflow and could dispatch it,
and I had shipped half of CMS165's fix and called the other half somebody else's ingest work.

**The sweep workflow's first real run failed, which is the argument for running it.** Not on the
measure: on `corepack pnpm`, which ignores the version `pnpm/action-setup` pins and fetched 12.3.4
against a lockfile written by 10, dying with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` before a single case
was evaluated. The script now prefers the pnpm already on PATH and falls back to `corepack pnpm@10`.
Every guard that ran before it behaved: the credential check passed, and the truncation check printed
`31 value sets, 3172 codes, 0 truncated` after completing AdvancedIllness from VSAC at 1000 → 2000
codes.

**CMS130 agrees with the second engine on 63 of 64** — the best first result of any measure swept, and
the eighth measure to be cross-executed. Its single disagreement is `DENEX 1→0` on a case carrying a
`MedicationRequest` with a dispense duration and no `dosageInstruction`: the same signature the CMS2
investigation proved by mutation that morning. Recorded as consistent-with rather than proven, which is
the August standard, because proving it needs a mutated bundle through the credentialed workflow and
that input does not exist yet.

**CMS165 returned 11 of 68, and it is not a number.** The Java engine puts 56 of 68 patients out of the
initial population entirely — the shape of a harness or configuration difference, not a disagreement
about the measure, and precisely the kind of result the check script's degenerate-sweep refusal exists
to stop being quoted. The obvious explanation was CMS137's period boundary, since this deck starts most
encounters at the period's first millisecond; the correlation does not hold, because nine cases whose
every encounter sits at that instant were admitted by Java anyway. So it is written down as an open
question with the next experiment named — `QICoreCommon.toInterval` over a hypertension `Condition`
with no explicit onset — and excluded from the running total, which is now **362 of 387 across eight
measures**. A number that is probably measuring the harness does not belong in a total cited as
evidence about engines.

**A blood pressure now carries its own profile — one necessary piece of #533, not its other half.** Making `trustMetaProfile`
per-measure was necessary and useless alone: under it an UNSTAMPED reading is not retrieved at all, and
WebChart-derived bundles carry no `meta.profile`, so cms165 could never have been routed on real data.
`prepareForQiCore` stamps `us-core-blood-pressure` on an Observation that already says it is one — the
LOINC panel code, or both a systolic and a diastolic component. That is normalization by this file's own
test: the profile is derived from codes the resource already carries and no clinical fact is added. The
negative cases are the point of the tests — a hemoglobin is not promoted into a blood-pressure measure
by sitting beside one, half a blood pressure is not one, and the right code in the wrong system is not
one either. It is the seam every bundle source flows through, so the corpus, the fixtures and WebChart all get the
stamp from one change — and **it does not make cms165 routable**, which two drafts of this entry claimed
before a reviewer read the library and I checked it. `trustMetaProfile: true` reaches
`cql-exec-fhir`'s `requireProfileTagging`, which filters EVERY profile-typed retrieve on `meta.profile`
and THROWS outright when a Patient retrieve matches nothing (`lib/fhir.js:428,442`). cms165 is authored
on QI-Core 6 and wants `qicore-patient`, `qicore-encounter`, both Condition profiles and more; the
corpus stamps fourteen, which is why the measure runs there and only there. On an unstamped bundle this
change does not help — the Patient retrieve throws first, loudly, before a blood pressure is looked at.
What it does supply is the one piece no other layer can: only the codes say a resource IS a blood
pressure. #533's ingest half stays open, with a second blocker behind it — WebChart's BP panel carries
`status: "unknown"` and the measure admits only `final | amended | corrected`.

The test I wrote to prove the opposite — score an unstamped bundle and assert the answer is unchanged —
was deleted rather than adjusted, because it asserted something false. It self-skips locally without the
terminology sidecar, so it would have failed for the first time in CI, on the claim rather than on the
code.

**Still genuinely the owner's, and only these:** the cms137 flip, which is a routing decision the locked
decisions reserve and which turns on whether measure 305 survives the final rule; and the live segment
repair, which needs an authenticated admin session against the running pilot. Everything else that was
open is closed or has its next experiment written down.


## 2026-09-07 — the eight flags MM-1 left open, and CMS2's seven disagreements run to a cause

Every open flag from the last three entries had one thing in common: it was recorded somewhere a person
would have to remember to look. None had a GitHub issue, so the first act of the day was filing eight
(#530–#537) with the evidence each would need. This entry is what came of working them.

**CMS2's seven cross-engine disagreements have a cause, and it is the cause CMS122 and CMS125 already
had.** Open and unexplained since the 2026-08-04 sweep, and the MM-1c precondition on CMS2's flip. The
baseline reproduced exactly — 29 of 36, all seven `NUMER 1→0` — and the seven turned out to be precisely
the cases whose only depression follow-up is an antidepressant `MedicationRequest`; every case followed
up by a `Procedure` or `ServiceRequest` agrees, including the one patient who has both. Two suspects
were eliminated by direct observation rather than by argument: the order IS retrieved (it appears in
Java's own `evaluatedResource`) and the drug IS in the pushed expansion (200 of a declared 200, not
capped). Then four single-variable mutations, each on a fresh container: `dosageInstruction` timing and
dose changes nothing; `dispenseRequest.validityPeriod` changes nothing; moving the drug to a contained
`Medication` changes nothing; adding `dosageInstruction.timing.repeat.boundsPeriod` **and nothing else**
takes the sweep to 36/36. So `cqf-fhir-cr` will take a medication's start from `boundsPeriod` and not
from `authoredOn`, and `fqm-execution` and MADiE's own expected reports take it from `authoredOn`. The
implicated helper is `CumulativeMedicationDuration.medicationRequestPeriod` — the same one CMS122's and
CMS125's `DENEX` disagreements were isolated to in August. It is now implicated in **22 of the 25**
known cross-engine disagreements: CMS122's 6, CMS125's 8, CMS2's 7 and CMS130's 1 — 8 of them proven by a
single-variable mutation and 14 consistent-with by inventory, which is the distinction the August
evidence drew and the derived docs had lost. August counted **9 of 23 unattributed**; it is now **2 of
25**, the two CMS125 cases whose follow-up is a `Procedure` only. CMS137's single one is separate and
separately proved. One difference wearing three costumes is a materially better
position than three unexplained ones. Written up in `docs/evidence/CROSS_ENGINE_2026-09-07_CMS2.md`, limits included.

That finding turned around and indicted our own corpus. `corpus-bundle.ts` gives the dementia-medication
order a real 90-day supply *through the dispense request*, with a comment saying the frailty exclusion
must be reachable "because of the data, not because of an engine leniency" — and mutation 2a is the
proof that a dispense request alone does not satisfy the second engine. The order now states the same
window in `timing.repeat.boundsPeriod` as well. Same clinical fact, said in both fields the helper
reads; generator 4.1.0, no patient changed.

**`trustMetaProfile` became a per-measure fact (ADR-076 d1).** CMS165's decisive retrieve identifies a
blood pressure by profile ALONE — it is the only Observation retrieve in that artifact with no code
filter; the other four each name a code or a value set, which is what makes a targeted switch safe. With
profiles ignored every final Observation was a candidate blood pressure, so whichever result was newest
was read as the patient's latest reading. It is on for cms165 and off everywhere else, because trusting
profiles globally empties cms122's and cms125's populations and those are routed. This is possible only
because ADR-075's corpus stamps the profile each retrieve names, which it was already doing for exactly
this eventuality. **It does not make cms165 routable** and the measure stays out of the routing list:
an unstamped bundle retrieves nothing under it, so real WebChart blood pressures need stamping at
ingest first. The new failure mode is louder where it counts — a nightly run over a roster refuses outright when
nothing retrieves — though a one-subject evaluation still cannot refuse, since for one person
retrieving nothing is a legitimate answer.
The test that pins it asserts an invariant rather than a bucket — adding a hemoglobin result must not
change a blood-pressure measure's answer — and it needs the credentialed sidecar, so it is registered
in the CI job's explicit file list. A file that job does not name is a test that reads as covered and
never runs, which that job's own comment warns about.

**An operator's next action stopped being overwritten every night (ADR-076 d2).** Escalate, manual
resolve, an outreach send's "wait for the follow-up", rerun-to-verify — each wrote `next_action`, and
the nightly run replaced it with the wording table's line. U3 made that overwrite audited, which made
it visible without making it right. A `next_action_source` column now records who wrote it: `patchCase`
is the operator surface, `upsertFromOutcome` is the system's, and an OPERATOR action stands while the
outcome it was written about stands. When the status moves, ownership reverts — an instruction about
being OVERDUE is stale advice once CQL says something else. This is the rule `IN_PROGRESS` already had.
Wording-table edits still reach every system-owned case, and the missed rate is on the case page and the
roster cell regardless, because those read the evidence rather than the action.

**Retention turned on for Maui, with the index it was waiting for (ADR-076 d4).** ADR-073 d1 said the
window lands in the same commit as the Postgres keep-set index, and the workflow comment said the same
thing in the imperative. Both indexes exist now. Maui ships 400 days, which deletes nothing today on a
two-month-old instance and starts protecting the table later: the safest possible moment to switch such
a thing on. The coupling is a test rather than a memory — a shipped window implies both indexes, so
dropping one while the window stays set goes red.

The query itself did not change, and that took a measurement to establish rather than an opinion. The
obvious companion edit was to rewrite the keep-set as a correlated `EXISTS (a newer row for this key)`,
which reads like the more index-friendly form; it was written, and then the reviewer asked for claims
wider than what was measured, so it was measured. On postgres:16 over 300,000 outcome rows — the
pilot's shape — each variant deleting the same 200,000 under `EXPLAIN ANALYZE` in a rolled-back
transaction: the original query with no index does an external merge sort spilling 19 MB to disk at
523 ms; with the index it is an index-only scan at 274 ms; the `EXISTS` rewrite with the index is a
hash semi join over two sequential scans at 516 ms, and the planner does not touch the index at all.
So the INDEX was the fix and the rewrite was a pessimization. Reverted, with the numbers in the store's
docstring so nobody writes it again — including me, next year.

**A run now says how many subjects the segment gate dropped (ADR-076 d3).** The pilot's `All Patients`
lists two clinics and the corpus spans five, so the first 20,000-patient run would have evaluated 52 %
of patients and opened no case for any of them: NOT_APPLICABLE on the roster, absent from every
worklist, nothing wrong in the data. Seeding still creates and never mutates — widening a segment stays
a human act with an audit row — so the run's job is to make the need impossible to miss, not to repair
it. One WARN per run with the count, the share, the measures and the sites; nothing at all when nothing
is gated, because a warning on every run is a warning nobody reads. Same remedy as ADR-043's, and the
same reasoning.

**`waiver_status` on a multi-rate outcome now answers from the rate the case is about**, read from
`official.rates` rather than from whichever define sorted first. A no-op for CMS137, whose rates share
one exclusion expression, and correct for the first multi-rate measure vendored without that property.

**The sweep is a script now** (`scripts/cross-engine-sweep.sh`), because three of the four ways to get a
cross-engine run wrong are silent and each has cost an afternoon: a warm container answering from cache,
a load that races the Clinical Reasoning module's registration, terminology pushed after the first
evaluation. It found a fourth on its first run: the readiness probe was `curl | grep -q`, and `grep -q`
exiting at the first match kills curl with SIGPIPE, which under `pipefail` reads as failure — so the
probe never fired against a server that had been ready for minutes. Fetch, then match. A manual
`cross-engine-sweep` workflow runs the same script where the VSAC credential lives, which is the only
place CMS130's and CMS165's sweeps can happen (#532); it refuses outright without the credential rather
than sweeping capped expansions and reporting the number as evidence.

**Still owner-owned.** The cms137 flip (#534) is NOT done and should not be: ADR-072 D1 sequences it
after cms2 and cms130, cms130's sweep needs a manual dispatch of the new workflow, and the CY2027 final
rule that decides whether measure 305 survives APP Plus is expected around November. **Its `--subjects
all` gate evidence is banked**: over all 20,000 corpus patients the gate reads 45/45 MADiE, 599 in the
initial population and denominator, 518 actionable, 0 evaluation errors, both rates alive (numerators
231 and 81), effectivePeriod covering the year — evidence FOR the flip on the whole roster rather than
the 2,000-subject sample U3 ran, written up in `docs/evidence/FLIP_GATE_2026-09-07_CMS137.md` so the
numbers have a source and not just a sentence. cms165's ingest-side stamping (#533) is the open half of
that issue. The live Maui segment repair (#536) is still a person's audited `PUT`; what changed is that
the run now tells you it is owed.

## 2026-09-06 — CMS137's gate runs on the roster Maui actually runs, and a case says which rate was missed (MM-1 U3)

U3 as specified on 2026-09-04 was mostly absorbed by U2 (#528): cms137 vendored, gated 45/45, executable,
an Active catalog row and identity, per-rate and per-stratum exports, a flip gate reading every rate. The
spec's two-row shape (`cms137` + `cms137_engagement`) was rejected in favour of ADR-074's one row with a
worst-of bucket, so what remained of U3 was the part the single-row design still owed and the verification
pass. Branch `feat/mm1-u3-cms137-gate`. Two findings, both the same shape: something that read as a
shadow of the real thing and was not.

**The flip gate was measuring a roster Maui no longer runs.** `flip-gate`'s roster reading built its
subjects from the 48-row occupational fixture filtered to the maui tenant, through the official-only
fixture bundles. U2 made Maui's roster the generated corpus, composed through `compositeBundleSource` —
so a corpus shape the artifact could not read would have passed the gate on a roster the deployment
had stopped evaluating, which is the exact class of silent failure `corpus-official-population.test.ts`
exists for. The gate now composes `composeDeploymentDirectory` and `compositeBundleSource` the way the
run pipeline does, under an env that routes the measure under test the way the flip would (the composite
refuses an unrouted measure, and the gate exists because the measure is not routed yet), and records
`roster.source` — profile, directory size, subjects evaluated, the hypothetical
`WORKWELL_OFFICIAL_MEASURES` — so the JSON attached to a flip PR says whose roster it describes.
`compositeBundleSource` takes the profile explicitly; the gate hands it a corpus source built from the
same seed its own directory was composed from — the composite's default seed is the deployment's, which
a test pins, and my first cut read it from the partial routing env instead and broke that test. A
measure outside the profile's set is refused up front with the profile named. `--subjects` caps the
reading (the CLI defaults to 2,000, `all` lifts it) because every bundle is materialised for one batch
call (ADR-074 d14).

**The case page could not say which rate the patient missed.** The bucket is the worst of Initiation and
Engagement, so OVERDUE covers a new episode nobody treated AND a patient who initiated and never came
back. The display table's comment promised "the evidence shows which"; the case page rendered rate 1's
populations (`official:numerator = true` under an OVERDUE heading for an initiated-but-not-engaged
patient) and the raw JSON, and the frontend never rendered `official_summary` at all. Now
`officialDisplayFor` takes the outcome's evidence and, where `official.rates` is present, selects the
wording of the first rate the subject is in the denominator of, not excluded or excepted from, and not in
the numerator of; the roster cell, the case detail, the case row's `next_action` (the case store receives
the evidence and persists nothing from it) and the CDS card all read it. `expressionResults` carries every
rate under its reviewed label (`official:Initiation:numerator`, `official:Engagement:numerator`;
`OFFICIAL_MEASURE_SEMANTICS.cms137.rateLabels`), single-rate measures byte-identical; the frontend
renders the label and the summary (ADR-074 d13). Prose about a persisted CQL result — never a rule.

**The gate, run on the corpus with the local sidecar** (`WORKWELL_INSTANCE=maui`, 20,000-patient
directory, first 2,000 subjects, evaluation date 2026-12-31):

| | |
|---|---|
| MADiE | 45/45 agree |
| Roster | 60 of 2,000 in the initial population and denominator; rate 1 numerator 23, rate 2 numerator 8; 52 actionable, 8 compliant; 0 evaluation errors |
| effectivePeriod | covers 2026 (the 2027 pilot year still trips the MM-1d warning) |
| Verdict | evidence FOR the flip |

The 15 patients who initiated and did not engage are the ones whose wording changed today. Two things
the run taught: the gate's MADiE half reported NOT RUN twice before it ran, because this machine's
`.official-content` sparse cone predated cms137 (eight measures, not nine — the 2026-09-05 trap again;
`fetch-official-cases.ps1` fixed it), and `cql-exec-fhir` prints "Failed to locate element for
Procedure.period" throughout because the artifact's `FirstSUDEpisode`/`ValidEncounters` read `.period`
across a union of Encounters and Procedures — artifact noise, not a corpus defect.

**The second-engine sweep, once Docker was up.** `cross-engine-check.ts` compared `group[0]` of each
MeasureReport — for CMS137, Initiation alone, so an Engagement disagreement would have read as agreement.
The comparison is now a tested pure function over every group (`src/standards/cross-engine.ts`, the same
classifier the MADiE gate uses), and the script records the period as the Java engine represents it.
Fresh HAPI 8.10.0 container, upstream bundle loaded, our 28 value-set expansions pushed before the first
evaluation: **44 of 45 cases agree on both rates**, including all eight initiated-but-not-engaged cases.
The one disagreement is "IPPass DetoxVisit": a detox encounter whose `period.start` is
`2026-01-01T00:00:00.000+00:00`, the first millisecond of the year, which Java (period at second
precision, UTC — its own report says so) reads as not `during` the period and the JS engine — whose
period is at millisecond precision, so its comparison is exact — reads as included. Isolated by two
mutations on fresh containers: one second later the case is admitted (45/45), and the SAME instant
written without milliseconds is admitted too (45/45), which rules out a coarser Java period or a strict
bound — it is millisecond-versus-second precision, on the Java side alone. A characterisation of a
boundary, not a verdict; our runtime and the steward agree on all 45
(`docs/evidence/CROSS_ENGINE_2026-09-06_CMS137.md`). cms130/cms165 stay unmeasured cross-engine — their
sidecars are VSAC-completed and not producible here — and CMS2's seven `NUMER 1→0` are unchanged.
Running cross-engine total: 299 of 323 across seven measures.

**Pre-PR review, three reviewers (Gemini 3.8 Flash through Antigravity, own reviewer, GLM 5.3 Flash).**
What survived and was fixed: the README's known-answer row still said 8 measures / 410 cases beside a
cross-engine row that counted nine (455/455 since U2); the conformance row's "IPP and DENOM agree on all
278" sat beside a 323 total whose one new disagreement IS on IPP/DENOM; the gate's verdict for a refused
batch also printed the ADR-043 "nobody is in the initial population" sentence and "even after the
per-subject fallback" for subjects it never reached — one finding now, "N subjects were never evaluated
because of it"; the causal claim in two summaries was stronger than one mutation supported, and the
JS-side sentence was wrong (fqm builds the period at millisecond precision — there is no uncertainty on
that side) — hence the second mutation above, and the summaries now say what the pair of mutations
shows; the disposition rule ran on the SQLite floor only, so the CREATED → UNCHANGED → UPDATED → UNCHANGED
sequence is now in `store-contract.ts` and CI's postgres:16 job runs it on the ceiling; the new
`CASE_UPDATED` carried no `nextAction`, so it was indistinguishable from the silent refresh it replaced
(the payload carries it now, every disposition); `populationCountsByRate` on a group-less report
recursed forever, reachable from the sweep's expected-report read outside its try (a zero vector now,
pinned, with the CMS122 reference-agreement exemption pinned through `compareReports` beside it); and
"one batch call" outlived the chunking in ADR-074 d14 and a docblock. Declined, with the reason written
down: Gemini asked that a NULL or operator-set `next_action` not count as a change — but the persisted row
does change, once, and an audited UPDATED is the honest record of it (`DATA_MODEL_CONTRACTS.md` §4 says
so); a nightly run overwriting an operator-set action is a pre-existing behaviour worth its own issue.
GLM 5.3 Flash (xhigh, the last of the three to finish) verified every one of the same paths and found
nothing above LOW: one miscount in the evidence document's running total (44 multi-rate cases for 45),
fixed.

**Not done, and why.** The flip itself stays the owner's workflow edit, sequenced after cms2/cms130 per
ADR-072 D1 — nothing here routes cms137 — and CMS2's seven cross-engine mismatches, MM-1c's precondition
for ITS flip, are still without a cause.

**Review (own reviewer + Gemini 3.8 Flash with shell access, one round).** Two HIGHs, both real, both
the same shape as the unit itself — a path that looked like it read the evidence and did not:

- **Rerun-to-verify dropped the evidence.** `verificationNextAction` called `nextActionFor` without the
  fresh outcome, so pressing "Rerun to verify" on an initiated-but-not-engaged patient rewrote the case's
  `next_action` to the combined wording — "confirm initiation within 14 days" for a patient who had — and
  recorded it in the audit payload. Staff rerun exactly the patients they are working. Fixed; pinned by a
  test that runs as the Maui profile, because cms137 is runnable only where a profile lists it.
- **The gate built a roster for a measure the profile cannot run.** Maui's corpus source deliberately
  does not gate `bundleForSubject`, so `--measure cms68` would have generated 20,000 bundles and printed a
  report; on the default profile cms137 has no fixture shape, so every subject arrived as `bundle:
  undefined` and the executor threw. Refused up front now, naming the measure and the profile (exit 2).
- MEDIUM: `missedRateIndex` hard-coded "missed = not in numerator"; it now takes the measure's
  `numeratorMeansCompliant`, the same reading `outcomeFromPopulations` applies, so an inverse multi-rate
  measure cannot name the rate a patient PASSED as the gap. LOW: the AI explain fallback printed the first
  three defines — rate 1, all true — for a six-row multi-rate outcome (every official row now); the MCP
  explanation rendered `Initiation:numerator` (now `Initiation · numerator`); a stray parenthesis in the
  contracts doc.

The own reviewer's pass added four that the first had not seen, all fixed:

- **A `next_action` rewrite under an unchanged status was unaudited.** `next_action` used to be a
  function of (status, measure), so a re-confirmed OVERDUE was UNCHANGED and the pipeline rightly wrote
  nothing. With rate-aware wording the same OVERDUE can carry a new action — the patient initiated since
  last night — and both stores would have refreshed the column silently. A re-confirm whose `next_action`
  moved is now `UPDATED` in the SQLite floor and the Pg ceiling (one store test pins CREATED →
  UNCHANGED → UPDATED → UNCHANGED), so the pipeline's `CASE_UPDATED` records it; the idempotency contract
  says so.
- **The gate evaluated the roster as ONE batch.** The pipeline hands the executor 500 subjects at a time
  (ADR-075); twenty chunks and one 20,000-bundle batch are different working sets and different failure
  surfaces, and the roster reading exists to be a shadow of the run. It now evaluates in
  `WORKWELL_RUN_CHUNK_SIZE` chunks, counts unchanged, a dropped subject in chunk 2 still an evaluation
  error. Bundles are still built up front, so `--subjects` stays the memory control and the runbook says
  which.
- **`routed as WORKWELL_OFFICIAL_MEASURES=cms137` when the operator sets nothing** reads as "cms122 and
  cms125 unrouted", a configuration no flip creates; the CLI now warns and the runbook says to pass the
  deployment's list.
- **One new test was vacuous against the fallback**: the combined OVERDUE wording also matches "initiated
  but not engaged within 34 days", so the exclusion test passed when no rate was selected at all. It now
  excludes the other rate's phrase and asserts identity with the Engagement entry; a sibling pins that
  every per-rate table has exactly one entry per reviewed rate label.

**Verification.** Backend typecheck clean; full backend suite **2,393 pass, 21 self-skip** (clean run
after the second review round) with, on the first run, one real failure — my first cut had the composite read the corpus seed from the routing env, and
`corpus-bundle-source.test.ts` (which pins the deployment's seed against a partial env) caught it; fixed
as above — and one environmental: `corpus-membership.test.ts` runs locally once any sidecar exists and
reports the cms130/cms165 codes it cannot check without theirs (the credentialed job has all four).
Frontend lint, build and the evidence component's tests green. Two host detours worth the sentence:
every SQLite-backed test failed with "the local D1 adapter needs better-sqlite3" on this branch AND on a
clean `main` worktree — the vendored package's link pointed into a U1 worktree deleted on 09-05, and the
pinned 11.x has no Node 24 prebuilt, so it is now a junction to backend-ts's built 12.x; and piping
`pnpm test` through `head` had been hiding the exit code. Docs: ADR-074 amendment, `DEPLOY.md` flip-gate
block (command, roster provenance, and the stale "cms130/cms165 have no deck" paragraph corrected),
`DATA_MODEL_CONTRACTS.md` §5, `MEASURES.md`, `STANDARDS_CONFORMANCE.md`, `guide/04` (the
vendored/gated/runnable/routed table at nine measures).

## 2026-09-06 — the 20,000-patient corpus runs through the real pipeline (MM-1 U2)

U2 is code-complete on `feat/maui-corpus`: **typecheck clean, 2,314 backend tests passing, 0 failing**;
frontend lint and build clean with 368 tests passing. Three ADRs written — **ADR-075** (the corpus, lazy
composition, chunked evaluation), **ADR-074** (multi-rate, which the CMS137 work had been citing in
nineteen places without a body), and **ADR-073** (outcome retention).

**The realized corpus, at 20,000.** Generated in **0.3 s**, deterministic from `maui-py2027-v1`, the
first 48 patients byte-identical to the fixture rows every screenshot and saved filter already names.

| | |
|---|---|
| Clinics | Wailuku 5,618 · Kahului 5,234 · Kihei 3,947 · Lahaina 3,185 · Pukalani 2,016 |
| Panels | 40 PCPs, 423–571 patients each |
| Age | median 54; 65+ 6,732 · 45–64 6,064 · 18–44 4,401 · 0–17 2,803 |
| Sex | 52.0 % female |
| Conditions | hypertension 7,853 · diabetes 3,049 · SUD episode 547 · bipolar 347 · colorectal cancer 183 · hospice 87 · ESRD 62 — all emitted as FHIR. `frailty` (592) and `pregnancy` (162) are drawn and counted but **not emitted**: the corpus has no verified code for either, so no measure can read them. |
| Blood pressure | 1,673 of 7,853 readings (21 %) are isolated systolic — high systolic, normal diastolic. Previously zero, which meant CMS165's "both components below threshold" conjunction was never exercised. |

**Measured performance.** A full run over the corpus — 20,000 patients × 14 measures = **280,000 work
items in 43.9 s** on this machine, against the pinned 15-minute ceiling. Corpus generation is linear:
11.1× the time for 10× the subjects. The engine in that measurement is a stub and the test says so; CQL
time against the real artifacts is the credentialed job's business, and a new test there asserts the
official artifacts actually find a population in a data-first corpus.

**Two things found that were wrong on main.**

The **Maui e2e was stale from U1** — it asserted three measure columns, `totalEvaluated` of 144, and a
`hypertension` column that no longer exists on a patient roster. The project is workflow-dispatch only,
so nothing had run it since the runnable set changed. Fixed to the ACO's five and 240.

The **live Maui instance needs a segment repair before the corpus is switched on.** `All Patients` was
seeded when the roster spanned two clinics; the corpus spans five, and case creation is gated by segment
applicability — so **52 % of patients (10,435 of 20,000)** would get outcomes but no cases, roster cells
reading NOT_APPLICABLE and no work list ever surfacing them. Nothing in the data would be wrong;
everything the staff can act on would be missing. Documented in `DEPLOY.md` beside the corpus size,
because it belongs with raising it rather than after somebody notices half the panel is empty.

**Review.** The reviewer's one critical finding was real and would have corrupted every number:
`WORKWELL_MAUI_CORPUS_SEED` reached the directory and not the bundles, so with it set the roster's
`pat-00053` and the chart evaluated for `pat-00053` were different people under the same id. Fixed
twice over — the composite takes the directory's own seed, and `bundleForSubject` cross-checks the
regenerated patient against the roster row and refuses rather than serving somebody else's chart. My
first test for it sampled the fixture prefix, whose fields are seed-independent by construction, and
passed against the very bug it was written for.

Four guards it found could not fire, including `invariant 6`, which asserted only `totalEvaluated` — a
value that can never be per-chunk — while the counters actually at risk were asserted nowhere.

### The review pass (four lanes)

Own correctness reviewer, a clinical/provenance reviewer, GLM 5.3 Flash and Gemini 3.8 Flash. Two
findings would have produced wrong numbers for the pilot, and both were invisible to every test:

- **CMS2's follow-up order carried a FINDING code.** `ServiceRequest.code` was SNOMED 428181000124104
  "Depression screening positive" — which classifies a screening *result* and is a direct-reference code
  with no value set. CMS2's numerator retrieves follow-up through the referral, follow-up and
  antidepressant value sets, so **1,240 documented follow-ups at 20,000 were invisible** and every one
  of those patients read non-compliant: a work list full of people the practice had already handled.
  Corrected to 183524004 "Referral to psychiatry service", which is what CMS's own CMS2 deck uses.
  A new guard — an orderable resource may never carry a direct-reference code — catches the class, and
  fails when the old code is put back.
- **Retention kept the newest row per (subject, measure), not per PERIOD.** A calendar-year eCQM's whole
  2027 evidence is superseded by the first 2028 run, so every PY2027 row became deletable around April
  2028 — months before anyone could be asked to justify a PY2027 rate. Now per period.

Three more that were real:

- **The scheduler skipped a whole night** whenever a run started more than 30 minutes past the anchor —
  a run at 12:30 gave a next fire 47.5 hours later — and the commonest trigger is the most ordinary,
  the first run after a working-hours deploy. My own test asserted a 44-hour gap under the name "a late
  run does not drag the next one late". The rule is now one scheduled run per UTC day at the anchor.
- **The retention pin list truncated at 100,000 open cases**, ordered `updated_at DESC`, so the rows
  dropped were the long-open ones whose evidence was about to be deleted. Both exclusions now live in
  SQL, per row, with no list to truncate.
- **A mid-chunk failure on the SYNCHRONOUS run path** left the run RUNNING forever with no terminal
  audit event. `ASYNC_SCOPES` covers only ALL_PROGRAMS and SITE, so a 20,000-subject MEASURE run went
  through the uncovered path.

And a set of clinical corrections: Encounter periods carried no timezone (invalid FHIR `dateTime`, on
the resource every denominator reads); hospice was drawn, counted and never emitted, so a denominator
exclusion could never fire; ESRD prevalence was 3–5× the real figure; SUD was one diagnosis for all 564
patients; conditions had no age floors (17 substance-use episodes under 13); condition onsets could
predate birth; and a `setUTCMonth` overflow made 11 of 27 look-back months unreachable.

**Flagged, not fixed — owner-owned.** The Postgres keep-set orders by
`(subject_id, measure_id, evaluation_period, evaluated_at DESC)` and no such index exists, so on a large
table the nightly DELETE sorts the whole thing. An index is a migration. Retention stays unset
everywhere until that is decided, and `DEPLOY.md` says so.

**Left for the owner:** the segment repair above, the Postgres retention index, and the review of the retention SQL in the PR.

### The second pass — what the sandbox was actually showing

Before opening the PR, a second review round: own reviewer, a clinical reviewer, GLM 5.3 Flash, and
Gemini 3.8 Flash — this time with shell access through Antigravity rather than a read-only diff, and it
earned it. Its two CRITICAL findings were the same two I had reproduced an hour earlier by running the
credentialed job's own test locally (the terminology sidecars can be vendored locally for cms2 and
cms137, whose pins do not need VSAC): **the deployed sandbox had been putting the entire roster out of
every initial population, every night, since the corpus landed.**

- **The corpus described 2027; the run scored 2026.** Every clinical fact was pinned to
  `CORPUS_MEASUREMENT_YEAR = 2027`, while a nightly run evaluates the calendar year of its evaluation
  date (ADR-072) — 2026, today. Not one encounter fell inside the measurement period. The
  `effectivePeriodWarning` was silent because the 2026 artifacts and the 2026 period agree exactly; the
  run completed; the roster read MISSING_DATA for everyone. The population test that would have said so
  was pinned to `2027-12-31` and passed. **Fixed by making identity fixed and clinical facts follow the
  year the run scores** (generator 4.0.0, ADR-075 amendment): a patient is the same person in every year,
  and `bundleForSubject` generates their facts for the year of the evaluation date. The population test
  now asks about the current UTC year.
- **CMS125 found nobody** — `inIPP=0` in the credentialed job's own log, which was red on this branch.
  Its initial population compares the `us-core-sex` extension to SNOMED 248152002, not
  `Patient.gender`, and the corpus Patient carried only `gender`. The Patient now carries `us-core-sex`,
  `us-core-race` and `us-core-ethnicity` in the steward's own shape, plus a `Coverage` typed from the
  Source of Payment Typology — the four supplemental data elements every artifact declares.
- **CMS137 found nobody.** Its denominator is a qualifying ENCOUNTER during which an encounter-diagnosis
  Condition starts; the corpus emitted a problem-list Condition at midnight on a day that need not have
  had a visit. The episode is now an office-visit `Encounter` plus a `qicore-condition-encounter-diagnosis`
  with onset inside its period. Measured over 184 SUD patients at 2026-12-31: 172 in the initial
  population, 69 meet Initiation, 25 meet Engagement — both rates alive.
- **CMS2's 170 documented refusals read OVERDUE.** The exception retrieves a CANCELLED observation of
  the screening INSTRUMENT with the refusal in its `qicore-notDoneReason` extension; the corpus emitted a
  final Observation coded with the refusal itself. Reshaped to the steward's own deck's form.

Then the standards findings the first pass had deliberately left: the mammogram is now
`qicore-observation-clinical-result` rather than a lab profile with an imaging category; the Provenance
informant is a resolvable `Organization`; frailty is emitted with the dementia medication or
advanced-illness diagnosis the 66+ exclusion needs, and palliative care, bilateral mastectomy and total
colectomy are drawn and emitted so every shared denominator exclusion can fire; `pregnancy`, which no
vendored measure reads, is gone.

**The multi-rate half (ADR-074 amendment).** Stratifier results — which `fqm-execution` had been
computing and the package discarding — are persisted as `evidence_json.official.strata` and reported: the
summary and individual `MeasureReport`s carry a `stratifier` per group in the steward's true/false-stratum
shape, and **the QRDA III now emits every group and every stratum** (a Reporting Stratum V2 per stratum
per Measure Data observation) instead of refusing multi-rate with a 501. The stratum shape is derived from
the IG and the `cqm-reports` reference exporter, not yet CVU+-validated, and `STANDARDS_CONFORMANCE.md`
says so. The flip gate and the compliance API read every rate (`rates`, additive). The MADiE evidence
report renders `r1 e/a · r2 e/a` per population instead of rate 1 alone, and the committed report is
regenerated from the credentialed run — which also surfaced that CMS138 is a THREE-rate measure whose
second and third rates the report had never shown either. And the summary MeasureReport and QRDA III **no longer return 422 above
5,000 subjects** — they were unreachable for every official measure on the 20,000-patient pilot, the
exact roster they exist for — because the aggregate is now summed from paged reads.

Smaller, all real: an unrecognised `ageBand`/`sex` token is a 400 naming the accepted values on the
roster, cases, both CSV exports and the MCP tool — it used to be dropped, serving the whole practice under
a heading that said "65+"; `planned.progress` is now exact at the point of failure rather than a per-chunk
lower bound; cms137 has official display wording (it fell back to "no record on file" and "order a
screening"); the retention notice says closed cases' rows survive too.

**What U3 had not finished.** cms137 was vendored, gated and executable, and invisible: no Active
`cms137` catalog row existed (only the Draft `cms137v14` placeholder), so the programs overview could
never list it, and no roster panel contained ANY of the four official-only ACO measures — a flip would
have made a measure runnable with no column to show it in. Now: an Active `cms137` row (ADR-071's seed
deprecates `cms137v14` toward it, audited once), a `cms137 → CMS137 / MIPS 305` identity, and the quality
panel holds all six ACO measures, each a column exactly where its deployment routes it. The Maui e2e
specs asserted five columns and 240 evaluations on a stack that routes nothing; corrected to what the
code does there (the two authored measures, 96), with the reason written in.

**Realized at 20,000 (2027 facts):** SUD episodes 604 · frailty 573 · palliative care 47 · bilateral
mastectomy 63 · total colectomy 21 · hospice 95 · payer Medicare 3,927 / Medicare Advantage 2,900 /
Medicaid 3,277 / commercial 9,896 · race White 6,532 / Asian 5,810 / NHOPI 4,871 / Other 2,162 · Hispanic
or Latino 2,303. Identity, clinics, panels and the 48-row prefix are unchanged.

**The third review round, on the second pass itself.** Own reviewer (execution against the real ELM,
five mutations), Gemini 3.8 through Antigravity, GLM 5.3 Flash. What survived verification and was fixed:

- **CMS2 banded the screening instrument by the wrong age.** The artifact bands by age at the START of the
  period; the corpus used age at the end, so a patient who is 17 on Dec 31 (16 on Jan 1) got the adult
  instrument and the measure, reading them as an adolescent, put them in the denominator with no
  numerator — 102 screened patients per 20,000, all OVERDUE with a screening on file. Verified by
  execution before and after: 40 of 40 such patients now COMPLIANT, refusals still EXCLUDED.
- **29 of 604 SUD episodes fell after Nov 14**, outside CMS137's initial population, while the comment
  beside the draw and the manifest's estimate said otherwise. Capped at Nov 14 (same two draws, so the
  pinned digest of the first 100 did not move); the estimate uses age at period start for cms2 and cms137.
- **Diabetes is an encounter diagnosis.** CMS122's only Condition retrieve is through
  `qicore-condition-encounter-diagnosis`; the corpus stamped problems-health-concerns. Harmless under
  `trustMetaProfile: false`, and the whole diabetic roster the day profiles are trusted.
- **The "same person in every year" guard sampled five indices**, none of which crossed an age band
  between 2026 and 2027, so a mutation making payer follow the evaluation year passed it. It now checks
  all 20,000 and requires that hundreds cross a band.
- **The dementia MedicationRequest fired the exclusion through a null interval** — no supply period, and
  the engine treats `Interval[null, null]` as overlapping everything. It now carries a 90-day
  `expectedSupplyDuration`, so the exclusion is reachable because of the data.
- **cms125 is routed in production and declares two age strata**, so its QRDA III and MeasureReport are
  stratified as of this pass and outside the CVU+-validated shape — the conformance caveat named only
  CMS137; it now names cms125.
- **One errored subject could flip a whole official run's exports to the status histogram** (GLM, the
  one HIGH). The provenance gate read a single row — whichever sorted first — and an errored subject
  persists `{ evaluationError }` with no `official` block, while `PARTIAL_FAILURE` is reportable. cms137
  with an errored first row exported one rate, no strata. The gate now skips rows no engine evaluated
  and pages on to the first that was; a test seeds exactly that run and fails against the old gate
  (ADR-074 d12). GLM's MEDIUM — `unmeasured` computed and dropped — was already closed by the header
  Gemini asked for; GLM reviewed the committed range, which predates it.
- **Three guards that read as present but could not fire** (GLM, LOW): the single-rate QRDA III's
  "byte-shape identical" claim was asserted structurally and is now a pinned digest, recorded after
  diffing the scrubbed output against the pre-multi-rate builder and finding it identical; the corpus
  had a digest pin for one evaluation year only, so a draw-order bug that moved clinical facts between
  years while keeping identity would have passed — a 2026 pin joins the 2027 one; the paged sum was
  tested at 5,001 rows but never at an exact page multiple, where the last full page is followed by an
  empty one — 4,000 rows now sum to 4,000.

**Codex on the PR (#528), four findings, all real, all fixed.**

- **The scheduler's debounce floor existed in the docstring, in DEPLOY.md and as the tick's argument —
  and nothing read it.** Enabled at 11:59, the first run fired at once and the 12:00 anchor fired a
  minute later: two 20,000-patient runs for the same data. One test pinned that as correct ("firing twice
  in a day is cheap"). The floor now applies to TODAY's anchor only — a same-day run inside the window
  has served the day, tomorrow's anchor is never pushed — so the night-skip the anchor rule was built to
  prevent stays prevented; the three tests that pinned the double run now pin the floor.
- **Both Maui workflows shipped retention at 90 days while DEPLOY.md said to leave it unset until the
  Postgres index exists.** Removed from both; the drift guard now pins its ABSENCE on Maui so adding it
  is a deliberate edit in the same commit as the index (ADR-073 d1).
- **Compaction deleted first and audited second, across two stores with no shared transaction.** An
  audit failure left rows irreversibly gone with a rejected promise as the only record. The intent
  event is now written before the delete and the completion event after (ADR-073 d4); a test fails the
  audit store on each write in turn and checks nothing is deleted without a ledger entry.
- **A chunk whose persist rejected after part of it committed was reported as unevaluated.** Postgres
  inserts in 500-row chunks, SQLite in slices of 90; the pipeline advanced its count only on a returned
  length. The Postgres adapter is now one transaction (contract test forces a failure in chunk 2 and
  asserts chunk 1 rolled back — runs in CI's postgres:16 service), and the pipeline recounts from the
  store on a persist failure so the terminal audit says what the table holds: 140, not 100, in the
  test that seeds exactly that.

**Still owner-owned:** the segment repair, the Postgres retention index, and the cms137 flip itself —
`pnpm flip-gate --measure cms137` now reports both rates; the workflow edit that routes it remains the
gated human act MM-1c describes, after the cms165 profile question (do NOT route cms165 — its decisive
retrieve is by profile alone under `trustMetaProfile: false`).

## 2026-09-05 — the five pilot measures become runnable, and the gate that says two of them are not

MM-1 U1 is code-complete on `feat/mm1-official-only-runnable`: typecheck clean, 2,191 tests passing,
0 failing, 43 Pg-ceiling self-skips. The unit is ADR-072 — the runnable rule, the subject-bundle seam,
the three official-only QI-Core shapes, the calendar measurement period, the display wording, the
routing badge, the catalog promotion, the vendored MADiE decks, and the flip gate.

**What the pilot actually exposed.** ADR-047 said a measure is onboarded when its MADiE gate is green.
That is necessary and not sufficient, and three measures proved it: cms2, cms130 and cms165 were
vendored, gated at 410/410 and carried semantics after ADR-071, and none of them could run, because the
pipeline derived its runnable set from the AUTHORED registry and they have no binding row. Gated,
routable and runnable are three different states that look identical from a distance. `classifyRunnable`
now names all four possibilities, and `official-pending` is a first-class answer rather than an error —
a vendored measure a deployment has not turned on is correctly configured, not broken.

**The period was answering a different question.** The official path had inherited the authored path's
rolling 365-day window, so a measure CMS defined on a calendar year was being scored over a window CMS
never defined it on. It is now the calendar year containing the evaluation date, on the run row and in
`evidence_json.official`. A mixed run keeps the authored behaviour rather than silently re-scoping half
of itself. TWH's cms122/cms125 counts move as a result; that is a correction.

**The pre-PR review found three criticals and two wrong clinical codes. Two of the criticals were in
code written today.** Worth recording because none of them would have failed a test.

1. **The calendar period silently emptied the roster for ~90 days every January.** Synthetic
   qualifying encounters are dated relative to the EVALUATION date; the period is now the calendar
   year. So a run on 2027-02-15 put its only encounter in 2026, outside the period, and every subject
   left the initial population — a completed run, every case MISSING_DATA, a roster reading "nobody
   eligible" rather than an error. PY2027 begins 2027-01-01 and Maui runs nightly. Every existing test
   pins a mid-year date, which is exactly why it survived. Fixed by clamping in-period events forward
   (`dateInMeasurementPeriod`); the regression test runs six dates and fails on four without the fix.
2. **The flip gate could never produce evidence FOR a flip.** It read fqm-execution's
   `populationResults` — an ARRAY of `{populationType, result}` — as a keyed record, so initial-
   population membership was always 0 and every measure got an unconditional ADR-043 "nobody is in the
   initial population" verdict, indistinguishable from the real thing. The test passed because its
   stub invented the same wrong shape the reader assumed. A stub that agrees with the code and
   disagrees with the engine tests nothing.
3. **The vendored-deck hash check was dead.** The loader resolved
   `measures/official/<id>/tests` against the CONTENT CHECKOUT while the vendor writes it into the
   REPO, so the path never existed, `existsSync` was always false, and every run silently fell back to
   the upstream deck. The 1169 committed files were read by nothing and `tests.sha256` protected
   nothing — while the commit message said "the gate reads them from the tree". Anchored to the module
   now, and proven by tampering a case file and watching the gate refuse. Fixing it immediately
   exposed a second defect it had been hiding: the vendor copied only case DIRECTORIES, so the
   `.madie` file naming every case was never vendored and the deck could not be opened at all.
4. **Two clinical codes were simply wrong**, both pre-existing, both verified against
   `tx.fhir.org`. `bipolarDisorder` was 13746000 — not a valid SCTID (the check digit fails), so CMS2's
   bipolar exclusion never fired and excluded patients stayed in the denominator. `colonoscopy` was
   44441009, which is *Flexible fiberoptic sigmoidoscopy*, filed under the Colonoscopy value set with a
   "Colonoscopy" display: a real colonoscopy 5-9 years old read as OVERDUE, and the synthetic case
   passed only because 3 years is inside both windows. The guard that should have caught both
   (`corpus-membership.test.ts`) self-skips without the gitignored sidecar and had never run on them.
5. **CMS165 has a flip blocker that no amount of verification would have surfaced.** The executor runs
   `trustMetaProfile: false` — deliberately; trusting profiles empties the population for the two
   measures actually routed. CMS165 is the only pilot measure whose decisive retrieve identifies blood
   pressure by PROFILE ALONE, with no code filter, so with profiles ignored "a blood pressure" becomes
   "any final Observation": add one later HbA1c to a compliant patient and the numerator flips to
   false; add a same-day one and the engine throws. Every real patient has other labs. The synthetic
   fixture emits exactly one Observation per subject — the single shape that hides it. Left UNFIXED
   deliberately (the flag is load-bearing for cms122/cms125) and recorded as a hard blocker in ADR-072,
   MEASURES.md and the DEPLOY flip runbook.

**Four findings worth keeping, and one of them is a correction to the other three.****Four findings worth keeping, and one of them is a correction to the other three.**

1. **A stale sparse-checkout cone invented a blocker that did not exist, and I believed it for most of
   a day.** `.official-content` is a SPARSE clone whose checkout cone is set once, at first fetch. This
   machine's cone predated cms130 and cms165 being added to `fetch-official-cases.ps1`, so both served
   no bundle and no test deck — while `git log` showed the same pinned commit, because it was the same
   pinned commit. That is indistinguishable from upstream not shipping them, and I wrote it up as
   exactly that: into four documents, an ADR consequence, a commit message and a memory.

   It was wrong, and the evidence contradicting it was already committed in this repo.
   `docs/evidence/OFFICIAL_TESTCASE_REPORT_2026-07.md` records cms130 at 64/64 and cms165 at 68/68.
   Re-running the fetch script returns **8 measures / 410 cases**. All eight decks are now vendored,
   and a local full run reproduces every one against the runtime: CMS122 55/55, CMS125 66/66, CMS2
   36/36, CMS68 19/19, CMS951 55/55, CMS130 64/64, CMS165 68/68 — zero unexpected mismatches, zero
   errors. cms130 and cms165 are gated; what they still need is the MM-1c sweep, not a deck.

   The lesson is narrower than "check your assumptions": a local absence that contradicts committed
   evidence is a stale checkout until proven otherwise, and the committed evidence is the thing to
   check FIRST. Two related traps came with it — `git sparse-checkout list` shows the real cone, and on
   this host `ln -s` under Git Bash silently makes a real COPY rather than a symlink, so a worktree can
   keep serving stale content after the main checkout is refreshed (use a PowerShell junction).

2. **A run that could not be evidence was overwriting the evidence.** Found by running the full gate
   locally: it rewrote CMS138's row from 47/47 to 0/47 and left it staged. `writeReport` ran BEFORE
   `exitCodeForRuns` was computed and ignored terminology entirely, so both a FAILING run and a run
   that had fallen back to upstream value sets would replace the committed report with numbers that
   describe neither the runtime nor a green gate. Writing now also requires exit 0 and the runtime's
   own terminology. The suite had never asserted the report is written at all — only that a partial run
   does not write it — so a guard blocking every write would have passed; three tests now pin the
   positive case and both negatives.
3. **The vendored-deck hash was platform-dependent.** `tests.sha256` is over raw bytes, and with
   `core.autocrlf=true` and no `.gitattributes` the same deck could hash differently on Windows and on
   CI. A `.gitattributes` now marks the decks `-text`. Git was not in fact normalising them today, but
   that was inference, and the failure mode is a red CI nobody can reproduce locally.
4. **CI's reproducibility check could not see a new deck file.** `git diff --exit-code` ignores
   untracked files, so a regenerated-but-untracked case file would have passed the gate silently — the
   one thing it exists to prevent. It is now `git status --porcelain`, and the five vendor commands pass
   `--with-tests` so the regenerated manifests still carry their `tests` block.

**The flip gate.** `flip-snapshot` cannot judge a measure with no authored BEFORE, so `flip-gate` is its
successor for the official-only three: MADiE, the roster through `evaluateLikeTheRunPipeline`, and the
artifact's `effectivePeriod`, each able to fail a flip alone, verdict in prose, exit code always 0.
Smoked on cms165 it returns five findings — including the 2026-vintage artifact scoring a 2027 period,
which is now the mechanical detector for the MM-1d re-vendor rather than something to remember. A deck
that did not run is reported as unavailable and never as a pass; that distinction is the whole point.

MM-1 U2 (the 20,000-patient corpus) is running alongside on `feat/maui-corpus`, Tasks 1-3 committed:
the PRNG, the parameter table, the verbatim 48-row fixture move (`employee-catalog` still 66/66), and
`patientAt`. Its distribution tolerances passed on the first run over the full 20,000 — every one of the
40 panels inside 350-650 — which is what the plan's weight-scaled PCP counts were corrected for. Task 4
turned out to need U1's code, not just Task 8 as the plan said, so that branch now sits on U1.

## 2026-09-04 — the Maui sandbox deploys on push and heals itself; the redeploy that showed why

The pilot's quality lead has had sandbox access since the 2026-09-03 handover, and the sandbox was still
running the handover build: three merges (#516, #517, #518) had landed on `main` with nothing carrying
them to `maui.os.mieweb.org`, because the Maui workflow was `workflow_dispatch` only. The first manual
dispatch at `668deab9` with `replace_existing=false` **failed by design** — the deploy script refuses to
touch an existing container without the replace flag — which is the honest way to learn that on this
platform every redeploy of a live container is a delete + recreate. The second dispatch with
`replace_existing=true` is the one that shipped.

Two workflow changes follow from that, both mirrored from TWH: **`deploy-maui-mieweb.yml` now triggers
on push to `main`** (with `REPLACE_EXISTING` true on push, as TWH's is), and a new
**`reconcile-maui-mieweb.yml`** self-heal watchdog recreates a down surface from `maui-latest` /
the Maui frontend's `:latest`. It carries Maui's env array verbatim from the deploy workflow — no S3
bucket keys, because Maui ships none — and `official-flip-config.test.ts` now lists it, pairs it with
the Maui deploy in `MUST_AGREE`, and its two terminology predicates read every in-scope workflow's
measure list rather than TWH's alone (the guard-scope gap ROADMAP MM-1b named). `DEPLOY.md`'s Maui
section says all of this.

Codex's review of the PR found two real defects in that reconciler, both of the same shape — an
automatic path quietly weaker than the manual one it copies. First, the deploy workflow refuses to run
Maui against the production database by comparing Neon endpoint hosts, and the reconciler carried
neither the secret nor the comparison; a self-heal is precisely where a mispasted `DATABASE_URL_MAUI`
would do the most damage, because it recreates a scheduler-enabled container with nobody watching. The
guard is now byte-identical in both files. Second, the build job pushed `maui-latest` before the deploy
job ran, so a build whose deploy then failed already owned the tag the reconciler heals from — the
recovery path would have carried an outage forward instead of ending it. The build now pushes only the
immutable `maui-sha-<SHA>`, and each deploy job promotes its own surface's recovery tag onto that digest
after the container is up (`docker buildx imagetools create`, a re-point by digest, so the promoted
bytes are the deployed bytes). Per-surface promotion also means a backend that deployed and a frontend
that did not can never be healed to as if they were one release. A pleasant side effect: a fast rollback
is itself a successful deploy, so it promotes the tag and a later heal no longer undoes it.

## 2026-09-04 — cms122's notation divergence is deliberate, and now pinned (#521)

Two tables describe cms122's improvement notation and disagree: the authored binding says `increase`
(its numerator is the compliant bucket) and the identity table says `decrease` (the official artifact's
numerator is poor control, and the Programs UI reads only the identity table). Nothing rendered wrong,
but nothing stopped either side changing silently. A test now states the divergence, why each value is
right for its consumer, and that cms125 agrees on `increase`; a second test through the real
MeasureReport builder proves an authored run's report carries the binding's notation and an
official-routed run's the artifact's (ADR-046). The divergence ends with #377, which retires the
authored cms122/cms125 rows.

## 2026-09-04 — a next action that is true whether or not the patient declined (#519)

`nextActionFor` receives only `(status, measureId)`, and for the four refusal-capable immunizations the
CQL folds "nothing recorded", "partial series" and "documented refusal" into the same bucket
(`MISSING_DATA` for the three permanent series, which never emit `OVERDUE`; `OVERDUE` or
`MISSING_DATA` for Td/Tdap). The persisted wording said "No … on file. Order or document one." to a
patient who had declined, next to a roster cell that already read "Declination on file". The four
measures now carry `NEXT_ACTION_OVERRIDES` for both statuses that name the gap and the record review
that distinguishes the states, and a mechanical test rejects any wording that asserts absence or a
refusal. A wording change is idempotent by construction: `planCaseUpsert` never reads `next_action`, and
both stores rewrite it on the `UNCHANGED` path without an audit event.

## 2026-09-04 — the Maui account rule is symmetric (#520)

`isDemoAccountRefusedOnProfile` refused only on the Maui profile, so the four `@maui.workwell.dev`
accounts could log in to TWH and were offered as assignees there. The rule is now an exact two-way
test: a Maui account is refused on every profile except `maui`, non-Maui accounts on `maui`. The
per-request gate from #514 applies it to already-minted access tokens, and the refresh path to refresh
tokens, with no further change. The child-process tests now carry positive controls (a non-Maui login
returning 200 with a token, a non-Maui token reaching `/api/runs`) beside every refusal assertion, so a
refusal cannot pass because login itself is broken; every demo account is asserted in both directions.

## 2026-09-03 — one compliance rate, computed the way CMS scores it; the inverse measure reads as inverse; next actions state the gap

**Two numbers for one measure.** The Maui walkthrough found the measure detail page showing 79.2% as its
headline and 84.4% (38/45) two panels lower under "Quality over time (source of truth)". The Programs
overview, per-run trend, hierarchy rollup, scale rollup and MCP summaries all divided by every bucket
including EXCLUDED; the quality-snapshot store had used `total − excluded` since E16, and the two were
documented as deliberately reconciling with each other by having the *snapshot* copy the overview's
denominator. The ACO divides by denominator minus exclusions and exceptions, and so does every eCQM
report WorkWell emits, so the overview was the odd one out. One exported `complianceRateOf` in
`program-read-models.ts` now serves every rate; `denominator` (= total − excluded) rides alongside
`totalEvaluated` (which stays a count) on `ProgramSummary` and `ProgramTrendPoint`; hierarchy, scale
and MCP use the same helper. The synthetic Maui roster reads 84.4% everywhere now, and the pinned tests
say so on the designed 38/7/3 distribution.

**One point per day, in the viewer's day.** The per-run trend plotted every run, so two bad runs on
2026-09-02 (the authored cms125 subset's VSAC dependence, fixed the same day) drew a 79 → 0 → 0 → 79 → 79
line with five identical "Sep 2" labels. `programTrend` now keeps the last completed run per calendar
day — *completed* meaning what `isCompletedRun` already means everywhere else, COMPLETED or
PARTIAL_FAILURE, so the headline and "from previous" compare like with like — and never plots a failed
or queued run. The day is the viewer's: the page sends its IANA zone as `tz` and the backend keys the
collapse in that zone (default UTC), because the pilot is at UTC-10 and a UTC day split every Hawaiian
afternoon into two points. The bad runs still exist as runs; they simply are not the day's point.

**CMS122 displayed as what it is.** Diabetes A1c > 9% is an inverse measure — the numerator is poor
control or no A1c, and lower is better — and the tile showed a green 79.2% "compliance". Measure
identity now carries `improvementNotation` (`decrease` for cms122; a test ties it to the official
semantics table's `numeratorMeansCompliant: false` so the next inverse measure cannot be declared in one
table only), the API serves it, and every rate on the two Programs pages — headline, quality-over-time
block, chart tooltips, run history — renders decrease measures as "Poor control X%" with a "Lower is
better" line, through one tested helper (`frontend/lib/measure-rate.ts`). X is overdue over
(compliant + due-soon + overdue): on the official path MISSING_DATA means outside the initial population
(or an evaluation failure), which is outside the denominator, so it counts in neither. Chips, worklist
links and the delta keep working, with the delta's good/bad tone inverted for decrease measures.

**What deliberately did not change.** The run-level `passRate` (run list, runs CSV §6.1, MCP run
summary, AI insight, audit packet) still divides by the evaluated total including excluded: it is an
operational per-run statistic, not the CMS rate, and the CSV column is a documented contract. The
"Overall compliance" KPI on the overview, which is a CMS-style number, now uses the denominator.

**Next actions state the gap.** `nextActionFor` said "Escalate mammogram follow-up immediately." for
every overdue case and "Schedule the … before the due date." for due-soon. It now says what is missing
and what closes it ("No mammogram on file for this measurement period. Order or document one.";
"No … result could be found. Check for outside records before ordering."; "A … is due before the end
of this measurement period."); the EXCLUDED sentence is profile-gated in the terminology PR. Case
detail, the cases list and CSV exports read the persisted string (written at case upsert, so an open case
shows the new copy after the next population run refreshes it) and CDS cards recompute it live, so this
changes what the pilot's staff see on every open case from the next run on.

**Review follow-ups (post-open).** (1) cms122 is inverse: its numerator is most-recent glycemic status assessment (HbA1c *or* GMI — the
vendored bundle carries the GMI LOINC) > 9%, *or* no assessment in the period, so an OVERDUE patient may have a
documented poor-control result, and "No HbA1c test on file … Order or document one." was wrong for that patient —
and the string is persisted on the case and rendered in CDS cards. `nextActionFor` now carries a per-measure
override; the cms122 OVERDUE sentence names both readings and states what closes the gap in the measure's own
terms (a result at or below 9% documented in the period), never an order the data may not support. The noun for
MISSING_DATA/DUE_SOON no longer narrows the measure to HbA1c either. (2) The "Quality over time" tile and its data table paired "Poor control 15.6%" with the
persisted compliant numerator (38 / 45). `displayRate` now returns the numerator and the denominator the
displayed percentage was made of, and every n / d on the two Programs pages renders those. (3) The overview
read cms122 as "Compliance 84.4%" until `/api/measures` resolved, and forever if that request failed.
`ProgramSummary` now carries `improvementNotation` from the identity table, and both pages fall back to the
summary's own notation, so the inverse reading never depends on a second request.

## 2026-09-03 — pilot mode: the engineering surfaces leave the quality team's view, and four broken affordances work

**Pilot mode.** The Maui walkthrough found a quality lead's sidebar carrying Measures, Studio, Runs and
API, a header offering MIE's brand list (Enterprise Health, MIE Web, BlueHive, WebChart, Ozwell,
WaggleLine), a "System" selector for a single-clinic deployment, a "Run All Measures Now" button on the
dashboard, and a case page with Escalate, Rerun to verify and Mark queued/sent/failed. Role gating was
nav-only: the clinician account could open every case by URL and the case manager could open the Studio
editor. `NEXT_PUBLIC_PUBLIC_DEMO=off` (already the Maui build's setting) now means *pilot mode*:
`isPilotMode()` / `canSeeEngineering(role)` in `frontend/lib/public-demo.ts` hide those items and
controls from every non-admin role and make `/measures`, `/studio*`, `/runs` and `/api-docs` render the
existing access-denied component for them (and skip their data fetches), so a URL cannot reach a page
the nav hides. Admins see everything; with the flag on (TWH, the public demo) nothing changes for anyone.
This is a UI convenience layered over the existing server-side role checks, not a replacement for them:
the case-action and run endpoints keep their CASE_MANAGER/ADMIN gates unchanged, so a pilot case manager
could still call them directly — the point of hiding is to stop the *accidental* click, not to add a
permission.

**Four affordances that did not work.** (1) The assignee pick list was a hardcoded pair of TWH accounts
the Maui profile refuses at login; `GET /api/users/assignable` now serves the case-manager and admin
accounts allowed on the active profile (gated in the security matrix, no hashes) and the case page reads
it. (2) Typing a patient's name and pressing Enter did nothing: the backend search was scoped correctly,
but the dropdown only opened on a successful non-empty response, so a failed response was silence, and
Enter had no handler. It now shows "No patients found" (in the deployment's term) on empty or failed
responses and navigates on Enter when exactly one result is shown. (3) The Compliant and Excluded chips
were the only two that were not links; the roster API and page gained a `measureId` parameter that
scopes the status filter to one measure's column (resolving the panel from the measure, so a link needs
no panel), and the chips link there. On the Maui roster the destination count equals the chip; on TWH it
can differ, because the overview folds in the scale tenant and honours the date range while the roster
does neither, so the chips do not forward a date scope the roster cannot honour. (4) The
Compliant/Excluded destination previously did not exist because the roster's status filter matched any
column.

**Review follow-ups (post-open).** (1) When the server canonicalized the panel — a chip deep link whose
measure lives in another panel, or the Maui default `immunizations` request being served as `wellness` —
the page also dropped `measureId`, so the roster refetched unscoped and the destination count no longer
matched the chip. Canonicalization now keeps the measure scope; a person changing the panel still clears
it. (2) The System selector on `/compliance` was still rendered for everyone in pilot mode; it is gated by
`canSeeEngineering` like the Programs and Hierarchy selectors.

## 2026-09-03 — the pilot sandbox stops saying "employee": a deployment subject term reaches the backend, and every occupational label on the patient profile is gone

**Why now.** A full walk of the live Maui sandbox from the quality lead's seat — every nav item and the
routes hidden from nav, both roles, desktop and phone, both themes — found that the first ten minutes
would surface a dozen trust-breakers. The single largest class was occupational-health vocabulary
surviving the "patient" terminology switch: it had only ever been a *frontend* build flag, so anything
the backend rendered still said employee. This PR closes that class; the rate/copy and pilot-surface
classes follow in their own PRs.

**Backend: the profile carries a subject term.** `DEPLOYMENT_PROFILE.subjectTerm` (`employee` on the
default profile, `patient` on `maui`) plus `subjectNoun()`, in `deployment-profile.ts`. It drives the
three places the backend puts words in front of a person: the AI prompts and deterministic fallback
(`buildDraftSpecSystemPrompt` / `buildExplainSystemPrompt`; the default-profile strings are pinned
byte-identical, and the fallback says "result date" / "exclusion status" instead of "exam/vaccine" /
"waiver" on a patient deployment), the outreach templates (`PATIENT_TEMPLATES`: a clinic message with
no "requirement", no "compliance", and no due-date line — the previous text read like an HR notice
with a due date eight months in the past), and the two subject columns of the outcomes/cases CSVs
(`patientExternalId`/`patientName`; `DATA_MODEL_CONTRACTS` §6 records it). Every branch is tested on
both profiles through the child-process pattern.

**The hypertension placeholder reads as clinical.** Its CQL defines were "In Wellness Program" and
"Has Medical Exemption", which the evidence panel showed verbatim, and its catalog row cited "HEDIS BPC
/ JPMC Wellness Rewards". Renamed to "In Eligible Population" / "Has Documented Exclusion", the ELM
recompiled (only that one ELM file changed), the catalog row and YAML relabelled as a CMS165
placeholder. Because the seed is name-idempotent an already-seeded database keeps the old row, so the
seed now carries a fingerprint-gated repair for exactly this row: each of policyRef and the whole spec is
classified as old, new or edited against the pre-change and current catalog values; when nothing is
edited and something is still old it writes one `MEASURE_SEED_UPDATED` audit event, then `updateSpec`,
then refreshes the stored CQL text so Studio shows the renamed defines; an edited row is left alone
with a warning; a repaired row is a silent no-op on every later boot. Tags are not repaired — no store method
updates them and the store is owner-owned — which the lane that hit the boundary reported rather than
worked around.

**Frontend, on the patient term only.** The evidence panel drops "Role eligible"/"Site eligible", says
"Exclusion status" and "Last result date", and no longer dumps the raw `why_flagged` JSON; the Programs
overview and measure detail drop the "Top Roles" card and their driver grids lose the empty column; the
roster (desktop table *and* the mobile cards), the header search results, the people page and the
segment editor drop the role; the patient profile hides job role and supervisor; the Runs grid drops
its Role column and says "Exclusion" / "Days since result"; the panel label reads "Quality measures";
the appointment dialog offers clinic visit types instead of Audiogram/TB Test/Flu Vaccine; "Period
2026-01-01" reads "Measurement year 2026"; the hero copy and the expired-exclusion banner say
"exclusion" instead of "waiver". The employee term is unchanged, pinned by paired tests, with one
deliberate exception for every profile: the Cases hero heading now carries an explicit `text-white`,
because a global heading colour overrode the section's colour and made it invisible in light mode.

**What is still occupational on the patient profile, on purpose.** The admin page and Studio (waiver
tables, OSHA references, role filters) are reachable only through the admin account and are
route-guarded for everyone else in the pilot-mode PR that follows; the MCP tool descriptions; the
`role`/`roleEligible`/`siteEligible` CSV columns (a contract change deferred, noted in
`DATA_MODEL_CONTRACTS` §6); and the hypertension value-set *names* ("Wellness Program Enrollment"),
which are shared with the obesity measure and only surface in Studio.

**Review record.** Four reviewers on the whole diff (GLM 5.3 Flash, Gemini 3.8 Flash, Sol, and the
orchestrator's own reviewer) found four largely disjoint sets: 13, 11, 23 and 12 findings. The real
ones, all fixed in a second round: the seed repair warned "row edited" on every boot after the first
and never refreshed the stored CQL text (Studio would have kept showing the old defines); an explicit
`templateId` bypassed the patient outreach templates on preview, send, campaign and the admin list;
outreach dispatch wrote "Wait for employee follow-up" into the case's next action; the fixture and
CQL-drafting prompts still said "occupational health"; and roughly a dozen frontend leaks the first pass
had not reached. Rejected on adjudication: that the TWH catalog's employer reference is a client-side
name (it is the demo tenant's own pre-existing label across the whole catalog), and the
concurrent-boot double-audit, which is the documented ADR-071 class. One implementation lane, asked to
keep JSON schema keys unchanged *and* to make the patient prompt free of the words those keys contain,
resolved the contradiction by writing the keys as unicode escapes — a prompt the model could not have
parsed. The gate that caught it was the orchestrator reading the diff, not a test; the test now strips
schema keys before matching prose. One GLM implementation lane looped on a UTF-8 `apply_patch` failure
(127 attempts, no edits) and was killed and re-routed; its RED test was kept. A second review pass
confirmed every first-pass item closed and left a short residual list (the admin template preview, the
EXCLUDED next-action sentence, the roster cell vocabulary, the escalation string, the audit CSV header,
the CDS card and discovery text, a CQL-only half-applied seed repair, the landing fallback copy), each
closed by a single-purpose lane with a both-profiles test. Verified on a local stack booted as the Maui
profile after each of the first two rounds: the built pages, the CSV headers, the AI fallback text and
the outreach preview all read as described here.

**Review follow-ups (post-open).** Two findings on the open PR, both real. (1) The seed repair compared
policy and spec against the pre-change fingerprint but replaced the CQL unconditionally, so a Studio
author who had edited only the CQL would have lost that work on every boot. The CQL is now fingerprinted
the same way: the stored text (line endings normalized) must equal either the pre-change reconstruction
(`hypertension-pre-change-cql.ts` — `reconstructCql` of the old ELM, which is what the seed wrote) or the
current one; anything else was authored, and the whole row is left alone with a warning rather than
half-repaired. (2) On the patient profile `updateTemplate` returned a "successful" record and wrote an
`OUTREACH_TEMPLATE_UPDATED` audit event without persisting anything — list, preview and dispatch all read
`PATIENT_TEMPLATES` from code, so the next request showed the old text. Create and update now refuse on
that profile (HTTP 400 with the reason, which the admin page already surfaces), unknown ids stay 404, and
no audit row is written for a change that did not happen.

## 2026-09-02 (later) — Maui routes cms122/cms125 official: the authored breast-cancer subset was hostage to VSAC reachability

**Found while verifying the redeployed sandbox.** Breast Cancer Screening on Maui read 0% compliant, 45
overdue, where the previous day's run had 38 compliant and 7 overdue — on identical code and an identical
synthetic roster. Only cms125 moved. The per-patient evidence said why: initial population true, `Has
Qualifying Mammogram` false, for a patient whose bundle always carries a mammogram 180 days back.

**The mechanism is terminology, not dates.** The authored `cms125` numerator retrieves `[Procedure:
"Mammography"]`. With `WORKWELL_VSAC_API_KEY` set (it is, on every deployed stack) the engine resolves
that OID through VSAC live, whose expansion is 92 LOINC codes and no CPT — the fact ADR-044 recorded when
it dual-stamped the synthetic mammogram as a CPT Procedure *and* a LOINC Observation. The bundled
CPT-bearing expansion is only consulted when the live answer is *empty*. So the authored measure is
correct exactly when VSAC fails, which it did the day before and did not today. Reproduced three ways:
locally with no key every evaluation date is COMPLIANT; a fresh manual run on the new container gives
45 OVERDUE again; the two production runs' evidence differs only in that one define. TWH never showed it
because TWH routes cms125 to the official artifact, which reads the LOINC Observation.

**Decision (owner, 2026-09-02): route cms122 and cms125 official on Maui, as TWH does.** The Maui
image already vendors both artifacts and sidecars; official routing does not use the runtime VSAC key;
both measures are MADiE-gated and routed in production. Gate before the flip: the official executors
over all 48 Maui patients return the designed distribution for both measures — 38 COMPLIANT / 7
OVERDUE / 3 EXCLUDED, zero mismatches — and `flip-snapshot --source synthetic` reports the flip inert on
the designed probes. One workflow env line; `official-flip-config.test.ts` reads the shipped value.
The authored cms122/cms125 subsets stay in the catalog for now (#377 retires them). The finding is the
sharpest evidence yet for that issue: an authored subset that is right only when the terminology
service is down is not a subset, it is a coincidence.

## 2026-09-02 (night) — Maui demo account restriction enforced per request

While login and refresh previously restricted authentication on the Maui deployment profile to
`@maui.workwell.dev` accounts, access tokens minted earlier (such as the public sandbox's
`viewer@workwell.dev`, with a 30-day TTL) continued to be accepted because `extractPrincipal`
only verified JWT signature and expiry. The worker's authorization gate now re-resolves
`findDemoUser(principal.email)` immediately after extracting a principal, setting it to null
if not allowed on the active profile so that protected routes return 401 unauthenticated.
To support this cleanly, `findDemoUser` accepts a defaulted `profileId = DEPLOYMENT_PROFILE.id`
parameter so profile scoping is tested in-process as well as end-to-end via child process.

## 2026-09-02 — the segment seed follows the deployment profile

The demo segment seed (`segment-seed.ts`) now selects its cohort set by `WORKWELL_INSTANCE` instead of hardcoding
the TWH occupational-health set for every deployment. The default profile keeps the three cohorts byte-identical
(snapshot-pinned in the test); the maui profile seeds a single "All Patients" segment scoped to the Maui directory's
sites with the profile's runnable measure set. An already-seeded Maui database keeps its old rows (name-idempotent,
never mutates) — the owner repairs it once via the audited segments API (see docs/DEPLOY.md). The per-profile
coverage invariant (`no-orphaned-measure-in-demo-seed`) is now asserted for both profiles, and the maui assertions
fail if the profile branch is removed.

## 2026-09-02 — the Maui sandbox is handed over: unclaimed runs recover, demo accounts are profile-scoped, public-demo affordances become deployment config

The Maui sandbox deployment is being handed to the pilot group for quality-lead review, which requires
hardening the sandbox against state leaks and operational dead ends:

1. **Unclaimed QUEUED run recovery (`failStuckRuns`):** On live deployments without an active background
worker daemon, runs placed into `QUEUED` status could sit pending indefinitely. Boot recovery now sweeps
unclaimed `QUEUED` runs older than 6 hours alongside interrupted `RUNNING` runs, transitioning them to
`FAILED` with distinct audited reasons (`RUN_RECOVERED`) and alerts so backlogs never hang silently.

2. **Profile-scoped demo accounts:** On the Maui deployment (`WORKWELL_INSTANCE=maui`), demo authentication
is restricted strictly to `@maui.workwell.dev` accounts. The standard `@workwell.dev` demo logins—including
the public viewer—are refused, ensuring the pilot group's workspace access remains cleanly separated.

3. **Public-demo affordances as deployment config (`NEXT_PUBLIC_PUBLIC_DEMO`):** With `NEXT_PUBLIC_PUBLIC_DEMO=off`,
the public sandbox entry cards, the walkthrough video (which references employee terminology), and GitHub
repository links are suppressed, and the landing page elevates "Sign in" to the primary CTA while the
login screen renders the clinical quality measure domain copy. Defaulting to `on` keeps existing TWH demo
deployments byte-identical while Maui boots cleanly scoped for the pilot review.

## 2026-09-01 (night) — #501: the Maui profile stops leaking foreign rows on every surface, and lists only measures it can run

**One predicate, shared, gated, injected.** `profileSubjectMatcher(lookup)` now lives in
`backend-ts/src/config/deployment-profile.ts` beside `isRunnableMeasure`: a subject must resolve in the
*injected* directory to appear, and on the default profile the predicate is a no-op by construction —
a TWH database legitimately holds subjects absent from the synthetic catalog (QRDA Category I imports
keyed by Cypress MRNs), and an ungated filter would silently drop them. Every surface the #500 review
named applies it before aggregation, paging and totals: the outcomes and cases CSVs, `/api/cases` and
`/api/cases/:id`, the run-outcome rows (including `X-Total-Count`), the MCP tools (`list_cases`,
`list_noncompliant`, `get_case`, `explain_outcome`, `check_compliance`), the programs site list, and
the orders route. The programs overview, the hierarchy rollup (both the live path and the scale path),
the orders route and MCP `list_measures` enumerate the profile's runnable set instead of the whole
catalog. Latest-run selection on a scoped profile happens *after* the predicate, so a newer run holding
only foreign subjects no longer hides the visible ones.

**Every surface carries a pair of tests**: a Maui test that fails on `main` (a foreign subject id
reaching the client, or a non-runnable measure in the list) and a default-profile companion asserting
an *unresolvable* subject is still included. The profile is selected by spawning a child per profile
(`backend-ts/src/test-support/run-profile-child.ts`), so the module-level profile cache cannot leak
between test files.

**Review found a default-profile regression before it shipped.** The first cut derived the programs
site list from evaluated rows on every profile; TWH would have lost sites whose staff had never been
evaluated. It is restored to the pre-change behaviour on default and asserted against the full site
list. Two reviewers (cross-model and independent) found disjoint sets again: one the site regression
and the six duplicated matchers, the other the unscoped hierarchy scale path, latest-run ordering, and
the MCP measure list.

**Frontend:** when a deployment leaves no panel runnable, the roster and the per-patient card now say
"No compliance panel is configured for this deployment." instead of an empty select or a claim about
the patient — on any panel response, not only the first.

**One intentional default-visible change:** MCP `get_case` and `explain_outcome` now return the coded
`CASE_NOT_FOUND` safe-error payload for an unknown id instead of throwing `ToolArgError`, as documented
in `docs/MCP.md`.

**Deliberately still open from #501:** the auditor run packet and CASE packet (`backend-ts/src/audit/audit-packet.ts`,
served by `routes/auditor.ts`) still emit unscoped outcome rows on a scoped profile — downloadable
artifacts, so they are filed as a follow-up rather than left silent; the run summaries (runs CSV
`export-csv.ts`, `/api/runs`, and MCP run summaries in `tools.ts`) still use raw
`countOutcomesByStatus`; `segment-seed.ts` (its site list is load-bearing for Maui applicability and
needs that path checked first), and the 100k store caps that precede profile filtering in the CSV, MCP,
programs and hierarchy readers are also known limits tracked in #508, because a Maui database holds
no foreign rows today.

## 2026-09-01 (night) — MM-0's last task lands in #505, and the Maui sandbox is live for the first time

**The Maui sandbox had never been deployed.** `deploy-maui-mieweb.yml` is dispatch-only and had zero runs;
both Maui hostnames returned 404 while the docs said MM-0 had shipped. Dispatched at 14:40, green at
15:0x; verified from the API rather than from a 200 — a sandbox login returns the wellness panel with
the three ACO-aligned columns over 48 patients, and the 15:00 scheduler run populated every bucket
(38/3/7 on CMS122 and CMS125, a five-way spread on hypertension). One stray QUEUED row in Maui's run
list is mine: I posted to the worker-queue endpoint instead of `/api/runs/manual` while probing; it is
inert and only a database delete removes it.

**MM-0 Task 4 — the MIPS↔CMS crosswalk — was the other unshipped piece.** MIPS ids existed only inside
catalog description strings. Now `backend-ts/src/measure/measure-identity.ts` is the one source of truth
(`{cmsId, mipsQualityId}` per catalog row), `GET /api/measures` serves it as `identity`, and the
frontend renders "MIPS 112 · CMS125 · Breast Cancer Screening" (the catalog page from the row's own
`identity`; every other surface through the `useMeasureIdentities` hook) on the
catalog (an Identity column), case detail, the roster headers and mobile cards, and the programs
pages including the chip aria-labels. A drift test parses the MIPS text out of every CMS catalog row and
fails if the map disagrees, has an extra entry, or a CMS row lacks a MIPS mention without a null id —
witnessed failing on a deliberately altered entry before it passed. Occupational measures have no
identity and render exactly as before, asserted with anchored negatives.

**Two review rounds, three reviewers, disjoint findings again.** The external cross-model review found the
drift guard matched only one of the two MIPS text forms in the catalog and that the hook had no
stale-response guard; the second reviewer found case detail keyed the lookup on `measureVersionId`, which
works only because the read model emits the slug as a stand-in — fixed by adding a real `measureId` to
`CaseDetail` — plus a test that claimed to assert a dash and did not. Neither reviewer found the other's.

**MM-1b is planned but not started.** An inventory pass, a drafted plan, and an adversarial spec review (14 findings, two
critical: CMS130/CMS165 semantics entries were missing from the plan, and pre-flip Maui behaviour was
undefined). The bundle with my adjudication is a local plan file for owner review — the id model
(rename to bare `cms2`/`cms130`/`cms165` vs an alias layer) and catalog activation's visibility on TWH
are owner calls.

## 2026-09-01 (late night) — MM-1b begins: the three official-only measures get one honest id and the semantics routing needs (slice 1)

**The id was the first thing in the way.** `cms2`, `cms130`, `cms165` were catalog rows keyed
`cms2v15`/`cms130v14`/`cms165v14`, but the official executor requires the requested id to equal the
manifest's `catalogId`, and `cms122`/`cms125` already use the bare form. Nothing anywhere references
the versioned ids — the measures have never run — so they are renamed rather than aliased (ADR-071).
The seed deprecates a legacy row once, with one `MEASURE_DEPRECATED` audit event, and only when the row
still carries the exact seed fingerprint; an edited row is left alone. A second seed is a no-op.

## 2026-09-01 (evening) — the stakeholder one-pager exists, and the quality-teams explainer is finally tracked (#478)

`docs/WHAT_WORKWELL_IS.md` is the page a non-engineer reads first: what WorkWell is beside WebChart,
what it is not, what differentiates it, what runs where, and how it fits a quality team's day. Two
things were deliberately written as *planned* rather than present — provider-panel work lists (MM-2)
and cards that resolve by order or exception (MM-3) — because the first draft described both as if
they shipped, and the whole point of the page is that a stakeholder can trust it. Conformance claims
are restated in qualified form and linked to `STANDARDS_CONFORMANCE.md`.

`docs/guide/normalization-for-quality-teams.md`, the one clinical-audience artifact, had sat untracked
since the 2026-08-24 alignment audit noticed it; it is committed and linked from the README and the
guide index alongside the one-pager.

## 2026-09-01 (later still) — the guard shipped, could not run, and production went down for the third time in the same place

**`OFFICIAL_MEASURE_SEMANTICS` gains `cms130` and `cms165`** — numerator means compliant for both,
verified against each artifact's `improvementNotation: increase` — so `officialRoutingProblems` no
longer refuses them for missing semantics. The rows stay Draft/NOT_COMPILED; runnable-ness, the
official-only Active state, the synthetic corpus and the flip gate are the next slices, in the order
the reviewed plan sets.

**Planning record.** An inventory pass mapped the pipeline; a drafted plan cut it into seven slices; an
adversarial spec review found 14 issues, two critical (the plan had omitted the CMS130/CMS165 semantics entirely, and left pre-flip
Maui behaviour undefined); the owner chose the rename over an alias layer and accepted that the three
rows are visible on TWH's catalog. The secondary delegate meter ran out mid-evening, so this slice
finished on the primary one.

**Review-driven hardening of the seed.** The deprecation audit is written *before* the status change
(the repo's audit-before-state contract), successors are inserted before predecessors are deprecated,
rows back-filled into an existing database now get their own audit event (a fresh first boot stays
unaudited, as it always was), and an edited legacy row is asserted to stay Draft. Known limit, recorded
rather than fixed: two worker processes seeding concurrently are not coordinated and `audit_events`
has no unique constraint, so a duplicate deprecation event is possible under a race — schema is
owner-owned.

## 2026-09-01 (later still) — the guard shipped, could not run, and production went down for the third time in the same place

**#502 merged at 18:02. The deploy it triggered failed at 18:04, at the same DELETE, with the same
`curl: (28)`, and the fix did not fire.** No read-back. No warning. `twh-api-ts` deleted, the deploy
stopped before recreating it, backend down. Restored by re-running the job; all four surfaces
verified back at 200.

**The cause is one line, and it is inside `request()`, not inside the new guard.** Its retry loop
does `set +e` around curl and then an unconditional **`set -e`** — and errexit is a property of the
*shell*, not of the function. So `request()` re-armed errexit **before returning**, reaching across
the function boundary to undo the caller's `set +e`, and the shell exited on `request()`'s own
non-zero return. `delete_container_confirmed` never reached the line after the DELETE. Reduced, it is
unambiguous:

```
inner() { set +e; false; set -e; return 1; }
outer() { set +e; inner; local rc=$?; set -e; echo "REACHED: rc=$rc"; }
outer            # prints nothing; the script exits 1
```

**Why nothing caught it, which is the part worth keeping.** The unit test substitutes a fake
`request()`. That is the right boundary for testing the *decisions* — when to read back, when to
re-issue, when to refuse — and eight mutations confirm it tests them well. But a double defines away
everything about the real thing that it does not model, and what it did not model here was the one
behaviour that mattered: the real `request()` manipulates the caller's shell flags. Two review passes
looked at this code. The independent one **did** flag the save-versus-assert pattern — as a MINOR
point about the *new* file, on the grounds that it was "correct here". I agreed and skipped it. The
same pattern in the file it *calls* was the outage.

**Fixed three ways, because the first two are each sufficient and neither is where the lesson is:**

1. `request()` saves the caller's errexit (`case "$-" in *e*)`) and restores it only if it was set.
   The class fix — every caller was exposed, not just the new one.
2. The call sites are errexit-immune **by construction**: `|| return 1`, and a condition context.
   Both are exempt from errexit no matter what the callee does to the shell, so this cannot be
   defeated from inside `request()` again.
3. **`mieweb-delete-confirmed.integration.test.sh`** drives the *real* `request()` and the *real*
   `delete_container_confirmed` under the deploy's own `set -euo pipefail`, faking only `curl`.
   Reverting both fixes makes it fail, reproducing the production log line exactly.

**And the harness got the same lesson wrong once more before getting it right.** The first draft of
that integration test called the function as `delete_container_confirmed … && echo ok || echo fail`
— a condition context, which suppresses errexit for the call *and everything beneath it*. It passed
with the production bug fully restored. The deploy calls it **bare**; the test now does too. A
harness gentler than the caller it stands in for is not a test of that caller.

**What I would take from all three of today's rounds:** every defect — Codex's, the reviewer's four,
and this one — was the same shape, a control that reads as present and cannot fire. Mutation testing
found it in the code. Review found it in two guards and two tests. Production found it in the seam
between a test double and the thing it stood for, which is the one place none of the earlier passes
could look. **Test a survival guard against the real thing that fails.**

## 2026-09-01 (later) — the deploy stops failing over a DELETE it cannot see the result of, and the always-loaded doc set is halved

**The recurring outage has a name now, and it is not the manager.** Merging #500 triggered
`deploy-twh-mieweb.yml` run `33528872552` at 15:57. It ran `DELETE /sites/1/containers/2026` to
replace `twh-api-ts`, got `curl: (28)` after 30 s with zero bytes, and stopped — **but the manager had
already applied the deletion.** Production lost its backend, the frontend deploy was skipped so it
stayed on pre-merge code, and it sat that way for ~3 hours. The same `curl: (28)` on the same DELETE
is recorded on 2026-08-30. This was the second time, not the first.

**Two things were wrong, and only one of them was the timeout.**

The once-only rule in `mieweb-api-request.sh` is correct about what it refuses: a lost response means
the manager's state is unknown, and re-issuing a state-changing request into an unknown state is the
worse default. But "unknown" was treated as terminal, and it never had to be — *the manager will say
what is true*. `.github/scripts/mieweb-delete-confirmed.sh` asks it. On any DELETE that does not
return cleanly it polls `GET /sites/{id}/containers?hostname=…` (6 × 10 s) and decides on the answer:
**absent → the delete landed, continue**; **still registered → re-issue**, which is not a blind retry
because the request demonstrably did not take effect. Bounded at three attempts. The once-only policy
is unchanged; what changed is that the ambiguity now gets resolved instead of ending the deploy.

**The assertion that matters most is the one about not knowing.** A list read that *fails* counts as
still-present, never as absent. Collapse "could not tell" into "it's gone" and the deploy proceeds to
create over a container that is still running — this guard's own failure mode, inverted. That is
pinned as its own test, and it is the reason the guard is not vacuous.

Five behaviours pinned in `mieweb-delete-confirmed.test.sh`, wired into CI's `deploy-helper` job —
necessary because deploy scripts execute only on push to main and are otherwise invisible to every PR
check, the same blind spot that let #356 ship a shell parse error. Each assertion mutation-checked:
reverting to abort-on-failure, collapsing the unreadable-list case, removing the re-issue, and
ignoring the read-back each fail their own assertion and no other.

**The second wrong thing was a comment.** `reconcile-twh-mieweb.yml` says it runs every 15 minutes and
`DEPLOY.md` quoted that as the worst-case recovery latency. Measured over the twelve most recent
scheduled runs (2026-08-30—09-01): **2.5 to 7.5 hours apart**, never fifteen minutes — GitHub queues
`schedule` on a best-effort basis and drops runs under load. Its last run before the outage was 12:46,
three hours before the deploy failed. The reconciler is a slow backstop, not a watchdog, and both the
workflow header and DEPLOY.md now say so with the measurement attached. Nothing that must not stay
broken for hours can be left to it — which is exactly why the fix above lives in the deploy path.

**Two review rounds, and both found the same class of defect in my own guard.** Codex (P2): the
read-back returned the same status for *confirmed still present* and *the read itself failed*, so a
timed-out DELETE plus an unreachable manager produced up to three blind state-changing retries — the
ambiguity the helper exists to respect, reintroduced by the helper. I had handled the unreadable case
correctly on one side (it must not read as *absent*) and not the other (it must not read as *present*
either). The verdict is now three-valued, and only the **last** observation in the window decides.

The independent review then found four more, of which two were mine and two were the tests lying about
their own coverage:

- **`.data[0].id // empty` extracts `""` from an error envelope served with a 200 exactly as it does
  from a genuinely empty list** — and `""` is the verdict that lets the deploy CREATE. The highest
  blast radius in the file, reached *through* the guard. Absence now requires an affirmative envelope
  shape; anything unrecognised is could-not-tell.
- **No wall-clock bound.** Six confirmation checks × six inner curl retries × three delete attempts,
  against a job with GitHub's 360-minute default, holding the `twh-mieweb-container-ops` concurrency
  group throughout — the same starvation this entry is about, from the other direction. The
  confirmation GETs now run with `MIEWEB_REQUEST_ATTEMPTS=1` (the poll loop *is* the retry) and every
  container-ops job across all four workflows carries `timeout-minutes: 45`.
- **Two guards that were individually vacuous**: the request-exit check and the empty-body check each
  covered for the other, because the stub returned non-zero *and* printed nothing. The stub now emits
  a partial body on failure, so each has to carry its own weight.
- **The re-target line had no test at all**, so the docblock's "in case it moved under us" was a claim
  nothing verified. It has one now — and the hostname-keying assumption behind it (the read is keyed
  on hostname, not on the id being deleted, so the concurrency group is what makes it safe) is written
  down instead of being an unstated property of a different file.

**And a correction to what this entry said an hour ago.** I wrote that mutation-checking had found
test 8's guard missing. The mutation I ran deleted two lines at once; the review separated them and
showed the load-bearing one is `last_read="unknown"` — clearing `CONFIRMED_CONTAINER_ID` is
unobservable, because the only exit that could read a stale id requires `last_read="present"`, set in
the same iteration. The comment in the test claimed coverage that did not exist, in a repo whose whole
point is not doing that. Fixed at the source.

**The sharpest finding was about a test, not the code.** Test 9 — the one guarding the
highest-blast-radius path — passed with the production shape check deleted, because the `jq` stub keyed
its answer on the response body and ignored the filter entirely. It was asserting the stub's opinion.
The stub now branches on the filter, modelling what real `jq` does with each, and the mutation fails as
it should. Eleven cases, eight mutations, seven caught; the eighth is the single-attempt read, which is
a performance change with no behavioural signature and is not claimed as covered.

**Separately: the always-loaded doc set went from ~128k chars to ~58k**, a little under half, and
`JOURNAL.md` from 1.17 MB to 234k. **Nothing was compressed and nothing was summarised** — the cut was
made on a single test, *does a session have to avoid silently contradicting this?*, and everything
removed failed it:

- **CLAUDE.md, 83k → 23k.** The two "History — Current Focus" blocks (2026-08-04 and 2026-07-24, ~670
  of 867 lines) were dated narrative retelling what `DECISIONS.md` holds as ADR bodies and this file
  holds day by day — both in more detail, both authoritative over the retelling. Same reasoning that
  removed the 2026-06→07-22 blocks on 2026-07-29. What was *not* history was kept and is now findable
  rather than buried mid-paragraph: the three standing corrections, the open-item list, and a
  one-line-per-milestone status table.
- **LOCKED_DECISIONS.md, 17k → 8k.** §5 moved verbatim to `docs/archive/AUDIT_FACTS_2026-07-24.md`. Its
  own preamble already said "§4 above is binding; this section is not" and "where this section and the
  code disagree, the code wins" — which is precisely the description of something that does not belong
  in a file whose purpose is things a session must not contradict.
- **JOURNAL.md, 1.17 MB → 234k.** July and April–June split out **verbatim** to
  `docs/archive/JOURNAL_2026-07.md` (110 entries) and `docs/archive/JOURNAL_2026-04_06.md` (152). All
  311 entries verified present and byte-identical after the split. A journal that has been summarised
  is no longer evidence of what happened, so the rule going forward is written into the file: cut the
  oldest complete month when it passes ~300k, never condense on the way out.
- **`AI_GUARDRAILS.md` and `DATA_MODEL_CONTRACTS.md` were left alone, deliberately.** Every line in
  them is a rule the Definition of Done makes mandatory on every PR. Shaving a few hundred tokens off
  a safety document is a bad trade against dropping one of those rules by accident.

## 2026-09-01 — closing the profile leak surface: column scoping, four-site row isolation, pre-aggregated aggregate guards, and server canonicalisation

**The roster's columns follow the deployment profile, not just its rows.** Scoping the directory
without scoping the panel definitions caused `/compliance` on Maui to render 48 patients under five
occupational immunization columns (`PANELS.immunizations`) that could never evaluate an outcome.
`panels.ts` introduces `RUNNABLE_PANELS`, `AVAILABLE_PANELS`, and `PROFILE_DEFAULT_PANEL`. Availability
and column derivation now share one source of truth (`RUNNABLE_PANELS`), folding the catalog-Active
conjunct (`active.has(m) && isRunnableMeasure(m)`) into availability so that `availablePanels` cannot
offer a panel that renders zero columns. The panel list derives dynamically from `Object.keys(PANELS)`
rather than a hardcoded tuple. The roster response shape gains `availablePanels`; requesting a panel
with no runnable measures canonicalises to the profile default (`wellness` on Maui) rather than returning
a 400 error. The degenerate case where no panel is runnable preserves the non-null `panel` string contract,
returns `availablePanels: []` with zero columns, and logs a startup warning naming the cause.

**Server-side panel canonicalisation broke three client assumptions.** With the server now capable of
answering with a different panel than requested, three frontend areas required remediation:
(1) `IndividualComplianceStatus` fanned out across all `PANEL_OPTIONS` and merged columns. On Maui, all
three requests canonicalised to `wellness`, triple-rendering columns with duplicate React keys
(`Encountered two children with the same key, 'hypertension'`) and corrupting expansion state. It now
reads `availablePanels` from the first response, requests only remaining unserved panels, and dedupes by
`measureId` for older backends. (2) The panel `<select>` `value={roster?.panel ?? panel}` displayed the
last-loaded panel, snapping the control back to the previous value during cold fetches (11.8–12.5s)
before flipping; it now displays the selected panel immediately. (3) Mock order-dependence in
`page.test.tsx` and `page.urlfilters.test.tsx`, where `beforeEach` mocks had hardcoded `panel: "wellness"`
and triggered an unintended canonicalisation `router.replace` fetch, was resolved by echoing the requested
panel back in mocks and strengthening assertions back from `.some()` to `.at(-1)`.

**Four-site `profileMatcher` data isolation and the two pre-aggregated leaks.** In `program-read-models.ts`,
`siteMatcher` and `tenantMatcher` short-circuit when query filters are absent, allowing foreign subjects
to reach headline totals and risk outlooks. Row-level profile isolation (`profileMatcher(directory.employeeById)`)
was rolled out across all four sites: `programOverview` rows, `programOverview` open cases (`openCaseCount`),
`runsWithOutcomes` in `programTrend`, and `programRiskOutlook` (`latestBySubject`, `repeatNonCompliers`,
`siteComplianceRates`, `upcomingExpirations`). Live `wc|` subjects and default-profile uncatalogued QRDA
Cypress MRN subjects remain preserved. Two pre-aggregated paths bypassed row-level predicates entirely:
(1) `foldScaleCounts` SQL-aggregates scale runs via `aggregateScaleRun`, which on a restored database
would fold ~120k foreign subjects into summaries; it now returns early when `tenantById("mhn")` is
invisible on the active profile. (2) `programTrend`'s monthly snapshot path reads `quality_snapshots`
keyed by `(measureId, scopeLevel, scopeId, period)` without a deployment profile dimension; scoped profiles
now fall through to per-run trend series where `runsWithOutcomes` applies isolation.

**Closing test defects in the branch's own live-directory test suite.** Review identified two defective
assertions in `program-read-models.live-directory.test.ts`: (A) The `upcomingExpirations` assertion was
vacuous because foreign subjects were `OVERDUE` without recency evidence and could never qualify; fixed by
providing `COMPLIANT` status with matching recency evidence (`Most Recent Exam Date`) to both Maui-resolvable
and foreign subjects, ensuring Maui-resolvable subjects appear while foreign subjects are excluded.
(B) The `repeatNonCompliers` mutation check crashed with a `TypeError` on `b.evaluatedAt.localeCompare`
inside child processes due to missing fixture timestamps rather than failing the assertion; fixed by
providing `evaluationPeriod` and `evaluatedAt` to `mauiRow`, `twhRow`, `unresolvableRow`, and `liveWcRow`.
Both mutations verified: removing `profileMatch` fails both assertions as clean assertion failures with
`result.status === 0`.

**Deliberately deferred:** `programOverview`, `hierarchy-rollup.ts`, and `routes/orders.ts` iterating all
Active catalog measures rather than profile-scoped measures; `export-csv.ts`, `mcp/tools.ts`, and
`case-read-models.ts` resolving names without filtering rows; degenerate empty-`availablePanels` client
rendering as "no measures for this patient"; and adding a deployment profile dimension to the
`quality_snapshots` schema.

## 2026-08-31 — the Maui sandbox becomes real: a deployment profile, its workflow, and a shared image tag that could have healed the live demo onto unmerged code

**`WORKWELL_INSTANCE` is load-bearing again, and it is what makes the Maui sandbox a sandbox.** The
synthetic directory and the runnable measure set were compile-time constants, so the second deployment
would have come up showing and evaluating TWH's people while refusing its own — a live URL with an
empty work list. The env var (set by all three deploy workflows and, until today, read by *nothing* in
`backend-ts/src` — a Java-era leftover whose consumer died with the JVM) now selects a deployment
profile controlling which tenants are visible, which are evaluable, and which measures are runnable.
Default is today's behaviour exactly; `maui` is the 48 patients and `cms122`/`cms125`/`hypertension` —
MIPS 001/112/236, the ACO-aligned measures that are runnable today. Measured on both profiles: maui
48 visible / 48 evaluable / one tenant / three measures; default unchanged.

**The architecture was forced, and finding that out cost nothing because the brief was reviewed before
it was implemented.** The obvious design — have `employee-catalog.ts` read the profile — is illegal
here: the catalog lives inside `src/engine/` and `engine-boundary.test.ts` forbids production imports
escaping that tree. A spec-review pass caught it before any code was written, along with a bucket
assertion in the same brief that could not have failed. The catalog therefore stays env-free and
exports pure scoping helpers; `src/config/deployment-profile.ts` reads env and composes; app-side
consumers import from there. That also avoids an ESM temporal-dead-zone cycle the naive version would
have had. **Provider attribution is preserved by construction** — `assignProviders` still runs over the
full base before any filtering, behind an internal full-provider index, because filtering first would
silently renumber existing providers.

**One predicate, enforced everywhere, not just where the list is derived.** `isRunnableMeasure` gates
every evaluation path including the *explicit* MEASURE-scope run, which previously accepted any id in
the registry — without that, the Maui sandbox could have run audiogram and HAZWOPER against patients.

**Recorded rather than "fixed":** `orderKey` clusters over sequential ids, so the maui ordering is
effectively `pat-001…pat-048` for every rate key and cms122/cms125 assign identical targets. It is
pre-existing (TWH's `emp-*` ids share it) and unfixable without reshuffling TWH. Consequence worth
stating: the sandbox shows ~5 actionable patients on each of cms122 and cms125 — *the same five* — and
8 on hypertension. Thin for a team meant to beat on it; profile-scoped compliance-rate overrides are
the lever, deliberately not taken here.

**The leak that scoping the population did NOT close, and how it hid.** Review found the flagship
roster on Maui rendering **198 rows — 100 twh, 50 ihn, 48 maui** — led by occupational-health
employees at "Plant A" under immunization columns Maui cannot run. The cause is one level deeper than
the profile: `engine/ingress/webchart/live-directory.ts` builds its `STATIC_DIRECTORY` from the RAW
catalog, and `roster-read-model.ts` renders from `directoryForRows()`. A leak sweep that greps
app-side files for imports of `employee-catalog.ts` cannot see it — `roster-read-model.ts` imports
only `isDemoPersona` from the catalog and looks clean. The read goes through an **engine-side** module,
which structurally cannot import the app-side profile, and that is exactly the seam that opens when a
population becomes configurable while a directory stays imported. Fixed by injection: the static half
of the directory snapshot is now supplied by app-side callers (roster, hierarchy rollup, program read
models, quality materialization, employee profile, run pipeline, cases route) and defaults to the raw
catalog, so the engine boundary is intact and the default deployment is unchanged. Pinned by a test
that fails on the old code with `198 !== 48`.

**Also from review, each a different class:** the runnable-measure gate was refusing `mode=latest` on
the compliance API — a *read* of already-computed, persisted, audited history, which a runnability
*config* must never make unretrievable (ADR-061 deliberately made "no run covered this subject" a 404
and nothing else); the new profile test carried two `f(x) deepEqual f(x)` assertions comparing the
profile module's exports against themselves rather than against the raw catalog; and the resolved
profile was invisible at boot, so the one misconfiguration that reproduces the roster leak
deployment-wide would have shown a healthy container and a 200 on `/actuator/health`. All fixed, with
the profile id now logged once at init in the style operators already grep for.

**Deliberately unchanged, so it is not mistaken for coverage:** `src/program/` read models and segment
validation still derive from the full directory and full registry, so a Maui operator can still see
occupational programs listed. The run picker likewise offers all 14 registry measures and 11 of them
refuse at submit — the refusal is correct and loud, but offering the button is a gap. A worry that turned out to be unfounded and is recorded because the
reasoning matters: `isApplicable` returns true only when no segment is enabled, and `ensureSegmentSeed`
runs on the scheduler and on `/api/compliance`, so Maui could plausibly have evaluated everyone and
created zero cases. It does not — the seeded baseline's `measureIds` include all three Maui measures and
its site list derives from the unscoped catalog, which contains the Maui clinics.

**MM-0's deployment plumbing exists: `deploy-maui-mieweb.yml`, four pseudonymous sandbox accounts, and
the flip-config guard finally derives its own workflow list.** The workflow is TWH's with Maui's
identity — `maui-api-ts` / `maui` hostnames, `DATABASE_URL_MAUI` + `WORKWELL_AUTH_JWT_SECRET_MAUI`,
`WORKWELL_INSTANCE=maui`, `NEXT_PUBLIC_SUBJECT_TERM=patient` as a frontend build ARG — and
`workflow_dispatch`-only, because the two Maui secrets do not exist yet and a push trigger would fail
every push until they do. `WORKWELL_OFFICIAL_MEASURES` is deliberately absent: no pilot measure has
been through its own flip gate, so Maui evaluates authored CQL (locked decision 4A.5).

**The finding worth keeping is one review caught and two passes had missed.** The workflow, copied
from TWH, pushed `ghcr.io/taleef7/workwell-api-ts:latest` — and TWH's backend image repository is the
*same* repository. `reconcile-twh-mieweb.yml` heals the live `twh-api-ts` container every 15 minutes
by recreating it from that repository's `:latest`. So a Maui dispatch from any unmerged branch would
republish `:latest`, and the next time the live demo went unhealthy it could have healed itself onto
that code. `deploy-staging-mieweb.yml` had already solved this with `staging-*` tags, which is the
tell: the hazard was known once and not carried forward. Maui now pushes `maui-latest` /
`maui-sha-<SHA>` and deploys the namespaced sha; the frontend needs no namespacing because it builds a
different repository. **Nothing was ever at risk** — the workflow had not been dispatched — but the
window between merging it and first dispatch is exactly when it would have been. Documented in
DEPLOY.md as load-bearing rather than left as a tag convention someone could tidy away.

**`official-flip-config.test.ts` stops being a three-name allowlist.** Its `WORKFLOWS` array was
hardcoded to the three TWH/staging files, so a new deploy workflow was invisible to a test whose whole
claim is that it validates "the string that actually ships" — the #380/#400 guard-scope class, named
as MM-1b work in the roadmap and paid down here instead. Discovery is now derived from the filesystem:
a workflow qualifies when it deploys through the shared container script **and** sets
`WORKWELL_INSTANCE`. Both halves are needed — the script reference alone also matches
`deploy-workwell-redirect-mieweb.yml`, a redirect container that ships no measure routing and so
passes every assertion **vacuously**. That was measured, not argued: with the redirect included the
other three tests stayed green and only a new `deepEqual` on the discovered set failed, naming it. The
predicate is keyed on `WORKWELL_INSTANCE` rather than on an image variable name because a future
workflow can rename its variables and stay a WorkWell deployment.

**Also on the record: `WORKWELL_INSTANCE` was, until today, read by nothing in `backend-ts/src`.** All
three deploy workflows set it; it is a Java-era leftover whose consumer died with the JVM. It is being
made load-bearing again as the deployment-profile selector rather than documented as inert.

Gate: 2049 tests, 2008 pass, 0 fail, 41 skipped — run by the orchestrator independently of the
implementing lane, not taken from its self-report.

## 2026-08-30 (closeout) — the three MM-0 PRs merge; and the Maui deployment was never blocked on anyone

**Merged in order — #497 → #498 → #499 — and `main` is at `fd2e5f51`.** #499 was rebased onto the other
two first; the only conflict was the predictable one (all three inserting a JOURNAL entry at the top),
resolved by stacking rather than choosing. Every review thread across the three PRs is replied to and
resolved; the frontend suite is 41 files / 208 tests, lint clean, build clean, and the 19-check CI run
was green before the squash. Housekeeping done: three worktrees removed, all six local+remote `mm0`
branches deleted, refs pruned, and a superseded local plan draft deleted after diffing it against the
committed version (the committed one was a strict superset).

**The post-merge deploy failed once and it was not ours.** `Deploy TWH OS MIEWeb` died in the
Create-a-Container step with `curl: (28) Operation timed out after 30002 milliseconds` on the container
DELETE — a transient MIE API timeout, not a code fault: nothing in #499 touches the backend or the deploy
path, and #498's identical deploy had succeeded 18 minutes earlier. `gh run rerun --failed` came back
green in 1m40s. Final board on `main`: CI ✅ (13m25s), Deploy ✅, CodeQL ✅.

**One review lesson worth keeping, because it cost the only real regression of the day.** Task 2 was the
one lane that shipped without the independent reviewer pass — the implementer was itself a capable agent,
which is exactly the rationalization that skips the step. Running it late found the employee-mode
whitespace regression described in the entry below. **The reviewer step is not conditional on who
implemented.**

**A standing assumption was checked and is FALSE: the Maui container is not an MIE gate.** ROADMAP §7.3
listed "Maui container provisioning + DNS" as owed by MIE, and §9.1 as an owner step to *confirm the
path*. Confirmed, and the answer discharges it: the Container Manager lists all five existing containers
under the owner's own account with a New-container action and an API-keys page, and
`.github/scripts/deploy-mieweb-container.sh` already **creates** a container when the hostname does not
exist — which is how `twh-api-ts`, `twh` and both `twh-staging*` containers came to exist — authenticated
by the `LAUNCHPAD_API_KEY` secret every TWH deploy uses. So the Maui sandbox is not up for one reason
only: **nobody has written `deploy-maui-mieweb.yml` yet.** That workflow is TWH's with `maui-api-ts` /
`maui` hostnames, `NEXT_PUBLIC_SUBJECT_TERM=patient` passed as a frontend build ARG, and
`WORKWELL_INSTANCE=maui`; the two things only the owner can supply are a separate Neon database
(`DATABASE_URL_MAUI` — the `workwell_spike` schema self-creates, so no migration) and
`WORKWELL_AUTH_JWT_SECRET_MAUI`. §7.3 and §9.1 are marked discharged in the roadmap.

**Where MM-0 stands.** Code: Tasks 1–3 merged and deployed; Task 4 (the MIPS↔CMS crosswalk UI) is the
last code item and is unblocked. Deployment: the Maui instance is now a *self-service* piece of work
ahead of or beside Task 4, not a wait. Still genuinely external: MIE's order-mapping docs and new-UI
access, the CDS client-auth answer, Nicole on exceptions, the ACO on attribution and measure 305, and the
CY2027 final rule.

## 2026-08-30 (later) — MM-0 Task 2: subject terminology becomes deployment config (PR #499)

`NEXT_PUBLIC_SUBJECT_TERM` (`employee` default | `patient`) drives a `SUBJECT` term set in
`frontend/lib/terminology.ts` — singular/plural/capitalized forms plus the indefinite article and the
collective noun ("workforce" / "patient population") — and a ~20-file sweep moves every user-visible
"employee" display string onto it. **Display text only, byte-identical in employee mode by design**: API
paths, payload keys (`employeeExternalId`), routes (`/employees/...`) and grid field keys are deliberately
untouched, and the Dockerfile takes the var as a build ARG the TWH workflows never pass. The review pass
earned its keep here too: it caught **one real employee-mode regression** — folding a two-line JSX text
node into a template literal ate the space between two sentences in the runs-page hint (JSX strips a
newline-adjacent-to-expression whitespace run entirely; verified by rendering both shapes) — plus a missed
"Employee External ID" label in the Studio Tests tab that hid behind its same-line identifier, the
"workforce" phrasing in two Recalculate confirms, and five copies of an untested inline article ternary,
now a tested `SUBJECT.an` field. Copilot's PR pass added three always-plural strings ("1 patients"), now
count-aware. Env row + Maui build-arg note in DEPLOY.md; the patient-mode scope-name seam in the runs hint
(the dropdown says "Patient" while the API scope stays `EMPLOYEE`) is rendered from `SCOPE_LABELS` so the
hint matches what the user sees.

## 2026-08-30 (later) — MM-0 lands its first slices, and review makes the Maui tenant directory-only

**MM-0 Tasks 1 and 3 are implemented (PRs #497, #498), each through a triple review** (an
implementation lane, an independent reviewer pass with mutation checks, and the PR-time Codex bot), and
both reviews earned their keep. **#497** (clickable status chips + URL-backed case/roster filters): the
filters ended up **derived from the URL per render** rather than state-initialized — browser back/forward
correctness, pinned by tests that use a new *reactive* `next/navigation` mock whose `push` actually
updates the params (a static mock made every write-back invisible, a mutation check proved it); chips
carry the active site/date scope so the destination matches the clicked count; and **COMPLIANT/EXCLUDED
chips went back to static** — the roster's status filter is any-cell-per-panel, not per-measure, so no
destination reproduces those counts today, and a wrong list is worse than no link (measure-scoped roster
drill-down recorded as MM-2 backlog). It also fixed the previously-dead `/cases?measureId=` footer link.

**#498's review verdict changed the design: the maui tenant is DIRECTORY-ONLY until MM-1**
(`EVALUATION_EXCLUDED_TENANTS` / `EVALUABLE_EMPLOYEES` in `employee-catalog.ts`; every evaluation
surface — run pipeline, backfills, case-rerun, impact preview, compliance-api preview — now reads the
evaluable population). Two measured findings forced it: appending 48 rows to the global seeded
distribution **reshuffled ~181/900 existing twh/ihn targets** (e.g. `emp-053` diabetes_hba1c
EXCLUDED→COMPLIANT — case churn on the live demo at the next nightly run), and the `pat-*` ids
hash-cluster in `orderKey`'s Java-hash band so the cohort lands in one or two buckets — meaning the
planned per-tenant bucket-coverage test verified a distribution the product never computes (the
vacuous-guard shape again, caught before merge). Also on the record from review: patients would have
received occupational-health evaluations (audiogram/HAZWOPER cases), the live demo's seeded
`All Employees` segment doesn't cover the new clinics (repair deferred to the MM-1 activation checklist,
noted in DEPLOY.md), and the persona `dateOfBirth` fields are display-only today — the bundle builder
derives ages from ids, so the plan's IPP rationale for them was wrong. The anti-churn invariant is now
pinned in tests: `EVALUABLE_EMPLOYEES` is byte-identical to the pre-maui population, with `emp-053`'s
seeded target as the reshuffle canary. Bucket coverage for the pilot cohort moves to MM-1, where
per-tenant distribution / id de-clustering gets designed deliberately.

## 2026-08-30 — ADR-070: the Maui pilot re-spearheads the roadmap; the ACO's measure set finds the engine five-sixths already built

**`docs/ROADMAP_2026-08-30.md` is the new APPROVED active plan (ADR-070; LOCKED_DECISIONS §4A).**
WorkWell has its first real customer: a primary-care group on WebChart — repo name "the pilot group,"
deployment name "Maui," under a locked naming policy (no client legal or staff names in repo docs; source
materials gitignored local-only) — entering an **MSSP ACO for PY2027**, measurement starting 2027-01-01.
The 2026-08-27 working session with MIE and the pilot's quality team set the direction; the owner locked
it 2026-08-30.

**The headline is a position, not a plan: five of the six computable measures are already gated in the
tree — and the review round (below) forced the position to be stated exactly.** The ACO's EMR-reported
set decodes from MIPS quality IDs to CMS122 (MIPS 001), CMS2 (134), CMS165 (236), CMS125 (112), CMS130
(113) — every one vendored and MADiE-gated, two routed official in production — plus **CMS137 (305, SUD
initiation & engagement), the one gap**. But **gated ≠ routable ≠ runnable**: the run pipeline derives
its runnable set from the authored registry (`RUNNABLE_MEASURE_IDS = Object.keys(MEASURES)`),
CMS2/CMS130/CMS165 exist product-side only as Draft/NOT_COMPILED catalog rows, and CMS130/CMS165 have no
`OFFICIAL_MEASURE_SEMANTICS` entry (construction refuses them) — so **official-only measure onboarding
is MM-1's real substance**, not a workflow edit. And **CMS137 is doubly conditional**: the CY2027
proposed rule (CMS-1848-P — the very rule the standing FHIR-timeline correction tracks) **proposes
removing Quality IDs 305 and 493 from APP Plus for PY2027**, so ACO/final-rule confirmation precedes the
multi-rate spike (initiation ≤14d, engagement ≤34d — every routed surface assumes single-rate), which
precedes any promise; ADR-047's MADiE-gate precondition applies unchanged. A third review finding:
**every vendored artifact's `effectivePeriod` is 2026-only and the runtime never checks it** — PY2027
needs a re-vendor + full re-gate (MM-1d) or stale 2026 logic runs silently into 2027. Two existing debts
become customer-facing and rise accordingly — CMS2's 7 unexplained `NUMER 1→0` mismatches and the
CMS130/165 sweep — and the milestone order now says **no known-unverified measure is routed to the
pilot**: each measure's debt clears before its flip. The set's other three members (two CMS-claims
outcome measures, CAHPS) are not EMR-computed — informational tiles at most.

**What the customer meeting changed about the product, in three findings.** (1) The engine's consumer is
a quality team working **provider panels** — never by measure — so the UI grows patient-centric work
lists, PCP/location filters, saved per-staff filters, and clickable status-chip drill-downs ("click the
number, land on the patients to work"). (2) **Cards resolve, not alert**: accept/dismiss is rejected in
favor of place-the-order (standing order for simple measures; a discretion-requiring pick list for
colorectal/breast) and document-the-exception — both inside ADR-067's unchanged refusals, and the
exception path must produce **structured data CQL reads on the next run**, never a WorkWell-side status
override (ADR-008, AI_GUARDRAILS §1). (3) **Orders are local** — practice order catalogs carry local
names and billing codes, often no LOINC, and imaging centers need not return LOINC on results; MIE's
LOINC-on-order-rows mapping (results inheriting the requisition's code) is MIE-side work WorkWell will
consume, and its documentation is a named external dependency.

**Milestones, cheap-first (ROADMAP §5):** MM-0 Maui instance + UX wins (second deployment, "patient"
terminology as deployment config, chip drill-downs, pseudonymous sandbox accounts, primary-care synthetic
roster, MIPS↔CMS crosswalk in the UI) → MM-1 measure set (confirm-305 → onboarding → per-measure gated
flips → PY2027 re-vendor → CMS137 conditional) → MM-2 work lists/assignment (attribution semantics
deferred until the ACO answers) → MM-3 resolution actions (blocked on MIE order docs + Nicole; an offered
order is a proposal and never changes compliance) → MM-4 encounter-time integration (blocked on MIE
new-UI access AND ADR-067's named CDS client-auth gap; a card stays a rendering of a completed
evaluation — freshness comes from evaluating sooner on ingest). **MM-0's build-and-test work is fully
unblocked; container provisioning gates only its final deploy step.** The milestones deliver a
**sandbox**; the pilot's production/PHI phase is a separate `PRODUCTION_READINESS`-gated decision.

**Demotions, named rather than silent:** the versioned compliance API keeps existing but loses its
"contract MIE consumes" framing (decision 5 SINCE-note in LOCKED_DECISIONS §4) — the integration contract
is the card/CDS surface plus the Maui deployment (and precisely: the CDS service is a *parallel* surface
reading the finalized-outcome stores directly, not an API consumer); **M-E1 defers behind M-M**, and so
does **M-D0/D1** (Inferno US Quality Core) — both deferred, neither cancelled (locked decision 6 stands
as the long-term differentiator). ADR-058 decisions 1–4, the §4 verification set (ROADMAP_2026-08-04 §4 —
that file stays in docs/ because locked decision 2 cites it), the QRDA bridge, and the published
`@work-well/*` packages are all untouched.

**The PR's review round was three streams, and each earned its keep.** Codex's PR line comments found
the runnability gap (the P1 that became "gated ≠ routable ≠ runnable") and the blocked/unblocked
contradiction. The code-reviewer pass found the stale guide chapter 9 / guide README (the Definition of
Done's own requirement), the false claim that `official-flip-config.test.ts` validates "any" workflow
(its `WORKFLOWS` array is three hardcoded TWH/staging files and its sidecar predicates read
`deploy-twh-mieweb.yml` only — the #380/#400 guard-scope class, now named as MM-1b work), the
§4A-vs-ROADMAP-§2 decision-count mismatch, and the stale always-loaded ADR counts. The adversarial Sol
pass found the two biggest: **CMS-1848-P proposes removing 305 from APP Plus** (verified against the CMS
fact sheet and Federal Register — potentially cancelling the largest new-engineering item) and the
**2026-only `effectivePeriod`** on every vendored artifact with no runtime check; it also caught
CMS130/CMS165 mislabelled "routable" (no semantics entry — README's standing claim was wrong too, now
corrected), the sandbox-vs-"running its ACO year" over-promise, the missing CDS-auth blocker on MM-4, and
the "order closes the gap" wording that an order-is-not-a-result reading rightly kills. One Sol finding
was rejected on adjudication: Doug/Nicole in repo docs is not a naming-policy violation — the policy
forbids *client-side* names, and its text now says so explicitly. Docs updated in this change:
ROADMAP_2026-08-30 (new), ROADMAP_2026-08-04 (superseded banner), DECISIONS + ADR_INDEX (ADR-070),
LOCKED_DECISIONS (§4A + SINCE notes), CLAUDE.md (Current Focus rotation + count refresh), README (current
focus + routable correction), guide README + chapter 9, this entry.

## 2026-08-27 — the MCP tools get the FINAL rule (#491); the serializer takes the declared result type (#482/#488)

**#491 filed and fixed — MCP `check_compliance` served mid-run rows as the compliance answer.** The
defect the #470 work surfaced and deliberately left out of that PR: `check_compliance` (and
`get_employee`'s `latestOutcomes`) picked the newest outcome row with no run-finalization check, so a
row written mid-run — before the run reaches a terminal status, or before `/finalize` in the QRDA
import flow — was handed to an AI client as *the* persisted answer, `decisionAvailable: true`. The
compliance API has enforced exactly this rule since the #399 review (ADR-061: only a
`COMPLETED`/`PARTIAL_FAILURE` run's outcome is served); the MCP tool was the model that route was
built from and never got the same fix. Both tools now read `listLatestFinalizedOutcomePerMeasure`
(#486's primitive — the FINAL rule in SQL, bounded by measure count instead of history size);
`check_compliance`'s absence message says "no finalized outcome" rather than implying no run ever
covered the subject, and `get_employee` dedups to one row per measure. Three tests written RED first
(the mid-run row was served over an older finalized one; mid-run-only read as an answer; get_employee
returned both rows for one measure). The review round (#492) added: an unresolved `measureName` is
`MEASURE_NOT_FOUND` rather than advice to wait; the attached `caseId` must be status-consistent with
the served answer (Codex's P2 — a case reshaped mid-run by an unfinished re-evaluation is not
attached, while a re-confirmed same-status case stays); a deterministic `measureId` tie-break on the
top-5 cap; `evaluationDate` declared reserved-and-ignored. #493 filed for the employee-profile read —
the last newest-row-wins latest-answer reader.

**The runtime translator now runs with `EnableResultTypes` and the `$cql` route threads the define's
static type into the serializer.** The engine's runtime numbers carry no type, so the serializer had
been discriminating Integer-vs-Decimal intervals by whether the boundaries were whole numbers —
`Interval[1.0, 2.0)` shipped as `Interval<System.Integer>` with `high = 1` (true coverage
1.99999999) — and a Long that reached JS as a plain number was indistinguishable from an Integer.
Now the declared type is authoritative exactly where the runtime value is mute (numeric interval
point types, Long identity → `valueString` integer literal labeled `System.Long`, never through
`Number`); temporal intervals keep value-flag detection; no declared type falls back to the old
heuristics byte-identically, pinned. The translator flag is one addition on top of `defaultOptions()`
and the conformance baseline reproduced **byte-identically** (211 known non-passing cases unchanged),
so the harness numbers did not move; `compile-measures` builds its own LibraryManager and is
untouched.

**The runner re-run: 1,589 → 1,606 pass over live HTTP, 17 fail→pass, zero regressions.** The
decomposition corrected two of the 2026-08-26 diff's bucket claims. **Nine Long arithmetic cases**
(`AbsLong`, `Multiply2LBy3L`, `ProductLong`, …) had been sitting in the `fail‖fail` "engine gap"
cluster — but the engine's arithmetic was CORRECT on every one; the runner failed on serialization
identity (fixed) and the in-process harness failed on upstream's representation split (a Long
literal is a string, Long arithmetic returns a number). The tenth Long flip, `Negate1L`, was
already correctly attributed as a serialization loss in the diff's `pass‖fail` cluster. (My first
draft of this entry put all ten in `fail‖fail`; the #494 review caught the miscount against the
regenerated harness results.) **Five Except cases** flipped for a
reason that is not this change at all: the published 2026-08-25 run predated the #481 review round's
temporal/quantity closed-normalization, so this is the first HTTP measurement of the tree as merged.
And **`RolledOutIntervals` is reclassified, no code change**: the test's own cast makes the static
type `Interval<DateTime>`, our engine faithfully produces day-precision DateTimes, and
`@2012-01-01T` is the correct rendering — the corpus writes `Date` literals and the runner
string-compares, so it joins the timezone cluster as a grader-semantics artifact. What remains ours:
nothing — `NegateMaxLong` (the engine coerces the Long literal through `Number` in Negate) and
`1L + 2L` string concatenation are upstream `cql-execution` gaps, now precisely separated from the
serialization losses. `STANDARDS_CONFORMANCE.md`'s "phase 2, not built" clause about the `$cql`
endpoint — stale since #474 — corrected with the runner-graded figures.

## 2026-08-26 — #484 merged after a Codex round resolved by measurement; chapter 10 becomes the two integration flows

**PR #484 (the CQM membership formulas, ADR-069) is merged — squash `84d4bc6b`, #476 closed, all 17
checks green.** Codex's one finding was a P2 worth taking seriously: serving the IG membership
derivation under `populationsSource: official-evidence` could change what a v1 integration receives,
and the v1 stability statement says the field's meaning must not change. **Resolved by verification,
not by splitting the derivation:** both routed measures declare only
`initial-population / denominator / denominator-exclusion / numerator` (checked in the vendored
bundles — no DENEXCEP or NUMEX population exists in anything any deployment routes), and
`fqm-execution` zeroes NUMER under DENEX itself (ADR-055), so for every evidence row any deployed
writer has persisted the derivation is the identity function — no v1 response changes by a byte. The
meaning of the field (*measured* vs *inferred*) is unchanged, and the prior "persisted verbatim"
wording was already inaccurate (subset clamping predates ADR-069). Keeping raw flags on v1 while the
exporters fold would have reintroduced the two-membership-notions drift the PR closes. All of this
now stands in `COMPLIANCE_API.md` under `populationsSource`, where an integrator will look.

**The same PR carries the chapter-10 rewrite:** `docs/guide/10-scenarios.md` now holds the two flows
an integration conversation needs — the scheduled population batch (built; the former S1+S2 merged at
stakeholder granularity) and S7 in-encounter (target state; heading and anchor unchanged so
`CDS_HOOKS.md` links resolve). The five internal operator flows moved to git history with a note; the
batch scenario names the open question — whether results should also render inside WebChart's UI —
as a question for the WebChart side rather than a decision. Prepared for the Maui conversation
(meeting postponed; the material keeps).

**#477 — the README refresh, per the alignment audit's communication verdict.** Four additions and a
sync: a **positioning paragraph** in the lead (supplementary to WebChart, which carries certification;
composes `fqm-execution`/`cql-execution` rather than competing — previously stated only in
`PACKAGES.md` §2); **a tour of the product** — the nine screenshots that sat untracked at the repo
root moved to `docs/assets/` and embedded with one-line captions, ending the README's zero-imagery
state; a **"What runs where" table** making the gated ⊂ routable ⊂ routed distinction per priority
measure explicit (CMS68's episode-basis construction refusal and CMS138's weaker-green footnote
included), with the plain statement that **alerting is WorkWell-screens-only today** — the CDS Hooks
service is live but no client invokes it; and an **integration-surface table** leading with the four
external contracts (compliance API, CDS Hooks, OpenAPI/`/api-docs`, MCP) plus the published packages,
with `POST /$cql` added to the internal highlights. Counts synced to measured 2026-08-26 values
(2,021 backend tests, 68 ADRs), and the CLAUDE.md "38 of 58" DECISIONS count — stale since the #396
review moved six ADRs back — corrected to 54 of 68 with the 20-moved/6-returned history stated.

**#485 merged (squash `792af88b`) after two review rounds that each caught something real.** The
independent reviewer verified every truth claim against the tree (all eight MADiE counts, the two
routed-flag workflow sites, the CMS68 refusal, all four integration routes — live-probed, not just
declared — the ADR arithmetic, all nine image blobs) and caught one accidental trim: the
`fidelity/diff` route had silently dropped out of the highlights. Codex then caught what no
tree-reading could: **three of the nine screenshots (campaigns, admin, people) were captured as the
VIEWER role and showed access-denied screens** under captions describing the features — the
product-tour equivalent of a vacuous guard, an image that reads as coverage and isn't. Fixed by
recapture, not retreat: booted the app, logged in as admin, same viewport — campaigns now shows a
dispatched simulated campaign with per-recipient delivery status, admin the scheduler +
integration-health panels, people the directory with live MOVED/DUPLICATE badges. Codex's second
finding was also right: the caption claimed brand switching as an audited admin setting, while
`applyBrand` writes only DOM + localStorage from the dashboard header — reworded to a per-browser
preference. Replies on all threads; #477 closed.

**The choice-of-profiles translator gap is FILED UPSTREAM:
`cqframework/clinical_quality_language#1831`.** Tightened before filing: the repro is now 7 lines with
zero includes (a locally-defined function on `FHIR.Condition`, one single-profile retrieve that
compiles, one union-of-profiles that does not); it is **not fluent-specific** (plain function calls
fail identically) and the explicit cast workaround is also refused
(`choice<…> cannot be cast as Condition`), so there is no in-language workaround. **Confirmed current
on 5.2.0** — installed the latest KMP JS artifact in scratch and reproduced identically, which also
answers a #479 question early: that upgrade will not unblock CMS138/CMS951. The Java-accepts evidence
is CMS's own pipeline: the committed CMS951 ELM in `dqm-content-qicore-2025` (translator 3.27.0 per
its annotations) contains the union + `prevalenceInterval()` construct 5.2.0 refuses. Two 5.2.0 API
notes recorded on #479: the model-info provider callback signature is now `(name, ?, version)`, and
required-model loading is stricter (USQC's modelinfo declares USCore required; omitting it reads as
"could not load model information"). Offered upstream to test candidate fixes against the
eight-measure set.

**The S7 demo is REAL end to end — the in-encounter scenario now runs over MIE's own WebChart data,
with only the chart UI mocked.** The chain, every link live: Docker `dev-wcdb` (Doug's seeded
WebChart MariaDB, 56 patients) → `wcdb-fhir-shim` on :8085 → the backend with the WebChart seam
configured → a cms125 MEASURE run over the live connection (run `7a95bffe`: 206 evaluated, 57
OVERDUE, 27 cases) → `POST /cds-services/workwell-compliance-patient-view` for patient `wc-8`
(Ellen Thompson, 56F — genuinely overdue for a mammogram) returning **14 real cards** (2 warnings, 12
info) with per-card provenance naming the run — and the **feedback leg exercised** (an `overridden`
POST, audited). Deliverable: a mock-encounter artifact rendering the real cards beside an honest
real-vs-mock table and the wire transcript — the piece that makes guide S7 tangible for the
rescheduled Maui conversation. Two operational notes for re-running it: the transport appends `/fhir`
itself (`WORKWELL_WEBCHART_BASE_URL=http://127.0.0.1:8085`, not `…/8085/fhir` — the first attempt
404'd on `/fhir/fhir/…`), and the login response's token key is `token`, not `accessToken`. Demo
artifacts are local scratch; the Docker containers stay up for instant re-demo.

**The runner-vs-ADR-060 case diff is DONE — and its biggest finding was a defect in OUR harness.**
(`docs/evidence/CQL_RUNNER_HARNESS_DIFF_2026-08-26.md`.) The "unexplained 12-case delta" resolved as:
the harness's regex XML reader parsed **through comments**, grading 12 tests upstream had deliberately
disabled (plus a pure file-rename artifact, `CqlQueryTest` vs `CqlQueryTests`). ADR-060's "1,835
cases, nothing skipped" therefore included 12 dead tests — true corpus 1,823, corrected headline
**1,612 pass** (−10) and 29 invalid-accepted (−2), no live case moved. Fixed RED-first (commented-out
test and commented-out group fixtures), `EXPECTED_CASES` moved with the reason in its docblock — the
refuse-to-report guard fired on the fix, which is that guard working — baseline regenerated, `--check`
green. The diff's other verdict is the one worth quoting: the 41 cases the runner fails where the
harness passes contain **zero engine-wrongness** — 38 are DateTime timezone-rendering (CQL partial
DateTimes vs FHIR's required offset, a spec tension worth raising on the track), 1 is
Date-rendered-as-DateTime (#482 family), 2 are real Long serialization defects (filed #488: precision
loss through JS `Number` and the lost `L` identity). Six cases grade BETTER over HTTP than in-process
— three because the runner tolerates decimal-precision trailing digits the harness strictly flags, two
because the serializer's closed-normalization is more spec-correct than the harness's weaker JS
comparison path, one a harness display defect. With every off-diagonal cell explained, the two
headline numbers (1,589/1,823 over HTTP, 1,612/1,823 in-process) are now safe to cite together —
the prerequisite `CQL_EVALUATION_SERVICE_2026-08-25.md` named before external submission.
`STANDARDS_CONFORMANCE.md` corrected in the same change.

**#470 closed: the CDS invoke is now bounded by the measure count, not the subject's history.** The
point-of-care path scanned up to 100k outcome rows and `JSON.parse`d every row's evidence to keep the
newest finalized row per measure. Per the issue's own spec: a store-level
`listLatestFinalizedOutcomePerMeasure(subjectId)` (Pg `DISTINCT ON`, SQLite window function, both
joining `runs` so the COMPLETED/PARTIAL_FAILURE rule lives IN the query) plus a constant-time
`hasOutcomes(subjectId)` probe that preserves the route's two-absence distinction — "never evaluated"
(try the next candidate id) vs "rows exist, none finalized" (this subject resolves, renders the
informational card, audits differently). Contract-tested on both stores RED-first, including the case
that matters: a measure whose only rows belong to a still-RUNNING run is ABSENT, never served stale,
even when its row is the newest of all. The other four wide-scan callers stay deliberately: the
compliance API needs period bounds + its `pendingRuns` count, MCP's `check_compliance` currently
serves mid-run rows (a separate defect to decide on, not to smuggle into this change), and
identity/profile are operator surfaces. `CDS_HOOKS.md`'s stated limit updated to say what the read is
now. Suite 2,023, 0 fail.

**#483 closed the same way it was found:** the three `MAX_CQL_BYTES` guards in `measures.ts`
(playground compile, raw CQL save, save+compile) counted UTF-16 code units, so 30,000 CJK characters
passed a 64 KiB cap while weighing 90,000 bytes — the identical defect class Codex caught on the
`$cql` route in #481, filed then instead of folded in per one-task-per-PR. RED first (one multibyte
test covering all three sites), then a shared `cqlTooLarge` helper on `TextEncoder` bytes.

## 2026-08-25 — the `$cql` Evaluation Service exists, and HL7's own runner has graded it (#474)

**The entry ticket to the Connectathon 43 CQL Engine Parity scenario is built and measured.**
`POST /$cql` — the CQL IG's system-level operation in the exact subset `cqframework/cql-tests-runner`
drives: an `expression` in, a `return` parameter out, no patient, no data, no terminology. The engine
side existed since ADR-060 (`evaluateExpressions`); what was missing was the transport and the CQL→FHIR
serialization. TDD throughout: 23 new tests (serializer + route), RED first, suite 1,976 → 1,999, 0 fail.

**The serialization contract was read out of the consumer, not invented.** The runner's extractor chain
(read at source, 2026-08-24) defines what an engine must emit: lists as repeated `return` parameters;
`null` as `data-absent-reason` on `_valueBoolean`; empty list/tuple as `cqf-isEmptyList`/`cqf-isEmptyTuple`
(absence must be SAID — an absent parameter reads as "no result", a different answer); numeric intervals
as unity-coded Ranges declaring `Interval<System.X>` via `cqf-cqlType` (FHIR-56226), with open boundaries
**closed-normalized** because the reader derives closedness from boundary presence. The serializer tests
produce their values through the real translate→evaluate pipeline rather than hand-built engine objects.

**Two structural choices worth keeping.** The **error split is load-bearing**: a translation failure is a
400 OperationOutcome (the request is defective); a runtime failure is a **200** carrying an in-band
`evaluation error` parameter (the evaluation's outcome IS a result) — the runner grades
`invalid="semantic"` vs `invalid="true"` on exactly this line. And **unsupported operation inputs are
refused by name** (`subject`, `data`, `library`…), never accepted-and-ignored — ADR-061's preview-501
reasoning in a new place: an answer computed while silently dropping `subject` would look
patient-specific and not be. `/$cql` sits outside `/api/` where `authorize` ends in permitAll (the
ADR-067 hazard), and it executes caller-supplied CQL — so it carries an explicit machine-client auth
rule, asserted as pure `authorize` calls.

**The acceptance run: 1,823 cases over live HTTP, runner-graded — 1,589 pass / 223 fail / 11 skip /
0 errors** (`docs/evidence/CQL_EVALUATION_SERVICE_2026-08-25.md`). The published reference JS
submission (1,533 pass / **113 skip** / 1,731 graded, Java translator, April 2026 corpus) is **not
like-for-like** — its corpus was ~92 cases smaller, and on pass-rate over cases graded it is higher
(88.6% vs 87.2%); the review caught the first draft of this entry claiming "passes more", which the
corpus delta does not establish. The defensible comparison is skip discipline: 11 runner-own skips vs
113, with an empty SkipList — the ADR-060 posture that skipping the weak clusters would delete the finding. Failure
clusters match the known upstream gaps (Long, `Slice`, decimal precision, 27 invalid-accepted);
logical/nullological/conditional — the constructs the measure CQL is built from — are at 0 fails.
Named, not smoothed: the runner-vs-ADR-060 case-by-case diff (separating serialization-mapping losses
from engine gaps) has not been produced and should precede any external submission of these numbers.

**The bug the acceptance leg caught that no unit test could.** The route passed a shared module-level
headers object into every `Response`; the local host layer writes its computed `Content-Length` INTO
the object it is handed, so the first response poisoned every later one (measured: a 321-byte
`Parameters` under `Content-Length: 78` — clients hang on shorter bodies, parse-error on longer). Hours
of client-side misdiagnosis (keepalive, header sets, three HTTP clients) until a raw-socket capture
showed the declared length was the FIRST body's. Fixed with per-response fresh headers; recorded in the
route's docblock. In-process route tests can never see this class — the Response never traverses the
host's serialization layer — which is the argument for the live acceptance leg being part of done.

**Merged as #481 after two review rounds, every finding RED-tested before its fix.** The independent
pass: the statement-injection analysis written out (no escalation possible — declarations are grammar
errors, retrieves resolve no model, the engine is data-free) and then made moot by a def-count guard
that refuses injected statements anyway; plain-object-prototype tuple detection (a `Tuple { lowClosed:
… }` no longer serializes as a corrupted Range); INT32_MIN off-by-one; and the comparison-honesty fix
above. Codex round 1: a 64 KiB expression bound before the synchronous translator (413, the
`/api/measures/compile` precedent) and open TEMPORAL boundaries closed-normalized via the values' own
`successor()`/`predecessor()`. Codex round 2: the same normalization for QUANTITY intervals (no
stepping methods — the Decimal step applies to the value), and the size bound corrected to count
**encoded bytes** rather than UTF-16 code units — verifying that claim found the identical defect at
three sites in `measures.ts`, filed as #483 rather than folded in. Deferred with a pinned example:
interval point type should come from the compiled ELM, not a whole-number heuristic (#482). Final:
CI's full suite (SQLite floor + Postgres ceiling) **2,085 tests, 0 fail**; every job green; squash
`2bbb6dae`.

**Later the same day — the #475 bounded spike answered its named unknown: USQC content COMPILES under
the JS translator, 6/8 clean, and both failures are ONE upstream gap.** The approach fork first:
`dqm-content-cms-2025` commits **no built bundles** (`bundles/measure/` is a `.gitkeep`; the Library
resources are 1.2 KB stubs), unlike the qicore repo our vendor pipeline consumes — so the plan's
"re-point the vendor scripts" premise was wrong, and per the recommend-first rule the options went to
the owner. Decision: ask the track community for the blessed bundle packages (Sept 2 kickoff / Zulip),
run the bounded translation spike now, do #476 meanwhile. The spike (all inputs pinned:
`dqm-content-cms-2025` @ `9f5f2298`, `HL7/us-cql-ig` @ tag `2.0.0-ballot`, `HL7/cql-ig` STU2): all 8
target measures through our runtime `@cqframework/cql` 4.0.0-beta.1 wiring with the USQualityCore
0.1.0-cibuild + USCore 6.1.0-derived modelinfos registered. **Six compile at 0 errors** (CMS122/125/
130/165/2/68); CMS138 and CMS951 fail on exactly one operator — `prevalenceInterval` over a **union of
two Condition profiles**: the JS translator does not resolve `choice<A,B>` against a fluent signature
both alternatives convert to (`FHIRCommon`'s `prevalenceInterval(Condition)`), reproduced in 8 lines,
Java-accepted (the repo commits Java-built ELM for CMS125/CMS2). Two API findings for our own wiring:
namespaced includes need namespace registration and the curated `cql-to-elm` JS surface exposes no
`NamespaceInfo` (the spike reached the Kotlin-mangled export); include-version matching is enforced
(`2.0.0` ≠ `2.0.0-ballot`). Also on the record: the USQC measure CQL headers say *"for internal use
only. Not for use or distribution in commercial products"* — the distribution posture is a question for
the track before any vendoring. Full detail: issue #475 comment (2026-08-25); spike artifacts stay
local scratch.

**#476 shipped the same day (ADR-069): population membership now applies the CQM IG's published
formulas per subject, pinned by a test that quotes its ruler.** `hl7.fhir.uv.cqm` STU1's proportion
formulas (*Denominator Membership = IP ∧ DENOM ∧ ¬DENEX ∧ ¬(DENEXCEP ∧ ¬NUMER)*; *Numerator Membership
= … ∧ NUMER ∧ ¬NUMEX*) are exactly what marginal-count score arithmetic assumes — and our per-subject
flags did not encode the interactions: a DENEXCEP∧NUMER subject was subtracted from the effective
denominator while staying in the numerator (a score that can exceed 1.0), DENEX∧NUMER kept a numerator
the spec removes, and `numerator-exclusion` was **absent from the population-code map entirely**, so a
NUMEX entry was silently skipped and the numerator overstated — the unrecognized-input-reads-as-covered
shape again (#380/#400). RED first (6 of 8 new assertions failing for the predicted reasons), then the
fix confined to `normalizeMembership` + the two evidence readers; the folds are SILENT where the subset
clamps stay ALERTED, because a writer reporting raw co-true flags is spec-conformant while an inverted
subset pair is corruption (the loudness split is the ADR's core). Deliberately narrow: NUMEX folds into
`numer` and is NOT a reported population (no shipped measure declares one). The suite proves the change
inert on every existing surface — **2,018 tests, 0 fail, no snapshot moved** — because fqm pre-zeroes
the interactions it computes and the authored status rule cannot produce co-true flags; the defect was
reachable only through evidence a different writer would produce, which is why nothing external ever
caught it. In-test oracle computes the IG formulas independently over a mixed cohort and cross-checks
`countPopulations` → `measureScore` against them. **The independent review then caught the fix
diverging from its own ruler** on the one triple the cohort omitted: the first cut folded the
exception against the NUMEX-adjusted numerator, where the IG's DM formula negates it on the RAW
criteria result — so a DENEXCEP∧NUMER∧NUMEX subject was dropped from the effective denominator
instead of staying a scored failure. Fixed RED-first; the hand-picked cohort is now backed by an
**exhaustive 64-combination sweep** against the in-test oracle (subset-violating vectors included),
so "exact for all flag combinations" is measured rather than claimed. Two more review catches folded
in: `COMPLIANCE_API.md`'s `populationsSource: official-evidence` row said "persisted verbatim" about
booleans that are now the IG derivation of the persisted vector (reworded — the persisted evidence IS
verbatim; the served block is derived); and a results array recognizing ONLY `numerator-exclusion`
had silently become a valid all-false vector where it used to alert as unreadable — NUMEX is a
modifier, not a membership population, so it no longer counts toward `recognized`.

## 2026-08-24 — a three-sided alignment audit: original intent, stakeholder guidance, and where HL7/CMS are actually going

Run so the next planning round starts from a verified picture instead of memory; the full audit lives
in local working notes (kept out of the repo by owner preference — this entry carries the findings that
matter). Method: one audit pass over the tree (every stakeholder ask scored against evidence with
paths), one research pass over primary sources (CMS rules, ONC, HL7 IG publication records, the
Connectathon 43 track pages, npm/GitHub state of the JS CQL stack).

**The three verdicts.** (1) *Original intent:* nearly everything achieved or evolved-with-ADR; the one
real drift is that occupational **content** — the original differentiator, reaffirmed as locked
decision 6 — has grown by exactly one lab-only measure since May. (2) *Stakeholder guidance:* aligned
on every concrete technical ask; the exposures are legibility, not code — **gated ≠ routed is
stakeholder-invisible** (2 of 8 priority measures route; six run only inside the CI harness; CMS68 is
structurally unroutable and CLAUDE.md's wave-2 summary wrongly said otherwise), and ADR-058's
retirement of the Cypress bar still awaits its ratifying owner conversation. (3) *External:* the
strongest finding — **the QDM/QRDA column is being wound down by both CMS and ONC**. CY2027 PFS
proposed rule: FHIR reporting voluntary PY2028–29, **mandatory PY2030**, MIPS CQMs sunsetting; HTI-5
proposes removing the eCQM certification criteria; US Quality Core 0.5.0 is Active and ONC-published.
The FHIR-column bet of ADR-058 / locked decisions 1–3 is now citable to CMS as the published direction
rather than defended as a judgment call.

**Two findings that convert directly into September work.** The Connectathon 43 Clinical Reasoning
track's *CQL Engine Parity* scenario is `cql-tests-runner` driving a **system-level `$cql`** operation —
and the engine already evaluates data-free expressions (`evaluateExpressions`, ADR-060); the gap is an
HTTP facade and the CQL→FHIR `Parameters` serialization. And the *USQC Refactored Measure Parity*
scenario is `dqm-content-cms-2025` — the same eight measures, refactored QI-Core → US Quality Core, in
the same per-patient test-case format the MADiE gate already consumes. Both are named scenarios where
the existing 410/410 discipline is the preparation. Also learned: the JS translator shipped a released
**5.2.0** (we pin 4.0.0-beta.1 — a full major behind), CQL 2.0 published 2026-07-29 with `Slice` — one
of our recorded `cql-execution` gaps — now a specified function, and the new CQM IG (`hl7.fhir.uv.cqm`,
QM IG's successor) publishes **normative population-membership formulas** our evidence-first membership
derivation can be pinned against directly.

**Stale-claim sweep** (each a pending fix): CLAUDE.md's "~785 tests" vs its own 1,910;
AI_GUARDRAILS still naming retired Java classes; README's 1604 badge and two contradictory ADR counts;
DATA_MODEL_CONTRACTS §5 vs read-time `why_flagged` (#463); the CMS68 routability error; and the "~2030
not CMS-attributable" standing correction, now itself superseded by CMS-1848-P (proposed).

**Nothing beyond docs changed today.** The proposed next-step sequence (three doc PRs — truth fixes,
README refresh, stakeholder explainers — plus the owner conversations and the two pre-September
standards items) was approved by the owner the same day; the tracker now carries it as milestone
"Connectathon 43 readiness" (#474 `$cql` facade, #475 USQC content vendor, #476 membership-formula
test) plus #477/#478 (docs) and #479 (translator upgrade, post-September).

**The truth-fix PR landed the same evening (#480, closes #463) — and the review process earned its
keep twice.** The code-review pass caught that the PR's own new `evidence_json` note had introduced a
fresh false claim while fixing a stale one (it asserted `evaluatedResource` is persisted and omitted
the load-bearing `official` key — exactly the error class the PR exists to remove), plus ADR-047's
Status line carrying the same CMS68 over-claim its own point 6 refutes, and two undocumented AI
authoring surfaces in `ai-assist.ts`. Codex then added what both had missed: `qrda1Import` is a third
persisted evidence key (ADR-051/056), and a failed evaluation **replaces** evidence rather than
appending. Both verified against the tree (`runs.ts:654/833/867`, `run-pipeline.ts:693`) before the
note was amended. A contract doc that had been wrong in one way for months was nearly re-committed
wrong in a different way on the day it was "fixed" — three independent readers is what caught it.
Suite measured on the tree: **1,976 tests, 1,961 pass, 0 fail, 15 self-skip**; CI green across all
jobs; squash-merged as `0c526f84`.

## 2026-08-17 — `/api-docs` redirected to login, and three guards each watched the wrong side of it (#471)

The API reference page shipped in #469 was unreachable. It was correct in every other respect — a
top-level route outside `app/(dashboard)/`, fetching the spec with a plain `fetch` and no bearer token —
but `PUBLIC_ROUTES` in `auth-provider.tsx` listed only `/` and `/sandbox`, and that provider is mounted in
the **root** layout. Every visitor was redirected to `/login`, which is the exact opposite of the page's
purpose: an integrator should be able to read the contract before they have credentials.

**Why nothing caught it is the part worth keeping.** Three guards sit adjacent to this and each is true
about its own subject. The page's own component tests render `ApiReference` directly, so the provider
never mounts. `openapi.test.ts` asserts the **backend** serves the document, which it does. And the
post-deploy probe was `curl`, where the redirect is invisible — the server returns **200** and the bounce
happens in the browser. Server-side correctness, client-side failure, and no guard positioned on the seam.
This is the vacuous-guard family again, in the shape where every individual control fires correctly and
the defect lives in the gap between their scopes.

So the fix is not the missing entry. `auth-provider.test.tsx` now **walks `app/`** for real `page` files
and checks each resolved URL against the provider's own predicate.

**Review (Codex P2) caught that the first version of that walk was itself the same defect, one layer up.**
It mapped top-level *directory names* to URL segments, which the App Router does not do. A public page at
`app/(public)/help/page.tsx` would have made the test demand a nonexistent `/(public)` entry — and once
somebody added that bogus entry to silence it, the guard would **pass** while `/help` still redirected. A
regression test stepping over the very defect it exists to catch. The walk now recurses and resolves URLs
the way the router does: a route group contributes no segment, `(dashboard)` marks everything beneath it
authenticated however deeply nested, and a dynamic segment is skipped because matching is prefix-based, so
its static ancestor is what must be listed.

Two changes the fix pulled in. **`isPublicRoute` is extracted and exported**, so the test asserts against
the provider's real matching rather than a reimplementation that would only ever agree with itself. And a
**second assertion covers the converse** — nothing in the allowlist may exempt the authenticated group —
because a lone `/` entry would satisfy the coverage direction while unlocking the whole app.

Mutation-checked in both directions and on the route-group case specifically:
`app serves /help outside (dashboard) but it is not public`, and
`/programs is inside (dashboard) but PUBLIC_ROUTES exempts it`. Frontend suite 190, 0 fail.

**Carried forward:** an HTTP probe is not evidence that a page loads. For anything behind a client-side
router, the deployment check has to be a browser, or a test that mounts what the browser mounts.


## 2026-08-17 — the integration surface becomes real: a CDS Hooks service, and the OpenAPI document that was claimed for a year

Both of the 2026-08-14 asks are now built, on one branch, because they are the same theme: a CDS Hooks
discovery endpoint is itself an API that wants documenting alongside `/api/v1/compliance`. **ADR-067**
(CDS Hooks) and **ADR-068** (OpenAPI). The TODO that stood at the top of this file is discharged.

**What ships.** `GET /cds-services` (public), `POST /cds-services/{id}` and `POST .../{id}/feedback`
(bearer-gated) — a CDS Hooks **2.0.1** service for the `patient-view` hook, returning cards built from the
most recent **finalized** run. And `GET /api/v1/openapi.json`, a hand-authored OpenAPI **3.1.1** document
for the promised surface only, rendered for humans at the frontend's public `/api-docs`. Suite 1964 → 1969
plus 6 frontend tests; 0 fail; `redocly lint` 0 errors.

**Research corrected me three times before any code was written, and each correction changed the design.**
(1) **The auth model is not RFC 7523.** CDS Hooks defines a bespoke signed-JWT bearer scheme (RFC
7515/7517/7518): no `sub`, no token endpoint, `aud` equal to the invoked endpoint URL, an `iss`/`jku`
allowlist — and it **SHALL NOT** be signed with a symmetric algorithm. Our HS256 token therefore can never be
a conformant CDS Hooks JWT, so the profile is a *named gap* rather than something to claim. It is
deliberately not built: `jku` fetching is SSRF-by-design, and a verifier whose allowlist nobody has
populated is a control that reads as present and cannot fire. (2) **No graded conformance ruler exists** —
`cds-hooks/cds-validator` is JSON Schemas last pushed 2018-02-05, the sandbox emits no score, and Inferno has
no CDS Hooks kit (only the CRD-scoped one). So the claim is ADR-065's shape: conforms structurally,
self-graded, unverified by any external suite. (3) **The measure-outcome→card mapping is ours.** HL7's
blessed route is `PlanDefinition/$apply` → `RequestOrchestration` → cards, and CQF Ruler and AHRQ's CQL
Services both do CQL→cards that way — but **DEQM's `$care-gaps` stops at a `DetectedIssue` and nobody
publishes the gap→card bridge.** Recorded as a local mapping in `STANDARDS_CONFORMANCE.md` rather than cited
to an IG.

**Three refusals are the substance of the CDS work, and each is mutation-checked.** `critical` is never
emitted and is *unrepresentable in the card type* — it means "the user must not proceed", which WorkWell is
not entitled to say about someone else's encounter (locked decision 1); `systemActions` likewise. A
suggestion is offered only where the order code carries an **APPROVED** terminology mapping read from the
store, so **cms122 and cms125 get no suggestion** — their CPT codes have no mapping at all, and
`order-catalog.ts` calls its codes "representative (demo, not billing-certified)". That consequence is
stated up front in three places rather than discovered at a demo; unlocking it is a terminology review, not a
code change. And **an absence is a CARD, not an empty list**: a patient with no finalized outcome gets one
informational card, because `{"cards":[]}` at the point of care reads as "no gaps" — the confusion ADR-061's
404 exists to prevent, and the one that would have hidden the `wc|<patientId>` namespace trap
`PROPOSALS_2026-08.md` §P1 names.

**The feedback endpoint exists with no schema change**, which is why it was worth building at all: `card.uuid`
derives from `(runId, subjectId, measureId)`, so correlating a uuid is a recomputation over the subject's own
outcomes rather than a lookup in a table only the owner may create. Deterministic ids also mean a client
re-firing the hook for an unchanged run gets the same uuid, so repeat feedback does not fragment.

**The security-relevant part is small and was nearly invisible.** `/cds-services` is outside `/api/`, and
`authorize` ends in `return { ok: true }` for non-`/api` paths — permitAll, mirroring Spring's
`anyRequest().permitAll()`. Without an explicit rule the invoke endpoint would have served per-patient
clinical status to anonymous callers. Two rules added, order load-bearing (`/cds-services/**` also matches the
bare path), asserted both as a unit call and end-to-end through the worker; deleting either rule fails both
assertions.

**On the OpenAPI side the guard found things immediately, which is the point.** The document is hand-authored
— zod earns its keep only as a runtime validator, `@hono/zod-openapi` presupposes a router we do not have, and
TypeSpec would add a second hand-maintained source of truth with no coupling to a hand-rolled dispatcher — so
the contract test is treated as the other half of the decision, not garnish. It asserts **two-way coverage**:
every documented `(path, method, status)` produced by a real request through the real worker, and every
observed response documented. Mutation-checked three ways. Then `redocly lint`, which catches a class the
contract test cannot, rejected **five uses of `nullable`** — a 3.0 keyword OpenAPI 3.1 removed in favour of
type unions. Two different guards, neither implying the other: the same lesson as the CVU+ XSD/Schematron
episode, where a check's scope was narrower than the claim it was cited for.

**And the coverage test refused a mis-modelling of mine.** I documented a `405` under the `get` operations of
the GET-only paths to silence a Redocly `operation-4xx-response` warning. A 405 belongs to the *path*, not to
the GET, so the document would have been asserting that a GET returns 405 — false. The test failed, the 405s
came out, and four warnings remain with a written reason instead. No ignore file.

**Two stale ARCHITECTURE claims are corrected, one of which I did not go looking for.** §9's
"The OpenAPI document (`workwell.swagger.enabled=true`) advertises version `v1`" was a springdoc property
belonging to a backend retired in #109 PR4 — and §7 did not mention `/api/v1/compliance` at all, so the file
was simultaneously claiming a document it did not serve and omitting the one contract it does. Writing the
document also surfaced that §9 promised `/api/version` returns `uptime`; it does not, and never did here.

**S7 is rewritten** and its per-part table now splits along the line that matters: *delivering a finding into
a workflow*, *offering follow-up as an order*, and *did anyone act on it* move to **built**, while
**evaluating data supplied on the request** stays not built — that is step 2, and `prefetch` is exactly where
it would go. The service declares none *because* it evaluates none, which is the same refusal as ADR-061's
`mode=preview` 501, in a different place. The sequence diagram now draws that missing leg as a dashed arrow.

**Also: `docs/transcripts/` is now gitignored.** Only basename globs (`**/*transcript*.md`) matched before, so
`docs/transcripts/2026-08-16 call.md` was committable by accident. Verified with `git check-ignore`.

**Owner steps this creates.** Two, both cheap and both for other people. **MIE's CHPL entry could not be
read** — chpl.healthit.gov is an SPA and its API is key-gated — so whether WebChart holds §170.315(b)(11) is
a manual lookup; note that (b)(11) and HTI-1 **do not name CDS Hooks**, so nothing here is justified by
certification. And the joint call now has a precise question instead of an open one: **does WebChart act as a
CDS Hooks client, and if so what are its `iss` and JWKS URL?** There is no public evidence either way — zero
hits for CDS Hooks across both MIE docs sites, and their FHIR API is documented as new with essentially no
adoption.

**Not done, deliberately.** No `encounter-start` service (maturity 1 in the CDS Hooks Library IG, and it would
return the same cards); no `prefetch` evaluation; no OpenAPI path aliases beyond the canonical one; no
try-it-out console on `/api-docs`, since `swagger-ui-react` peers on `react@">=16.8 <19"` and this app is on
React 19 — a copyable `curl` instead.

**The review round changed real things, and two of them were mine to be embarrassed about (#469).** A
code-review pass plus Codex's PR comments produced seven substantive fixes.

The one both reviewers found independently: **feedback returned `200` when its audit write failed.**
Best-effort auditing is right for *invoke* — the cards are still correct — but for feedback the audit event
IS the persistence, which is the whole reason the endpoint needed no schema change, so a swallowed failure
was a silent no-op that told the client never to retry. Now `503` with `recorded`/`of`. It also collided
verbatim with CLAUDE.md's "every state change writes `audit_event` — no exceptions".

The one that mattered clinically: **a failed CQL evaluation rendered as a fact about the patient.**
`PARTIAL_FAILURE` is terminal so its rows are served, and a subject whose evaluation threw persists as
`MISSING_DATA` with an `evaluationError` — which `deriveCell` turned into "No record on file" and
`nextActionFor` into "Collect the missing documentation". On a dashboard that is an approximation; in
someone else's chart it is the same confusion `noEvaluationCard` exists to prevent, one layer in. Such a row
now gets a "could not be evaluated" card with no suggested order.

Codex's best catch: **the suggested `ServiceRequest` referenced `Patient/wc|4821`** — WorkWell's internal
subject id, which names nothing in the client's namespace and is not a legal FHIR id, so the suggestion
could not be applied. Only bites on the deployment the feature exists for. Fixed in the CDS layer alone,
because `GET /api/orders/proposals` shares `toServiceRequest` and the internal id is correct there.

**Four of my own guards could not fail**, which is worth recording in a change whose selling point is guard
rigour. The worst: `assert.notEqual(authorize(...).ok && alias === OPENAPI_PATH, true)` — the `&&` is always
false, so it passed for every possible implementation, and it was not one I had mutation-checked. Also a
`critical` assertion against a type that permits only two values, an `Array.isArray` that pinned a field name
and nothing else, and a `.find()` that returned the oldest audit event while being named `latest`.

**One Codex comment I did not act on, and said so on the thread.** It argued `acceptedSuggestions` should be
an array of UUID strings; the spec defines "an array of json objects identifying one or more of the user's
**AcceptedSuggestion**s", each with a REQUIRED `id`, and every example is `[{"id": …}]`. Complying would have
made the published contract non-conformant. But checking it properly found something real underneath — our
runtime accepted `[{}]` — so the `id` is now required, and I had to push a second commit because I had
already *claimed* that in the reply before it was true.

**And a self-inflicted one worth carrying: `sed -i` over UTF-8 source replaced a space with a literal NUL
byte, twice, and it reached a commit.** It typechecked, all 1,976 tests passed, and the only symptom was
`grep` reporting the file as binary — a signal I saw and dismissed as a bad measurement. It sat in the
separator feeding the card-uuid hash. Fixed, with a six-line test over `src/cds/` that would have caught
both. The rule going forward is simply: do not `sed` UTF-8 source.

**Deferred with a reason, not forgotten: [#470](https://github.com/Taleef7/workwell/issues/470).** Resolving
a patient scans that subject's entire outcome history and parses each row's evidence. Real, but **not this
change's defect** — five callers share the constant, and the CDS route copied it deliberately; what is new
is a *latency budget* for it. The fix is a per-measure store query with a `store-contract.ts` case, which is
a different review surface, and nothing fires the hook today so it is unobserved. Stated in
`CDS_HOOKS.md` → *Limits, stated* rather than left for an integrator to discover.

---

## 2026-08-14 — M-E1 leads with immunization, and CDS Hooks turns out to be a specification rather than a dependency

Two owner decisions, taken off the back of the questions in the entry below.

**TODO — publish the WorkWell API contract as OpenAPI and serve Swagger UI.** *(DONE 2026-08-17 — ADR-068;
see the entry above. Kept here because the probe result it records is the reason the work happened.)* The
TypeScript backend is live, but authenticated probes against both production and staging confirm that
`/api/openapi.json`, `/api/swagger`, `/swagger-ui`, and `/api/docs` all return `501 not_implemented`. The
Swagger UI at `manager.os.mieweb.org/api` documents MIE Create-a-Container, not WorkWell. Add a versioned
OpenAPI document for the WorkWell integration surface (beginning with `/api/v1/compliance`), expose a Swagger
UI, test both routes in CI/deployment smoke checks, and correct the stale OpenAPI claim in `ARCHITECTURE.md`.

**Decision 1 — M-E1's first content pack is immunization, not OSHA.** Three reasons, in order of
weight. **A written specification already exists**: WebChart's immunization surveillance system
reports carry a denominator (has a qualifying encounter, with a few age exceptions — shingles at 50+),
a numerator (met the appropriate dose count), and a next-due forecast with the appropriate spacing
(hep B at four weeks, then six months). Authoring from an existing implementation is far cheaper than
authoring from regulation text, which is what `OshaHearingStandardThresholdShift` demanded and why it
took the care it did. **It is unambiguously occupational**: healthcare employers require immunizations
*above* the general population — two MMR doses where most people need one, because their staff are
continuously exposed — which is exactly locked decision 6's "the measures nobody publishes". And **it
has a counterpart waiting**: a parallel MIE workstream owns configurable per-client vaccine rules, with
WorkWell's half being compliance display and alerts. M-E1 previously had nobody downstream of it.
What changes: M-E1 led with OSHA (hearing conservation, respirator, hazwoper) and now leads with
immunization, the OSHA content sitting behind it. The hearing-conservation measure stays as the worked
example of authoring straight from a regulation.

**On the port itself: do not hand-translate the SQL into CQL.** That is the same intractable direction
as ELM→SQL and fails for the same reason — two implementations of one set of semantics, with no way to
say which is right (chapter 7, ADR-025). The better answer is the architecture already built: express
the rule at the **parameter tier** and generate *both* sides from it (`@work-well/measure-codegen` plus
`generate-sql.ts`), which is already parity-tested at 4 measures × 56 patients × 2 dates with zero
divergence. **Stated rather than glossed**: today's codegen knows only *windowed recency*, and
immunization needs a new rule shape — dose count, minimum spacing, next-due forecast. That is the same
pattern extended, not a new architecture. **Consequence worth noticing**: this would answer the
question that has sat open in chapter 7 since July — whether the CQL→SQL path is a product path or a
proof that has done its job. It would make it a product path, and give it its first real consumer.
**Unknown until the rule definitions are actually seen**: whether the parallel workstream's per-client
rule shape maps onto rule parameters. If it does, those definitions feed codegen directly and nobody
ports anything by hand.

**Decision 2 — CDS Hooks is adopted as a SPECIFICATION. ADR-008 stands, and `cqf-fhir-cr` does not
enter the runtime.** The distinction that decides it: **CDS Hooks is a JSON request/response contract
over HTTPS** — a `/cds-services` discovery endpoint plus one invoke endpoint per service, returning
cards (summary · detail · indicator · suggestions · links). Serving it requires **no Java at all**; it
is two routes on the worker that already exists. `cqf-fhir-cr` is merely *one implementation* that
serves CDS Hooks by evaluating `PlanDefinition`s — and WorkWell already evaluates measures. Adopting it
at runtime would not be reusing a wheel we lack; it would be **replacing a working engine with a second
one**, which is the exact failure mode "don't reinvent the wheel" warns against, pointed the other way.
So: **reuse the standard** — free, JVM-free, and the strongest available form of not-reinventing, since
it adopts the community's contract instead of the bespoke submit-a-bundle endpoint S7 currently
sketches. **Do not reuse the implementation** at runtime, absent a specific capability our engine
lacks; none was found. `cqf-fhir-cr` keeps the role it has already earned — B7's independent
cross-check by an engine sharing no code with ours (255/278). **S7 is deliberately NOT yet updated**:
it still documents the bespoke endpoint, and rewriting it waits on whether WebChart speaks CDS Hooks as
a client.

**Recorded so it is not re-litigated: reaching for a Java engine later would not cost ADR-008 either.**
ADR-029 already runs **ICE — Java, OpenCDS, Drools** — as a long-lived self-hosted sidecar behind a
port, with the TypeScript adapter falling back to the simulated forecaster when the base URL is unset
("inert-unless-configured holds… behavior is byte-identical"). That ADR **cites ADR-008 approvingly
while doing it**, because ADR-008's constraint is that WorkWell must not *require* a JVM to run, test
or deploy — and an optional sidecar does not. Local dev, CI and the SQLite floor all stay JVM-free. A
Java engine behind a port is therefore an established shape here, not a precedent that needs setting.
Also worth carrying: ADR-029's own context shows the transport question — *"CDS Hooks vs ICE API vs a
WebChart-ICE bridge"* — was deferred to MIE back in July, so CDS Hooks has been an open thread in this
repo since then rather than a new idea.

**A related doubt, recorded undecided: ICE may be the wrong instrument for this particular use case.**
ICE scores the general ACIP schedule, while the occupational requirement is deliberately *above* it.
ADR-029 already establishes that ICE and WorkWell can legitimately disagree and that this is not a
defect — but for immunization *compliance* the forecast probably wants to come from the same rule
parameters (spacing arithmetic) rather than from ICE. Not decided, and it should be.

**Open for the next joint session** (gated on the MIE outage clearing). Does WebChart already speak
CDS Hooks as a **client**? — this changes the design, not merely the estimate, and it is the cheapest
question on the list. The shape of the per-client vaccine rule definitions. Where the forecast comes
from. And one correction to carry in explicitly: **no CDS hook fires in WorkWell today** — no hook, no
card, no `PlanDefinition`, no `$apply`; the alerts exist only on WorkWell's own screens. Saying so
plainly and early matters, because an assumption that point-of-care alerting already works would leave
S7 unprioritised and the gap found much later.

## 2026-08-14 — two questions from Nicole: there is no CQF Ruler anywhere, and the engine was never the differentiator

Recorded because both answers were arrived at by reading the tree rather than from memory, and both
will otherwise be re-derived expensively later.

**Q1 — does WorkWell use CQF Ruler to alert the provider? No, and nothing like it.** Verified by
search: **zero** references to `cqf-ruler`, no CDS Hooks implementation, no `PlanDefinition`, no
`$apply`. The only CDS Hooks mentions in the repo are in the archived ICE immunization-forecasting
design docs, where it was weighed as a transport option and **not taken** (ADR-012 / ADR-029). Two
things from that family *are* used and neither is alerting: stock **HAPI FHIR** is the local "fake
WebChart" simulator (ADR-032), and **`cqf-fhir-cr`** — cqf-ruler's successor, cqf-ruler itself being
archived in favour of HAPI plus the clinical-reasoning module — was used **once**, as B7's
independent second opinion, cross-executing the CMS artifacts through an engine sharing no code with
ours (**255/278** across six measures). A verification exercise, not a runtime component. The larger
fact underneath the question: **WorkWell does not alert providers at all today**, which is the gap
S7 exists to describe.

**The finding worth keeping: CDS Hooks is the published standard for S7's alerting shape, and the
S7 sketch is currently designed *around* it rather than *with* it.** The mapping is close enough to
be uncomfortable. Hooks fire at workflow moments (`patient-view`, `encounter-start`, `order-sign`) —
that is the four in-encounter checkpoints. Cards carry summary / detail / indicator
(info · warning · critical) / suggestions / links — that is the alert shape, already specified. A
card's **suggestion** can carry a proposed action the EHR applies — that is the task write-back,
**standardised, and without WorkWell needing write credentials into a certified EHR**, which is the
single heaviest requirement in S7 as written. A card's **link** can launch a SMART app — which is
exactly the narrow "embed WorkWell for the drill-down" case, without embedding it on the alert path.
Since every layer here having an outside authority attached is the actual product, inventing a
proprietary submit-bundle-get-findings endpoint cuts against the thing being sold. **This is not a
decision, and nothing was changed** — S7 still documents the bespoke endpoint. It is a candidate
mechanism to weigh before anyone builds one.

**Open, cheap to answer, and it changes the design rather than the estimate: does WebChart already
speak CDS Hooks?** Not determinable from this repo. If it does, S7's largest unbuilt piece gets
substantially cheaper *and* standards-shaped; if it does not, the bespoke endpoint is back on the
table. Worth putting to Doug/MIE before anyone designs the endpoint. Note this is the same territory
as **P1 / [#458](https://github.com/Taleef7/workwell/issues/458)** (the encounter-close quality
check) — P1 is a slice of what S7 draws whole, and both run into ADR-061's `mode=preview` 501. That
501 is worth reading as a *feature* here: preview refuses because it composes a **synthetic** bundle,
so an endpoint (or a hook) where the EHR supplies a **real** bundle is precisely what makes that
answer honest. The hole in today's API is the shape of the thing that would fill it.

**Q2 — what makes WorkWell a better engine than the existing ones? It is not one, and
`docs/PACKAGES.md` already says so in writing.** The engine *composes* `cql-execution` rather than
competing with it, and PACKAGES states that **no performance or conformance comparison against
`fqm-execution` has been run, so none is claimed**. The strongest evidence is a routing choice made
against our own package: **the two CMS measures live in production run on `fqm-execution`, not on
`@work-well/measure-engine`.** That is deliberate rather than a shortfall — a claim like "this
person is overdue" is checkable by somebody who does not trust us *because* it traces to a published
measure on a reference engine against NLM code lists graded by the measure authors' own cases. A
proprietary "better" engine would make the claim **less** checkable, not more.

**What is actually differentiated, in descending order of defensibility.** (1) **The occupational
content** — nobody publishes CQL for OSHA hearing conservation, respirator surveillance or hazwoper
medical monitoring, so a competitor can download every CMS artifact in existence and still not have
it (locked decision 6). (2) **Evidence retention as a deliberate non-optimisation** — every named
rule is evaluated and kept even when nothing downstream asks for it; an optimiser would delete
exactly the thing we sell. (3) **Packaging** — two dependencies, no `node:` builtins, content
**injected rather than shipped** (enforced as a compile error), Workers-portable; `fqm-execution`
drags a large dependency tree, which is why `official-executor` is deliberately unpublished
(ADR-063). This is the one place a measurable engineering claim exists. (4) Everything around the
engine — cases, audit, exports, the Studio — which is most of the product and none of it engine work.

**Counter-evidence recorded rather than smoothed over.** On speed the comparison runs *against* us:
the authored engine is ~**68 ms/subject**, while `fqm-execution` batched is **11–16 ms** (171 ms
unbatched). Not apples to apples — authored returns a value per rule, the reference calculator
returns population booleans, so it is more information for more work — but nobody should read it as
a speed win. And ADR-060's **1,622 of 1,835** language-conformance result has its failures in the
**shared** translator and engine, not in anything we wrote: we inherit upstream's gaps along with
its credibility, including `1L + 2L` evaluating to `12`.

**A third thing surfaced on the way: the patient feedback loop is outbound only.** Outreach goes out
over `EMAIL` / `SMS` / `PHONE` (simulated by default), a delivery status comes back, and it is
recorded as a `case_action` with an audit row. There is **no inbound path** — no `Questionnaire`, no
survey, no patient-reported outcome, no capture of a reply. The consequence worth stating: **"did the
outreach work?" is answered by re-evaluating clinical data** (`rerun-to-verify` checks whether the
EHR now shows the test happened), not by hearing from the person. A patient replying "I already had
that done elsewhere" has nowhere to land, and delivery status is "the message sent", which is a much
weaker signal than "the person engaged".

Also today, and unrelated to the above: the guide's diagrams were simplified across the board — the
whole-thing-on-one-page flowchart cut from 22 sentence-length nodes to 7 short-labelled ones with the
detail moved beneath it, all six scenario diagrams abstracted (implementation lanes folded, `Postgres`
renamed `Database`, arrow routing corrected where a response was drawn bypassing the intermediary
that actually relays it), and a "who's who" glossary added. **S7 was added** as the first scenario in
the chapter that documents behaviour which does not exist — the target architecture for the WebChart
seam — marked as such in three places, with a per-part table of what exists today.

## 2026-08-12 — three product ideas become written proposals, not code

The 2026-08 feedback carried three product-shaped ideas, and they are written up rather than built —
none is understood well enough yet for building to be the cheaper way to find out what it should be.
`docs/PROPOSALS_2026-08.md` sketches each in one page — what it is, how it maps onto
machinery that already exists, what would actually have to be built, and the questions still open.
**P1**, an encounter-close quality check, leans on the compliance API (ADR-061), which already answers
per-subject-per-measure and says where its numbers came from; the honest part is that `mode=preview`
deliberately returns 501 on a WebChart stack because it composes a synthetic bundle, so a point-of-care
check is a new live-composition path, not a flag flip ([#458](https://github.com/Taleef7/workwell/issues/458)).
**P2**, the "not seen in a while" outreach view, needs an encounter-recency signal that exists nowhere
today — and a decision about what "seen" means, since any-encounter and the measure's own qualifying
encounter produce different lists ([#459](https://github.com/Taleef7/workwell/issues/459)).
**P3**, a next-action due date, is arithmetic over evidence the engine already wrote — last exam plus
the measure's configured window, which `case-outreach.ts` already computes privately as a clamped date
for outreach templates while `employee-profile.ts` computes the related *day count* (window − days
since) for the profile read model — and is **never** an AI prediction (`docs/AI_GUARDRAILS.md`)
([#460](https://github.com/Taleef7/workwell/issues/460)). A fourth issue names the live WebChart
demonstration run so it does not evaporate ([#461](https://github.com/Taleef7/workwell/issues/461)).
Nothing was built, nothing is scheduled, and every proposal awaits owner review.

## 2026-08-12 — the guide gets a scenarios chapter, a chronological one-pager, and a numbers audit

Owner review of the documentation asked for three things: sequence diagrams per user flow, a
one-page overview whose layout actually expresses time order, and every number verified. All
three land in one PR; the product-shaped ideas from the same review are deliberately NOT built
here — they become written proposals in a follow-up PR, per the approved design
(`docs/archive/superpowers/specs/2026-08-12-guide-scenarios-and-feature-proposals-design.md`).

**Chapter 10 exists: six sequence diagrams, the guide's first.** The 21 prior diagrams are 20
flowcharts and a timeline — structure and history, never sequence. The selection criterion is stated in the chapter and is
the reason the set is six and not sixteen: a flow earns a sequence diagram when the *order of
handoffs* is the content. S1 a run (scheduled or manual — one pipeline after the trigger), S2
WebChart end-to-end (SMART auth → FHIR reads → normalization → evaluation → the versioned
compliance API, with the 404-not-empty-200 and preview-501 semantics drawn), S3 a flagged
person worked by an operator (the AI lane shown with its deterministic fallback, never touching
compliance state), S4 authoring draft-to-active (the build-time/run-time compile split as a
Note), S5 the standards loop (import → identity grouping → finalize refusal gate → three export
formats), S6 an MCP consumer (SSE handshake, role gate at dispatch). Admin CRUD flows are
excluded by the criterion and the chapter says why; the auth/session flow is deferred, cheap to
add if a security review wants it. Every route path, audit event name, disposition list and
count in the diagrams was verified against the tree before drawing, and spec reviewers
re-verified independently (the S6 role-gate claim traced to `tools.ts` CM/ADMIN and
`dispatch.ts` enforcement).

**The README one-pager now reads chronologically.** The old diagram put BUILD TIME and DATA IN
side by side at the top — two stages that happen at different times, drawn as peers, which was
the owner's exact critique. Now: ① BUILD TIME (happens once, output committed) sits alone above
an "EVERY RUN" band whose five stages ②–⑥ chain strictly top to bottom; the CQL→SQL lane stays
a dotted side-track. Node wording is untouched except "17 CQL files" → "17 CQL libraries".
**A sweep of the other 20 diagrams found zero further offenders** — chapter 3 already carried
the explicit BUILD/RUN split, and every other time-ordered diagram reads in true order; the
verdict table is at `docs/evidence/GUIDE_DIAGRAM_SWEEP_2026-08-12.md`. The critique was about one
diagram, and one diagram is what changed.

**The numbers audit corrected five things and verified everything else.** Corrections:
chapter 6's store-interface count ("eleven more" → "twelve more"; the factory holds 15);
chapter 1's "nine artifacts in total" → "eight", matching its own enumeration (the MAT export
is a measure *definition*, not a run output, so the count moved rather than the list growing);
chapter 3's node-type count re-anchored from an unlabeled 26 — true only of HepatitisBSeries —
to 29 on the audiogram, the measure the chapter actually walks, with the node-family table's
example column generalized (the audiogram carries `LessOrEqual` and `IntervalTypeSpecifier`,
not `Less`/`First`/`Interval` by name, so attributing family examples to it was the blocker);
chapter 10's S4 note tightened to "17 measure libraries (+FHIRHelpers)"; and chapter 6's
undated 1,940-test count destabilized to point at chapter 9, which owns it dated. Verified and
left alone: 14 registry measures / 12 authored / 2 routed, the 410/410 MADiE split and its
per-measure addends, 150-person roster, 13 MCP tools, 18 committed ELM files, 22 tables, the
conformance and cross-engine figures, and chapter 9's dated history — which stays historical by
the audit's own rule.

## 2026-08-12 — CI now proves the committed ELM is what the CQL produces (#410)

The gap chapter 3 documented as a manual prerequisite is closed: the backend CI job recompiles all
17 measures (+FHIRHelpers) after typecheck and fails on any difference from the committed output.
Edit a `.cql`, forget to regenerate, and CI now says so — instead of staying green while the
deployed measure runs the last-compiled logic. ADR-040's sentence, one layer up, finally with a
guard.

**The pre-wiring checks the issue demanded, all run before a line of YAML.** (1) Determinism:
`compile-measures` twice on a clean tree — byte-identical, ~9 s per run, so the check is sound and
cheap enough to live in the existing backend job (fail-fast between typecheck and the long suite)
rather than paying a second install in its own job. (2) The committed tree is in sync today, so the
gate lands green. (3) No double-report: the `official-cases` job's "reproducible from its pin" gate
covers the VENDORED CMS artifacts; this covers the AUTHORED measures, which that gate never sees.

**Mutation-checking changed the shape of the fix, which is why it happens before wiring.** A version
bump in one measure produced a NEW `.elm.json` — an *untracked* file, which `git diff --exit-code`
(the issue's sketched command) silently ignores. The landed check does `git add` on the output paths
first and diffs the index, so new files fail too. It also covers all THREE outputs the script
writes, not just `elm/`: the compiler regenerates `src/measure/resources/cql-resources.json`
(the bundled translator resources) on every run, and the issue's sketch missed it. Both are the
vacuous-guard shape — a check narrower than the claim it gets cited for — caught this time before
the guard shipped rather than after.

**And then the gate's first clean-runner run FAILED, and the failure was a real finding.** The
issue's third pre-wiring check — "confirm byte-determinism holds on a clean runner, not just
locally" — was the one I could not fully discharge from a Windows machine, and it is exactly where
the defect was. On the Linux runner all 18 ELM files and `index.ts` reproduced byte-identical, but
`cql-resources.json` differed by one line: it embeds the RAW text of the three translator
resources, so it encodes the line-ending flavor of the checkout that generated it — committed from
a CRLF working copy, regenerated on an LF one. The local determinism check was blind to this by
construction (same machine, same flavor, both runs agree). `compile-measures` now normalizes CRLF
on read — inert for the translator (ELM carries no source text; locators count lines the same
either way, which the 18-identical-files result demonstrates) — and the sidecar is regenerated in
its platform-independent form. The claim "byte-deterministic" was true per-machine and false
across machines, and only the gate itself could tell the difference.

**Codex's review then found the third gap in the same guard, and the repository already contained
its proof.** The compiler only ever WRITES: a committed `.elm.json` the current CQL no longer
produces — a deleted or version-bumped library — is touched by nothing, stages no deletion, and
passes forever. Two such orphans were already committed (`BreastCancerScreeningCQL-1.0.0`,
`DiabetesHbA1cPoorControlCQL-1.0.0` — superseded by 2.0.0s, absent from the generated index,
loadable by nothing in the runtime; chapter 3's "a few measures keep two versions" was, it turns
out, describing them). The gate now `rm`s the generated directory before recompiling, which turns
an orphan into a staged deletion; verified to fail on exactly those two files before they were
deleted, and to pass after. Three guard-scope defects in one small check — untracked additions,
embedded line endings, orphaned deletions — each found by a different instrument (mutation, the
clean runner, review), none by re-reading the code.

Guide chapters 3 and 9 updated; the chapter 9 gap entry stays struck-through rather than deleted,
because "found by review on the documentation PR that wrote the guarantee down as though it
existed" is the provenance worth keeping.

## 2026-08-12 — the fonts are self-hosted, and a Google outage can no longer fail a deploy (#453)

`next/font/google` downloads font binaries at build time, which made fonts.gstatic.com a hard build
dependency in the two places the frontend builds: CI on every PR, and `deploy-twh-mieweb.yml` on
every push to `main`. #449 showed what that costs — a Google-side 404 for a rotated `.woff2` URL
failed a build whose change did not touch the frontend, surfaced as a Turbopack module error rather
than the real cause. Terminology got the deliberate treatment for build-time fetches (ADR-036);
fonts now get the same.

**The app fonts (Geist, Geist Mono, Fraunces) moved to `next/font/local`** over committed woff2s in
`app/fonts/` — the exact latin-subset variable files Google served for the previous configurations,
with source css2 URLs recorded in `app/fonts.ts`. The three call sites (`layout.tsx`, `page.tsx`,
`login/page.tsx`) now import from that one module. A detail worth keeping: Google serves the SAME
variable file for Fraunces 600 and 700, so one file covers both weights.

**The second, separate fetch was Jost, and it turned out to be two different things.** The brand css
`@import url(fonts.googleapis.com/...Jost...)` appears twice: inlined into the app bundle via
`globals.css` — where it sits INSIDE the `layer(theme)` block, which CSS forbids for `@import`, so
browsers silently drop it and Jost never loaded in-app at all (why the migration doc says "app keeps
Geist") — and at top level of `public/brands/enterprise-health.css`, where the runtime brand
switcher really does fetch it from Google on every switch. Both are gone: `public/brands/` is
generated by `pnpm sync:brands`, so the fix lives in `scripts/copy-brand-css.mjs` — it rewrites the
known Google import to `@font-face` rules over committed `public/fonts/jost-*.woff2` (latin +
latin-ext, normal + italic), and **fails loudly on an unknown Google Fonts import**, so a future
brand css cannot silently reintroduce an external fetch. `globals.css` now imports the transformed
public copy instead of the package file, so the built bundle carries no fonts.googleapis.com URL —
verified by grepping the entire `.next/static` output: **zero** googleapis/gstatic references,
where before the change there was one live import plus the build-time downloads.

**Scope honesty:** Jost previously came from Google with cyrillic subsets too; the self-hosted set
is latin + latin-ext (the app is English; EH is a US brand). And the app bundle inlining the brand
css means the visual behaviour is unchanged by construction — the layered `body` rule still loses
to globals' unlayered Geist rule, so no pixel moves in-app; only the brand switcher's Jost now
comes from our origin. Verified: build green, 180/180 tests, lint clean, ~183KB of woff2 committed.

## 2026-08-12 — the frontend leaves Node 20, and the backend-ts half turned out not to be free (#452)

The frontend was the last thing in the repository on Node 20 (EOL April 2026): the `ci.yml` frontend
job, the e2e job, and all three stages of `frontend/Dockerfile`. All five pins are now 24, matching
`backend-ts` and the shim, and `frontend`'s `@types/node` moved `^20` → `^24` so the types track the
runtime. The lockfile diff is exactly the `@types/node` 20.19.39 → 24.13.3 peer-dep cascade (plus
`undici-types`, its own dependency) — nothing else moved. Verified locally: lint, 180/180 tests, and
a production build, all on the updated lockfile. The Dockerfile change proves itself on the next
push to `main`, when `deploy-twh-mieweb.yml` builds the image. This unparks #430 (jest-dom 7, held
solely on the Node floor).

**The issue's "while there" half is NOT in this PR, and the reason is a measurement.** #452 suggested
moving `backend-ts`'s `@types/node` `^22` → `^24` in the same change. Doing it produces ~50 typecheck
errors, all one shape: `@cloudflare/workers-types` declares the global `URL`, `@types/node` 24's
`node:url` functions now demand Node's own `URL` (whose `searchParams.entries()` returns a
`URLSearchParamsIterator` carrying `[Symbol.dispose]`), and the workers-types `URL` — every published
entrypoint of it, `latest` included, checked in `node_modules` — still returns a plain
`IterableIterator` with no dispose. Structurally incompatible, and no version of either package
currently fixes it: bumping workers-types to 4.20260702.1 changes nothing. So `backend-ts` stays on
`^22` deliberately — its types lag its runtime, but they compile — and the conflict is recorded on
the issue rather than papered over with 50 call-site casts.


## 2026-08-12 — the action majors are finished, and every GitHub Action in the repo is current

The second and last batch: `docker/login-action` 3→4, `docker/build-push-action` 6→7,
`pnpm/action-setup` 4→6. Taken as one change again rather than three, for the same reason as #435 —
three separate merges over the same `uses:` lines means three rebases and three full CI runs.

Checked rather than assumed, and the answers were the same as last time: both Docker actions are
"Node 24 as default runtime, requires Actions Runner 2.327.1+", which cannot bite because all **24**
`runs-on:` lines are GitHub-hosted `ubuntu-latest`. `pnpm/action-setup` is the only one with a
different story — v5 moved to Node 24 and v6 "added support for pnpm v11" — and it matters not at
all here because every invocation pins `version: 10.17.1` explicitly, so the action installs the
pnpm we ask for regardless of which it supports.

With this, no action in the repository is behind: checkout v7, setup-node v7, cache v6,
upload-artifact v7, setup-buildx v4, login v4, build-push v7, pnpm/action-setup v6.

## 2026-08-11 — the first Dependabot triage, and two of my own holds overturned by reading the notes

Six PRs sat held from the 2026-08-10 batch. Working through them properly reversed two of my own calls,
which is the point of reading release notes rather than version numbers.

**#429 `next` 16.3.0 — merged, and my hold was wrong.** I had recorded it as "a plain feature minor
with no remaining security value" now that 16.2.11 had cleared the advisories. The first line of
16.3.0's core changes is **"Update vendored lodash to 4.17.23 to fix CVE-2025-13465"**. It is a security
release; Dependabot did not label it one because the vulnerable lodash is *vendored inside* next rather
than resolved as a dependency, so it raises no alert of its own. A version number cannot tell you that.

**#430 jest-dom 7.0.0 — still held, but for a completely different reason than I gave.** I had warned
that a matcher-library major "fails by quietly asserting something slightly different, which green CI
cannot detect". Reading 7.0.0: the only changes are *additive* (`toContainAnyBy*`, `toContainOneBy*`)
plus two structural breaks — `@testing-library/dom` becomes a required peer, and the **minimum Node is
now 22**. No matcher semantics moved. The real blocker is the Node floor: the frontend runs **Node 20**,
in `ci.yml` and in all three stages of `frontend/Dockerfile`, while the backend and shim are on 24. So
CI is green on a runtime the package no longer claims to support, which is not evidence worth merging on.
The frontend being the Node-20 outlier is now the tracked blocker.

**#419 `@types/node` 24 → 26 — closed, wrong direction.** Types should track the runtime. The shim
builds `FROM node:24-alpine` and pins node 24 in CI, so its `^24` is already right and 26 would type it
a year ahead of what it ships on. The genuine inconsistency is the opposite one and this PR does not
touch it: `backend-ts` declares `^22` against a `node:24` image, so its types *lag*. And `frontend`'s
`^20` is correct rather than drift — it really does run Node 20.

**#416 / #428 TypeScript — held, now with the number that settles it.** Dependabot proposes **7.0.2**
for the shim (the native Go port; the diff pulls in `@typescript/typescript-darwin-arm64` and friends)
and **6.0.3** for the frontend. Merging both would put the repository on three TypeScript majors at
once, with `backend-ts` on 5 and no updater that will ever propose its half.

**The same defect found a third time, and this one failed loudly.** After the grouping landed,
Dependabot's next round proposed `react` 19.2.4 → 19.2.8 while leaving `react-dom` at 19.2.4. React
refuses to start — *"Incompatible React versions: the react and react-dom packages must have the exact
same version"* — and all 35 frontend test files failed at **collection**, not on an assertion. Same
defect as the `eslint-config-next` split: an exact-pinned pair moved by half. The difference is
instructive: this one is unmissable, whereas the eslint-config-next split would have merged green.
A `react` group now covers `react`, `react-dom`, `@types/react` and `@types/react-dom`.

**#426 and the durable fix.** The group PR wanted to move `eslint-config-next` alone, and `next` +
`eslint-config-next` are the only two exact-pinned frontend dependencies, deliberately pinned to the
same version. Merging #429 first resolved it in the right direction. To stop it recurring,
`.github/dependabot.yml` now has a **`nextjs` group** covering both, declared **before** `frontend-dev`
— Dependabot's documented rule is that "if a dependency matches more than one rule, it's included in
the first group that it matches", so a broad dependency-type group listed first would swallow
`eslint-config-next` before the pair could claim it. Both the ordering rule and `applies-to` defaulting
to version updates were checked against the docs rather than assumed; the group is explicitly scoped to
version updates so a security fix for one never waits on the other.

## 2026-08-11 — the fqm-execution period-end fix, re-measured: three defects where I had reported one

Went back over upstream issue **projecttacoma/fqm-execution#371** and our PR **#372** against the
running engine rather than the spec, prompted by a review question — is there a simpler fix using `<`
instead of `<=`, and why `.999`? It turned up more than it was looking for.

**`.999` is not an approximation, and the half-open alternative is not simpler.** Measured against
`cql-execution` 3.3.2: millisecond is the finest field its `DateTime` carries,
`normalizeMillisecondsField` truncates anything finer **downward** (`.9999` becomes `999`), and
`successor(23:59:59.999)` is the next midnight — so `.999` is the last representable instant of the
day, with no gap for anything to fall into. The half-open form `[start, next-day)` behaves identically
**and yields the same `.999`**, because `Interval.end()` calls `toClosed()`, which applies
`predecessor()`. The most CQL-pure option — keeping day precision on the boundary — returns **null for
everything**, including a date obviously outside the period, so it would turn every `during` comparison
null. Four designs, one table, all four run rather than reasoned about.

**Three defects, where the issue reported one.** (1) The PR only matched `YYYY-MM-DD`, but the option's
README documents partial dates too — `2019-12` resolved to December *1st* and `2019` to January 1st,
losing 31 and 364 days rather than one. (2) `DataRequirementHelpers.createIntervalFromEndpoints` routes
through the fixed function only when **both** endpoints are given; its end-only branch parses the end
directly and had the same bug in a place the first fix cannot reach. (3) `parseTimeStringAsUTC` parses
with `moment.defaultFormatUtc` — no fractional-second token, and a *literal* trailing Z — so it
**silently drops milliseconds and ignores a non-UTC offset** (`08:30:00+02:00` read as `08:30:00Z`, a
two-hour error). (1) and (2) are fixed in #372; (3) is filed as **#376** rather than bundled, because it
hits the period *start* and every other caller of that function.

**The finding that lands on us: our own workaround does not do what its comment says.**
`normalizePeriodEnd` appends `T23:59:59.999Z`, and fqm drops the milliseconds on arrival — the effective
boundary is `23:59:59.000Z`. Our 121/121 against the MADiE decks holds because the deck's boundary
Procedure sits at exactly `23:59:59Z`; at `23:59:59.500Z` it would have failed and this would have been
a different issue. The docblock now records the measured behaviour instead of the intended one, and
states the consequence: **delete the function when #372 lands, do not keep it** — the string it produces
is not date-only, so it would bypass the new branch and stay a millisecond short of the fix. Also
recorded upstream: `parseTimeStringAsUTCConvertingToEndOfYear` has no call sites anywhere in that
repository, and its `add(1,'years').subtract(1,'seconds')` idiom lands 999 ms short of the year it
names — the helper I originally modelled ours on was both dead and subtly wrong.

Upstream verification on the rebased branch: `npm run check` (484 unit tests, up from 477) and
`npm run test:integration` (46) both pass.

## 2026-08-10 — CodeQL and Dependabot, with four dependencies held back on purpose (branch `chore/security-scanning`)

Neither was running. Checked rather than assumed: `code-scanning/default-setup` reported
`not-configured` with no analysis ever recorded, the Dependabot alerts API returned "disabled for
this repository", and there was no `.github/dependabot.yml`. The only two mentions of Dependabot
anywhere in the tree were `ci.yml` comments explaining how the VSAC-credentialed steps degrade when
GitHub withholds a secret from a fork or Dependabot PR — so the CI had been written to tolerate
Dependabot for months without Dependabot existing.

**Enabled in repository settings:** CodeQL default setup over `actions` and `javascript-typescript`
(the workflows matter as much as the sources here — eight of them, and the deploy and publish jobs
hold registry, Neon, VSAC and npm credentials), and Dependabot vulnerability alerts repo-wide.
Automated security *fixes* are deliberately left off: an auto-opened PR against one of the four
dependencies below is exactly the case that wants a human deciding, and alerts already surface it.

**`.github/dependabot.yml`, scoped rather than blanket.** Weekly PRs for GitHub Actions, `frontend`
and `wcdb-fhir-shim` (`e2e` monthly), with dev-dependency minor/patch grouped so the PR count stays
low. Four dependencies are bumped only deliberately —
`@cqframework/cql`, `cql-execution`, `cql-exec-fhir`, `fqm-execution` — and the reason is the one
worth recording: their versions are *inputs to published numbers*, so a bump can pass the whole suite
and still make a committed claim untrue. `compile-measures` runs by hand rather than in CI (#410), so
a translator bump does not regenerate the ELM it produced; `cql-execution` + `cql-exec-fhir` are the
entire manifest of the published `@work-well/measure-engine`, making any change a semver event for
people outside this repository; and the 410/410 MADiE gate was measured against `fqm-execution` 1.8.5
exactly. All four still raise alerts.

**Review turned a hedge into a measurement, and the answer changed the file.** The first draft
carried a `backend-ts` entry with the workspace question written down as unverified — its pnpm
workspace takes five `workspace:*` members from `../external/mieweb-cloud/packages/*`, a git
submodule stored as a bare gitlink, and Dependabot's npm updater does not initialize submodules.
Codex reproduced it; so did a fresh clone here with the submodule uninitialized:
`pnpm -C backend-ts update typescript --lockfile-only` exits 1 with
`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` for `@mieweb/cli`, at workspace resolution, before any registry
dependency is considered. So it is not "might not work" — it can never work, and every scheduled run
would error. The entry is **deleted**, with the reproduction recorded in the file so nobody re-adds
it on the theory that Dependabot might cope. A permanently erroring updater is the vacuous-guard
shape again: it reads as coverage in the config while proposing nothing.
Consequence stated plainly: backend-ts gets alerts (demonstrated — 16 of the first 104 came from
`backend-ts/pnpm-lock.yaml`) but no routine version PRs, and its four load-bearing dependencies now
have no `ignore:` list because there is no updater to ignore them; the rule survives as a
hand-bumping policy in `CONTRIBUTING.md` and as a day-one requirement on any future entry.

**First scan, reported not fixed.** CodeQL: 27 open alerts, the largest group **12 ×
`actions/missing-workflow-permissions`** — workflows with no explicit `permissions:` block, which is
exactly the class scanning `actions` was enabled to catch. One high sits in a *published* package
(`js/polynomial-redos`, `measure-engine/src/cql/vsac-client.ts`); three are `js/stack-trace-exposure`
on route handlers; seven more highs are `includes()` assertions inside test files. Dependabot: 104
alerts, and **`next` 16.2.4 accounts for 44 of them**, patching at 16.2.5 / 16.2.6 / 16.2.11 — one
patch-level bump. None fixed here; one theme per PR. Filed as #412 (next), #413 (workflow
permissions), #414 (the published-package ReDoS) and #415 (stack-trace exposure, filed as review
rather than fix — how much diagnostic detail an API should return is a contract decision, not a
find-and-replace).

**#412 done: next 16.2.4 → 16.2.11.** The interesting part is the lockfile. `pnpm up next@16.2.11`
re-resolved the whole transitive tree — 1,184 lines, dragging `@babel/*` 7.29.0 → 7.29.7 and
`@typescript-eslint` 8.59.1 → 8.67.0 along with it, which is a great deal of unrelated surface to
accept in the name of a security patch. Editing `package.json` by hand and running
`pnpm install --lockfile-only` produces **119 lines**: `@next/*` 16.2.4 → 16.2.11 and a single
dedupe (`@babel/parser` 7.29.2 was reachable only through the old next chain). Same fix, a tenth of
the blast radius, and a diff a reviewer can actually read. Verified with `--frozen-lockfile` (the
gate CI applies), lint, 180 tests across 35 files, and a production build.

**#413 done: every job in every workflow now declares its permissions.** The count was **13**, not
the 12 first reported — eight jobs in `ci.yml`, the two deploy jobs in each of the TWH and staging
workflows, and the deploy job in the redirect workflow. The pattern is consistent and worth naming:
in all three deploy workflows the BUILD jobs already declared `contents: read` + `packages: write`,
because pushing to ghcr forced the question, while the DEPLOY jobs beside them declared nothing and
inherited the repository default — so the jobs holding the Create-a-Container API key were the ones
running unscoped. `ci.yml` uses no `GITHUB_TOKEN` at all (verified: no `gh` call, no registry push,
no commit back), so `contents: read` at workflow level covers all eight; declaring it there rather
than per job means a job added later inherits the floor instead of silently taking whatever the
default grants. The trap, written into each file: a job-level block **replaces** the workflow-level
one rather than extending it, which is why the build jobs must keep restating `contents: read`
beside `packages: write`. `publish-packages.yml` was deliberately not touched — its `id-token:
write` is what signs the sigstore provenance attestations (ADR-063), and narrowing it would publish
without provenance rather than fail.

**#414 done: the ReDoS in the published package, fixed and mutation-checked.**
`cfg.baseUrl.replace(/\/+$/, "")` in `measure-engine/src/cql/vsac-client.ts` is quadratic on a long
run of slashes that is *not* at the end — the engine consumes the whole run from every start
position, then fails `$`. Replaced with a backwards scan. **The severity claim is deliberately
downgraded rather than inflated:** the input is a config value the consumer supplies when
constructing the client, not request data, so reaching it means configuring your own VSAC base URL
with tens of thousands of slashes. It is fixed because the file ships inside
`@work-well/measure-engine` and the alert therefore appears in the scan of anyone who installs it —
a one-line loop is cheaper than that conversation. **Mutation-checked both ways**, which is the only
reason the regression test is worth having: with the regex restored, the timing test fails at
**5,486 ms** on a 100k-slash input while the behavioural trimming test still passes — so the timing
assertion is the one carrying the fix, and the bound (1,000 ms against an observed 0.5 ms) is about
1,000× the real cost, far too wide to flake on a slow runner.

**Triage corrected: 3 of the 10 alerts I called test-file noise were real.** The claim was "seven
highs are `includes()` assertions inside test files" — true of seven, and the remaining three were
lumped in with them without being read. Reading them:

- **`js/useless-regexp-character-escape`** (`routes/measures.test.ts`) is the interesting one, and
  it is the vacuous-guard shape in miniature. The filename assertion built its regex from a
  **template literal** containing a single-backslash dot — and there, that is not an escaped dot.
  JS drops the backslash, so the regex received a bare `.` and the assertion also passed for
  `matXxml`. Verified by evaluating both forms: before, `matXxml` matched; after doubling the
  backslash, it does not. An assertion weaker than it reads.
- **`js/identity-replacement`** (`vendor-workflow-safety.test.ts`) was a `.replace(":", ":")` —
  a no-op left over from an escaping intent that regex never needed. Deleted.
- **`js/incomplete-sanitization`** (`standards/official-cases.ts`) — `escapeMarkdown` escaped `|`
  but not `\`, so a value ending in a backslash turned `\|` into `\\|`: a literal backslash renders
  and the pipe closes the cell, silently giving the table an extra column. Backslash is now escaped
  first. **No committed report changes** — only engine/loader error text reaches that function, and
  the one backslash in the current report is a static PowerShell path in the template.

Only the other **seven** are genuinely false positives: assertions like
`report.measure.includes("madie.cms.gov")` checking our own emitted canonical, and one array
`.includes` CodeQL read as a URL substring check. Dismissed as used-in-tests rather than left to
make the Security tab a wall nobody reads.

**The five GitHub Actions majors, taken as one change rather than five Dependabot PRs.**
`actions/checkout` v4→v7, `setup-node` v4→v7, `cache` v4→v6, `upload-artifact` v4→v7 and
`docker/setup-buildx-action` v3→v4. Merging them one at a time would have meant five rebases and
five full CI runs over the same lines. **Both classes of breaking change were checked against this
repository rather than assumed away.** Every major in the set is really "now runs on the Node 24
runtime, requires Actions Runner 2.327.1+" — which cannot bite here because every job runs on
GitHub-hosted `ubuntu-latest`, verified across all 24 `runs-on:` lines. The one substantive change
is `checkout` v6's safer `pull_request_target` default, where it stops checking out the PR head
unless `allow-unsafe-pr-checkout` is set; `pull_request_target` appears in **zero** workflows here,
so it does not apply either. The deploy workflows are not exercised by PR CI, but
`deploy-twh-mieweb.yml` runs on push to main, so the merge itself is the test.

## 2026-08-10 — the documentation restructure: docs/guide/ is born, the archive absorbs the rest (branch `docs/doug-doc-restructure`)

ADR-066. The owner directive after the 2026-08-08 walkthrough session: trim the redundant docs and
maintain one clear, diagrammed explanation of everything — CQL, authoring, AST/ELM, FHIR, the
packages, the engine, the compiler, the dependencies, SQL and the CQL→SQL goal, the databases, the
data sources — plus current state and future.

**Built: `docs/guide/`, ten chapters, 21 mermaid diagrams.** Sourced from the 2026-08-08 system
walkthrough (which was never committed — it is now, in `docs/archive/`) and the meeting artifact,
whose compiler-pipeline material (ELM as the intermediate representation, the 26-node-type
taxonomy, the rewriting-vs-lowering distinction, the three places the analogy breaks) existed
nowhere in the repo. Four gaps were written fresh because neither source covered them: the Rule
Builder → YAML `rule:` → `generateCql` mechanics (with the fact that the hand-written `.cql` stays
the build source and the generated file is the parity artifact), an ELM node reference built from
the real committed `AnnualAudiogramCompleted` tree, a FHIR primer for a FHIR-naive reader, and the
SQLite-floor/Pg-ceiling store factory. Chapter 9 owns every volatile number, dated, with its
reproducing command — the suite figure (1,940 / 1,925 / 0 / 15) is from the 2026-08-08 run, not
copied from memory.

**Trimmed: top-level `docs/` from 47 markdown files to 20 tracked, all live.** 23 files and five
directories moved to `docs/archive/` (nothing deleted): the three superseded roadmaps,
`CQF_FHIR_CR_REFERENCE.md` (also dropped from CLAUDE.md's always-loaded imports — its stop
condition died with the JVM in #109 PR4), five overlapping demo docs, the May-era
`WALKTHROUGH_GUIDE.md`, the dated research/QA/strategy snapshots, both source PDFs, `sprints/`,
`superpowers/{plans,specs}`, `new instructions/`, `FABLE_REVIEW_2026-07-02/` and
`mieweb-ui-migration/`. `OFFICIAL_TESTCASE_REPORT_2026-07.md` went to `docs/evidence/` instead —
CI regenerates it and `official-gate.test.ts` reads it, so those paths moved in the same change
(the one non-docs edit class in the PR, tightly coupled by definition). Live cross-references
updated in place; `JOURNAL`/`DECISIONS`/`CHANGELOG` keep their historical wording. A false alarm
worth recording: the three meeting-transcript `.txt` files and the vision-doc screenshots looked
committed but were already gitignored and untracked — the local-only rule was never violated.

**Rewired:** README's documentation map leads with the guide; `ARCHITECTURE.md` got its light pass
(the `com.workwell.*` §3 heading finally renamed, a header pointing readers at the guide);
CLAUDE.md's doc lists updated (guide added to the Definition of Done's affected-docs list);
ADR-066 recorded; ADR_INDEX regenerated.

**Review caught the difference between a link that resolves and an instruction that is true.** The
first sweep repointed `CONTRIBUTING.md`'s sprints link to `docs/archive/sprints/README.md`, so the
404 was gone — but the sentence around it still told a new contributor to pick their next task out
of a directory where sprints 0–7 are all merged, which `AGENTS.md` had already called history and
not a queue. Two files, two answers. "Before you start" now leads with the guide and the roadmap
and names the archive as context; the branch convention lost its `feat/sprint-1-<slug>` form, which
had been disagreeing with CLAUDE.md's `feat/<slug>` since the sprints closed; and the PR checklist
names the affected guide chapter, matching the Definition of Done this PR added. The general shape
is worth keeping: a mechanical path fix leaves the prose asserting whatever it asserted before, and
only the prose says whether the destination is somewhere a reader should go.

## 2026-08-07 (M-E1) — the first occupational measure: OSHA Standard Threshold Shift (branch `feat/me1-osha-hearing-sts`)

ADR-065. Traceability: `docs/measures/OSHA_1910_95_STS.md`. Answers #405.

**The differentiator is now evidenced, not asserted.** Zero occupational-health quality measures exist
across the 2026 CMS eligible-clinician eCQMs (49), hospital eCQMs (17), HEDIS MY2026 (93), every public
`.cql` file on GitHub, the `cqframework` organisation, or the HL7 FHIR IG registry. Two near-misses are
not counter-examples: CBE #0431 healthcare-personnel influenza vaccination is an **NHSN aggregate
facility report**, and the 25 CSTE/NIOSH Occupational Health Indicators are **state-workforce
surveillance counts** sourced from discharge and workers-comp data. The field has *indicators* — what
already happened, across a population — and no *measures*: what should happen to a named worker by a
named date.

**#405's oracle question is answered, and it reframes rather than picks.** For a measure with no
official definition the author of the CQL is also the author of the test cases; such measures never
enter the authoring or certification pipeline at all. That is the normal state, not a compromise. What
converts author-owned content into *credible* content is the community route — publishing the measure
and its cases in the standard shape, with the documentation that lets an organisation act as steward.
So the deliverable is **a measure packaged so it could be stewarded**, not one that passes an external
check that does not exist.

**Scope is ONE obligation.** 1910.95 creates several with different triggers, deadlines and evidence;
a single "hearing conservation compliance" percentage would hide partial failure — a programme could
refit every worker and notify none and still score well. This implements STS detection `(g)(10)(i)`,
the one fully computable from clinical data, and the traceability doc lists the others as explicitly
not implemented with a reason each. **`(g)(8)(i)`'s 21-day notification is NOT COMPUTABLE at all** —
its clock starts at the *determination*, and OSHA has stated the standard sets no limit between the
audiogram and that determination.

**Real terminology, and one thing that did not need inventing.** LOINC panel **89015-2**, whose 22
codes are all members of `us-core-clinical-test-codes` — an audiogram already has a US-Core-conformant
FHIR representation. (`100653-5`, which search results offer, is **deprecated**.) The cohort is the one
exception and cannot be otherwise: `(c)(1)`'s trigger is an 8-hour TWA at or above 85 dBA, an
industrial-hygiene measurement absent from every clinical feed. ICD-10-CM **Z57.0** is a documented
proxy — structurally the ADR-042 `us-core-sex` gap again.

**Where the regulation is discretionary, the measure refuses rather than defaulting silently.** Age
correction is optional under `(g)(10)(ii)`, Appendix F is informational only, and OSHA has permitted
tables from other datasets — so **two employers can lawfully reach opposite conclusions on identical
audiograms**. STS is a function of the audiogram *and employer policy*. None is applied, which detects
more workers and is the protective direction, said where a reader sees it.

**Four defects, all found by review rather than by the happy path.** Two by my own adversarial tests:
`Determinable` used OR across ears, so a worker with an incomplete right ear and a clean left one
returned COMPLIANT — improving the apparent rate by absorbing the people whose data is incomplete;
and `Overdue` had no initial-population gate, reporting OVERDUE for a worker with no noise exposure.
Two by code review (#408): the exclusion was **permanent** — a worker excused for a 2019 shift had
every later shift suppressed, which is silent under-detection; and non-final Observations were
accepted, so one `entered-in-error` row could re-anchor the baseline for every future shift, the
baseline being the earliest record.

**It is deliberately NOT in the measure registry.** Registering it would put it in
`RUNNABLE_MEASURE_IDS` and every population run, where the synthetic corpus cannot produce two dated
audiograms carrying six LOINC thresholds each — **the first authored measure the rule-params codegen
cannot express**, that template being a recency window. It is verified through the engine's consumer
path, `evaluate({ elm, metaOverride })`, the same surface an external integrator uses.

**`STANDARDS_CONFORMANCE.md` gains a section** so the M-A/M-B verification language cannot carry over
by association: never "OSHA-conformant" or "OSHA-validated" — **OSHA does not certify software** — and
never a legal determination. It is a surveillance aid.

**Named and not done:** independent re-derivation by a second author from the CFR alone, which is the
strongest verification available here. Also: corpus generation so the measure can join the roster, and
the `1904.10` recordability rule (an STS **and** a 25 dB total level, age correction permitted for the
first test and forbidden for the second).

**Review then found four more, three of them the same under-detection.** Baseline/current dates were
derived from **both ears combined**, so an unrelated right-ear-only recheck nulled the left ear's
average and made a **confirmed left-ear shift vanish** — under-detection caused by data *arriving*;
dates are now per ear. The exclusion was **permanent**. Non-final Observations could anchor the
baseline. And `Numerator` was not conjoined with `Denominator`, so it was true outside the initial
population — latent in the app under ADR-031, not latent for the IG publication ADR-065 describes.
Duplicate thresholds now refuse rather than resolving by bundle order; an unexpected unit is refused
rather than coerced.

**Three documentation corrections on a traceability document**, which is where they matter most: the
`(g)(8)(ii)` chapeau says "Unless a **physician** determines", not "physician or audiologist";
`(g)(9)`'s per-ear baseline revision is an OSHA interpretation rather than CFR text; and **the LOINC
codes do not encode conduction method** — the bone-conduction panel shares the same 22 members, so a
bare Observation is ambiguous between air and bone. That is now a stated limitation.

Suite 1940, 0 fail (+19). Typecheck clean. `compile-measures` emits 17 libraries.


## 2026-08-07 — `@work-well/measure-engine@0.1.0` and `@work-well/measure-codegen@0.1.0` are published

Dispatched `publish-packages.yml` dry-run first, read the packed file lists, then for real. Both are on
the public registry with **SLSA provenance** (`slsa.dev/provenance/v1`) signed by GitHub Actions and
recorded in sigstore's transparency log.

| | files | unpacked | dependencies |
|---|---|---|---|
| `@work-well/measure-engine@0.1.0` | 59 | 134 kB | `cql-execution`, `cql-exec-fhir` |
| `@work-well/measure-codegen@0.1.0` | 13 | 51 kB | none |

**The tarball contents are the ADR-059 claim made visible**: `dist/` + `src/` + README + LICENSE, no test
files, and **no measure content** — no catalog, no ELM, no value-set expansions.

**Verified the way that matters, not by the workflow's exit code.** Installed both from npm into an empty
directory — no workspace, no clone — and evaluated `example-consumer`'s measure there: COMPLIANT, OVERDUE,
and `unknown measure 'audiogram'`, with codegen emitting CQL. **That discharges ADR-062's caveat** —
`example-consumer` said in its own README that it was a consumer outside the *app*, not the *repo*. It is
now outside the repo, against the real registry.

**Two traps, both recorded in the workflow header because either will mislead the next person.** The
**dry run never exercises `NPM_TOKEN`** — it stops before the publish step, so a mis-scoped token passes
it and fails the real run. And the **registry is not immediately consistent**: `npm view` returned 404 for
several minutes after a publish that had already succeeded and signed provenance. I read that 404 as
evidence of npm's staged-packages flow and sent the owner to an empty Staged Packages page; the packages
simply had not propagated. The log line to trust is `+ @work-well/<pkg>@<version>`.

**Named, not done:** npm is restricting 2FA-bypass tokens for direct publishing (deprecation notice in the
publish log). The replacement is **Trusted Publishing** via OIDC — the workflow already has
`id-token: write`, so migrating would delete `NPM_TOKEN` outright.

**A re-run at an unchanged version will now fail** — npm never permits reusing a version number — so a
release begins with a version bump. Recorded in the workflow header and `docs/PACKAGES.md`.

## 2026-08-06 — the npm scope is `@work-well`, because `@workwell` was never obtainable (branch `chore/npm-scope-work-well`)

ADR-063 amendment + `LOCKED_DECISIONS.md` §4.5 note. **The `work-well` org exists and `NPM_TOKEN` is
set; nothing is published yet.**

**The cause.** An unrelated unscoped package named `workwell` already exists on npm, and npm refuses an
**org** name that collides with an existing **package** name. The org could not be created, which is how
this surfaced — in the owner's browser, at org-creation time.

**My pre-flight check was wrong in a way worth keeping.** It verified `@workwell/measure-engine` (404),
the `scope:workwell` registry search (empty) and `registry.npmjs.org/-/org/workwell` (404), and concluded
the scope was unclaimed. All three were true and **none is the gate** — `registry.npmjs.org/workwell`
returns **200**. Nothing a test could reach; the same shape as ADR-063's other finding, a check cited for
more than it covers. Hyphen not underscore: npm scopes conventionally use hyphens and `@work_well` reads
as a typo in an install command.

**The decision did not change** — a neutral scope rather than `@mieweb/*` — only the spelling, so
LOCKED_DECISIONS §4.5 and ADR-063 carry the reason rather than being silently rewritten.

**Deliberately untouched:** `nurse@workwell.test` email domains and `urn:workwell:*` identifiers. They
are not the npm scope, and ADR-046 makes the urn form load-bearing for authored-measure identity.

**Three things the rename missed, each found by a different mechanism, and all the same shape — a sweep
narrower than the claim it was cited for.**

1. **A guard caught the first.** `fqm-isolation.test.ts` writes the specifier as an escaped regex
   (`@workwell\/official-executor`), so `@workwell/` did not match; test 5/5 — the ADR-026 quarantine
   door — failed with an **empty importer list** rather than passing vacuously. The one place in the diff
   where a silent miss would have mattered.
2. **Review caught the second.** Bare `@workwell` with no trailing slash survived in
   `publish-packages.yml`'s owner steps, which instructed the owner to create an org npm refuses. A sweep
   for the class then found **three more in CLAUDE.md** that review had not flagged.
3. **Review caught the third, and it is the one I should have known better than to do.** The sed rewrote
   **every dated JOURNAL entry back to 2026-07-24**, making the 2026-08-05 entry claim `@work-well/*` was
   that day's owner call. It was not. I had been careful not to rewrite LOCKED_DECISIONS for exactly this
   reason and then did it to the journal by machine. The file is restored to its pre-rename state; this
   entry is the record instead.

**Also fixed, and larger than a spelling change:** `publish-packages.yml`'s header said the workflow
"cannot succeed today" because the scope and token do not exist. Both are now false. It also now states
what the dry run does **not** do — it stops before the publish step, so it never exercises `NPM_TOKEN`,
and a token whose scope selection misses `@work-well` passes the dry run and fails the real one.

**CI silently ran nothing on the PR.** `ci.yml`'s push trigger did not list `chore/**`, so the branch got
zero checks — and "no checks" is visually identical to "nothing to run". `chore/**` and `docs/**` added,
with the hazard named in a comment; the list stays explicit because `official-cases` clones ~34 MB and can
take 20 minutes.

Suite 1921, 0 fail. `pnpm verify:publish` green under the new scope.

## 2026-08-05 (#397) — the translator gets a UCUM service, and the defect's whole interest is how it hid (branch `fix/ucum-translator-service`)

ADR-064. Closes #397, the follow-up ADR-060 named and deliberately did not bundle.

**The defect.** `LibraryManager` takes the UCUM service as its **fourth** argument and defaults to one
that *throws*. We passed three. So no CQL with a quantity literal could translate — and the surface was
the Studio's ELM Explorer, which recompiles as you type: an author writing valid unit-bearing CQL got an
error naming a missing service rather than anything about their code.

**How it hid, which is the part worth keeping.** It was invisible to the entire suite **and** to
`pnpm compile-measures`, because no committed measure uses a unit. Every gate green, feature broken. It
surfaced only when the V7 harness ran CQL somebody else wrote — 155 of 183 apparent translation errors —
and was nearly published as "the JS translator delta". **A defect only third-party content can reach is
the standing argument for running third-party content.**

**One validator, three call sites.** `src/measure/ucum.ts` now serves the runtime translator, the
build-time compiler and the harness. They must agree: a measure that compiles at build time and fails in
the authoring UI, or the reverse, is a defect invisible from either side. It left `scripts/` because it is
production code now, and `compile-measures` moved to `node --import tsx` to import it (gen-cql's
precedent; bare `node` now fails and the header says so).

**Not in `@workwell/measure-engine`** — UCUM validation is translation-time and the engine never
translates. Adding it would grow the surface of a package whose whole claim is a two-dependency manifest,
for a consumer that cannot use it.

**An honest table, not a dependency, erring toward rejection.** Full UCUM is a new dep and therefore an
owner call. Now that this gates authoring the direction of the error matters, and refusing an unrecognized
atom is the safe one: a false rejection is a visible complaint an author reports; a false acceptance lets
bad CQL through the gate and shows up later as a wrong number.

**`NO_UCUM_SERVICE` keeps the before-state reachable.** Production never passes it; the regression test
asserts the same library compiles under the default and **fails** under it. A fix nobody can watch fail is
a fix nobody can verify — and this codebase has now caught three guards that could not fire.

**Review found three defects in the table, two of them the exact directions the ADR weighs.** A false
REJECTION — `mg/(kg.d)`, an ordinary dose rate, split into `["mg", "(kg", "d)"]` by a regex; parenthesised
subterms are now parsed recursively, which also fixed a **leading solidus** (`/min`, `/uL`) nobody
reported. And two false ACCEPTANCES: `m[lb_av]` validated because `m` is a prefix and `[lb_av]` an atom,
but UCUM prefixes attach to **metric** atoms only and there is no millipound (the table is now split
metric/non-metric; `mmHg` removed as not-a-UCUM-symbol, `mm[Hg]` being milli + `m[Hg]`); and `mg / dL`
passed because each component was trimmed. **One review point was wrong and is refused with the grammar
cited:** repeated `/` is legal — `<term>` is left-recursive, so `mg/kg/d` is `(mg/kg)/d` — and "fixing" it
would have added a fourth false rejection. Pinned as a test. Writing the tests then caught a defect of my
own: the leading-solidus allowance applied recursively accepted the empty group `mg/()`.

**Verified:** `pnpm compile-measures` **byte-identical** (16 measures + FHIRHelpers, nothing moved);
conformance unchanged (1622 pass, 213 known non-passing, no regressions); a unit-free library compiles to
identical ELM with and without the service, which is what licenses calling this inert for the existing
tree. 7 new tests.

## 2026-08-05 (M-C / C4) — a package is publishable when its tarball runs outside the workspace, not when it is published (branch `feat/mc-c4-package-publishing`)

ADR-063. **M-C is complete.** Scope stays neutral `@workwell/*` (owner call this session); pitching Doug
on `@mieweb/*` remains a later option, and it is cheap to defer precisely because there are no external
consumers yet.

**The gap C4 exists to close.** C1's proof was an import graph and C2's was a `workspace:*` consumer —
both claims about the *source tree*. `example-consumer`'s own README says it is a consumer outside the
**app**, not outside the **repo**. So everything the workspace supplies for free was untested: whether
`files` ships what the code needs, whether the declared `dependencies` suffice, whether the emitted
JavaScript resolves at all without `moduleResolution: Bundler` and `allowImportingTsExtensions`. Each of
those fails silently in-repo and loudly for the first integrator.

**`pnpm verify:publish` is the answer, and it runs on every PR** (CI's `packages` job). It packs real
tarballs, installs them into a temp directory under the OS temp dir with a plain `npm install` and no
knowledge of this repo, then runs the engine there on `example-consumer`'s measure content — COMPLIANT,
OVERDUE, and `audiogram` still unknown — and typechecks a TypeScript consumer against the packed
declarations under `moduleResolution: node16`. Reusing the C2 content rather than inventing a second toy
measure keeps both proofs about the same artifact.

**`publishConfig` keeps the two resolutions apart.** In the tree, `exports` names `src/index.ts`, so
`pnpm typecheck` checks real sources and a change reaches the app with no build step; at pack time pnpm
rewrites `exports`/`types`/`main` to `dist/`. Worth recording because it fixes the package manager:
`publishConfig` field rewriting is a **pnpm** feature — npm understands only `registry`, `access` and
`tag`, so `npm pack` would ship a manifest still pointing at `src/*.ts`.

**A claim of mine that measurement killed.** `rewriteRelativeImportExtensions` rewrites `./x.ts` → `./x.js`
in emitted JS but not in emitted `.d.ts`. I built a post-pass and wrote that the TypeScript consumer check
was what caught it. Mutation-checking that — disabling the rewrite — showed **step 5 still passes**: `tsc`
substitutes `.ts` → `.d.ts` when resolving and finds the declaration beside it, so TypeScript consumers
were never broken. The post-pass stays (the specifiers are false on their face and only work by a
TypeScript-specific rule that non-`tsc` declaration readers do not implement) but is documented as
defensive, not as a bug fix. The assertion with teeth is the one covering **`.js`**, where dropping the
flag breaks every consumer at runtime — and that one was mutation-checked as firing, naming 6 files. Same
guard-scope shape as #380 and #400: a check cited for more than it covers, caught this time before it was
published rather than after.

**Two guards fired for real while building.** The tarball first shipped six `*.test.ts` files (`files:
["src"]` sweeps them in) — now `!src/**/*.test.ts`. And the packed-manifest check reads `package.json` back
*out of the tarball*, because `publishConfig` is applied at pack time and a typo there leaves `exports`
pointing at source with nothing else to notice.

**Nothing is published, and the docs say so.** `publish-packages.yml` is `workflow_dispatch` only,
defaults to a dry run, and refuses without `NPM_TOKEN`; it cannot succeed today because the `@workwell`
scope does not exist. ADR-041's pattern — inert until the owner creates the secret, owner steps written
into the file header. `official-executor` is deliberately **not** publishable: it is the sole home of
`fqm-execution` and the package boundary *is* the ADR-026 quarantine.

**`docs/PACKAGES.md` carries the positioning and the semver policy.** *Composes `fqm-execution`, does not
compete with it* — and the evidence is our own routing, since official CMS eCQMs run on `fqm-execution` in
production (ADR-045/046) because *run the official published CQL, never reauthor* is a standing rule. **No
performance or conformance comparison against `fqm-execution` has been run, so none is claimed.** Semver is
pre-1.0 with a stricter-than-standard reading (removals and semantic changes take the minor, so a patch
never breaks you; pin `~0.1.0`), and 1.0 is gated on a consumer outside MIE rather than on a date.

Suite 1910, 0 fail (+5, the rewrite's precision tests). Typecheck clean. `pnpm verify:publish` green.

## 2026-08-05 (M-C / C2) — codegen leaves the engine, and a consumer that shares no code with the app proves the split worked (branch `feat/measure-codegen-and-consumer`)

Two packages, ADR-062. C4 (publish) is the only piece of M-C left.

**`@workwell/measure-codegen` — zero dependencies.** `generate-cql.ts` has **zero imports**, so it never
shared code with the engine, only a directory. The engine answers *"is this patient compliant?"* from
compiled ELM; codegen answers *"what CQL expresses this rule?"*. Authoring-time versus runtime. A consumer
evaluating measures should not have to take a CQL emitter, and a browser-side rule builder should not have
to take a CQL runtime — being dependency-free, this one runs in a browser.

**`@workwell/example-consumer` — a test, not a sample.** ADR-059's boundary test proves the engine imports
no WorkWell content; that is a claim about the *source tree*, not about whether the package is usable by
someone who has none. So this package pretends to be that someone: one dependency, its own measure
(`tetanus-booster.cql` + the ELM compiled from it, neither referenced by the app), its own FHIR bundle. It
asserts all three of its own outcomes and that `audiogram` is **unknown** to it. If the engine ever
re-acquires our catalog, this stops evaluating.

**Building it found an API fact no document stated:** `CqlExecutionEngine`'s constructor loads
`FHIRHelpers-4.0.1` eagerly, so **every** consumer must supply it or construction throws. Found by writing
the consumer, not by reading the API — which is the whole argument for building one rather than asserting
consumability in prose. Now its own test.

**The limitation is stated, not glossed:** it resolves through `workspace:*`, so it is a consumer *outside
the app*, not outside the repo. Whether the published tarball contains what a consumer needs is C4's
question.

**The boundary guard did its job unprompted.** Moving codegen made `src/engine/cql/codegen/generate-sql.ts`
import a package its allowlist did not declare, and `engine-boundary.test.ts` failed immediately. The
allowlist gained the entry with its reason — that file validates a rule before templating SQL; it emits
text, it never evaluates. Also removed one of my own vacuous assertions in the new consumer test
(`.constructor.name === "Promise"` — an assertion about JavaScript, not about this codebase).

**Review found the one thing the move broke, and the reason nothing caught it** (#400). `scripts/gen-cql.mjs`
still imported `generateCql` from the engine, so `pnpm gen-cql` would have thrown. The codemod walked `.ts`
only — but the deeper problem is that **no guard could have seen it**: `tsc` does not typecheck `.mjs`, and
`measure-engine-api.test.ts`, whose entire job is checking that imported names are exported, walked `.ts`
under `src/` only. An API check that inspects only what the compiler already checks is checking the wrong
half. It now covers `scripts/` and `.mjs`/`.js`, and asserts it saw at least one.

Suite **1885 → 1890**, 0 fail.

## 2026-08-05 (M-C / C3) — the compliance API exists, and it refuses to answer an absence (branch `feat/compliance-api`)

`GET /api/v1/compliance/{subject}/{measure}?start&end&mode=latest|preview` — locked decision 5's *"contract
MIE consumes"*, and Doug's question shape verbatim. ADR-061; documented as a contract in
`docs/COMPLIANCE_API.md` with a stability statement.

**Three surfaces nearly answered this already and none was a contract:** the roster grid is a UI read model
shaped by the frontend, MCP's `check_compliance` is Claude-facing and role-gated, and a run answers for a
population and writes records. C1 made the engine constructible without our content; this makes it
consumable.

**The design decision that carries the most weight is `populationsSource`.** The owner chose an eCQM-native
response — population membership booleans, not a bare status. But for a WorkWell-**authored** measure only
`initialPopulation` is measured; the other four are *inferred from `OutcomeStatus`*. Nothing in the numbers
distinguishes that from an official artifact's own population vector, so the response names its own source,
read off the **same field** `membershipFor` branches on — the label cannot disagree with the numbers it
describes.

**`latest` with nothing persisted is a 404, not an empty 200.** "No run has covered this subject" and "this
subject is compliant" must never be confusable; the body says which absence it is and points at `preview`.
That is the single easiest way to make a compliance API dangerous.

**No second evidence reader.** `membershipFor` and `officialReportIdentity` are the same functions the
MeasureReport and QRDA III exporters use. A new API is exactly where a second reader gets written by
accident, and ADR-031 exists because two readers that can disagree is a defect class. The load-bearing test
asserts the API's population block agrees with `buildIndividualMeasureReport` **for the same record**,
against the exporter's real output rather than a hand-written expectation.

**A plan correction worth recording, because it inverted a security claim.** The plan said `authorize.ts`
falls through to *permit* and that a new rule was therefore mandatory. Verified false: `RULES` ends with a
generic `/api/**` → `AUTHENTICATED` pair, so the route was already gated and the permit default applies
only to non-`/api` paths. No rule added; a test asserts the 401 anyway, since `RULES` is first-match-wins
and this route returns per-subject clinical status.

`preview` routes through `routedEngineForEnv` and composes its bundle the way the run pipeline's EMPLOYEE
scope does, so preview and a run see identical input — and a test asserts a preview writes **nothing**
rather than trusting the `persisted: false` label. 13 route tests; suite **1876 → 1892**, 0 fail.

## 2026-08-05 (M-C / V7) — the CQL conformance suite runs, and the first number it produced was 15× wrong in our favour (branch `feat/cql-conformance-harness`)

**1,835 cases / 16 files / 11 seconds: 1,622 pass · 155 fail · 12 translation-error · 4 runtime-error ·
11 invalid-refused · 31 invalid-accepted · 0 skipped — and 1,633 on the upstream rule.** Issue #296, open since 2026-07-15, closed. Full
write-up in `docs/evidence/CQL_TESTS_2026-08-05.md`; the decisions are ADR-060.

**Why this suite and not more tests generally.** `cql-execution` 3.3.x — our exact runtime — already has a
published report card (1,533 / 81 / 113 / 4). **That run used the Java translator.** We translate with
`@cqframework/cql` 4.0.0-beta.1, and that delta is unpublished. One directly comparable signal came out
clean: **our 4 runtime errors are the same four cases as their 4 errors.**

**The thing worth remembering from today: the harness was the defect FOUR times, and twice it nearly
published.** The
first full run reported **183 translation errors** — a headline number, and 171 of them were ours.
**155 were `No default UCUM service available`**: `LibraryManager` takes the UCUM service as its *fourth*
argument and defaults to one that throws, so every expression containing `1.0'cm'` failed to translate.
**16 more were our own grading line** — `define Passed: Actual ~ Expected` will not type-check when the two
sides have different static types. The real figure is **12**. It was caught only because the plan required
clustering the diagnostics before believing the total, which took one command and saved publishing a
number wrong by a factor of 15.

**Findings that are real** (and all in the translator/engine, none in our measures):
- **`Slice` is unimplemented in the JS translator** — 10 of the 12 remaining translation errors.
- **31 of 42 `invalid` cases are translated AND evaluated.** `Exp(1000)`, `Ln(0)`, `minimum Boolean`. A
  permissive translator accepts malformed measure logic at authoring time — directly relevant to the
  Studio's CQL editor, which uses translator diagnostics as its compile gate.
- **`Long` is broken and silent: `1L + 2L` → `12`.** String concatenation, not addition. No throw, no
  warning, a number-shaped wrong answer. `Sum({6L,2L,3L,4L,5L})` → `62345`. Independently confirms what
  the connectathon research predicted. No WorkWell measure uses `Long`, and this is a reason not to start.
- **Decimal precision is not applied** to aggregates (`PopulationStdDev` at full IEEE-754 width), and
  **`Ceiling` does not null at the Integer boundary**.

**Five files are perfect** — logical, nullological, queries, aggregate, conditional. Those cover the
constructs our own measure CQL is actually built from.

**Nothing is skipped, deliberately.** #296 proposed a SkipList over the known-weak clusters; skipping them
would have deleted the finding (`system.long` is 33 cases and holds the worst defect) and reported a
better rate over a smaller denominator. The mechanism exists — expressed as *the capability set we claim*,
the corpus's own vocabulary rather than a rotting list of test names — and is unit-tested against a
fixture so it is not vacuous. It is empty.

**A production gap fell out of it, and is NOT fixed here:** the runtime translator has no UCUM service
either, so the Studio's ELM Explorer cannot compile any CQL containing a quantity literal. `compileCql`
now accepts an optional `validateUnit`; production passes none, so its behaviour is byte-identical.
Wiring it in is a real behaviour change and gets its own PR.

**ADR-048's `node:` CLI debt is reframed, not paid — its stated basis had expired.** It planned to split
library values out of the four `*-cli.ts` files because `devdb-cli.ts` exported to production
`live-cli.ts`; measured today, `live-cli.ts` takes `DEVDB_WHITELIST` from `report-table.ts` and every
remaining importer of the four is a test or a `bin.ts` shim. The real hazard was that
`engine-boundary.test.ts` keyed its `node:` carve-out on the **filename**, so a request-path module merely
*named* `*-cli.ts` would have passed. Now keyed on **reachability**, derived rather than listed.
Mutation-checked both ways.

**Review found two more, both in published text** (#398). (3) The `invalid` bucket was not measuring what
the corpus means: `cql-tests-runner` counts a RUNTIME failure as a refusal too, so `invalid` cases are now
executed when they translate — 11 refused / 31 accepted, not 6 / 36 — and the finding's headline example
turned out to be one of only 2 `invalid="syntax"` cases, which upstream does not route that way at all.
(4) The claim that the JS-comparison fallback "fires on zero cases" was read off a field `runnerJson`
**never serialized**; it is 16, and it is now printed, serialized and baselined. Also fixed: the harness
was outside `tsconfig.json`'s `include`, so the code producing a published number was never typechecked —
adding it immediately caught two test fixtures missing a required field.

Suite **1863 → 1876**, 0 fail. The runner refuses to report at all unless it parsed all 16 files and all
1,835 cases with every case in exactly one bucket.

## 2026-08-05 (docs) — the ADR record is split into what governs and what is history (branch `docs/prune-adr-record`)

The ADR record had grown past the point where it could be navigated: 58 records, 338k, in one flat file
with no signal about which of them still govern anything. Git shows **117 of the 118 commits** touching
`DECISIONS.md` under the owner's identity, but the prose was drafted by Claude inside sessions and committed
through that account — and only **9 of 58** records carry a written owner or stakeholder input. The rest are
decisions Claude made and the owner ratified by merging.

Reading all 58 produced a four-way classification that the single flat file had been hiding:

| | | |
|---|---|---|
| **20** | still **binding** | constrains what may be done next |
| **24** | **design records** | how a built thing works; read before touching it |
| **7** | **historical findings** | a diagnosis written up in ADR form; constrains nothing |
| **7** | **superseded** | do not act on it |

**The 14 superseded + findings moved to `docs/archive/DECISIONS_ARCHIVE.md`; `DECISIONS.md` is 338k → 267k.**
Deletion was rejected on a concrete ground rather than caution: these are cross-referenced constantly
(052 by 059, 043 by 044/045/046, 051 by 055/056, plus `CLAUDE.md`, `LOCKED_DECISIONS`, `ARCHITECTURE` and
this journal), so removing bodies would have left dozens of dangling pointers. Every **heading stays** in
`DECISIONS.md` with a dated one-line pointer and a sentence saying what the record found — so an `ADR-0NN`
reference anywhere in the repo still resolves and one `git revert` undoes it. `ADR_INDEX.md` marks them
with `·archived`.

**Review changed the answer, and it was the right catch.** The first cut archived **20**; six of them —
ADR-041, 042, 044, 045, 053, 057 — are cited as *current behaviour* by live code or a runbook. Six test
names literally begin `"ADR-044:"`; `normalize.ts` states the ADR-042 mapping rule in its doc comments;
`run-pipeline.ts` names ADR-057 inside an operator-facing warning; `DEPLOY.md` builds the whole vendoring
runbook on ADR-041 and ADR-053. **A record named by a test, a doc comment, an operator warning or a runbook
is a design record, however diagnostic its prose reads** — and this file's own taxonomy says design records
stay. So they moved back rather than the archive being redefined to fit them. **14 archived, not 20**, and
the win is 338k → 267k rather than 210k. Two other review findings fixed: the archive fragments were dead
(GitHub slugs the *whole* heading, so `#adr-057` matched nothing — explicit `<a id>` anchors now, all 20…
14 verified), and `ARCHITECTURE.md` + `DEPLOY.md` each cited **ADR-033**, which has never existed; both
meant ADR-032.

**The structural finding worth keeping.** The "running CMS's own published measures" group is **18 records —
nearly a third of the file — and only 6 of them constrain anything.** The other 12 are diagnoses: a value
set absent from a bundle, a mammogram in the wrong vocabulary, a harness measuring the wrong window. Useful
history, but the journal already tells each of those stories, and filing them as ADRs is most of why the
file reached 338k. Findings belong here, not there.

Also delivered: a browsable map of all 58 with the classification and a plain-English line each, as a
private artifact outside the repo. **Nothing in the record was edited or renumbered** — bodies are verbatim in the archive. ADR-033
still does not exist and its number is still not to be reused.

## 2026-08-05 (M-C / C1) — `@workwell/measure-engine` exists, and the question that blocked it for two weeks was the cheap one to answer (branch `feat/measure-engine-extraction`)

The extraction has been promised since 2026-07-24 and deferred twice. It was never a lifting problem:
`engine-core-boundary.test.ts` had already decided and enforced where the boundary sits. It was **one
undecided question** — does the package ship WorkWell's measure content, or take it injected? — and ADR-052
named it precisely, declined to answer it, and everything stopped there.

**Answered: injected. The package ships zero content.** `CqlExecutionEngine` takes
`{ measures, elmLibraries, expansionFallback? }` as a **required** constructor argument. Our 15-measure
catalog, the 17 compiled ELM libraries (1.2 MB) and `withBundledEcqmFallback` — whose own docblock begins
*"the codes the synthetic corpus stamps"* — stay app-side under `src/engine/cql/`, wired in exactly one
place: `createWorkwellEngine()`, which the ~45 former `new CqlExecutionEngine()` sites now call. The
argument that excluded `synthetic/employee-catalog.ts` applies to those three with equal force, and
`evaluate(input.elm, metaOverride)` already supported consumer-supplied measures — so the registry and ELM
were always a default, never a necessity.

**Required, not defaulted to empty, and verified as a compile error** (`TS2554` on `new
CqlExecutionEngine()`). An empty catalog reports `MISSING_DATA` for every subject, which is
indistinguishable from a genuinely ineligible roster — the ADR-043 hazard, and one PR-8f's retrieve check
provably cannot see.

**The thing worth recording: ADR-052's "real blocker" DISSOLVED rather than being paid.** It recorded nine
core-test→app edges and concluded the move must *"either strand those tests or give the package a
devDependency pointing back at the app."* Neither. Under content injection every one of those tests is
testing *content-configured* behaviour and is app-side by the same rule that excludes the content —
`cql-execution-engine.test.ts`, `foreign-condition-scoping.test.ts`, `generate-sql.test.ts`,
`value-set-resolver.test.ts`, `audiogram-vsac-parity.test.ts`, `measure-executor.test.ts` all stay put and
import the engine by its package name. **Four** package tests had no app edges and moved with their subjects;
`package-boundary.test.ts` is new, not moved (git renders it as a rename on a similarity heuristic). The blocker was an artefact of the undecided question, not an independent obstacle.

**Two changes the extraction FORCED, both stated rather than smoothed over.** (1) `fhirNativeExecutor` and
`resolveMeasureExecutor` now **require** their engine binding — they defaulted to a lazily-constructed
shared engine, which only worked while the engine imported content at module level; an executor that
manufactures its own engine would have to manufacture a catalog, and the only one it could invent is empty.
Zero production callers, so no behavioural surface. (2) Offline expansion is now gated on
`expansionFallback` being **supplied**, not on the OIDs looking eCQM-shaped. Unchanged, a consumer injecting
neither resolver nor fallback would have entered expansion mode against an empty `CodeService` and
zero-matched every retrieve; now they get the base library — a limited answer instead of a silently wrong
one. WorkWell always injects the fallback, so nothing here moved.

**Enforcement was rewritten, not relocated — the old test predicted its own end.**
`engine-core-boundary.test.ts` said in its docblock that the move would leave it unresolvable if left behind
and vacuous if moved verbatim. So: `packages/measure-engine/src/package-boundary.test.ts` recomputes the
closure from `index.ts` and refuses a third dependency, any `node:` builtin, any escape, and **any import of
WorkWell content by name** — the assertion that keeps the decision from being quietly reverted.
`src/engine/measure-engine-api.test.ts` keeps the outside-only half: no deep import past the entry point, no
relative reach-around into `packages/`, and every imported name **read from `index.ts`** rather than
restated, so the check cannot drift from the real surface. The eleven-name `CORE_ENTRY_POINTS` list is
deleted. `engine-boundary.test.ts` still polices `src/engine/`, but its allowlist no longer admits
`cql-execution`/`cql-exec-fhir` — a file there reaching for the CQL runtime would be evaluating measures
*beside* the engine instead of through it.

**All eight new or rewritten assertions were mutation-checked** (broken deliberately, confirmed red,
restored). Not ceremony: a boundary test that survives its own subject moving is exactly the vacuous-guard
shape caught on #350, #354, #363 and #365.

**Review then found a ninth thing the eight could not see, and it is the same lesson again.**
`httpVsacClient` built its HTTP Basic header with **`Buffer`** — a Node *global*, which arrives through no
import — so "the package is NODE-FREE" stayed green while a VSAC-configured Worker or browser consumer
would have thrown before issuing a request. The blind spot is inherited (the identical `node:`-only check
has been in `engine-boundary.test.ts` since PR-1); what this change did was **widen the claim being cited**,
from "file I/O stays at the CLI edge" to "publishable and portable". That is exactly #380's finding about
`qrda-schematron-check.py`: a guard whose SCOPE is narrower than the sentence quoting it. Fixed both halves
— `TextEncoder` + `btoa` (verified byte-identical to `Buffer`, and correct rather than merely portable,
since bare `btoa` throws above U+00FF), and the guard now scans closure SOURCE for `Buffer`, `process.*`,
`__dirname`, `__filename`, `require(`, with its own non-degeneracy assertion. Mutation-checked.

**Measured.** Suite **1859 → 1863** tests, 0 fail — the +4 is precisely the 6→10 boundary-test split, so no
test was stranded (the failure mode this PR was most exposed to). `compile-measures` and `generate:sql`
reproduce byte-identical output. `pnpm evaluate` unchanged. `pnpm flip-snapshot --measure cms125` still
reports **5 of 5** in the official initial population, agreeing with authored, no roster row changed.
`src/engine/` is 33 production files, from 43.

**Named, not implied — what C1 did NOT do:** the `node:` allowlist for the four `*-cli.ts` entrypoints
(ADR-048's second debt) is untouched, because those files stayed app-side, so the debt did not move; it is
C2's. `packages/measure-codegen`, the external consumer, the `cql-tests` harness (#296) and the versioned
compliance API are C2/C3/C4. The package is `private: true` until C4.

## 2026-08-04 (M-E0) — the mechanism is proven by construction, and the connectathon contribution is written (branch `feat/connectathon-contribution`, #394)

**The mutation proof that failed yesterday turned out to BE the finding.** `cqf-fhir-cr` retrieval is
QI-Core **`meta.profile`-sensitive**: a hand-`PUT` `Condition` with no profile stamp is stored, searchable
and **silently never retrieved** — absent from `evaluatedResource`, and the measure evaluates as if it were
not there. Stamp the profile and the identical resource is picked up immediately. That silently invalidates
any comparison built on hand-authored data, which is worth more to the track than the discrepancy itself.

With that understood, three single-variable mutations on one failing subject, each on a fresh server
(`$evaluate-measure` caches): inject a hospice `Condition` → **DENEX 0→1**, so the engine CAN exclude this
subject and the failure is branch-specific; add a minimal `dosageInstruction` → still 0; inject an
**Advanced Illness** `Condition` → **1**. The last bypasses only the medication arm, and since the branch is
`age ≥ 66 AND frailty AND (advanced illness OR dementia meds)`, it proves age and frailty are both credited.
**The failing conjunct is precisely `"Has Dementia Medications in Year Before or During Measurement
Period"`** — whose `medicationRequestPeriod()` opens `singleton from R.dosageInstruction`, and the MADiE
cases carry **no `dosageInstruction` at all**, only `dispenseRequest.expectedSupplyDuration`. Two conforming
engines disagree about what those null inputs yield. ADR-055's standard is met.

**`docs/evidence/CONNECTATHON_DISCREPANCIES_2026-08-04.md`** is the M-E0 deliverable: 255/278 across six
measures, three findings classified in the track's own A/B/C/D scheme, with a direct question back — *what
should `medicationRequestPeriod()` return when `dosageInstruction` is absent?*

**Review caught an overstatement that would have gone to a standards body**, and it was the right kind of
catch. The report attributed all 16 CMS125/CMS122 disagreements to that one finding while the evidence doc
it cites still said two were unexplained. Measured attribution: CMS122 **6 of 6** and CMS125 **8 of 10**
disagreeing cases carry a `MedicationRequest`, and **0 of the 25** agreeing `DENEX=1` cases do — so the
finding accounts for **14 of 23**, not 16. The confidence was overstated too: proven by construction on
**one** case, consistent-with for the other thirteen. Both corrections shipped, and Finding 3 is retitled
"the 9 disagreements Finding 1 does NOT explain" — CMS125's two `Procedure`-only cases plus CMS2's seven.

**Still open, and named as such everywhere:** CMS125's 2 `Procedure`-only cases, CMS2's 7 `NUMER 1→0`,
CMS130/CMS165 unswept (they need the credentialed vendor workflow). Submitting the contribution is an owner
calendar step, not engineering. **Next milestone is M-C** — the packaging spearhead that locked decision 5
makes the primary deliverable.

## 2026-08-04 (M-B / B7) — a second engine runs our artifacts for the first time: 255/278 across six measures, three of them perfect (branch `feat/cross-engine-check`)

The check that changes what we can honestly say. Our MADiE gate is 410/410, but **the execution is entirely
ours** — and the obvious second opinions do not qualify, because **`fqm-testify` and `deqm-test-server` both
wrap `fqm-execution`**, so they compare our engine to itself. `cqf-fhir-cr` (HAPI Clinical Reasoning) is a
separate implementation in a different language. This is the first time WorkWell's artifacts have been run
by anything that is not us.

```text
SIX measures, 278 MADiE cases, HAPI 8.10.0, completed terminology
  CMS68   19/19    CMS951  55/55    CMS138  47/47     <- perfect
  CMS122  49/55    CMS125  56/66    CMS2    29/36
  total  255/278   (23 disagreements)
```

IPP and DENOM agree on **all 278**. Within each measure every disagreement has one identical shape:
CMS125 `DENEX 1→0`; CMS122 `DENEX 1→0` **and** `NUMER 0→1` (the same root — it is inverse, and `fqm` zeroes
the numerator when an exclusion is true, so one cause reports as two differences); CMS2 `NUMER 1→0`, which
is a genuinely different failure.

**A tidy hypothesis, killed by measurement.** The first sweep ran on the upstream bundle's terminology,
where `…1003.110.12.1082` (AdvancedIllness) ships **capped at 1000 of 1997** — the exact gap ADR-041 exists
to close, and it feeds a DENEX, so it was the obvious suspect. Pushed our completed expansions (32 value
sets, **3043 codes**, matching ADR-041's recorded figure), **verified the server holds `expansion.total:
2000`** for that OID, re-ran: **the same 10.** Terminology is excluded.

**Two corrections to my own first reading, both from measurement.** (1) **`$evaluate-measure` CACHES** —
a `Condition` PUT for an already-evaluated subject was stored and searchable yet the next evaluation
returned a byte-identical `evaluatedResource` without it. That means the terminology test above ran WARM
and proved nothing as first evidenced; re-run cold it gives the same 10, so the conclusion stands and now
the evidence does too. (2) The disagreement is **branch-level, not resource-level**: I first reported a
`MedicationRequest` correlation (8/10 vs 0/25), but Java **does** retrieve both the `MedicationRequest` and
the `DeviceRequest` — they are in `evaluatedResource`. What separates the groups is that every agreeing
DENEX case uses a *simple* branch (hospice, mastectomy history) while every disagreeing one uses the
compound **Advanced Illness and Frailty** branch. **Stated as characterisation, not cause** — this codebase's standard for a cause is a mutation
that flips one case (ADR-055), and that has not been done yet. Also stated: this does **not** show ours is
right and theirs wrong. It shows that on this artifact, this data and **this server configuration**, one
implementation diverges in a characterizable way; a stock HAPI was used and no alternative CR settings were
explored.

**Two traps closed in the harness itself.** The CR property is **`hapi.fhir.cr.enabled`** — with
`cr_enabled` the server starts fine and declares no measure operations, a silent no-op, so the script now
refuses unless `Measure/$evaluate-measure` is in the CapabilityStatement (otherwise every evaluate 404s and
the sweep reports "0 agreements" that is really a broken container). And it **refuses a sweep where every
case returns an all-zero vector** — that is terminology or libraries failing to resolve wearing agreement's
clothes, the PR-8f/ADR-043 hazard.

**A batch-run number I published and then had to correct:** an initial loop swept all six measures back to
back and reported **CMS122 at 7/55**. The container answers `/metadata` with 200 before the CR module is
ready, so that sweep ran against a half-started server. On a settled server CMS122 is **49/55**. A degraded
server produces *more* disagreement, not less, which is why the three 100% results survived the bad batch —
but both divergent measures were re-measured before being reported.

**Context that makes the 23 unsurprising:** the CMS7-FQR connectathon's own Java-vs-JS run over 74 measures
× 3,964 cases found **98.16% pass with 3 measures still disputed**, and the track's stated ask to
participants is precisely *verify on an alternate engine and classify each discrepancy*. This run is that
contribution, and it is the concrete thing to bring to M-E0.

**The JVM is back — deliberately, and only here.** ADR-008 retired it from the product; this is a dev-time
oracle in Docker, never runtime, packaged or CI. Evidence:
`docs/evidence/CROSS_ENGINE_2026-08-04.md`.

**The mechanism is now PROVEN by construction, and the thing that unblocked it was the failed first
attempt.** A hand-`PUT` resource with no `meta.profile` is stored, searchable and **silently never
retrieved** — `cqf-fhir-cr` retrieval is QI-Core profile-sensitive. Stamp the profile and the same resource
is retrieved immediately. With that, three single-variable mutations on one failing subject: injecting a
hospice `Condition` flips DENEX 0→1 (so the engine CAN exclude this subject — the failure is
branch-specific); adding `dosageInstruction` alone does not; injecting an **Advanced Illness** `Condition`
flips it to 1. That last one bypasses only the medication path, and since the branch is
`age ≥ 66 AND frailty AND (advanced illness OR dementia meds)`, it proves the age and frailty conjuncts are
both credited. **The failing conjunct is precisely `"Has Dementia Medications in Year Before or During
Measurement Period"`** — whose `medicationRequestPeriod()` derives from `dosageInstruction`, which the MADiE
test cases omit entirely. The two engines disagree on what that yields.

**Still open:** CMS2's `NUMER 1→0` is a different, undiagnosed cause; CMS130/CMS165 have no test cases
checked out. Next: take the classified discrepancies to the CMS7-FQR track (M-E0).

## 2026-08-04 (M-B / B6) — the first FHIR-column measurement: base R4 is clean, DEQM is three defects wide (branch `feat/deqm-validate`)

First of the two checks that replaced the retired Cypress bar (ADR-058, ROADMAP §4 V3).
`backend-ts/scripts/deqm-validate.ts` builds four MeasureReports from the **real production builders** and
runs the HL7 validator over each **twice**: base R4, then the DEQM STU5 profile requested explicitly.

```text
base R4 : 0 errors across all four reports   ← the floor
DEQM    : 12 errors — exactly 3 per report, the SAME 3 every time
```

**The two runs are different questions and the script says so.** `measure-report.ts` deliberately does not
stamp `meta.profile` with a DEQM canonical, so nothing here claims DEQM conformance — the validator was
*pointed* at the profiles with `-profile`. Claiming a profile we do not meet is the misdeclaration ADR-050
corrected for QRDA's `…24.1.3` and `…27.1.2`; asking what claiming it *would* cost is the honest version.
**Do not add `meta.profile` on the strength of this run** — the gate is 0 DEQM errors, with the base run
proving the resource stayed valid R4.

**The identical 3-per-report count across official AND authored is the informative part**: none of the
three is provenance-dependent, so they are properties of how every report is built rather than of the
ADR-046 identity split. (1) **`deqm-0`** — the canonical SHALL carry a version, and **we already hold it**
(`evidence.official.version`, which ADR-046 threads to the QRDA III identity), so this is an omission at one
call site rather than missing data. (2) **`reporter` fails `qicore-organization`** — our contained
Organization carries only `name`; that is QI-Core's constraint reaching us *through* DEQM. (3) **`deqm-3`**
— measure scoring required on the root **or** every group and not both; we emit none.

**Two findings outside the error count.** `measureScore.value` is warned as outside commonly supported
decimal range: we emit raw float `0.019417475728155338` while `qrda3-export.ts` formats the same quantity
`.toFixed(4)` — and that file's comment claims the two exporters "must match exactly". They match in value,
not representation. And the DEQM package **resolves `hl7.fhir.us.qicore#6.0.0` + `hl7.fhir.us.core#6.1.0`**,
which is independent confirmation of ROADMAP §6 correction 2 arriving from the tool rather than from
research — the published stack binds **QI-Core 6, not STU7**.

Deliberately **not in CI** (Java 17+, a ~187 MB rolling jar, network to `packages.fhir.org` — none of them
backend-ts deps), following the `qrda-schematron-check.py` precedent: the script is how a number gets its
authority, and regressions get pinned in TypeScript citing constraint keys. The jar is gitignored and the
run **records its SHA-256** rather than pinning one, because pinning a rolling "latest" would be stale
rather than protective. Evidence: `docs/evidence/DEQM_VALIDATION_2026-08-04.md`. Typecheck clean.

## 2026-08-04 — the roadmap is reworked: the engine is the product, and the ruler we were chasing does not exist for our column (branch `docs/roadmap-2026-08-04`, ADR-058)

**Started the day intending to build supplemental data. Reading Cypress's source instead killed that plan
and then the milestone's whole bar.** The plan was defensible on its face — 45/53 of the C2 errors were
supplemental data, it is unambiguously our gap, and fixing it first would make the residual red
attributable to lineage alone. Then `projecttacoma/cqm-validators` said otherwise:

```ruby
nodes = find_measure_node(measure.hqmf_id, doc)
return {} if nodes.nil? || nodes.empty?
```

Supplemental data is built **only inside that matched node** and read back as
`(reported_result[:supplemental_data] || {})[pop_key]`. With an empty extraction there is nothing to key
into. **The supplemental errors are downstream of the identity short-circuit, not an independent second
gap** — perfect supplemental data would not have moved the verdict by one error. The sequencing argument was
backwards: the residual was *already* purely lineage.

**Two more facts from the same file killed the relabel option too.** Populations are matched on
`reference/externalObservation/id[@root = <UUID>]`, and **the QI-Core artifact has no per-population UUIDs
at all** — read from the vendored bundles, its populations are *named* (`InitialPopulation_1`, …). So
"relabel two ids" was never the shape; it would mean importing the QDM measure's entire identifier surface
via a hand-asserted crosswalk taken from the answer key's own internals. And the two "invalid id" errors
Cypress emitted are **exactly our own artifact's** version-specific and version-independent UUIDs
(`ae8bc6fe-…`, `f766afa2-…`), so the document was internally honest all along.

**Then the research pass found the thing that reframes the milestone.** `projecttacoma/cvu-fhir` — MITRE's
fork of Cypress, README verbatim *"An open source tool for testing electronic Clinical Quality Measure
calculation"* — has 3,771 commits and was **last pushed 13 April 2023**. Someone tried to build
Cypress-for-FHIR and shelved it. Cypress itself is actively maintained (v7.5.1, 30 Jul 2026) with **zero**
mentions of FHIR, QI-Core or dQM. **There is no FHIR-lineage grader.** So the choice was never
green-versus-red; it was *green on the ruler CMS is migrating away from* versus *measured against the
ecosystem's own content and an independent engine, where no ruler exists to be green on*.

**The owner decision that settles it: WorkWell is supplementary to WebChart and does not pursue ONC
certification.** WebChart already carries it (~33/49). Doug's ask was always **packaging** — make the engine
consumable across MIE — which is a library-and-contract problem. That removes the only reason to build a QDM
execution path, and it demotes certification-shaped work from spearhead to bridge.

**ADR-058** records all of it. **`docs/ROADMAP_2026-08-04.md`** supersedes the 2026-07-24 roadmap: the five
milestones survive, but **M-C (packaging) is promoted to spearhead**, the bar becomes a **named set of
FHIR-column checks** with per-check scope and limits, and M-E (occupational measures) is elevated as the
differentiator — the part no competitor obtains by downloading CMS artifacts.

**The new bar is stronger than the one it replaces, not weaker.** V4 is cross-execution against Java
`cqf-fhir-cr`, and the reason it matters is that **`fqm-testify` and `deqm-test-server` both wrap
`fqm-execution`** — the library we already run — so neither is an independent arithmetic check. Java
`cqf-fhir-cr` is. "Two independently written engines agree on CMS's own test cases" beats "a QDM
certification tool read a document we labelled as a measure we did not execute." Accepted cost, stated: that
puts a JVM back in the **verification** path against ADR-008's direction — dev-time oracle only, never a
runtime or packaged dep.

**Four corrections to the record, each because leaving them is a gate enforcing a retired goal.**
(1) "~2030" for CMS FHIR endpoints is **not CMS-attributable** — it traces mostly to NCQA's HEDIS goal;
CMS's own page states the target with no year and the original RFI said "by 2025", which slipped. Say "no
published date." (2) "QI-Core STU7 = US Core 7 = WebChart's exact surface" is half right and misleading:
the equality holds, but **CMS's shipping content is authored on QI-Core 6** and the forward direction is
**US Quality Core 0.5.0 over US Core 6.1.0**. (3) "Cypress CVU+ is the verification bar" is removed from
`STANDARDS_CONFORMANCE.md` **and from the `conformance` skill**, which would otherwise keep enforcing it in
every future session. (4) The supplemental-data gap is re-recorded as downstream, and **deferred, not
cancelled** (B8) — it changes no external number today.

**Nothing measured is withdrawn.** QRDA I and III both stay at 0 findings against the HL7 base ruler; the
64/64 and 150/150 subject-level agreement against Cypress's own expected results stands exactly as recorded.
What changed is which of those we call the bar.

**Two things worth acting on that fell out of the research.** The CMS7-FQR track's stated ask to
participants is to *verify results on an alternate engine* and classify the remaining discrepancies (74
measures × 3,964 MADiE cases, 98.16% pass, 3 disputed) — WorkWell is exactly that, and in a space with no
certification tool, connectathon peer review **is** the third-party verification. And Lantana's
connectathon FHIR server is **live right now** (probed 2026-08-04: HAPI 8.10.0, 76 Measures, 3,070
MeasureReports), serving every measure we have vendored or gated at v1.0.000. Metadata reads only; nothing
was POSTed to a third party.

**Open owner step, and it is the one input that would reopen this:** confirm with Doug/Nicole that
certification of WorkWell's *engine* is not a business goal. Evidence:
`docs/evidence/FHIR_VERIFICATION_LANDSCAPE_2026-08-04.md`. Docs only — no code changed.

## 2026-08-03 (M-D) — the live WebChart path gets the two elements our SQL mappers add, and the gate that was missing (branch `fix/webchart-live-official-parity`, ADR-057)

M-D's first item, and it was a landmine rather than a feature: ADR-042 mapped `us-core-sex` and ADR-044
dual-stamped mammography, both in the two SQL→FHIR sites, and both sit **upstream of the live FHIR
transport**. `normalizeWebChartBundle` was untouched by design, so a third-party WebChart server got
neither. Recorded and left open in both ADRs: official CMS125 puts a live tenant's ENTIRE roster out of its
initial population — silently, 100% MISSING_DATA rather than an error — and a woman who WAS screened reads
OVERDUE, which `case-logic.ts` escalates to HIGH. Inert only because no WebChart-configured stack routes
officially; the day one does, both fire.

**Both derived now, on the ADR-037/ADR-044 normalization terms.** `us-core-sex` from `Patient.gender`
through a two-value allowlist (`other`/`unknown` assert NOTHING — there is no concept to assert and
guessing is what this must not do), never overwriting one the server supplied, tagged
`derived-from-gender`. A LOINC imaging `Observation` from a CPT/HCPCS mammography `Procedure`: a two-code
allowlist rather than a category sweep, only from a `completed` Procedure, carrying the `category ~
imaging` that `Status.isDiagnosticStudyPerformed` also requires, and **suppressed entirely when the server
already sends the Observation** — checked at bundle level precisely so it can see the whole patient.

**ADR-042 declined to infer sex here, and this reverses that for a stated reason.** The symmetry is the
argument: administrative gender and recorded sex can legitimately differ, so deriving is an inference — but
reading a server's own `female` as not-female is *also* an inference, and a worse one, because it is silent
and it empties the measure. ADR-043 already established that a whole roster out of the initial population
is the hazard, not the safe answer.

**The gate the webchart skill's trap #4 said did not exist now does.**
`live-official-parity.test.ts` strips exactly those two elements from the committed fixture to reproduce
the live shape — a live server sends `Patient.gender` and a CPT Procedure — and pins that official CMS125
admits **4 of 56** with normalization and **0** without. So it cannot pass on data that never needed the
fix, which is what the existing `devdb-official-eval.test.ts` does: its fixture comes from one of the
mappers ADR-042/044 fixed, so the derivation never fires there. It also verifies the fixture still CARRIES
both elements before stripping them — a guard on the guard — and pins every negative: a non-final
Procedure, a non-mammogram Procedure, an unmapped gender, a server that already supplies the element.

**Review caught this change CREATING the divergence it removes, on the commonest coding form.** The
mammography allowlist compared `system|code` exactly while the crosswalk fifty lines away normalizes system
aliases and upcases the code — so a CPT-as-OID mammogram reconciled to a cms125 event (authored read
COMPLIANT) while the derivation did not fire (official read OVERDUE). Six of eight realistic codings. Both
now go through one exported `codingKey`, with a matrix test pinning every alias. Also fixed: the derived
extension violated FHIR's ext-1 (`value[x]` and `extension` together — provenance moved to `meta.tag`);
`SEX_CONCEPT` was a plain object literal indexed by untrusted input, so `gender: "constructor"` asserted a
malformed extension the "asserts NOTHING" test could not catch; the mammography suppression was bundle-wide
rather than per-subject; and the 4-vs-0 negative arm compared "normalized vs not normalized at all", which
is not attributable — it now normalizes and strips only the derived element.

**And the mammography half had no end-to-end assertion at all** — every test checked the SHAPE of a
resource, which is precisely what ADR-042 paid a measurement pass to learn is not enough. The fixture
cannot close it either (its only mammogram belongs to wc-49, age 33, dated 2015). With one in-window
screening injected into the four IPP subjects, official CMS125 now reads NUMERATOR for all four with the
derivation and none without.

**Still untested: the live HTTP transport itself.** This exercises every transformation a routed run
applies to a WebChart payload and none of the request shaping, exactly as `devdb-official-eval.test.ts`
says of itself. Suite 1850, 0 fail; the new file is wired into CI's sidecar-dependent `official-cases` job.

## 2026-08-03 (M-B) — the C2 loop runs end to end through the API, and Cypress cannot read the document it produces (branch `feat/qrda1-batch-import-finalize`, ADR-056)

Two routes existed nowhere and #386 §11.1 named one of them: `/evaluate` takes ONE document and one
subject, and **no route called `finalizeRun`**, so an imported run stayed RUNNING and the QRDA export
refused it. Both are built, and the loop locked decision #2 names now runs through the product:

```text
CMS125  153 documents → 150 subjects (3 merged, 2 demographic conflicts) → COMPLETED
        {"IPP":150,"DENOM":150,"DENEX":47,"NUMER":2}
CMS122   68 documents →  64 subjects (3 merged, 1 unreadable, 3 conflicts) → COMPLETED
        {"IPP":64,"DENOM":64,"DENEX":32,"NUMER":31}
```

Both are Cypress's expected results **exactly**. The unreadable CMS122 document is the half of a
clinically split patient carrying only a payer entry (ADR-051 refuses it); its person is recovered from
the other half, which is why 68 documents still resolve to 64 people.

**The grouping rule is deterministic and identifier-only, and that was a measurement rather than a
principle.** Documents merge when they share any `<recordTarget>` identifier, transitively; a document
sharing none is its own person. Adding a name+birthdate pass for the identifier-less documents changes
**nothing** on any of the four archives — the patients Cypress ships without an MBI are never the ones it
duplicates — so a rule that buys no accuracy and can merge two different people is not worth having. It
is ADR-022's rule one level down. Demographic disagreements inside a merged group are **reported, never
resolved**: a `birthDate` conflict moves a person between age bands in both routed measures, and review of
the C2 harness reproduced exactly that failure.

**`/finalize` is not a "finish this run" button, and the guard is stateless.** Finalizing a population run
from outside would mark a partial roster COMPLETED and make it exportable — the exact harm the export
guard exists to prevent. So it refuses unless EVERY outcome carries `qrda1Import` evidence, which is true
only of a run whose roster came from supplied documents. Fails closed on a mixed run.

**Then the submission, and the result is red for reasons that are not our arithmetic.** Cypress's
`ExpectedResultsValidator` ran against a document we produced for the first time. `state=failed`, and:

- **0 population mismatches — which is NOT a pass, and reading it as one is the trap.**
  `check_population` compares only `if !reported_result.empty?`, so a document it cannot read produces no
  population errors at all. Measured directly: `reported_results: {"PopulationSet_1" => {}, …}` — **empty
  for every population set**. It read no number of ours and compared nothing.
- **3 identity errors:** `Invalid HQMF ID Found: AE8BC6FE-…`. Cypress's bundle is **CMS125v14, the QDM
  lineage**; we run and report **CMS125FHIR v1.0.000, the QI-Core one**. Different eMeasure UUID, different
  set id, population criteria named rather than UUID-identified. `extract_results_by_ids` looks for its own
  measure's ids and finds none of ours. **Not fixable by relabelling** — ADR-046 decision 3 forbids
  claiming an eMeasure identity the run did not use.
- **45 and 53 supplemental-data errors:** QRDA III wants RACE/ETHNICITY/SEX/PAYER per population and we
  emit none. The input is there and we drop it — Patient Characteristic Payer is in every Cypress document
  and our importer skips it; race/ethnicity ride in `<recordTarget>` unread.

**A wrong reading I nearly recorded, corrected by checking the source.** `Reported IPP value 150 does not
match sum 0` looks like Cypress quoting our 150 back — it is not. `check_supplemental_data_matches_pop_sums`
computes that number from the **expected** supplemental values and calls it "Reported"; the `0` is ours.
Taken at face value it would have become "Cypress read our numbers and they matched", which is the
opposite of what happened.

**Review broke the finalize guard end to end, and it was the worst failure available in the diff.**
`scheduleAsyncRun` returns RUNNING immediately and finishes its fan-out in the background, so an
ALL_PROGRAMS run spends a window RUNNING with **zero** outcomes — during which "every outcome carries
`qrda1Import`" is vacuously true. Measured: one document imported into that window, finalized COMPLETED, a
QRDA III exported, and the run then gained 2,100 more outcomes. Import-drivenness is now a property of the
run's **construction** (`requestedScope.importDriven`), which a run the pipeline owns can never acquire;
both checks run. **And the `PARTIAL_FAILURE` branch was structurally dead** — `/import` did not persist a
failed subject at all, so every row `/finalize` could see came from a successful evaluate, and 150
documents with 20 failures would have exported a 130-row roster as a complete report. Failed subjects now
persist `MISSING_DATA` + `evaluationError` exactly as the pipeline does; one fix, both halves. `/finalize`
also writes its `RUN_COMPLETED` audit event, which it was skipping.

**Four more, all measured, all in the identity path:** a `nullFlavor` id merged two different people; two
people could resolve to the SAME subject id (grouping is root-aware, the importer's patient id is
deliberately root-agnostic, and `outcomes` has no unique key to catch it); taking the canonical Patient
whole dropped a `us-core-sex` that only the other document stated — silently removing a person from
official CMS125's IPP while reporting it as a `gender` "conflict" of `["", "female"]`; and the canonical
tiebreak fell back to input order for equal identifier sets, letting `readdirSync` decide a 28-year
birthdate swing. Plus two route regressions against `/evaluate`: the measure check ran over the UNION so
one matching document licensed the whole batch, and `localMeasureId` was dropped so an authored export was
unchecked. All fixed, all pinned, and the load-bearing `assertMeasureIdentifiers` path — which had no test
at all — now has one.

**So the bar is unchanged and now precisely located.** The loop exists, runs over a third party's archive,
and produces the right numbers — measured directly in #388 at 64/64 and 150/150 subjects. It is not green,
for a lineage split our export deliberately will not fake and supplemental data we do not carry. Evidence:
`docs/evidence/CVU_C2_SUBMISSION_2026-08-03.md`.

## 2026-08-03 (M-B) — the QRDA importer is fixed and now matches Cypress EXACTLY on 214 patients (branch `fix/qrda1-import-datatype-coverage`, ADR-055)

This morning's spike closeout diagnosed two import defects and left them unfixed. Both are fixed, a third
surfaced during the fix, and the comparison was re-run: **IPP 64=64 and 150=150, DENOM identical, NUMER
31=31 and 2=2, DENEX 32=32 and 47=47 — 64 of 64 and 150 of 150 subjects agreeing on every population**,
reproduced against a second, independently generated archive (66/68 and 152/153 documents). That is the
first external, known-answer validation of the chain from a **third party's document** through our import
into the official executor — complementary to the MADiE gate rather than a repeat of it, since MADiE
hands the executor finished bundles and grades only the executor.

**Each datatype's FHIR target was read off what the artifacts' ELM actually RETRIEVES, never off a
QDM-to-QI-Core table.** The ELM is what the executed measure will look for; a plausible second-hand
answer that retrieves nothing is indistinguishable from a patient with no data — the ADR-043 hazard
through a new door. Measured: Intervention Performed → `Procedure`, Intervention Order →
`ServiceRequest` (same value set, different type, so the pair cannot be collapsed), Device Order →
`DeviceRequest`, Medication Active → `MedicationRequest`, Symptom and Assessment → `Observation`. The
libraries read `authoredOn`, `performed`, `effective` and `value` — and notably NOT `status` or `intent`,
so those are set to what QI-Core requires rather than to satisfy a predicate.

**Two nested-element traps and one inversion, each of which loses data silently.** A Device Order's code
is on `participant/participantRole/playingDevice/code` — `<supply>` carries none and the only `<code>` up
the tree is the ActClass literal `SPLY`, so the obvious "walk up" yields a DeviceRequest coded "Supply".
A Medication's drug is on `consumable/…/manufacturedMaterial/code`. And **Symptom inverts code and value
while Assessment does not**: `[Observation: "Frailty Symptom"]` filters on `Observation.code`, a QDM
Symptom's own `<code>` says only "this entry is a symptom" (LOINC 75325-1) and the `<value>` carries the
symptom — the same inversion as Diagnosis — while an Assessment keeps `<code>` as the instrument and
`<value>` as the result. Also: `<supply>` and `<substanceAdministration>` had to join the candidate
element scan, or those two datatypes stay invisible however good the mapper is.

**`<translation>` is an ADDITIONAL coding, not a fallback** — CDA's translation is "the same concept in
another vocabulary", exactly what a multi-coding `CodeableConcept` means — and an unmappable primary code
no longer discards the whole resource. ICD-10-PCS, RxNorm, CVX and four others joined the system map.

**Then both measures were short by exactly nine, and all nine had the same name shape.** `THREE N
Independent Risk Factors …` — an inpatient `Encounter` carrying
`<sdtc:dischargeDispositionCode code="428371000124100"/>`, discharge to home for hospice care. The
Hospice library reads `Encounter.hospitalization.dischargeDisposition`; our encounter mapper carried
`type` and `period` and nothing else. **One field closed both measures to exact agreement.**

**Mutation-checked one fix at a time, and it caught a vacuous assertion of my own.** A test asserting a
Device Order is not coded `SPLY` could never fail — a mapper reading the supply's own code finds nothing
and drops the resource entirely — so the assertion is gone along with the unreachable fallback it was
guarding. Reverting any of the six fixes now fails exactly the test that claims it. Two older tests were
also corrected rather than left passing for the wrong reason: both used a bare Medication, Active as "a
datatype we cannot translate", which stopped being true today.

**Review caught a live defect of exactly the class this PR fixes, and the exact agreement did NOT catch
it.** HCPCS was mapped to `urn:oid:2.16.840.1.113883.6.285` where the vendored expansions say
`http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets` — 103 codes across the two measures, including
Annual Wellness Visit `G0438` on 22 documents. `cql-execution` compares `system` by exact string equality,
so a near-miss URL is **worse than an absent one**: an absent system drops the resource visibly, a wrong
one imports it and leaves it invisible to every retrieve with no diagnostic anywhere. It read as 64/64
only because the initial population is `exists(...)` and those patients carry other qualifying
encounters — a right answer for the wrong reason, which is precisely what this comparison exists to
catch and did not. Fixed, the speculative mappings I had added alongside it (CVX, CDT, NUCC, plain
ICD-10) removed for the same reason, and pinned twice: literals in one test, the artifacts' own
expansions in a sidecar-gated one.

**Three more from the same review.** The ADR claimed the libraries do NOT read `status` or `intent` — they
read `status` 22 times and `intent` 6, every exclusion retrieve is wrapped in a `Status.is*` predicate, and
`isMedicationActive` is an `Equal` on `"active"`, so the false rationale was one plausible edit away from
killing the dementia exclusion. Corrected, with every value pinned against its predicate. `negationInd`
was unhandled — a negated act would have imported as a positive fact and manufactured an exclusion from a
record stating the opposite; now skipped and reported. And five mutants survived the new tests: fixtures
added for the unmapped-primary-with-translation path, the `authoredOn` effectiveTime fallback, and a
wrapper template preceding its datatype; `symptomFrom`'s fallback to the element's own `<code>` removed
rather than tested, because it is reachable and actively wrong.

**Scope held deliberately.** No export change — `qdm-entries.ts` can only emit what our own evaluated
bundles contain, and those carry no frailty, hospice or palliative data, so import and export are now
asymmetric and the round trip cannot reach the new mappers; they are pinned by a fixture modelled on
Cypress's own documents instead. Suite 1807, 0 fail. The MADiE gate is untouched by construction — it
never reaches the importer.

**Still not met:** `ExpectedResultsValidator` has never graded a document we produced (no HTTP route
finalizes an imported run), only `PopulationSet_1` is compared, the patients are synthetic, and the
identity resolution this depends on still lives in the harness rather than the product. Next: identity
resolution on the import path, then the finalize route.

## 2026-08-03 (M-B) — the C2 oracle reproduces and the comparison ran: IPP and DENOM match, exclusions do not, and the cause is our IMPORTER (branch `docs/cvu-c2-oracle-and-comparison`)

#386 stopped at "establish the oracle before running anything through WorkWell", because across three
setup runs CMS122's expected IPP read 128, then 93. **It reproduces exactly, and the irreproducibility
was one thing: teardown that deletes the Product but not its `CQM::IndividualResult`s.** Two clean
rebuilds now agree on every graded number — CMS122 64/64/31/32, CMS125 150/150/2/47 plus both strata,
and the supplemental-data digests byte-identical.

**The oracle is now DERIVED, not recorded, which is the difference between a number and an oracle.**
`IndividualResult` = patients × population sets (CMS125's 300 is 150 unstratified + each patient's own
stratum, and 28 + 122 = 150 proves one stratum each). Archive documents = patients + 1 clinical split +
`rand(1..3)` duplicates. **So the archive document count legitimately varies between rebuilds while the
expected results do not** — 66 → 68 and 152 → 153 across the two passes. That is Part 2's "66 vs 67"
puzzle: not instability, the duplicate test doing its job.

**A FOURTH prerequisite, which review of #386 did not find because it needed the archive rather than the
tree: identity resolution.** The augmented duplicate and the clinical split each get a NEW Cypress MRN,
and the duplicate also gets a randomized first name, last name **or** birthdate — so `TWO Diabetes Adult`
and `TWO Diabetes Axult` are one person. The identifier that survives both is the **Medicare Beneficiary
Identifier**; keyed on it, 66 documents resolve to 64 people and 152 to 150, exactly the counts the
expected results were computed over. Four CMS122 patients ship with no MBI at all, so name+birth is the
fallback. `POST /api/runs/:id/evaluate` keys the subject off the first `<id>` extension — the per-document
MRN — so **nothing in the product path does this**, and a real C2 submission would report 68 people where
Cypress expects 64 and fail on arithmetic before any logic was involved.

**Prerequisite 11.2 is measured, not argued: zero subjects move.** The bundle's period is **CY2024**
(despite `bundle-2025.zip` calling itself the 2026 performance period), and the rolling window differs from
it by one day at the start. Re-running both measures on both windows: 0 of 64 and 0 of 150 change
population membership.

**The comparison. IPP 64=64 and 150=150; DENOM 64=64 and 150=150; CMS125's NUMER 2=2.** Per subject,
against Cypress's own per-patient results: **41 of 64 and 122 of 150 agree on every population**, and every
single difference is one direction — `DENEX: cypress=1 workwell=0`. CMS122's numerator inflation (54 vs 31)
is exactly its 23 missed exclusions falling through, which for an inverse measure means the numerator.
**Two artifact properties decide how that table may be read, both verified in the vendored bundles:**
`Denominator` is an `ExpressionRef` to `Initial Population` in both measures, so **DENOM restates IPP —
one agreement, not two**; and fqm sets NUMER false whenever DENEX is true for a proportion measure
(`DetailedResultsBuilder`), so the numerator cannot be read apart from the exclusions. A first draft cited
a harness check that "no subject is in both DENEX and NUMER" as evidence the columns were comparable —
**that check cannot return anything else for these measures** and was removed rather than reported; the
conclusion is carried by the per-subject table, where 23 subjects each show `DENEX −1` and `NUMER +1`.
**Run against BOTH archives** (66/68 and 152/153 documents): every graded number identical, which is the
direct answer to "is a MATCH an artefact of which documents happened to be duplicated".

**The cause is QRDA import coverage, twice, and the MECHANISM of each is confirmed by CONSTRUCTION —
`--inject` makes both a reproducible command, though each is n=1 subject, so that the two causes account
for ALL 23 + 28 differing subjects remains an inference from the datatype inventory and Cypress's own
patient names.**
(1) We translate five QDM datatypes; the exclusion logic reads Assessment Performed, Intervention
Performed/Order, Medication Active, Symptom and Device Order. Adding back the ONE dropped Assessment for
`TWO N Long Care GP Adult` (LOINC 71802-3, SNOMED 160734000 "lives in a nursing home") as a QI-Core
Observation flips it to `denominator-exclusion: true, numerator: false` — Cypress's expected answer for
that patient exactly. (2) `concept()` reads only the primary `<code>` and only from six mapped code
systems, so **4 of CMS125's 10 Procedure entries are dropped for being ICD-10-PCS**, two of them carrying
the SNOMED translation the exclusion value set actually contains; adding those two back flips DENEX the
same way. **This says nothing bad about the artifacts or the executor** — given the data, the official
artifact computes Cypress's answer both times. The gap is between the document and the engine.

**Codex added two more, both the same silent-skip class and both fixed:** the comparison covers
`PopulationSet_1` only — CMS125's two strata carry their own expected results and a C2 submission is
graded on all of them, so the report now names the uncompared sets above the table (the executor package
surfaces only `detailedResults[0]`, so reading fqm's stratifier results is a production change and out of
scope); and an unknown `--per-patient-key` returned `undefined`, which skipped the per-subject comparison
AND the oracle self-check while still printing a plausible aggregate table and exiting 0. It refuses now.

**Review of this branch found two defects in the HARNESS, both fixed and both recorded** — its output is
quoted as evidence, so "the instrument was wrong in a way that produced a plausible number" is exactly the
failure this work is about. The merge picked one document's demographics by **filename sort order**, and
review demonstrated a **false MATCH** by mutating a birthdate in the document that does not win: the table
printed `IPP 64 = 64 MATCH` while discarding a birthdate it had been handed. It never fired in either pass
only because Cypress randomised names both times. Conflicts are now reported (3 people in CMS122, 2 in
CMS125, all on `name`), and the printed label comes from the same document as the evaluated Patient. And
the per-patient export selected a population set on `r['stratification']`, **a field that does not
exist** — so for CMS125 it took whichever of a patient's two rows Mongo returned first; both carry IPP=1,
so a mixed selection can still sum to the right aggregate. Now keyed on `population_set_key`, asserted to
match exactly one row, **re-exported and byte-identical to the file the comparison used** — latent, not
active. Also: `rebuild.rb` printed SETUP DONE over an `errored` test (which is how trap 2 fails), and the
harness now checks its own people count against the oracle's patient count and the per-patient rows against
the aggregate, so an identity artefact surfaces as itself rather than as an apparent engine defect.

**Three smaller findings recorded rather than smoothed over.** `untranslatedTemplates` names the LAST
templateId in the entry, which is routinely a nested ATTRIBUTE template (Author dateTime 31 times, Rank) —
so the diagnostic meant to tell an operator which datatype was lost names something that is not a datatype,
and §16.1's inventory had to be computed independently. `Patient.birthDate` receives a full dateTime
(`1978-12-24T20:30:00Z`) where FHIR types it `date`; it moved no population here but our own exporter would
never produce it. And one document is refused correctly — the half of a clinically split patient that
received only a payer entry, refused under ADR-051, with the merge recovering the person from the other
half.

**What did NOT happen, and the bar is unchanged.** Prerequisite 11.1 is untouched: no HTTP route calls
`finalizeRun`, so an imported run still cannot reach the Cat III export. This went around it by calling the
executor directly — the alternative §11.1 itself named — which measures the calculation and proves nothing
about the submission. `ExpectedResultsValidator` has still never graded a document we produced, so locked
decision #2's import → evaluate → export → CVU+ green **loop** remains unmet. Shipped: the harness
(`scripts/cvu/c2-calculation-check.ts`), the four Cypress-side oracle scripts (`scripts/cvu/c2/`), the
README method, and Part 3 of the evidence doc. No `backend-ts/src` change — the two importer defects are
diagnosed here and fixed in their own PR.

## 2026-08-02 (M-B) — Calculation Check spike: the loop is already built, and it is blocked on one file (branch `docs/cvu-calculation-check-spike`)

Timeboxed spike on #385, asking one question: can Cypress run a Calculation Check against WorkWell for
CMS122/CMS125, and what does it need? **Yes — and every piece WorkWell needs already exists.**

**Calculation Check is the C2 task**, and reading the task models makes the target unambiguous. C1 takes
QRDA Cat I and validates it against what Cypress generated. C2 takes QRDA Cat III and runs
`ExpectedResultsValidator` — comparing OUR numbers against Cypress's precalculated answers for its own
generated patients. C3 adds the CMS Schematron. C2 is §170.315(c)(2) "import and calculate", which is
exactly the shape of what we built.

**The loop C2 defines is already assembled here.** Cypress hands out its test patients as QRDA Category I
("always respond with a .qrda.zip file of qrda category I documents"). We import QRDA-I (ADR-051). We
calculate — and for these two measures on CMS's published artifacts (ADR-045/046). We export QRDA-III,
which as of today validates at 0 findings (#384). Upload that, and `ExpectedResultsValidator` does the
rest. **Nothing needs building.**

**The blocker is a measure bundle, and it is NLM-gated.** This Cypress has none — measured against its
Mongo: products 0, product_tests 0, value sets 0, fs.files 0. Bundles come from
`cypressdemo.healthit.gov/measure_bundles/bundle-<year>.zip`, years 2022–2026, and
`BundleDownloadsController` authenticates with basic auth failing as "Could not verify NLM User Account".
Probed unauthenticated: **HTTP 401**. Same licensing boundary ADR-041 hit for terminology, different
artifact.

**And the #365 trick does not transfer.** That workflow works because the vendor outputs are two small
committable files, with a test asserting the licensed sidecar never leaves the runner. A Cypress bundle
is licensed NLM content *in its entirety*, so routing it through a GitHub artifact IS redistribution —
the thing `vendor-workflow-safety.test.ts` exists to prevent. It has to be downloaded on the machine
running Cypress, by the owner, with the owner's key.

**Also corrected, in #385 and here: the MADiE gate already IS external calculation validation.** The
first draft of #385 called C2 "the first external check of our calculations" and said the document route
says nothing about whether calculations are correct. The second is true of that route; the first is
false. MADiE runs CMS's logic over CMS's patients against CMS's expected vectors, 410/410, through the
executor production uses. What C2 adds is the chain AROUND the executor — ingest, outcome derivation,
aggregation — which MADiE bypasses by handing it a finished bundle. Narrower claim, and the true one.

**Not verified, and stated as such:** whether CMS122/CMS125 are actually in the bundle (very likely —
Cypress covers 56 EP/EC measures — but an inference, not a measurement); whether our Cat III passes
`ExpectedResultsValidator` (conformant ≠ correct, and that is the whole point of C2); and whether our
QRDA-I import handles Cypress's generated patients, which may carry QDM templates beyond the five we
translate. One more self-correction: the first draft of the evidence doc recommended
`rake bundle:import`, which **does not exist** — import is an admin-UI upload driving
`BundleUploadJob`; the only bundle rake tasks are `precalculate_bundle` (which destroys the bundle) and
the `bundle:eval:*` diagnostics.

Evidence: `docs/evidence/CVU_CALCULATION_CHECK_SPIKE_2026-08-02.md`. **Owner step: one file.**

## 2026-08-02 (M-B) — QRDA Category III: 48 findings to 0, and it was carrying a CMS template it never conformed to (branch `fix/qrda3-cda-conformance`)

The evidence doc called Cat III "a larger piece of work and its own decision". It was — but the decision
turned out to be *what to read*, not what to build. Cypress ships a conformant Cat III fixture and the
2026 Schematron inside the container we already had running, so the shape was derivable rather than
guessable. **Both QRDA document types now validate at 0 findings against the HL7 base ruler.**

**The interesting defect: every required element was present and every rule about them still failed.**
`…27.3.3` *is* the Aggregate Count template, and it sat on the OUTER assertion observation with
`…27.3.24` inside. So the validator applied Aggregate Count's rules to the outer element — missing
`MSRAGG`, `methodCode`, `INT` value, three findings per population, 12 per document — while the inner
element that satisfied all three was validated as nothing at all. Correct nesting is Measure Data
`…27.3.5` wrapping Aggregate Count `…27.3.3`. A document can hold everything the IG asks for and score
zero on all of it, if the elements hang off the wrong template.

**The whole CDA header was also missing** — no `recordTarget`, `author`/`time` or `custodian`, all SHALL,
which is what the single XSD error was reporting from the other side (`component` where `recordTarget`
was expected). For an aggregate report `recordTarget` carries `<id nullFlavor="NA"/>`: CDA requires a
patient identifier and this document is about a population, so it is nulled rather than invented.

**And a misdeclaration nothing flagged.** `…27.1.2` is "QRDA Category III Report — **CMS** (V4)", claimed
here with extension `2017-06-01` against a real `2022-12-01`. **The HL7 ruler stayed silent precisely
because the extension was wrong too** — it matched no rule at all, so being more nearly right would have
made it visible. Dropped, for the reason ADR-050 dropped Cat I's `…24.1.3`. Found by reading fixtures,
not by a finding, which is the argument for reading them.

Also: templateId version drift, the performance rate moved from `…27.3.4`/`REASON` to
`…27.3.14`/`…27.3.30` with LOINC `72510-1` and a reference to the numerator it rates, and each Measure
Data observation now names the population criterion it counts (CONF:3259-18239) — the published
`Measure.group.population.id` for an official measure, the population code otherwise.

**Measured: 48 → 0.** Five regression tests pin it in TypeScript because CI runs neither CVU+ nor a
schema validator, and the nesting test is mutation-checked (reverting the templates fails exactly the
two tests that should catch it). Suite 1791, 0 fail. Running total across the day: 240 → 40, and every
remaining finding is a CMS Hospital templateId ADR-050 deliberately does not claim. **Locked decision
#2's bar is still not met** — this is the export leg, not the loop; Calculation Check has never run.

## 2026-08-02 (M-B) — the conformance matrix catches up, and one row was two onboardings stale (branch `docs/conformance-cvu-claims`)

The CVU+ result was recorded in evidence and CLAUDE.md but the two documents anyone *else* reads —
`STANDARDS_CONFORMANCE.md` and `README.md` — still said CVU+ had not run. Claiming less than you can
demonstrate is cheap; the risk in fixing it is claiming more, so every upgrade here is scoped to what
the validator actually returned.

**QRDA Category I upgraded** from "Schematron-clean … NOT CVU+-validated" to **CVU+-validated at 0
findings against the HL7 base IG, XSD and Schematron alike** — 10 documents, CMS122/CMS125, five-target
synthetic corpus, Cypress v7.5.1 at the pinned image digest. The row now carries the correction to its
own older sentence: that "0 base-HL7 errors" was confirmed *exactly* by CVU+ and was narrower than it
read, because `qrda-schematron-check.py` has no XSD in it and 76 findings lived in that gap.

**QRDA Category III stays a stub but stops being merely asserted to be one:** 48 findings, split into
templateId version drift (`2017-06-01` vs R2.1's `2020-12-01`/`2016-09-01`) and genuinely absent
structure, with each cited CONF number verified present in the captured responses before it was written
down. The single XSD error is the same finding from the schema side — `component` where `recordTarget`
should be, because `recordTarget` is absent.

**And a row nobody had touched in two onboardings: the MADiE gate said 231/231 across five measures.**
It is **410/410 across eight** — CMS138 took it to 278 (ADR-053), CMS130+CMS165 to 410 (ADR-054).
Verified from `OFFICIAL_GATED_MEASURES` rather than from the journal: eight keys, and
55+66+36+19+55+47+64+68 = 410. The README had been refreshed to 410 on 2026-08-01; the conformance
matrix had not, which is the more consequential of the two to be wrong. Also recorded there, because a
bare "410/410" flattens it: **CMS138's green is a weaker claim than the other seven** — upstream ships
its bundle one value set short, so four of its codes are ours while the expected vectors stay upstream's.

**What was deliberately NOT upgraded.** Locked decision #2's bar is the import → evaluate → export →
CVU+ green **loop**; this is the export leg, over synthetic data, via the externally-supplied-document
route. The **Calculation Check path has never run**, so nothing here says our calculations are right.
The official-vs-authored parity row keeps "the oracle is our own authored engine" — CVU+ has never been
pointed at that question. And the authored path still emits `urn:workwell:measure`, non-conformant by
design and pinned by a test.

## 2026-08-02 (M-B) — QRDA Category I passes the HL7 base ruler: 76 findings to 0, measured (branch `fix/qrda1-cda-schema-conformance`)

The findings from this morning's CVU+ run were three defects, and the arithmetic said so exactly:
56 + 10 + 10 = 76. All three are fixed and the same 22 submissions re-run against the same Cypress
instance. **Category I: 0 against the HL7 base ruler**, XSD and Schematron alike, on all ten documents.
Not a re-derivation — the documents were regenerated and re-uploaded.

**`@root` (56).** CDA's `II.root` is typed `uid` = `oid|uuid|ruid`, and `urn:workwell:employee`,
`:device`, `:custodian`, `:fhir` are none of those. Now four UUID constants in `qrda-common.ts`. Two
decisions inside that: **UUID rather than an OID arc**, because WorkWell holds no registered arc and
asserting an unregistered OID is a *false claim of a registered identity* — strictly worse than a UUID,
which asserts a private domain and nothing more (owner's call; if MIE assigns an arc, those four
constants are the only place that changes). And **generated once, hardcoded**, because a per-run
`randomUUID()` would give the same employee a different identifier domain on every export — the opposite
of what a root means, and it would still pass the schema, so nothing would catch it.

**`versionNumber` (10).** The eCQM version STRING `1.0.000` was going into a CDA `INT`. Correct as
identity, wrong as a type. Now the major component via `cdaVersionNumber`, which returns `null` rather
than guessing when the version does not start with digits — omitting an optional element is conformant,
emitting an invalid one is not. Nothing is lost; the exact version is already pinned by the
version-specific eMeasure UUID in `<id>`.

**`<text>` (10).** It sat inside `<externalDocument>` *after* `setId`/`versionNumber`, where CDA's
sequence is `id, code, text, setId, versionNumber`. Dropped rather than moved: `ExternalDocument/text`
is an ED describing the referenced document's content, a bare measure id is not that, and `<id>`/`<setId>`
already carry the identity.

**The authored path deliberately still fails.** It keeps `urn:workwell:measure`, and a test pins that as
the ONLY invalid root left. ADR-046 decision 3 forbids inventing a published eMeasure identity and
ADR-051 concluded the authored catalogue is not QRDA-representable at all — so that document is
non-conformant *by design*, and the invalid root is the honest marker of it. A valid-looking UUID would
hide the fact rather than fix it. What the test enforces is that the exception has not spread to the
subject, device, custodian or resource roots.

**Also corrected, both of the same family as the run that found them.** `qrda1-import.ts`'s `idOf`
comment called `urn:workwell:fhir` "our own root" in a way that read as a dependency — the function is
root-agnostic, which is exactly what let the export's root change without touching ADR-051's round trip.
And `qrda1-export.test.ts`'s header presented "0 base-HL7 errors" as though it were a conformance
result; it is a **Schematron** result, and the XSD layer it never covered is where all 76 of these lived.

Remaining: **40** Category I findings against the CMS ruler — exactly 4 per document, all CMS Hospital
templateIds ADR-050 decided not to claim, undisturbed. **QRDA Category III unchanged at 48**; none of
these three touches its absent structure or templateId version drift, and that is its own piece of work.
Locked decision #2's bar is still not met — this is the export leg, not the CVU+ loop.
Backend suite 1790 tests, 0 fail. Evidence: `docs/evidence/CVU_VALIDATION_RUN_2026-08-02.md` §9.

## 2026-08-02 (M-B) — the first CVU+ result exists, and it says our own ruler had no XSD in it (branch `feat/cvu-validation-findings`)

Twenty-two documents went into Cypress CVU+ 7.5.1 and came back with 240 findings. That is the headline
only in the sense that a number now exists where none did; the useful part is which of them we already
believed and which we did not.

**Both recorded blockers were cleared, and only one had been real.** #376 stopped on "absent official
terminology sidecars" and Docker. The sidecars were never absent — that pass ran inside a git worktree,
and `terminology.json` is gitignored by design (ADR-036), so it cannot exist there. It was present in the
primary tree the whole time. The runbook's advice — regenerate through the approved vendoring process —
would have "worked" by re-fetching what was already on disk one directory up, and the uncredentialed form
of that command **reverts ADR-041's completed expansions back to capped**. The worktree in question still
holds exactly that as uncommitted changes to five manifests; left untouched and flagged, because
committing it would make cms122/cms125 unroutable and fail the deploy-blocking reproducibility gate.

**Then the generator still produced 0 documents**, twelve times over: `invalid ISO date for QRDA
effectiveTime: 2024-06-01T23:59:59.999ZT23:59:59.999Z`. `officialMeasurementPeriod` returns an asymmetric
pair on purpose — `start` date-only, `end` already pushed to end-of-day by the fqm#371 workaround — and
the fixture script appended a time suffix to both, so `start` was right by luck. Fixed by guarding on the
date-only shape the way `normalizePeriodEnd` guards itself. `literal-diff.ts`, the only other caller,
hands the pair to `calculateOfficial`, which re-normalizes idempotently, so it was never affected. **12
documents, 0 failures**, all 10 subjects in the official initial population.

**ADR-050's claim is externally confirmed, and is narrower than it reads.** Across all 10 Category I
documents the base-HL7 **Schematron** produced **0** findings — exactly what ADR-050 recorded. And the
CMS ruler costs exactly **+4** on every one of the ten, all four the CMS Hospital templateIds ADR-050
decided not to claim. CVU+ knows nothing about our partition and reproduced it on the nose.

**But CVU+ runs a layer we never did.** `qrda-schematron-check.py` measures "against the published
Schematron" — its own first line — and has no XSD in it. CVU+ runs `CqmValidators::CDA` first, and every
Category I document fails it 6–10 times: `@root` carrying `urn:workwell:*` where CDA's `uid` type wants
an OID or UUID (56 of the 76), `versionNumber="1.0.000"` in an `INT` (10), and a `<text>` inside
`externalDocument` (10). 76 accounted for exactly, so fixing those three takes Category I to zero against
the HL7 base ruler. Not a guard that could not fire — a guard whose scope was narrower than the claim it
got cited for, and invisible because the only instrument aimed at the document had no schema check in it.

**QRDA Category III is quantified for the first time:** 24 each, 23 of them Cat III Schematron. ADR-009
called it "a structurally-representative stub" and that is now a number. Two separable causes: templateId
version drift (`2017-06-01` where R2.1 wants `2020-12-01`), and genuinely absent structure — no
`recordTarget`, `custodian`, `author/time`, `methodCode`, `MSRAGG`, `statusCode`, `reference`, or
Aggregate Count. The single XSD error is the same finding from the schema side: `component` sits where
`recordTarget` should be, because `recordTarget` is not there.

**What this is not.** It is the externally-supplied-document route, not Calculation Check. Nothing here
says our calculations are right. Locked decision #2's bar — import → evaluate → export → **CVU+ green** —
is **not met**; this measures the export leg's distance from it. No conformance claim in `README.md` or
`STANDARDS_CONFORMANCE.md` was touched, per #379's scope. Also corrected in the runbook — **and then corrected again, because the
first correction overgeneralized.** `GET /qrda_validation` returns **500** and the POST returns **422**
under curl's default `Accept: */*`, since the controller is `respond_to :xml, :json` with no HTML
template. I wrote that up as "the `.json` suffix is required"; Codex's review flagged that the runbook's
own commands still used bare routes, and measuring all four combinations showed why that was harmless —
those commands already sent `Accept: application/json`, which returns 200/201. It is **content
negotiation, not the path**, and the defect was in my prose rather than in the commands. The suffix is
now belt-and-braces on both.

Evidence: `docs/evidence/CVU_VALIDATION_RUN_2026-08-02.md`.

## 2026-08-01 — Documentation refresh

Refreshed README.md and docs/ROADMAP_2026-07-24.md to reflect current reality: the MADiE gate now covers eight measures at 410/410 (was five measures at 231/231); cms122 and cms125 are routed to official execution in production, while six more measures are vendored and MADiE-gated but not routed — CMS2, CMS130, CMS138, CMS165, and CMS951 are routable but not yet routed, while CMS68 is additionally unroutable because episode-of-care support (population basis = Encounter) is unbuilt in the official executor (ADR-047).

Cypress CVU+ tooling is stood up but not yet run, QRDA Category I import/export API routes are documented, and the stale **PR-3 (NEXT)** label is corrected to shipped; this was a docs-freshening pass, not a feature.

## 2026-08-01 (M-B) — Cypress CVU+ stand-up recorded; QRDA fixture generation remains blocked

Cypress CVU+ v7.5.1 was cloned and booted successfully in Docker in the prior stand-up. The measured
application image is `workwell/cypress-round1:v7.5.1` with digest
`sha256:df920e01133ae2f2b22d70dc1e3694d5127257fcf1dc3b486f1194adf40906ac`; the stack is Ruby 3.4.9,
Rails 8.1, MongoDB 8.0.9, and `mitrehealthdocker/cqm-execution-service:latest`. The external-document
validation route is `GET /qrda_validation` followed by multipart
`POST /qrda_validation/:year/:qrda_type/:organization` with form field `file`; it requires a local
Cypress user and is distinct from the Product/ProductTest Calculation Check path.

This checkpoint added `scripts/cvu/generate-qrda-fixtures.ts`, its reference runbook and Docker files,
and the evidence record at `docs/evidence/CVU_FIRST_RUN_2026-08-01.md`. The generator attempted all five
ADR-038 subjects for each of CMS122 and CMS125, but the local official terminology sidecars were absent:
CMS122 refused at 26/26 value sets and CMS125 at 32/32. It therefore produced 0 QRDA-I and 0 QRDA-III
documents and recorded the 12 failures in the scratch manifest. Docker is down now, so no document was
submitted and CVU+ produced no pass/fail result, rule id, or error count. This is a reproducible
checkpoint toward M-B, not completion of the milestone.

---

## Earlier entries (archived 2026-09-01)

This file had grown to **1.17 MB / 311 entries**, which defeated its own purpose: the journal is
supposed to be the readable narrative of recent work, and at that size nobody scrolls it and nothing
loads it. Entries from 2026-07-31 backwards moved to the archive **verbatim** — nothing edited,
summarised or dropped:

- **`docs/archive/JOURNAL_2026-07.md`** — July 2026, 110 entries. The official-execution run
  (PR-1 → PR-9c, ADR-036…046), QRDA I and III, and the start of M-C.
- **`docs/archive/JOURNAL_2026-04_06.md`** — April–June 2026, 152 entries. The spike, the de-Java
  re-platform (#96 / ADR-008), and epics E10–E16.

Keep the split going: when this file next passes ~300 KB, cut the oldest complete month out to
`docs/archive/JOURNAL_<YYYY-MM>.md` and add a line here. Do not summarise on the way out — a
journal that has been compressed is no longer evidence of what happened.
