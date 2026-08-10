# Pass 4 — Strategy & Roadmap

**Fable Deep Review · 2026-07-02 · WorkWell Measure Studio**

Sources synthesized, in order: the Harmonization Charter PDF; the Quality Dashboards Working-Backwards PDF (the press-release goal state); `questions_for_doug.md` (Q1–Q7); the E9 CQL→SQL decision memo (`docs/superpowers/specs/2026-06-30-e9-cql-sql-bridge-decision-memo.md`); the top of `Workwell Vision Doc.md` (the 7-item Asks-for-Doug list, 2026-06-30); `docs/JOURNAL.md` (newest-first) and CLAUDE.md Current Focus.

---

## 1. What we are ultimately trying to achieve

Doug's two documents point at one thing. The **Charter** diagnoses the disease: MIE has four (really five) overlapping subsystems — Quality (eCQM), Health/Medical Surveillance, Preventive Care, Immunization, Order Panels — each built separately, each with hand-written SQL reports (`system/reports/CMS122v8.sql`), laborious measure definition, value sets that drift yearly, no real-time provider visibility, and manual order placement. The **Working-Backwards press release** defines the cure: the *OSHA Medical Surveillance Quality Framework* — one CQL-authored, eCQM-native (HQMF/CQL/ELM/ValueSet) measure engine with multi-level dashboards (enterprise → location → provider → patient), automated auditable outreach (DataChaser), HRIS-aware cohorts, FillMeIn analytics, open measure definitions — generally available inside **EnterpriseHealth and WebChart**, aligned to a reporting cycle ending **March 31, 2026** (a date that has already passed — see Ask #3).

**"Done / real-world deployed product" therefore means, concretely:**
1. Official eCQMs (real VSAC value sets) and OSHA surveillance measures executing against **real WebChart/EH patient data** — not a synthetic directory.
2. At **120k+ population scale** with acceptable latency, as the **source of truth for quality-over-time** (Doug's June-24 ask — answered structurally by E16).
3. Embedded in EH + WebChart (auth, navigation, org hierarchy from the real HRIS), replacing spreadsheet/manual chart review.
4. Outreach that actually sends (DataChaser/SendGrid), orders that can actually be written back, every determination explainable and auditable.

## 2. Where the app is today — honest position

**~90% of everything buildable-without-MIE is built, deployed, and live.** E1–E16 shipped: ports/adapters engine, headless evaluator, MeasureReport/QRDA/QI-Core, multi-level + multi-tenant dashboards, outreach campaigns, immunization forecasting, order proposals, CQL→SQL decision memo, roster + taxonomy, rule-builder codegen + segments, pluggable ingress, 120k scale tenant, standards-fidelity diff, cross-system identity with human reconcile, quality-over-time snapshot store with 13 months of live backfilled history. This review verified the live stack end-to-end: RBAC matrix exact, reconciliation invariant exact at 1,682,100 evaluated, 840 backend tests green, real scheduled runs firing daily.

The honest gap analysis splits into two very different buckets:

### Bucket A — build gaps (ours to fix; no external dependency)
From Passes 1–3 of this review, the substance of "polish to product" is:
1. **Audit completeness** — the population run pipeline doesn't write run/case audit events (H1) and the case upsert clobbers operator state (H2). For a product whose pitch is "every determination auditable," this is the top build gap.
2. **Scale-hardening the read paths** — missing indexes at 1.68M rows, four unbounded 120k endpoints, ever-growing scans behind /compliance and /programs/hierarchy (H4/H5/M16/M17; live 5–12s latencies today). The write path scales; the read path doesn't yet.
3. **Correct-by-construction CQL on foreign data** — HAZWOPER/TB match any Condition (H3), no out-of-IPP signal (L17), codegen numeric validation (M19). These become real-world compliance errors the day real data arrives — fix *before* E12 PR-2, not after.
4. **Role-fit UI** — case detail/Studio surfaces show write controls that 403 for read roles (H9/H10), unsaved-work hazards (H11/M26), refresh races (M24). The class of issue #181 fixed, finished properly.
5. Accessibility + dark-mode residue (Pass 3), stale-fetch races (M20), and the long tail of Ms/Ls.

None of this is architecturally scary; it is 2–4 weeks of disciplined hardening, and most of it directly strengthens the demo story ("watch the audit ledger while a run executes").

### Bucket B — externally-blocked integrations (only Doug/MIE can unblock)
Every one of these already has a built, tested, inert seam waiting:
| Blocked item | Waiting seam | Unblocks |
|---|---|---|
| VSAC/UMLS API key | `ValueSetResolver` (E3.2) | E14 PR-3 — run the *official* CMS122/125, execution-level fidelity diff |
| WebChart MariaDB schema / sandbox | `PatientDataSource` + inert `webChartDataSource` (E12) | Real data; also makes E15 identity + H3-class bugs testable against truth |
| Q2 decision: FHIR-native vs CQL→SQL vs hybrid | E9 memo (recommends C, FHIR-native-first) | The entire data-layer architecture; the memo is decision-ready |
| Managed S3/R2 bucket + creds | `CloudBucket` port (deploy-config only) | Durable evidence uploads — the one *live* limitation |
| ICE endpoint/credentials | `iceForecaster` stub (E6) | Real ACIP forecasting |
| DataChaser API access | `dataChaserChannel` stub (E5) | Real outreach at scale |
| Published `@mieweb/datavis` | vendored grid (ADR-007) | Drop `frontend/vendor/` |
| EH/WebChart order write API (Q7) | `OrderSubmitter` named-but-deferred (E7) | Close the order loop |
| HRIS hierarchy source (Q6) | synthetic directory swap point (E4/ADR-010) | Real org tree |

This is the review's most important strategic observation: **the project has run out of high-value synthetic work.** Continuing to build against the synthetic directory now yields diminishing returns and growing rework risk (e.g., identity semantics guessed before seeing real WebChart MRNs). The bottleneck is no longer engineering throughput — it is Doug's answers and MIE's credentials.

## 3. What to build next (and after that)

### Now (no dependencies) — "Product-hardening sprint," ~2–3 weeks
1. **Audit-invariant closure** (H1, H2, M6, M15): run/case audit events, state-aware upsert, atomic sweep. This is the pitch-critical fix.
2. **Scale read-path** (H4, H5, M16, M17 — owner-gated DDL for 3 indexes): make /compliance and /hierarchy sub-second at 1.68M rows; bound the four 120k endpoints. Turns the 120k demo from "works" into "fast," which is the whole point of the mhn tenant.
3. **Foreign-data correctness pre-work for E12** (H3, L17, M19, L14): scoped HAZWOPER/TB CQL + golden regression with foreign bundles, out-of-IPP signal, codegen validation, prompt fencing.
4. **Role-fit + races frontend pass** (H9–H11, M20–M26): finish the #181 class.
5. Cheap wins: pg.Pool error listener (H6), RUNNING-run filter in the rollup (H7), UNLINK clique fix (H8), identity 404s (L1).

### Next (as soon as ANY Bucket-B answer lands)
- **If WebChart schema arrives** → E12 PR-2 (MariaDB→FHIR adapter) is the single highest-leverage build: it flips the entire product from "synthetic demo" to "runs on real WebChart data," and everything downstream (E15 PR-3 real identity, real rosters, real dashboards) rides on it.
- **If the VSAC key arrives** → E14 PR-3 (official-CQL execution diff): the "we run the *official* measure" credibility story, ~1 PR of work behind the existing seam.
- **If Q2 is answered "Option C accepted"** → finalize ADR for the executor architecture; scope the bounded CQL→SQL second executor only for reports that must run in MariaDB (per the memo). If Doug says "hard SQL requirement," that is a major re-plan — surface it immediately, don't absorb it.
- **If the R2/S3 bucket arrives** → 1-day deploy-config change; closes the last live limitation.

### After that (the embed phase)
- Real HRIS hierarchy adapter (Q6 answer) replacing the synthetic directory.
- EH/WebChart embedding: SSO/real user directory (currently a hard rule to keep stubbed — flipping it is a Doug decision), navigation embedding, brand alignment.
- Order write-back (`OrderSubmitter`, Q7) with standing-order checks against real orders.
- DataChaser outreach GA + delivery-log tables (the documented `PgCampaignStore` drop-in).
- Performance/certification pass at real scale; QRDA III beyond stub if certification matters (Charter names Nicole Welsh for certification).

## 4. Staged path to "polished, deployed, real-data product"

**Stage 0 — Hardening (now, unblocked, ~2–3 wks).** The Bucket-A list. Exit: audit ledger complete for every state change; all live pages <1.5s at current scale; foreign-bundle golden tests green; role-fit UI clean; this review's H findings closed.

**Stage 1 — First real data (gated on WebChart schema; ~2–4 wks after).** E12 PR-2 adapter → run the existing 14 measures against a WebChart sandbox extract; validate E15 identity semantics against real MRNs; keep the synthetic directory as the test floor. Exit: one real WebChart patient population evaluated end-to-end with correct, explainable outcomes.

**Stage 2 — Official measures (gated on VSAC key; parallel to Stage 1; ~1–2 wks).** ValueSetResolver→VSAC live; E14 PR-3 execution diff; promote CMS122/125 to official-CQL execution mode. Exit: the fidelity tab shows COVERED with an execution-verified outcome match.

**Stage 3 — Architecture lock (gated on Q2 + Q1 answers).** Adopt Option C formally (ADR), pick EH-vs-WebChart-first (Q1), define the bounded SQL executor scope if any. Exit: data-layer ADR signed off by Doug.

**Stage 4 — Embed + operate (gated on MIE org decisions).** HRIS hierarchy, SSO, order write-back, DataChaser, R2 bucket, ICE. Exit: pilot deployment inside EH/WebChart for one real customer cohort — the press release becomes true.

Dependencies in one line: **Stage 0 → nothing; Stage 1 → WebChart schema; Stage 2 → VSAC key; Stage 3 → Doug Q1/Q2; Stage 4 → Stage 1+3 + MIE access items.** Stages 1 and 2 are independent and parallelizable.

## 5. Asks (prioritized, consolidated — supersedes nothing, sharpens the 2026-06-30 list)

**For Doug (decisions):**
1. **Q2 / E9**: accept Option C (hybrid, FHIR-native-first)? Or is all-SQL a hard requirement? *Most decision-ready; changes everything downstream.*
2. **Q1**: EH-first or WebChart-first for the embed target?
3. **Q3**: the real deadline now that March 31 2026 has passed — what's the next reporting cycle we aim at?
4. Confirm the hierarchy system-of-record (Q6) and the order write-back path (Q7).

**For Doug/MIE (access — each activates an already-built seam):**
5. WebChart MariaDB schema / sandbox (unblocks Stage 1 — the single biggest lever).
6. VSAC/UMLS API key (unblocks Stage 2).
7. Managed S3/R2 bucket + scoped credentials (1-day fix for the one live limitation).
8. ICE endpoint, DataChaser API access, published `@mieweb/datavis` (each ~days of wiring).
9. Proxmox `onboot=1` confirmation (nice-to-know only).

**For the owner (Taleef) — from this review, needing your sign-off, not Doug's:**
10. Owner-gated DDL: the three index sets from H5/M17 (self-creating `CREATE INDEX IF NOT EXISTS`, reversible).
11. A decision on reopen-after-manual-close semantics (H2) — product call, then a small code change.
12. Whether to keep the shared demo password for write-capable roles on a public sandbox (L3).

## 6. Verdict

Strategically, WorkWell has **completed the prototype phase and proven every claim the working-backwards press release makes that can be proven without MIE**: CQL-authored measures, eCQM-native artifacts, multi-level real-time dashboards at 120k scale, automated auditable outreach, quality-over-time source of truth. The remaining distance to "real-world deployed product" is roughly **one hardening sprint of our own work plus four external unlocks**, of which the WebChart schema and the Q2 decision dominate. The correct posture for the next conversation with Doug is not "look what I built" but **"everything is waiting on these five answers — which one do you want to unlock first?"**
