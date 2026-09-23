# Open questions — the Maui pilot

> **A living register, not a dated snapshot.** Each entry carries the date it was raised and its
> current status; answers are recorded in place and the entry is struck through rather than deleted,
> so a question answered once is not asked again. Add the answer and the date, and move it to
> §4 when it is closed.
>
> **What belongs here:** a question whose answer changes what we build or what we promise, addressed
> to somebody outside the repo — the pilot group, the ACO, or the owner. Engineering work belongs in
> a GitHub issue. Several of these have a filed issue for the *build* half; the issue is named where
> one exists, and the question is what that issue waits on.
>
> **What does not belong here:** anything that can be decided by reading the code, and anything
> already answered. This file exists because an unanswered question with no home decays silently —
> every entry below had been raised at least once, some three times, with no record of an answer.

**As of 2026-09-23.** Eight open.

---

## 1. For the pilot group

### 1.1 Does WorkWell serve the separate MIPS group submission?

**Raised:** twice, in two separate meetings (2026-08, 2026-09). **Status:** unanswered.

The practice carries a MIPS group reporting obligation distinct from the ACO's APP Plus submission.
The stated reason it differs: the group includes hospitalists and radiologists who sit outside the
ACO-attributed population, so the denominators are not the same people.

`ROADMAP_2026-08-30.md` §7.11 records that whether WorkWell is expected to serve that submission
**is still unasked**.

**Why it needs an answer before more is built:** it changes the scope of the measure catalog, the
attribution model and the export surface at once. Every one of those is currently designed around a
single attributed population. Building further on that assumption and then discovering a second
population is the expensive order.

### 1.2 Which health plan, and can we have its metric list?

**Raised:** three times — by the practice unprompted (2026-08), in the sandbox handover (2026-09-03),
and independently described by the ACO from their own side. **Status:** unanswered.
**Build issue:** #638.

The ask is that WorkWell show the measures a payer requires, not only the ACO's six. It stays
open-ended until there is **one named plan and its actual metric list**, at which point the real
question — are those metrics computable from data we already ingest? — becomes answerable.

Asking for one plan's list is a smaller request than it sounds and turns a standing ask into scoped
work. Designing against a general case first would be designing against nothing.

### 1.3 The pilot group has not been told their numbers changed — twice

**Raised:** not a question. An outstanding communication. **Status:** unsent, and **no longer held**:
it waited on a corpus change that was decided against on 2026-09-23, so it can go now.
**Related issue:** #637.

| when | what moved | cause |
|---|---|---|
| 2026-09-10 | rates moved 8–54 points; CMS122 went 7.4% → 72.4% on an inverse measure | ADR-078 / ADR-079 — out-of-population subjects left the denominator |
| 2026-09-22 | every measure fell; CMS122 72.4% → 52.8%, CMS165 62.4% → 45.2% | ADR-086's corpus cutoff (#595): the nightly now scores **year to date as of the run**, where it had been scoring the full year from future-dated facts. Confirmed 2026-09-22 by an exact reproduction. The fabrication fix (#594) moved nothing |

Both movements are corrections. The first removed people who were never in the measure's population
from its denominator; the second stopped the sandbox knowing about visits and results that had not
happened yet. Neither has been explained to the people reading the dashboard.

**What the message must also say:** the rates now rise a little every night until 31 December,
because the year is filling in, not because care is improving. And **on 1 January 2027 every measure
starts again near zero** — each counts only patients seen during the measurement year, so the first
days hold a handful of patients and fill in through January, as a real year-to-date report does. The
page says which year it shows, gives no rate until someone is counted, and flags rates resting on a
handful of patients. The 2026 results stay reachable: the attributed-list report's year selector and
the run history's 31 December run.

**This is the most time-sensitive item in this file.** One unexplained movement is a question. Two is
the point at which somebody stops believing the number, and a dashboard nobody believes is worth
nothing regardless of whether it is right.

---

## 2. For the ACO

### 2.1 The prioritised report list, and a hand-off cadence

**Raised:** promised on the 2026-09-09 call. **Status:** not received.
**Related issue:** #596 (the reporting asks that nothing tracks).

Two halves, and the second is ours to build once the first arrives:

- **The list** — which reports matter, in what order. Recorded in `ROADMAP_2026-08-30.md` §7.5 and
  never supplied.
- **The cadence** — how often a report is handed over, and in what form. This is a product
  requirement, not a scheduling detail: a report delivered on a cadence has to be generated on a
  schedule and retained, which is a durable archive (#580) rather than a download button.

### 2.2 The ACO's own structure — which track, and who is benchmarked against whom

**Raised:** 2026-09. **Status:** unanswered.

`ROADMAP_2026-08-30.md` §7.17 records this as *ask before building anything that assumes a single
flat ACO*.

It decides who submits, against which benchmark, and at what level performance is compared. The
scorecards in #596 cannot be designed without it — a scorecard is a comparison, and nothing here
currently knows what the comparison set is.

### 2.3 Confirm that 837/835 claims files are out of scope

**Raised:** 2026-09, in a meeting where WorkWell was the system being demonstrated.
**Status:** believed out of scope, never stated.

Claims files belong to the practice-management system. WorkWell does not read them and there is no
plan that it should.

Nothing written says so, which is why it will be asked again. One sentence in a reply closes it
permanently; leaving it unsaid does not.

---

## 3. For the owner

### 3.1 Does the per-patient compliance API stay?

**Raised:** once, then immediately walked back in the same conversation. **Status:** unresolved.

`ROADMAP_2026-08-30.md` §7.18 records that an instruction to remove this surface was withdrawn within
the same minute, and that no record exists of the conversation that followed.

The surface ships today: it is versioned, documented in `COMPLIANCE_API.md`, and served. Locked
decision §4A.4 demotes the compliance API from "the contract MIE consumes" to a kept, versioned
surface — which settles its *priority* and not its *existence*.

**Why it is worth one question rather than leaving it:** it is a documented public surface. If it is
going away, it should not be demonstrated to anyone first; if it is staying, the ambiguity should stop
costing a paragraph in every roadmap revision.

### 3.2 Should a failed evidence upload still show on the case timeline?

**Raised:** 2026-09-21 (review of #612). **Status:** unresolved.

`uploadEvidence` writes its audit event before the storage write, which is the audit-first rule. The case
timeline reads audit events, so an upload that then fails leaves an "Evidence uploaded — <filename>" row
with nothing to download. The rule picks the over-claim side for the ledger; whether an operator screen
should show it is a separate call.

---

## 4. Answered

*(Nothing yet. Move an entry here with its answer and the date it was given.)*
