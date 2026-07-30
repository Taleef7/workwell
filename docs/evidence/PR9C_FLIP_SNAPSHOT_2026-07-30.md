# PR-9c pre-flip evidence — **cms125** on demo/production

**Date:** 2026-07-30 · **Branch:** `feat/official-flip-pr9c` · **ADR:** 045
**Change:** `deploy-twh-mieweb.yml` and `reconcile-twh-mieweb.yml` set `WORKWELL_OFFICIAL_MEASURES="cms125"`.

> **cms122 is NOT in this flip.** It is routable and it agrees with authored on every corpus target — but
> its OFFICIAL numerator means *failure* (HbA1c > 9% or no assessment), while `improvementNotation` still
> declares `increase` and QRDA III carries no notation field at all. Routing it would emit a
> self-contradictory MeasureReport. `official-flip-config.test.ts` refuses to let it ship until that trio
> is discharged; see the task and ADR-045 decision 1.

Regenerate with:

```bash
cd backend-ts
pnpm flip-snapshot --measure cms125 --source synthetic --eval 2026-07-30
pnpm flip-snapshot --measure cms125 --source fixture   --eval 2024-06-01
```

---

## Which corpus is the right one — and what it is not

`deploy-twh-mieweb.yml` carries **no** `WORKWELL_WEBCHART_*` env entry (checked at all three layers:
workflow `env:`, job `env:`, and the `jq` array; `deploy-mieweb-container.sh` injects nothing of its own).
So the demo/production stack has no WebChart seam and evaluates the **synthetic** directory.

**Read the run below as an agreement check across the outcome space, not as a roster forecast.** It is
**five designed corpus probes**, one per intended outcome — *not* the 150-employee synthetic directory the
run pipeline actually evaluates. Two consequences worth stating rather than glossing:

- The five collapse into **three** buckets, because `DUE_SOON` and `MISSING_DATA` both score OVERDUE here.
- A roster distribution is therefore **derived, not measured**. It is derivable because `run-pipeline.ts`
  and `scale-generator.ts` call the *same* `deriveExamConfig` + `buildSyntheticBundle`, and
  `buildCms125Bundle` hardcodes birthDate, sex, encounter and the dual-stamped mammogram — so per-subject
  variation for this measure is nil. The conclusion (inert) holds; the number below is an inference.

---

## 1. Synthetic corpus — the agreement check

```
## cms125 — 5 subject(s)

| | distribution |
|---|---|
| before (authored) | {"COMPLIANT":1,"OVERDUE":3,"EXCLUDED":1} |
| after (official)  | {"COMPLIANT":1,"OVERDUE":3,"EXCLUDED":1} |

- official initial population: 5 of 5
- authored finds 3 actionable subject(s)

No subject's roster row changes. The flip is inert for this data.
```

**Verdict: no verdict** — the tool prints DO NOT FLIP or INCONCLUSIVE only when the official initial
population is empty. cms125 admits **5 of 5** and agrees with authored on every probe.

**Derived roster expectation** (not measured): 150 subjects → **120 COMPLIANT / 27 OVERDUE / 3 EXCLUDED**,
unchanged before and after.

## 2. WebChart dev-DB fixture — recorded, not the flip target

```
## cms125 — 56 subject(s)

| before (authored) | {"MISSING_DATA":52,"OVERDUE":4} |
| after (official)  | {"MISSING_DATA":52,"OVERDUE":4} |

- official initial population: 4 of 56
- authored finds 4 actionable subject(s)
```

Staging (11 `WORKWELL_WEBCHART_*`) is **not** flipped by this change.

---

## 3. Checklist status

| step | status |
|---|---|
| 1 — sidecar-gated gates green | **PASS** — CI `official-cases` job: **38 tests, 38 pass, 0 skipped**; MADiE 121/121 |
| 2 — non-zero initial population | **PASS** — 5/5 on the corpus; see the caveat above about corpus ≠ roster |
| 3 — numerator checked, not just membership | **PASS** — the mammography gap is closed by dual-stamping (ADR-044) |
| 3b — REPORTING semantics consistent | **PASS for cms125** (numerator means compliance, notation `increase`). **FAILS for cms122** — which is why cms122 is excluded, enforced by test |
| 4 — before/after distribution snapshot | **PASS** — this document |
| 5 — workflow edit (both deploy AND reconcile) | this PR |
| 6 — redeploy + read the signals | post-merge, below |

## 4. What to check after the deploy

1. **Grep the logs for `OFFICIAL_ROUTING_MISCONFIGURED`.** A misconfiguration does **not** refuse at boot
   — the throw is at engine construction, per request, while the DB-free `/actuator/health` keeps
   answering 200. A green container is not evidence.
2. **`seams: … official-measures=on`** in the boot line confirms the variable was read; it does not name
   which measures are routed.
3. **A new `triggeredBy='scheduler'` run must appear within ~15 minutes.** `WORKWELL_SCHEDULER_ENABLED=true`
   and `nextDueAtMs` resets on restart, so an ALL_PROGRAMS run fires shortly after the container comes up.
   If the sidecar is bad, `routedEngineForEnv` throws inside `schedulerTick`, which logs
   `SCHEDULER_TICK_ERROR` and retries forever — **no run is created, and the request-path
   `OFFICIAL_ROUTING_MISCONFIGURED` line never appears.** Absence of a scheduled run is the signal there.
4. **Read `run_logs`** for `cms125: N subject(s) evaluated in one official batch`.
5. **No ADR-043 `WARN`** should appear.

## 5. Rollback

Remove the `WORKWELL_OFFICIAL_MEASURES` line from **both** `deploy-twh-mieweb.yml` and
`reconcile-twh-mieweb.yml` and redeploy. Removing it from only one leaves the flip live via the self-heal
path — `official-flip-config.test.ts` fails that state, so CI catches it. `logic_version` carries the
artifact identity (ADR-040), so flip-off invalidates `eval_state` by construction; no manual cache `DELETE`.

## 6. Limits of this evidence

- **Five probes, not the roster.** Section 1's caveat is the honest version.
- The oracle is **our own authored engine**, not external truth. Agreement means the flip changes nothing
  for this data — not that either engine is correct. The external check is the MADiE gate (121/121), over
  CMS's test patients.
- **Cypress CVU+ has not run.** It remains the verification bar (M-B).
- Two user-visible surfaces degrade for a routed measure and are **not** addressed here: the case-detail
  **CQL Evidence Explorer** shows four `official:<population>` booleans instead of the authored clinical
  defines, and the **fidelity/Standards tab** compares authored against official for a measure whose
  stored outcomes are already official.
- Nothing here says anything about a **live third-party WebChart tenant**; production has no WebChart seam.
