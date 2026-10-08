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

**As of 2026-10-08.** Twenty-one open; one answered (§5).

---

## 1. For the pilot group

### 1.1 Does WorkWell serve the separate MIPS group submission?

**Raised:** twice (2026-08, 2026-09). **Status:** answered in part 2026-09-09: from 2027 the practice
participates as a MIPS APM, its quality is reported at the ACO level through APP, and practice-level
reporting is optional. Still open: if the practice chooses to report at practice level, does it expect
WorkWell to serve that submission?

The practice's group includes clinicians outside the ACO-attributed population (hospitalists and
radiologists), so a practice-level submission would cover different people from the ACO's. WorkWell is
designed around a single attributed population; a second one changes the measure catalog, the
attribution model and the export surface at once.

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

### 1.4 What does the practice record as meeting each measure, and how are unconfirmed conditions kept?

**Raised:** 2026-09-10. **Status:** unasked as a written question. Feeds the data-coverage work.

- For each of the six measures, which entries does the practice treat as meeting it: a diagnosis, a
  document type, a CPT code, a result? A measure reads only coded data, so an entry that is not coded
  the way the measure's value set expects is a gap in WorkWell even where the practice considers it done.
- Are conditions that are suspected or not yet confirmed recorded as unconfirmed (a verification
  status), or as ordinary diagnoses? Read as confirmed, they put patients into denominators they do not
  belong to.

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

**Raised:** 2026-09. **Status:** partly answered 2026-09-09: the pilot group was described as entering
MSSP for 2027 (the track was named as "A"; to confirm in writing, and dependent on the CY2027 final
rule). Still unknown: the track as MSSP names it, the benchmark, and the level at which performance is
compared.

`ROADMAP_2026-08-30.md` §7.17 records this as *ask before building anything that assumes a single
flat ACO*.

It decides who submits, against which benchmark, and at what level performance is compared. The
scorecards in #596 cannot be designed without it — a scorecard is a comparison, and nothing here
currently knows what the comparison set is.

*(2.3 is answered; see §5.)*

### 2.4 Does the ACO want CMS137 for 2027?

**Raised:** 2026-10-08. **Status:** unasked.

The CY2027 proposed rule would remove Quality ID 305 (CMS137) from APP Plus, and the final rule is
expected around November. WorkWell is set up to score CMS137's 2027 periods with its own translation
(routed on Maui, #767). If
the ACO does not want it whatever the rule says, it should come off the pilot's catalog rather than sit
on every screen.

### 2.5 Every patient, or only the ACO's attributed patients?

**Raised:** 2026-10-08. **Status:** unasked.

The attributed-list report (#654) scores whichever patients are on the list. Whether the ACO wants
quality for every patient the practice sees, or only for the patients the ACO attributes to the
practice, decides what the list should hold and what the report's denominators mean.

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

4.1–4.7 were raised 2026-10-02 from a check of the teatea trial, the docs and the dev database (the facts
are in `WEBCHART_API_ASSUMPTIONS_2026-07.md`, "Verified on the teatea trial"). 4.1, 4.2 and 4.6 were put
to MIE on 2026-10-02, and 4.4 and 4.5 in part; 4.3 and 4.7 have not been asked. 4.8–4.10 were written
down 2026-10-08; 4.11 comes from #663.

### 4.1 Can WebChart call WorkWell at the point of care?

**Status:** asked 2026-10-02. On 2026-10-07 MIE said any WebChart change goes through a written request
to its product team; that request is the route for this question.

The 2026-10-02 check found no CDS Hooks client that could call WorkWell: no setting, table or
documentation mentions one. Its own decision support is Scripted Rules, which MIE programs and which
cannot call out.
- WorkWell's CDS service (`CDS_HOOKS.md`) is built and live, so the question is the caller.
- Is a CDS Hooks client planned, in the classic UI or the new UI?
- If one exists or is coming: which hook fires (WorkWell answers `patient-view`); can it call a service
  that is not a payer's; does it send the patient's data with the request (prefetch); what are its `iss`
  and its JWKS URL; and how does it display a card?
- If not, can a SMART app open from inside a chart (a chart tab, with the open patient's context)? The
  smart-configuration advertises `launch-ehr`; the docs put the launch on a home-page portlet with a
  patient picker.

### 4.2 Do the API terms apply to WorkWell?

**Status:** asked 2026-10-02; unanswered.

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

**Status:** asked in part 2026-10-02 (how exceptions should count); where WebChart records them is not
yet asked.

WebChart's own measure pages point hospice, palliative care and frailty to a "Long-Term, Chronic, and End
of Life Care" page that is not published. Mastectomy (CMS125) and colectomy (CMS130) have no documented
workflow. CQL only sees what reaches FHIR.

### 4.5 Can WorkWell read changes and write back?

**Status:** asked in part 2026-10-02 (an outbound HL7 trigger, and the code an outreach encounter should
carry). #641 (change signal), #565 (write-back).

- Can a Refer-to-System send WorkWell HL7 events (ADT, ORU, MDM, SIU) over HTTPS?
- Can MDM^T02 come in with an agreed document type?
- Can an outside system create an assigned encounter, or a pending Due List order?
- Bulk export: how is the Group id for a practice's patients discovered, and is `_type` meant to be
  honoured?
- Can `Coverage.type` carry the plan's Source of Payment Typology code?

### 4.6 How should scanned screening documents count?

**Status:** asked 2026-10-02; answered in part. MIE's quality team confirmed that a document alone does
not meet a measure: only a result recorded in discrete, coded fields counts. Still open: who tells the
pilot group, and what WebChart's Preventive Care "last reported" date counts for.

WebChart can show a scanned mammogram, colonoscopy, FOBT or similar document, and a Preventive Care "last
reported" date, as screening evidence on its own screens. Over FHIR these are mostly untyped
DocumentReferences that the CMS measures do not read, so a patient whose only evidence is a scanned
document is a gap in WorkWell. The pilot group needs to hear that before anyone compares the numbers.

### 4.7 Which result statuses mean a final result?

**Status:** unasked.

The dev database's `observations.obs_status` holds only `''`, `F` and `DELETED`, so the dev tools read
`''` and `F` as final and leave everything else out. A result that was preliminary, corrected or never
obtained would count toward a measure if it were read as final. On the trial, FHIR serves blood-pressure
panels with `status: unknown`.
- Which `obs_status` values does WebChart write, and which are final?
- How does WebChart's FHIR server map them to `Observation.status`?
- Blood pressure: which key does WebChart's FHIR layer use to pair a systolic and a diastolic reading into
  one panel, why do the panels arrive with `status: unknown` (CMS165 accepts only final, amended or
  corrected), and is `Observation.encounter` set (CMS165 leaves out readings taken in an emergency or
  inpatient visit)?

### 4.8 Can WorkWell read which measures a practice is enrolled in?

**Status:** discussed with MIE 2026-10-07; not yet asked in writing.

WebChart keeps quality-reporting enrollment per provider, per measure and per period. WorkWell's measure
list is configured per deployment today, so it would show a gap for a measure the practice is not
enrolled in.
- Is the enrollment exposed over FHIR or bulk export, or only inside WebChart?
- When a provider is enrolled in a new measure, could WebChart notify WorkWell?

### 4.9 Which order and medication data does WebChart's FHIR server carry?

**Status:** raised 2026-10-08; unasked. Feeds #713.

- `DeviceRequest` is not in the trial's CapabilityStatement. Where do device orders (walkers,
  wheelchairs, oxygen) live? Four measures read them for the frailty exclusion.
- Is `_include=MedicationRequest:medication` supported? Without it, every referenced Medication is a
  separate read.
- How are a medication order's `status` and `intent` filled, and does it carry a dosage or days' supply?
  The measures' active-medication logic needs them.

### 4.10 Can WebChart score the Cypress test patients, and share its results?

**Status:** discussed with MIE 2026-10-07; unanswered.

WorkWell's agreement with the 2027 Cypress decks is measured patient by patient. WebChart's own results on
the same patients would show in advance where the two systems' numbers will differ, and why.

### 4.11 Does Create-a-Container restart an exited process, and can it health-check over HTTP?

**Status:** raised 2026-09-22 in #663, and asked there; unanswered.

Part B of #663 (exiting on a stall, so the platform restarts the worker) is safe only if the platform
restarts an exited process. Without that, exiting would leave Maui down until the next self-heal.

---

## 5. Answered

### 2.3 Are 837/835 claims files in scope?

**Raised:** 2026-09. **Answered 2026-09-09:** the ACO asked for the 837/835 files, and the practice will
export them from its practice-management system. WorkWell is not in that path and does not read claims
files.
