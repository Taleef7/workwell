# Guide scenarios chapter, chronological one-pager, numbers audit + three feature proposals — design

**Date:** 2026-08-12
**Status:** Approved design, pre-implementation
**Driver:** Owner feedback on the documentation (2026-08-11): sequence diagrams per user
flow/scenario are wanted; the guide's one-page overview does not express chronological order
(build-time and data-in sit side by side at the top, chapter labels out of reading order); all
numbers and percentages must be verified correct. Three further points were product-shaped, not
documentation-shaped, and are handled here as written proposals, not builds.

## Decisions taken (with the owner, in-session)

1. **Scope split:** documentation ships now; the three product-shaped items become one-page
   written proposals for review before any code. No feature implementation in this effort.
2. **"ELM against a WebChart environment"** is read as: running measures end-to-end against a
   real WebChart environment. The docs document the already-built live path; a fresh live
   demonstration is a named follow-up task, not part of the docs PR.
3. **Sequence diagrams live in a new chapter** (`docs/guide/10-scenarios.md`), cross-linked from
   the chapters that own each mechanism. Existing chapters keep their structural flowcharts.
4. **Chapter numbering stays.** The chronology critique is fixed in the diagrams, not by
   renumbering the guide (which is organized by concept, correctly for reference reading).
5. **Proposals live in one doc + one GitHub issue each** (`docs/PROPOSALS_2026-08.md`).
6. **Scenario selection criterion:** a flow earns a sequence diagram when the *order of handoffs
   over time* is the content — not the raw actor count. Admin CRUD flows (program/roster config,
   scheduler settings, email provider) are deliberately excluded: no temporal story. The
   auth/session flow (S7) was considered and deferred.

## PR 1 — `docs(guide)`: scenarios chapter, chronological one-pager, numbers audit

### 1. New `docs/guide/10-scenarios.md` — six sequence diagrams

Each diagram gets a short narrative and cross-links to the owning chapters; each owning chapter
gets a one-line pointer back; the guide README table gets a row. Mermaid `sequenceDiagram` blocks.

- **S1 — A run, scheduled or manual.** Scheduler / operator → run pipeline → per-measure router →
  authored engine *or* official executor → outcome + evidence write → case upsert (disposition) →
  audit event → dashboard/read models. One diagram for both triggers (the pipeline is identical
  after the trigger). The async-run path's discarded run message (ADR-043) is shown honestly.
- **S2 — WebChart end-to-end.** WebChart FHIR server → SMART Backend Services auth → transport +
  `normalizeWebChartBundle` (the two derived elements, ADR-057) → engine → Postgres →
  `GET /api/v1/compliance/...` consumer. Documents the already-built, already-measured live path.
- **S3 — Case/operator workflow.** Flagged outcome → operator opens case → evidence panel + AI
  explain with the deterministic fallback lane shown (AI never decides compliance) → outreach →
  resolve / rerun → audit trail accumulating throughout.
- **S4 — Authoring a measure.** Author → AI draft-spec (assistive only) → CQL in the editor →
  translator/ELM → catalog → activate → first run. Makes visible that compilation happens at
  authoring/build time, never during evaluation ("remember five things" #1). Feeds the M-E
  occupational authoring narrative.
- **S5 — Standards loop.** QRDA I batch import → identity grouping → evaluate → finalize gate
  (refuses runs whose outcomes lack `qrda1Import` evidence) → QRDA III / MeasureReport export.
  The interoperability bridge of locked decision 4.
- **S6 — MCP consumer.** Claude Desktop → MCP server → role gate → read-only tools → stores.

### 2. README one-pager rebuilt for chronology

Strictly top-to-bottom time order, stages explicitly numbered: ① BUILD TIME (happens once,
output committed) → ② DATA IN → ③ PREPARATION → ④ EVALUATION → ⑤ PERSISTENCE → ⑥ WHAT COMES
OUT, with the CQL→SQL lane rendered as a parallel side-track, dotted, not a destination. The
other 20 guide diagrams get swept for the same critique; only genuinely time-confused ones are
fixed. No gratuitous churn.

### 3. Numbers-and-percentages audit

Every number in the guide verified against the tree at HEAD: "17 CQL files", "12 of 14 / 2 of
14", "410 of 410", "150 people", test counts, and all of chapter 9's dated figures. Stale numbers
corrected; inherently volatile ones moved to or dated in chapter 9 per the guide's own rule.

### Definition of done for PR 1

Guide README + chapter cross-links updated, JOURNAL entry, conventional commit
(`docs(guide): ...`), CI green. Each new diagram is a standing maintenance obligation under the
guide's per-PR update rule — that is the accepted cost of the curated six.

## PR 2 — `docs`: feature proposals

`docs/PROPOSALS_2026-08.md`, one page per feature, each structured as *what it is → how it maps
onto existing machinery → open questions for the owner/MIE*. Justified on their own merits; no
quoted conversation. Plus one GitHub issue per proposal linking to the doc.

- **P1 — Encounter-close quality check.** Surface measure gaps for a patient at the moment an
  encounter is closed. Maps onto the compliance API's `mode=preview` (ADR-061) and the WebChart
  seam. Open: integration surface (WebChart-side hook vs WorkWell view), measure set, latency
  budget.
- **P2 — "Not seen in a while" per measure.** Given a measure, list patients not seen in N days
  with their current quality status. Maps onto the worklist plus an encounter-recency signal the
  shim already reads. Open: definition of "seen", N, and whether it is a view or an API.
- **P3 — Next-action date estimate.** Deterministic next-due date per patient per measure derived
  from compliance windows and persisted evidence (`next_action` exists on cases today).
  Explicitly not an AI prediction (AI_GUARDRAILS). Open: surfacing (worklist column vs API field),
  and whether "any quality" means all measures or the routed set.

Schema changes, if any emerge from these, stay owner-owned as always.

## Named follow-up (tracked, not in this effort)

- **Live WebChart demonstration:** an actual run against the live tenant/staging with real output
  the owner can inspect. Its own GitHub issue so it does not silently evaporate.

## Sequencing

PR 1 first (self-contained, direct response to the critique), PR 2 second, follow-up issue filed
alongside PR 2. Feature branches per task per CLAUDE.md.

## Explicitly out of scope

- Building P1/P2/P3.
- Renumbering or reordering guide chapters.
- Sequence diagrams for admin CRUD flows and the auth/session flow (S7 — deferred, cheap to add
  later if a security review wants it).
- Running anything against the live tenant.
