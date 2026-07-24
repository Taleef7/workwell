# Incremental / delta batch evaluation — design (#263, Phase 1)

**Status:** **APPROVED + IMPLEMENTED (Phases 2a + 2b), 2026-07-24 — ADR-035.** Owner signed off the §6
DDL and the §10 decisions in-session. Built on `feat/263-incremental-eval`; see JOURNAL 2026-07-24.
Corrections found against the real code during implementation (evidence is `{expressionResults}` only;
`why_flagged` is derived-on-read; `next_transition_at` is safe only for monotone-in-days measures, so
`flu_vaccine`/`cms122`/`cms125` are excluded from across-day reuse) are reflected in the code + ADR-035.
Tier 1 (`Group/$export?_since=`) remains MIE-gated and unbuilt.
**Date:** 2026-07-13 (design); 2026-07-24 (approval + build).
**Context:** #263 was gated on "what change signal does WebChart expose?" (#254 Q A6). The 2026-07-13
research pass (`docs/INTEGRATION_RESEARCH_2026-07-13.md`) answered most of it from public sources, so
this design is now writable. Companion: ADR-020 (scale), ADR-026, #253 (the cost profile this is
justified by), #256 (worker pool).

---

## 1. The problem, stated honestly

A recurring population run re-evaluates every subject × every measure, whether or not anything about
that subject changed. At the 120k scale tenant that is ~1.68M CQL evaluations. The measured cost
(#253, live Neon, N=5000) is **≈68 ms per evaluation** — so a full run is ~30 h single-threaded, or
order-of-hours across the #256 worker pool. Most of that work is recomputing an answer that cannot
have changed.

**What incremental evaluation can and cannot save — be precise about this, because it determines
whether the feature is worth building at all:**

| Cost | Full run | Hash-delta run | `$export _since` run |
|---|---|---|---|
| **CQL evaluation** (~68 ms/subject-measure — the dominant cost) | O(population) | **O(changed)** ✅ | **O(changed)** ✅ |
| **Data fetch** (WebChart HTTP, per-patient composition) | O(population) | O(population) ❌ | **O(changed)** ✅ |
| **Outcome rows written** | O(population) | O(population) — see §4 | O(population) — see §4 |

So the **content-hash tier saves the CPU, not the transport**, and **neither tier saves storage**
(§4 explains why, and why that is the right call). Since evaluation *is* the bottleneck (#253), the
hash tier alone is worth building — but do not let anyone claim it makes the run "O(changed)" end to
end. It does not.

---

## 2. The change signal: what WebChart actually exposes

Verified from the live sandbox CapabilityStatement (2026-07-13, `INTEGRATION_RESEARCH_2026-07-13.md`):

- **No `_lastUpdated` search parameter. No `history` interaction. No resource versioning.** So
  per-resource modified-since polling — the design this issue originally assumed — is **off the table
  entirely**. This is a hard finding, not an assumption.
- **`Group/$export` (Bulk Data 2.0.0, Inferno g10-certified)** is the only operation exposed. The
  Bulk Data kickoff spec defines **`_since`**, which is the one remaining candidate for a real change
  signal.

### Tier 1 — `Group/$export?_since=` (primary; ONE MIE confirmation outstanding)

If MIE confirms `_since` is honored (#254 A6 residual — the *only* thing still gated), incremental
evaluation becomes: periodic bulk export of resources changed since the last watermark → map exported
resources to patient ids → re-evaluate only those patients. This is the only tier that reduces
**transport** as well as CPU.

**Risk to flag now:** `_since` on a bulk export is only as good as the server's change tracking. A
server with no `_lastUpdated` on individual resources may still track modification for export
purposes — or may silently ignore `_since` and return everything. **Do not trust it without a
verification run:** the acceptance test is "export with `_since` = now returns an empty/near-empty
set, and a known edit shows up in the next export." If it silently returns the full population, we
have not saved transport and we fall through to Tier 2 anyway.

### Tier 2 — content-hash change detection (fallback; buildable today, answer-independent)

After composing each patient's bundle (the PR-2c per-resource composition, ADR-028), hash it. Skip the
**evaluation** for any (subject, measure, period) whose inputs are unchanged. This works with **no
change signal at all** and is therefore the guaranteed floor. It is what this design specifies in
detail, because it is the part we can build without waiting for anyone.

The two tiers **compose**: `_since` narrows the candidate set (transport), the hash confirms each
candidate actually changed (CPU). Build Tier 2 first; Tier 1 becomes a pre-filter when confirmed.

### ⚠ Tier 1's candidate set is NOT just "the patients WebChart exported"

**This is the sharpest trap in the whole design, and it only bites Tier 1.** A subject's evaluated
input is *not* only their WebChart clinical data. WorkWell stamps its own inputs onto the bundle
before CQL sees it:

- **The OH enrollment roster** (`engine/ingress/enrollment/roster.ts`) — WebChart carries no
  `urn:workwell:vs:*` program-membership Condition, so enrollment is held WorkWell-side and stamped
  in. Enrolling or un-enrolling someone changes their evaluated input with **zero WebChart resources
  changed**.
- **Segments** (`segment-applicability.ts`) — a cohort/rule edit changes case creation for subjects
  whose clinical data is untouched.
- The CMS125 qualifying-visit stamp, and anything else the ingress adds pre-evaluation.

So a `$export?_since=` candidate set would **miss** exactly these subjects, and copy-forward would
then carry a **stale compliance answer** for someone who was just enrolled (MISSING_DATA →
actionable) or just removed (actionable → out-of-population). That is a wrong answer, not a slow one.

**Rule:** Tier 1's candidate set is
`exported_patient_ids ∪ subjects_whose_workwell_side_inputs_changed`.

Concretely, the WorkWell-side inputs must either (a) be included in the hashed payload — which they
already are, if the hash is taken over the **post-stamp, evaluated** bundle as §5 requires, so **Tier 2
is immune to this by construction** — or (b) force a hash recomputation for the affected subjects when
`_since` is used to skip the fetch. **Recommendation: never let `_since` skip the *hash*, only the
*fetch*.** If a subject is not in the export, we may reuse their last-fetched bundle, but we must still
re-stamp the current roster/segments onto it and re-hash. The stamp is cheap; the CQL evaluation is
what costs 68 ms.

This is why Tier 2 is the floor and Tier 1 is only an optimization on top of it — never a replacement.

---

## 3. What "unchanged" means — the invalidation matrix

A cached outcome for `(subject, measure, period)` is reusable **only if every one of these is
unchanged**. Anything else re-evaluates.

| Input | Captured as | Why it invalidates |
|---|---|---|
| **Patient clinical data** | `data_hash` — SHA-256 over the canonicalized *evaluated* bundle (§5) | The obvious one. |
| **Measure logic** | `logic_version` — SHA-256 over the compiled **ELM** (not the CQL text: whitespace/comment edits must not invalidate, but a semantic recompile must) | A measure edit changes the answer for unchanged data. |
| **Value-set expansion** | folded into `logic_version` (hash of the ELM **+** the expansion hashes of every value set the measure references — `value_sets.expansion_hash` already exists, DATA_MODEL §3.4) | A VSAC re-import can flip membership with no CQL change. This is the invalidation everyone forgets. |
| **Compliance period** | `period` is part of the key (`bucketPeriodForMeasure`, the same key case-idempotency uses) | A cycle rollover is a new question, not a cached one. |
| **Evaluation date** | *not* cached across dates — the key is the period, and a within-period `asOf` shift changes recency answers | See the trap below. |

> **Trap — `asOf` is an input, not just a label.** Every windowed-recency measure computes "days since
> last exam" against the evaluation date. Two runs in the same period with the same data but different
> `asOf` can legitimately produce **different** statuses (COMPLIANT → DUE_SOON as the window closes).
> A cache keyed only on (subject, measure, period, data, logic) would serve a stale COMPLIANT for
> weeks. **Therefore:** either (a) include the evaluation date's *bucket* in the key so a daily
> scheduled run re-evaluates when the day changes — which defeats the entire feature for RECURRING
> measures — or (b) **restrict reuse to measures whose outcome is date-invariant given the data**, i.e.
> PERMANENT/series-completion measures, *plus* recompute the cheap date-dependent part.
>
> **Resolution (recommended):** do **not** cache the outcome. Cache the *evaluation*, and re-derive
> nothing. Concretely: re-evaluate whenever `asOf` moves to a new day **for RECURRING measures**, and
> reuse across days **only for PERMANENT measures** (`complianceClass: PERMANENT` — MMR, Varicella,
> Hep B; E10). That is 3 of 14 runnable measures — a **21% saving, not a 95% one.**
>
> This is the finding that most changes the value of this feature, and it must be surfaced to the
> owner before any code is written. The naive pitch ("only ~1% of patients change per day, so we save
> 99%") is **wrong for every recurring measure**, because the *clock* changes for everyone every day
> even when the data doesn't.

### Making it actually pay off for RECURRING measures

There is a way to get the saving back, and it is worth building — but it is a *different* mechanism
and should be named as such: **status-boundary caching.** For a windowed-recency measure the outcome is
a pure function of `(days since last qualifying event, window, grace)`. Given unchanged data, the next
date at which the status can possibly change is **computable** (`next_transition_at` — the day the
subject crosses into DUE_SOON, then OVERDUE). Cache that, and a daily run can skip any subject whose
`next_transition_at` is still in the future **and** whose data hash is unchanged.

That turns the daily saving from "21% of measures" into "every subject not near a boundary" — which at
a 365-day window with a 30-day DUE_SOON band is ~90% of subjects on any given day. **This is the design
worth building.** It is still descriptive (ADR-008): the CQL engine computes the status and the
transition date on the evaluations it *does* run; the cache only decides *whether to run*, never what
the answer is.

### ⚠ The copied EVIDENCE goes stale even when the STATUS doesn't

The status is stable until `next_transition_at` — but the **evidence is not**. CQL evidence carries
date-dependent defines computed from the evaluation date: `Days Since Last Audiogram`, `Days Since Last
Exam`, and the derived `why_flagged.days_overdue`. `CqlExecutionEngine` persists those values into
`evidence_json`. So a row copied forward on day N+30 would carry **day N's day-counts stamped with day
N+30's `evaluated_at`** — the case detail would say "412 days since last audiogram" when the true
figure is 442, and the audit trail would show a fresh evaluation timestamp over stale arithmetic.

That is not a cosmetic bug: it is exactly the kind of quiet inconsistency an auditor would find, and it
breaks the §8 parity claim as literally stated (identical status **and** evidence).

**Resolution — three options, in the order they should be considered:**

1. **Recompute the cheap derived fields, copy the rest.** The stale defines are pure functions of
   `(anchor date, evaluation date, window, grace)` — all of which are known without re-running CQL.
   Recompute the day-count defines and `why_flagged` arithmetically at copy time from the cached anchor
   date. This preserves both the status and honest evidence for ~0 cost. **Recommended.**
2. **Label rather than recompute.** Copy the evidence verbatim, and add
   `evidence_json.reusedFrom = <run-id>` **plus `evidence_json.evidenceComputedAsOf = <original date>`**,
   so every consumer can see the arithmetic is as-of an earlier date. Cheaper, but it pushes the problem
   onto every reader (the case UI, the AI explain surface, the auditor packet) and *one of them will
   forget*.
3. **Don't copy evidence at all for RECURRING measures** — i.e. only skip PERMANENT ones (the 21% case).
   Correct, and gives up the whole point.

**Whichever is chosen, the §8 parity test must be written to match it** — comparing status exactly, and
evidence either exactly (option 1) or modulo the explicitly-recomputed date-dependent defines. A parity
test that quietly ignores the evidence would be testing the wrong thing.

---

## 4. The correctness landmine: a skipped subject must still get an outcome row

**Every read model in the system is "the outcomes of the latest population run per measure"**
(`rollup-shared.ts` `latestRunRows` → the roster, the hierarchy rollup, the programs overview, quality
snapshots, the order proposals). If an incremental run writes outcome rows *only for the subjects it
re-evaluated*, then:

- the roster loses every unchanged employee (they simply vanish from the grid),
- the hierarchy rollup's reconciliation invariant (All = Σ tenants) breaks,
- `quality_snapshots` denominators collapse to the changed population,
- `totalEvaluated` (derived from `countOutcomesByStatus`, not stored) drops to the changed count.

This would be a silent, catastrophic data-quality regression, and it is the single easiest way to get
this feature wrong.

**Decision: skip the EVALUATION, never the OUTCOME ROW.** An unchanged (subject, measure) has its prior
outcome **copied forward** into the new run (same status, same evidence, new `run_id`, new
`evaluated_at`). The DB write volume is therefore **unchanged from today** — we save the ~68 ms of CQL,
which is the cost that actually matters (#253) — and **every existing read model keeps working with zero
changes**. No rollup, roster, snapshot, or export needs to know this feature exists.

The alternative (teach ~8 read models to fall back to "latest outcome per (subject, measure)" instead of
"outcomes of the latest run") is a far larger, riskier refactor for no CPU saving. Rejected.

**Auditability (issue acceptance criterion):** the run must distinguish evaluated from
skipped-unchanged. Copy-forward rows carry `evidence_json.reusedFrom = "<prior-run-id>"` so a skipped
subject is self-describing at the row level, and the run reports the split (§7).

---

## 5. The hash

- **Algorithm:** SHA-256 via **WebCrypto** (`crypto.subtle.digest`) — the pattern already used by
  `mcp/tool-audit.ts:30-35` and `audit/audit-packet.ts:385`, explicitly chosen for worker portability.
  **No `node:crypto`** on the request path; **no new dependency.** Stored in the house format
  `sha256:<hex>` (`case-event-store.ts:59`).
- **What is hashed:** the **normalized, evaluated** bundle — i.e. the bundle *after*
  `normalizeWebChartBundle` (data-source.ts) and after any enrollment stamping — not the raw HTTP
  payload. Hashing the raw payload would false-negative on a terminology-crosswalk change (the codes
  the CQL matches would shift while the hash stayed put) and false-positive on cosmetic server noise.
- **Canonicalization is mandatory and must be written** (none exists in the repo — the closest prior
  art, `expansionHash` in `resolve-valuesets.ts:66`, is a non-cryptographic sort-then-join over a flat
  list and is not reusable). `JSON.stringify` over a FHIR bundle is key-order-dependent; a server that
  reorders fields would invalidate every cache entry. Requirements: recursively sort object keys, sort
  bundle entries by `resourceType/id`, and **strip volatile fields** — `meta.lastUpdated`, `meta.versionId`,
  any `Bundle.timestamp`, any server-assigned `fullUrl`. **Stripping is a correctness hazard in the other
  direction:** strip too much and a real change becomes invisible. Only strip fields the CQL provably
  cannot read; document each one, and add a golden test that a *material* edit (a new Observation, a
  changed date, a changed code) always moves the hash.

---

## 6. Schema proposal — OWNER-GATED (do not create without Taleef's explicit sign-off)

One new table, floor + ceiling, matching house style (TEXT id via `crypto.randomUUID()`; floor TEXT /
ceiling TIMESTAMPTZ timestamps; ceiling schema-qualified to `workwell_spike`; ceiling index prefixed
`spike_`; an `OWNER-APPROVED DDL` comment block naming this issue + the rollback statement):

```sql
eval_state (
  id                 TEXT PRIMARY KEY,
  subject_id         TEXT NOT NULL,
  measure_id         TEXT NOT NULL,
  period             TEXT NOT NULL,          -- bucketPeriodForMeasure — same key as case idempotency
  data_hash          TEXT NOT NULL,          -- sha256:<hex> of the canonicalized evaluated bundle
  logic_version      TEXT NOT NULL,          -- sha256:<hex> of (measure ELM + referenced value-set expansion hashes)
  next_transition_at <date/ts> NULL,         -- §3: the earliest date the status can change on unchanged data
  last_status        TEXT NOT NULL,          -- for the copy-forward + a cheap parity assertion
  source_outcome_id  TEXT NOT NULL,          -- the outcome row to copy forward
  last_evaluated_at  <ts> NOT NULL,
  UNIQUE (subject_id, measure_id, period)
)
-- index: (measure_id, period)   [floor: eval_state_measure_period_idx / ceiling: spike_eval_state_measure_period_idx]
```

- **Reversible:** `DELETE FROM workwell_spike.eval_state;` — the table is a pure **cache**. Dropping it
  makes the next run a full run. Nothing else depends on it, and no outcome/case/audit row references it.
  This reversibility is the whole reason it is safe to add.
- **No FK** on `subject_id`/`measure_id` (backend-ts has no `employees`/`measures` tables — same as
  `person_links` and `quality_snapshots`).
- Ported behind a new `EvalStateStore` (port + SQLite + Postgres adapters + a shared `store-contract.ts`
  entry), wired into `Stores` in `factory.ts`, exactly like `PersonLinkStore`.

**Storage:** one row per (subject, measure, period) — at 120k × 14 that is ~1.7M small rows on Neon.
**This is not free, and the owner should price it before approving.** If it is judged too costly, the
feature can be scoped to the live tenants only (`twh`/`ihn`, ~2,100 rows) and the scale tenant excluded
— the scale tenant is generated demo data whose "changes" are synthetic anyway.

---

## 7. Run accounting (issue acceptance criterion: "skipped-subject accounting is auditable")

`runs` has **no count columns at all** — every count is derived from `outcomes` at read time
(`read-models.ts` `tallyFromCounts` over `countOutcomesByStatus`). Since copy-forward writes a row for
every subject (§4), `totalEvaluated` stays correct with no change.

For the evaluated-vs-skipped split, in preference order:
1. **The `RUN_COMPLETED` audit payload** + a run log line — zero schema, already the established place
   for run facts (`run-pipeline.ts:437-446`). **Recommended.**
2. `evidence_json.reusedFrom` on each copied row — makes it queryable per subject, also zero schema.
3. A `skipped_unchanged` column on `runs` — only if the owner wants it on the run list UI; needs DDL +
   a `FLOOR_COLUMN_BACKFILL` entry + an extended `finalizeRun` (which currently takes no payload).

Start with (1) + (2). Do not add a `runs` column for a number that can be derived.

---

## 8. Parity plan (issue acceptance criterion: "incremental == full on identical data")

The golden test that must exist before this ships:

1. Seed a fixed population. Run a **full** population run → capture every `(subject, measure) → (status,
   evidence)`.
2. Run an **incremental** run over the *same unchanged* data → assert **every** outcome is identical
   (status **and** evidence), and assert the run reports `skipped == total` (nothing was re-evaluated).
   *(Same-day: no date-dependent define can have moved, so evidence must match byte-for-byte.)*
3. Mutate one subject's data → assert **exactly one** subject re-evaluates, its outcome is correct, and
   every other subject's outcome is byte-identical to the full run.
4. Bump a measure's ELM (or a referenced value set's expansion) → assert **every** subject for that
   measure re-evaluates (the `logic_version` invalidation, §3).
5. Advance the clock past a subject's `next_transition_at` → assert it re-evaluates and flips status
   (the first trap in §3).
6. Advance the clock **short of** `next_transition_at` → assert the subject is skipped, the status is
   unchanged, **and the day-count defines / `why_flagged.days_overdue` in the copied row match a full
   run's values for that date** (the second trap in §3 — the stale-evidence one). This is the test that
   makes option 1 above real; without it, the copy-forward silently ships day-N arithmetic under a
   day-N+30 timestamp.

**A failure of (2) or (3) is a correctness bug, not a performance regression.** The rule stands: CQL
decides every outcome (ADR-008); this feature only decides *whether to ask it again*, and must be
provably unable to change an answer.

---

## 9. Recommended sequencing

1. **Now, unblocked:** owner reviews this doc + the §6 DDL. *(No code until then.)*
2. **Phase 2a:** the canonical-JSON hasher + `logic_version` computation as **pure functions with
   golden tests** — zero integration, zero schema. This is the risky part and it can be de-risked
   alone.
3. **Phase 2b:** `EvalStateStore` (after DDL sign-off) + copy-forward in `finishManualRun`
   (`run-pipeline.ts:264-293`, the single subject loop) + the parity suite (§8). Live tenants only.
4. **Phase 2c:** wire into the batch/scale path (`batch-evaluate-scale.ts` `persistChunk` at :246 — the
   single write choke point; the worker returns plain JSON rows to the main thread, so the hash can be
   computed in-worker and returned alongside, preserving the existing "main thread does every DB write"
   invariant).
5. **Later, MIE-gated:** `Group/$export?_since=` as a transport pre-filter (Tier 1), **with the
   verification run in §2** before trusting it.

## 10. Open questions for the owner — RESOLVED 2026-07-24

1. **Is the §6 DDL approved?** ✅ **Approved in-session.** `eval_state` shipped (DATA_MODEL §3.27), plus a
   `source_eval_date` column the recompute needs.
2. **Scale tenant in or out?** ✅ **OUT — live tenants only** (~2,100 rows). Achieved for free by wiring
   only `finishManualRun`; the scale path (`batch-evaluate-scale.ts`) is untouched.
3. **Is `next_transition_at` in scope?** ✅ **YES — built.** Implemented WITHOUT an engine change: the
   thresholds live in a TS table (`next-transition.ts`) that is GOLDEN-VERIFIED against the real CQL
   engine (sweeps `daysSinceLastExam`, asserts the CQL flips exactly at each boundary), so it can't drift.
   Only monotone-in-days measures get across-day reuse; `flu_vaccine`/`cms122`/`cms125` are excluded.
4. **Stale-evidence handling?** ✅ **Recompute (option 1).** Each `"Days Since"` define is advanced by the
   elapsed days at copy time (measure-agnostic; same-day copy is byte-identical). The §8 parity test
   asserts the copied `"Days Since"` equals a full run's for the later date.
