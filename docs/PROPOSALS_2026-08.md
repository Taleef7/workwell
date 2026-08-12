# Feature proposals — 2026-08

**These are proposals for owner and MIE review. None is approved, scheduled, or committed to.** Nothing
here has been built, and writing it down is not a plan to build it. Each proposal is one page: what the
thing is, how it maps onto machinery that already exists, what would actually have to be built, and the
questions that are open. Where a proposal would need a schema change, that change is the owner's — the
standing rule that schema and DDL are never written or applied by an agent applies to every line below.

Each proposal names its open questions rather than answering them. Some of those questions change the
shape of the feature, not just its polish; a proposal whose open questions were quietly resolved in the
writing would be a design document pretending to be a sketch.

Companion to the guide work of the same date (PR #457), which documented existing behaviour and proposed
nothing.

---

## P1 — Encounter-close quality check

*Tracking: [#458](https://github.com/Taleef7/workwell/issues/458)*

### What it is

When a clinician finishes an encounter in WebChart, show that patient's open measure gaps before the
encounter is closed — while the patient is still in front of them and an order can still be placed. Today
a gap surfaces in a nightly population run and reaches the patient through outreach, which is days later
and a different person's job. This moves the same answer to the point of care.

### How it maps onto what exists

The per-subject question is already a contract. `GET /api/v1/compliance/{subjectId}/{measureId}?start=&end=&mode=latest|preview`
(ADR-061, `backend-ts/src/routes/compliance-api.ts`, contract in `docs/COMPLIANCE_API.md`) answers *is
this patient compliant with this measure*, in a stable shape, with `populationsSource` stating whether the
population booleans are the executor's own measured vector or inferred from status. That honesty field
matters more at the point of care than anywhere else, because a clinician reading a screen has no way to
ask where a number came from.

Patient identity across the seam also exists: the WebChart transport (ADR-028) composes a per-patient
bundle over the real FHIR contract (`backend-ts/src/engine/ingress/webchart/webchart-client.ts`), so a
WebChart patient id maps onto a WorkWell subject id the API can be asked about. Note the namespace — the
live directory persists subjects as `wc|<patientId>`
(`backend-ts/src/engine/ingress/webchart/live-directory.ts:91`,
`backend-ts/src/run/run-pipeline.ts:433`), and the compliance API looks up exactly that string, so a bare
WebChart id is a 404 rather than an answer.

### What would have to be built

Three distinct pieces, none of them a configuration change.

1. **A trigger and a surface on the WebChart side.** Nothing in WorkWell can observe an encounter closing.
   This would require a WebChart-side change, which is MIE's to make.
2. **A multi-measure variant of the question.** The v1 contract is deliberately one subject and one
   measure per request, with no cohort endpoint (`docs/COMPLIANCE_API.md`, "Limits, stated"). "All gaps
   for this patient" is a different response shape and a different performance profile, so it is a new
   endpoint rather than a parameter.
3. **A live evaluation path for a WebChart deployment.** This is the substantive one. `mode=preview`
   returns **501** on a WebChart-configured stack today, on purpose: preview composes a *synthetic*
   bundle, so answering with it over a real patient would be demo playback reported as an evaluation
   (`compliance-api.ts:354–375`). `mode=latest` reads what a run actually computed, which is truthful but
   as old as the last run. A point-of-care check that reflects data entered during the visit needs live
   per-request composition through the transport — a new capability with its own failure modes, not a
   flag flip.

### Open questions

- **Integration surface.** A WebChart UI panel, an embedded WorkWell view, or an API only, with MIE
  building the presentation? Each puts the work in a different place and a different repository.
- **Latency budget.** A pre-close check is synchronous in a clinician's workflow. Our documented figure is
  about 68 ms per person for authored logic (guide chapter 1), but that excludes composing a live bundle
  over the transport, which is the unmeasured part. What is the acceptable ceiling, and what should the
  screen show when it is exceeded?
- **Measure set.** Only measures running CMS's published artifacts, where `populationsSource` is
  `official-evidence`, or every measure applicable to the patient? The second is more useful and less
  precise.
- **Who acts on the answer.** A gap shown at close is either an order the clinician places or a note
  someone else follows up on. That decision determines whether this is a display feature or an ordering
  one.

---

## P2 — "Not seen in a while," with quality status

*Tracking: [#459](https://github.com/Taleef7/workwell/issues/459)*

### What it is

Given a measure, or the whole catalog, list the patients whose most recent encounter is older than some
number of days, alongside their current compliance status. It is an outreach-targeting view: the people
worth contacting are usually the intersection of *overdue* and *not seen*, and neither list alone
identifies them.

### How it maps onto what exists

The compliance half exists. The worklist read model (`backend-ts/src/case/case-read-models.ts`) resolves
each open case to its employee, site, measure and current outcome status, and outcomes persist evaluation
dates plus the CQL define results. The readable `why_flagged` block — including `last_exam_date` — is
**derived at read time**, not stored: the engine persists `expressionResults` only, and `deriveWhyFlagged`
(`backend-ts/src/case/case-detail-read-model.ts:90`, applied at `:175`) builds `why_flagged` from them
when a case is read. `docs/DATA_MODEL_CONTRACTS.md` §5 shows the block inside the canonical
`evidence_json` shape without noting the derivation, which is misleading on exactly this point (#463).
Filtering, grouping and CSV export over cases are established surfaces.

Encounters are already part of the data model the engine reads: `Encounter` is one of the five clinical
resource types composed per patient by the transport, and it feeds the qualifying-visit logic in the
official eCQMs (`webchart-client.ts:70–72`).

### What would have to be built

- **An encounter-recency signal.** Nothing today records or computes "when was this person last seen" — a
  search for such a field finds none. Encounters are read during evaluation and are not retained
  afterwards. So this is either a value computed at read time from the source, or a value persisted per
  subject, and the second is a schema question and therefore the owner's.
- **A read model or API filter** that takes the recency threshold and returns the joined view. Whether it
  is a Studio view, a contract MIE consumes, or both is open (below). Note that the compliance half of
  each row is a *derivation*, not a column read: any surface showing `last_exam_date` has to run
  `deriveWhyFlagged` over the stored define results, which is a per-row cost and a per-row dependency on
  logic that lives in the case read model today.
- **A definition of "seen."** This is the load-bearing decision, not a detail. *Any* encounter and *a
  qualifying encounter as the measure's own initial population defines it* produce different lists for the
  same patients — CMS125's initial population, for example, requires a qualifying visit, and our synthetic
  roster stamps a CPT 99213 office visit precisely so that conjunct is satisfiable
  (`backend-ts/src/engine/ingress/enrollment/roster.ts:161–165`). Picking one silently would ship a list
  nobody could interpret.

There is also a data availability limit worth stating before anyone estimates this. On the WCDB shim path,
`Encounter` is advertised but returns an empty searchset — the dev seed has no coded encounter source
table (`wcdb-fhir-shim/src/server.ts:147–150`). So the recency signal has no source at all on that path
today, whatever we decide to do with it.

### Open questions

- **Default N.** 12 months, 18, 24, or per measure? A default is a clinical judgement, not an engineering
  one.
- **Studio view or API contract.** A screen we own can change; a contract MIE builds against cannot. If
  MIE would consume this, it belongs under `/api/v1/` with the promises that path carries.
- **Recency per measure or global.** One "last seen" per patient is simpler and blunter; per measure is
  consistent with how the measures themselves read encounters, and multiplies the work.

---

## P3 — Next-action date estimate

*Tracking: [#460](https://github.com/Taleef7/workwell/issues/460)*

### What it is

For a patient and a measure, the date the next procedure or action is due — the date an operator
schedules against, rather than a status word they have to translate into one. "OVERDUE" says something is
late; it does not say when it was due or when the next one will be.

**This is a deterministic calculation over evidence the engine already wrote, and it must never be an AI
prediction.** `docs/AI_GUARDRAILS.md` is unambiguous: AI never decides compliance, CQL is the sole source
of truth, and AI output is assistive text that is never persisted as canonical compliance data. A due date
derived from a persisted last event plus a measure's configured window is arithmetic, reproducible and
auditable. A model-generated date would be a compliance determination wearing a number, and is out of
scope for this proposal in every variant of it.

### How it maps onto what exists

The inputs exist, but one of them is **derived, not stored** — a distinction that changes the shape of
the work. The engine persists `expressionResults`, the raw CQL define outputs; the readable `why_flagged`
block carrying `last_exam_date` and `compliance_window_days` is built at read time by `deriveWhyFlagged`
(`backend-ts/src/case/case-detail-read-model.ts:90`, applied at `:175`), whose own docblock says so at
`:4–6`. `docs/DATA_MODEL_CONTRACTS.md` §5 shows `why_flagged` inside the canonical `evidence_json` shape
without that note, which is why an earlier draft of this proposal claimed the fields were persisted per
outcome (#463). The window itself is genuine configuration — `complianceWindowDays` on the measure binding
(the field at `backend-ts/src/engine/synthetic/measure-bindings.ts:33`; 365 days for the audiogram at
`:46`, 820 for CMS125 at `:49`).

The arithmetic itself already exists twice, in two places that cannot see each other — and both reach the
derivation the long way round:

- `computeDueDate` in `backend-ts/src/case/case-outreach.ts:132–148` computes last exam + window, falling
  back to the evaluation period, and clamps a past date to today so outreach never renders a due-by date
  in the past. It cannot read the stored evidence directly: `renderContext` builds a whole `CaseDetail`
  via `toCaseDetail` first, purely to get the derived block, and the code says why — "the raw stored
  outcome evidence has no `why_flagged` block" (`case-outreach.ts:164–175`).
- `daysUntilDue` in `backend-ts/src/run/employee-profile.ts:154–164` computes window − days since last
  exam for the employee profile read model, negative meaning overdue. It is a **day count, not a date**,
  and not even a function — an inline expression in an object literal (`:164`), so it is less reusable
  than the private helper above rather than more. It calls `deriveWhyFlagged` directly (`:153`) to get
  its window, so the run module already depends on a derivation that lives in the *case detail* read
  model.

Cases carry a `nextAction` today, but it is an instruction string, not a date — `nextActionFor` returns
text like "Schedule the mammogram before the due date"
(`backend-ts/src/case/case-logic.ts:59–73`; the TS field is `nextAction` on the case record in
`backend-ts/src/stores/case-store.ts`, backed by the `next_action` column at
`backend-ts/src/stores/postgres/schema-pg.ts:80`).
So there is no next-due *date* on a case, and the two computations above are private to their own callers.

### What would have to be built

A single derived next-due date per outcome, computed from the persisted define results, surfaced where
operators work — the worklist, the compliance API response, or both.

The most useful part of the work is probably consolidation rather than addition, and the derivation is
the reason. Two independent expressions of the same arithmetic — one producing a clamped date, the other
a signed day count — can already drift apart, and nothing would notice if they did. But both sit on top
of a *third* thing that is also duplicated in effect: `deriveWhyFlagged`, reached by `toCaseDetail` in
one caller and called directly in the other, from a module named for the case detail page rather than for
the derivation it owns. Adding a next-due date to the compliance API without addressing that would make a
third consumer of the same read-time derivation through a fourth path — the exact drift risk this section
already names, one layer down and harder to see. So the work includes pulling `deriveWhyFlagged` and the
due-date arithmetic into one place both read models and the API can share, rather than adding a caller.

Any new persisted column is a schema change and therefore the owner's; a computed-at-read-time field is
not — though "computed at read time" is now a cost to size rather than a free alternative, since it means
running the derivation per row on every list that shows a date.

### Open questions

- **Surfacing.** A case field, a compliance API field, or both? An API field is a `v1` promise and cannot
  be withdrawn.
- **Semantics when there is no last event.** `MISSING_DATA` means the data needed to decide is absent, so
  there is nothing to project a due date from. Options are a null, the end of the current evaluation
  period, or "due now" — and each reads differently to somebody scheduling from it. `computeDueDate`
  already picks one for outreach; that choice was made for a message template and should not be inherited
  by an API without a decision.
- **Whether the clamp travels.** Outreach clamps a past due date to today because a message must not tell
  someone to attend an appointment last March. An operator view arguably wants the true past date, since
  how overdue somebody is affects who gets called first.
- **Coverage.** The full catalog, or only the measures running official artifacts? Compliance windows are
  configured for our authored measures; for an official artifact the notion of a next-due date is a
  WorkWell interpretation layered on top of CMS's logic, and should be labelled as such if it ships.
