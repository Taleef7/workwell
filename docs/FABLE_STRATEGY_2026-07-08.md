# Fable strategy review — 2026-07-08

**Scope:** post-PR-#252 direction. Written by Fable 5 (senior-architect pass), with one adversarial
Codex (GPT-5.5, high) verification round on the technical claims. Local working doc — treat like the
FABLE_REVIEW artifacts.

---

## 1. Executive recommendation

**Pivot from engine-hardening to integration-readiness.** The engine story is now *done* for a PoC:
real batch evaluation proven, the E9 fork decided (ADR-025), terminology verified current. The one
remaining existential risk to this project is **integration latency**: when MIE's API contract lands,
either integration takes weeks because everything was pre-built against a contract double, or it takes
months because the transport, identity, and change-detection questions start from zero. Everything else
on the table — worker_threads, delta-eval, Option B, literal QICore execution — is optimization of a
solved problem or research.

Concretely, the next ~3 weeks:

1. Merge #252, roll back the fabricated seed, prove at N=5000, and **stop scale investment there**
   (one caveat: intra-run chunk resume before any >4h run — §3.2).
2. **Send MIE the question list + a candidate API contract this week** (§7). Latency on this dominates
   everything; it costs half a day.
3. Build the **contract-first mock WebChart API + `httpWebChartClient`** against it, so PR-2c becomes
   "bind to the confirmed contract," not "build the transport."
4. Close the two cheap production gaps that must exist *before* real data flows: **evidence bucket
   (#167)** and **clinical-computation observability** (§8).

## 2. Sequenced roadmap

| # | Move | Effort | Risk | Depends on |
|---|------|--------|------|------------|
| 1 | Merge #252; Neon rollback of fabricated seed; `--subjects 5000 --mode evaluate`; record per-eval profile | 0.5d | low | owner |
| 2 | Send MIE/Dave Carlson the §7 question list + candidate contract | 0.5d | low | — |
| 3 | Intra-run chunk-resume checkpoint for the batch engine (only if a big live tenant is wanted) | 1d | low | 1 |
| 4 | Contract-first mock WebChart API + build `httpWebChartClient` against contract tests | 3–5d | med | 2 (parallel) |
| 5 | Dev-DB fixture expansion: all exportable patients; deletes/corrections/status-changes; encounters/providers/locations; non-numeric obs | 2–3d | low | — |
| 6 | E15 PR-3 offline prep: `matchKey` over dev-DB identifiers; merge/unmerge semantics documented as MIE questions | 1–2d | low | 5 |
| 7 | Evidence bucket #167 (R2) + governance notes (retention, encryption, signed URLs, audit link) | 0.5–1d | low | owner infra |
| 8 | Clinical observability: per-run missing-data %, value-set-miss / mapping-failure counters, eval-latency histogram, per-measure drift vs prior run | 1–3d | low | — |
| 9 | (Deferred, designed-not-built) delta-eval design doc; worker/sharding; Option B; literal-QICore via published ELM + fqm-execution | — | — | triggers in §4–§6 |

Items 4–6 are the "integration-readiness package" and are the core block. 7–8 run in parallel.

## 3. The six forks

### 3.1 Highest-leverage next move → (b) WebChart integration readiness
The scale work de-risked Option A's known weakness; the adapter core, enrollment roster, and dev-DB
proof exist. What does **not** exist: a transport, a contract, an identity story against real keys, and
change detection. All are on MIE's critical path — and the only way to compress that path is to (i) ask
precise questions now and (ii) pre-build against an explicit contract double that MIE can *diff* rather
than a blank page. Codex's sharpest point, adopted: a self-authored mock can calcify wrong assumptions —
so the mock's contract gets **sent to MIE as a proposal**, making it a forcing function instead of a trap.

### 3.2 Was real-eval-at-scale the right call? → Yes, once. Stop now.
It was not premature: the 120k tenant was the demo's weakest claim (fabricated outcomes), and Doug's Q2
skepticism was precisely "Option A can't scale." Converting that to "we really evaluate a WebChart-shaped
population through the real adapter at ~60ms/eval, here's the measured profile" is strategic ammunition,
and it forced the terminology audit + crosswalk fixes. **But further investment (worker_threads,
delta-eval) is premature**: remaining project risk lives in the contract/mapping, not throughput.
- Prove at N=5000 (~1h) and publish the measured extrapolation (120k×14 ≈ 28h single-threaded).
- **Operational gap to fix before any long run:** resume is whole-batch (per-measure COMPLETED
  idempotency; finalize happens at the end) — a crash at hour 20 of a 28h run re-seeds everything. Either
  add a cheap intra-run chunk checkpoint (~1d) or cap the live tenant at N≈20–30k (2–3h). Do not run
  120k single-threaded without one of these.
- If/when a genuinely large tenant is needed: **multi-process sharding beats worker_threads** for this
  offline CLI (crash isolation, no pool code) — see §5.

### 3.3 WebChart readiness → §7 (questions) + roadmap items 4–6 (offline pre-build)

### 3.4 Option B (CQL→SQL) → inert seam, with one carve-out
Keep the transpiler permanently inert unless **all three** hold: (i) a *named* measure × population where
the FHIR-native path measurably can't complete its batch window economically, (ii) confirmed WebChart
schema, (iii) the measure is in the transpilable subset (existence/recency/simple counts). That trigger
may never fire — fine.

**The carve-out (adopt this framing now):** what an EHR architect will actually ask for is not CQL→SQL —
it's **DB-side denominator prefiltering**: a server-side query that shrinks *who gets a bundle built*
("patients with a diabetes dx," "patients with obs code X since date D") before full FHIR-native
evaluation. That is not transpilation, it's a data-source capability — so put it on the **MIE API
question list** (§7 #9), not in the executor seam. It composes with delta-eval and removes most of the
scale pressure that would otherwise argue for Option B.

### 3.5 Standards fidelity (E14) → official-subset is the right permanent PoC answer; the future literal path is *published ELM*, not a better translator
Two corrections to the current framing (Codex-verified):
- The HL7 Quality Measure IG requires executable measure packages to ship **pre-compiled ELM (JSON/XML)
  in the Library resources**. So the "translator can't compile QICore" blocker is bypassable by
  *consuming published ELM* — no translator at all. The runtime path is then **fqm-execution** (NCQA;
  wraps cql-execution + cql-exec-fhir; handles multi-library include graphs, `meta.profile`-filtered
  QICore retrieves, MeasureReports; actively maintained as of 2025–26). That is bounded engineering, not
  research — but it *is* a new dependency (ADR gate) and a second execution stack.
- **However:** CMS's Eligible-Clinician program (which CMS122 belongs to) still publishes **QDM-based**
  packages for 2025/2026 — a literal FHIR/QICore CMS122 artifact may not exist to execute. Chasing the
  "literal QICore diff" may be chasing an artifact CMS doesn't publish for this program yet.

**Verdict:** official-subset stays. Record in ADR-024's revisit note that the future path is
"published-ELM + fqm-execution when CMS ships FHIR-based EC packages," not "wait for a stable
multi-model translator." Cost now: zero. Benefit of going literal now: near-zero for a PoC.

### 3.6 PoC → production gap list, ordered
**Required for a first pilot:** (1) evidence bucket + governance (retention/encryption/signed URLs/audit
linkage — storage is easy, governance is the real item); (2) clinical observability (§8 — build *before*
real data, it's how the first real run gets debugged); (3) batch-run robustness (chunk resume; stuck-run
sweep exists); (4) auth **trust-boundary decision** — don't build SSO speculatively, but ask MIE now
whether WorkWell embeds in a WebChart session (SSO/OIDC) or stands alone (§7 #10); (5) E12 PR-2c itself.
**Nice-to-have / later:** scale perf (sharding/delta — when a real tenant size is known), API
rate-limiting/backpressure on the WebChart client, DR posture beyond Neon branches, per-tenant config
isolation, real user directory.

## 4. Direct answers to the engineering questions

**Premature optimization?** No — right once, for the reasons in §3.2. What to do with it now: merge,
prove at 5000, publish the profile, park. Its lasting value: the generator + batch engine become the
**load-test harness for the real adapter** the day PR-2c lands (same seam).

**Single highest-leverage build:** the contract-first mock WebChart API + `httpWebChartClient` built
against it, with the candidate contract sent to MIE to correct (roadmap #4 + #2 together).

**worker_threads viability:** Sound in principle — the engine is stateless per subject, Node workers are
fully isolated (module registry per worker), 1–3KB structured-clone cost is trivial. Gotchas: per-worker
re-init of ELM/Library/Executor/CodeService (don't share instances); memory ×N (14 measures' ELM +
value-set maps per worker — fine at N=2–4, suspicious at N=8+ on a small host); no upstream
thread-safety *guarantee* in cql-execution (confidence comes from worker isolation, not docs); generate
bundles *inside* workers rather than cloning if generation is cheap. **But for this offline CLI,
multi-process sharding is the better pattern**: N CLI instances over disjoint subject ranges (e.g. by
`mhn|Lxx` location prefix), crash isolation, no pool code. Requirements: runs created up-front and
shared, idempotency key on (run_id, subject_id) upserts or claim-range semantics, and mind Neon's pooled
connection limits. Either way: only if a trigger fires.

**Incremental/delta design:** the proposed "per-outcome valid-until + data-changed watermark" is
directionally right but **insufficient** for eCQM semantics. Breakers: measurement-period rollover flips
outcomes with zero data change; backdated/retroactive entry breaks watermarks unless the source exposes
a reliable `last_updated` (put it on the MIE list — it decides whether delta is even possible); deletes,
corrections, and patient merges matter as much as inserts; value-set version changes and measure-version
changes invalidate everything; absence-of-evidence and most-recent-fact logic undercomputes a naive
"next flip date." **Robust MVP pattern instead:** nightly full re-eval of the *active denominator
candidates* (bounded by DB-side prefiltering, §3.4) + event-driven single-subject re-eval (already have
the EMPLOYEE/CASE run path) + full re-eval on any measure/value-set/period change. Delta becomes an
optimization after integration truth exists.

**Evidence-trim policy:** tiered. (a) **Never trim failures** — full `{evaluationError}` evidence always.
(b) Full evidence for a deterministic ~1% sample (drill-in/demo/debugging). (c) Minimal `{scale:true}`
for the rest. (d) When R2 lands (#167), move full evidence *to the bucket* keyed by outcome id — DB keeps
status + pointer; that dissolves the trade-off entirely and is the production answer. (e)
Recompute-on-demand works for deterministic synthetic subjects; for real WebChart data it means
refetch + re-eval — acceptable, but the data may have changed, so recomputed evidence is *current*, not
*historical* — which is exactly why (d) is the right long-term answer for audit defensibility.

**Pushback on recent decisions:** ADR-025 is sound (adversarially confirmed — B can never be the
correctness authority; the parity gate is right). Real flags: (1) the whole-batch resume gap (§3.2);
(2) the **hardcoded active-flu-CVX list will rot** — the audit's own "durable follow-up" (resolve flu
membership from the VSAC OID via the ADR-023 resolver) should be scheduled, not just noted, because a
hardcoded currency fix is next year's currency bug; (3) the self-authored mock-contract risk (§3.1 —
mitigated by sending it to MIE); (4) "evidence to S3/R2 is config-only" understates the governance half
(§3.6). Nothing found that argues for reversal.

## 5. What Codex/GPT-5.5 changed in this review
Adopted from the adversarial round: the QDM-vs-FHIR packaging caveat on CMS122 (§3.5); published-ELM +
fqm-execution as the literal path; multi-process sharding preferred over worker_threads for the CLI;
the delta-eval breakers list + nightly-full-re-eval MVP pattern; DB-side denominator prefiltering as
the "Option B-lite" an EHR architect actually wants; evidence *governance* vs storage; identity breadth
(encounter/provider/location/merge-unmerge, not just patient id); clinical-computation observability;
"N=5000 proves your engine, not your integration."

## 6. Deferred-by-decision register (so nothing silently rots)
- worker_threads / process sharding — trigger: a named tenant whose batch window can't complete.
- Delta-eval — trigger: MIE confirms a reliable change feed / `last_updated`; design per §4.
- Option B transpiler — trigger: §3.4's three conditions, all measured.
- Literal QICore execution — trigger: CMS ships FHIR-based EC packages; path = published ELM +
  fqm-execution (new-dep ADR).
- SSO/real directory — trigger: MIE's trust-boundary answer (§7 #10).
- Flu-CVX VSAC-resolved membership — schedule proactively (next terminology touch).

## 7. The MIE / Dave Carlson list (send-ready)

Preface to send with it: *"We've built the WebChart→FHIR adapter and proven it offline against the
dev-wcdb sample; the transport is the last unbound seam. Below are the questions that bind it — plus a
candidate contract document; correcting ours is probably faster than specifying from scratch."*

1. **API shape.** Is the integration surface a true FHIR R4 API (which resources/profiles? a
   CapabilityStatement URL? `$everything` or per-resource search?) or a proprietary REST API over the
   `wc_miehr_*` schema? (Decides whether normalization is pass-through+reconcile or full row→FHIR.)
2. **Population enumeration.** How do we list the worker/OH population — filterable by
   employer/site/program? Pagination model and max page size? A count endpoint?
3. **Per-patient clinical reads.** Endpoints + date filtering for labs/vitals, immunizations,
   conditions, procedures, encounters. For non-numeric results: does the API return the base
   `observations` `obs_result`/`obs_result_code` representation or the `observations_current`
   numeric fast-path?
4. **Change detection.** Do resources carry a reliable `last_updated`? Is there a `_since`-style query,
   change feed, or audit table we can poll? How are **deletes, corrections, and backdated entries**
   represented? (This decides whether incremental sync is possible at all.)
5. **Identity.** Canonical patient key; MRN/alias model; how patient **merge/unmerge** events are
   surfaced. Canonical keys for encounter, provider, location, organization (hierarchy attribution).
6. **Auth.** Mechanism (API key header / OAuth client-credentials / bearer), token lifetime, rate
   limits, IP allowlisting. Sandbox credentials?
7. **Environments.** Is there a hosted sandbox (ideally seeded like dev-wcdb) we can hit over HTTP?
   Expected throughput ceilings for batch reads (N patients/night)?
8. **Program enrollment.** Where does OH-program membership live — does WebChart expose it, or is the
   roster WorkWell-side (as we currently assume via `stampEnrollment`)?
9. **Server-side filtering.** Can the API prefilter candidates (e.g., "patients with a diabetes dx,"
   "patients with an observation of code X since date D")? This bounds batch cost and largely obviates
   any CQL→SQL pushdown discussion.
10. **Trust boundary / embedding.** Is WorkWell expected to embed in a WebChart session (SSO/OIDC
    expectations?) or stand alone for the pilot? What auth story does MIE want end-state?
11. **PHI/governance for the pilot.** Data-handling expectations for evidence storage — retention,
    encryption-at-rest, access audit.

(Items 1–6 of the old §7 list in `docs/WEBCHART_FHIR_MAPPING.md` are subsumed above; 4, 5, 9, 10, 11
are new and load-bearing.)

## 8. Observability spec sketch (roadmap #8)
Per run: subjects evaluated / errored, per-bucket counts vs prior run (drift %), missing-data rate,
value-set resolution misses, terminology-crosswalk unmatched-code counts (the mapping-failure signal
that matters on day one of real data), eval-latency histogram, evidence-write failures. Surface on
`/admin` (Operations tab) + structured logs. All read-path/derived — no schema.
