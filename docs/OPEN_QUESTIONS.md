# Open questions — the Maui pilot

> **A living register, not a dated snapshot.** Each entry carries the date it was raised and its
> current status; answers are recorded in place and the entry is struck through rather than deleted,
> so a question answered once is not asked again. Add the answer and the date, and move it to
> §5 when it is closed.
>
> **What belongs here:** a question whose answer changes what we build or what we promise, addressed
> to somebody outside the repo — the pilot group, the ACO, MIE, or the owner. Engineering work belongs in
> a GitHub issue. Several of these have a filed issue for the *build* half; the issue is named where
> one exists, and the question is what that issue waits on.
>
> **What does not belong here:** anything that can be decided by reading the code, and anything
> already answered. This file exists because an unanswered question with no home decays silently —
> every entry below had been raised at least once, some three times, with no record of an answer.

**As of 2026-10-02.** Fifteen open.

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

## 4. For MIE

Raised 2026-10-02 from a check of the teatea trial, the docs and the dev database (the facts are in
`WEBCHART_API_ASSUMPTIONS_2026-07.md`, "Verified on the teatea trial"). None has been asked yet.

### 4.1 Can WebChart call WorkWell at the point of care?

**Status:** unasked.

WebChart has no CDS Hooks client: no setting, table or documentation mentions one. Its own decision
support is Scripted Rules, which MIE programs and which cannot call out.
- WorkWell's CDS service (`CDS_HOOKS.md`) is built and live, so the question is the caller.
- Is a CDS Hooks client planned, in the classic UI or the new UI?
- If not, can a SMART app open from inside a chart (a chart tab, with the open patient's context)? The
  smart-configuration advertises `launch-ehr`; the docs put the launch on a home-page portlet with a
  patient picker.
- If a CDS Hooks client is coming: what are its `iss` and its JWKS URL?

### 4.2 Do the API terms apply to WorkWell?

**Status:** unasked.

The published Terms of API Use forbid storing User Content beyond a session and cap use at 15,000 calls
per app per day. WorkWell stores outcomes and evidence. A nightly over a practice through per-resource
searches would exceed the cap; bulk export would not.

### 4.3 Which provider is a patient's PCP?

**Status:** unasked. Blocks the panels on live data (#564).

`user_patients` roles hold a patient's providers, and "Primary Care Physician" (role 290) exists unused.
`Patient.generalPractitioner` follows the attending physician on the trial.
- Which role does the pilot group use?
- Can FHIR carry it?

### 4.4 Where are the measure exclusions recorded?

**Status:** unasked.

WebChart's own measure pages point hospice, palliative care and frailty to a "Long-Term, Chronic, and End
of Life Care" page that is not published. Mastectomy (CMS125) and colectomy (CMS130) have no documented
workflow. CQL only sees what reaches FHIR.

### 4.5 Can WorkWell read changes and write back?

**Status:** unasked. #641 (change signal), #565 (write-back).

- Can a Refer-to-System send WorkWell HL7 events (ADT, ORU, MDM, SIU) over HTTPS?
- Can MDM^T02 come in with an agreed document type?
- Can an outside system create an assigned encounter, or a pending Due List order?
- Bulk export: how is the Group id for a practice's patients discovered, and is `_type` meant to be
  honoured?
- Can `Coverage.type` carry the plan's Source of Payment Typology code?

### 4.6 How should scanned screening documents count?

**Status:** unasked.

WebChart counts a scanned mammogram, colonoscopy, FOBT or similar document, and a Preventive Care "last
reported" date, as screening evidence. Over FHIR these are mostly untyped DocumentReferences that the CMS
measures do not read. So a patient can be compliant in WebChart and a gap in WorkWell. The two must be
reconciled before anyone compares the numbers.

### 4.7 Which result statuses mean a final result?

**Status:** unasked.

The dev database's `observations.obs_status` holds only `''`, `F` and `DELETED`, so the dev tools read
`''` and `F` as final and leave everything else out. A result that was preliminary, corrected or never
obtained would count toward a measure if it were read as final. On the trial, FHIR serves blood-pressure
panels with `status: unknown`.
- Which `obs_status` values does WebChart write, and which are final?
- How does WebChart's FHIR server map them to `Observation.status`?

---

## 5. Answered

*(Nothing yet. Move an entry here with its answer and the date it was given.)*
