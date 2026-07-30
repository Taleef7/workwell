# PR-9c pre-flip evidence — cms122 + cms125 on demo/production

**Date:** 2026-07-30 · **Branch:** `feat/official-flip-pr9c` · **ADR:** 045
**Change:** `deploy-twh-mieweb.yml` sets `WORKWELL_OFFICIAL_MEASURES="cms122,cms125"`.

This is the artefact DEPLOY.md §"Flipping a measure to official execution" step 2 asks for, committed
rather than pasted into a PR comment so the numbers a flip was approved on survive the flip.

Regenerate with:

```bash
cd backend-ts
pnpm flip-snapshot --measure cms122 --measure cms125 --source synthetic --eval 2026-07-30
pnpm flip-snapshot --measure cms125 --source fixture --eval 2024-06-01
```

---

## Which corpus is the right one

`deploy-twh-mieweb.yml` carries **zero** `WORKWELL_WEBCHART_*` (verified — `grep -c` returns 0), so the
demo/production stack has no WebChart seam and evaluates the **synthetic** roster. The synthetic snapshot
below is therefore the one this flip is judged on; the WebChart fixture is recorded for completeness and
because it is what the *staging* stack (11 `WORKWELL_WEBCHART_*`) would see.

Read the synthetic run as an **agreement check across the outcome space**, not as a roster forecast: it is
five designed corpus probes, one per intended outcome, not the full employee directory the run pipeline
evaluates. The five collapse into three buckets because `DUE_SOON` and `MISSING_DATA` both score OVERDUE
for these measures.

---

## 1. Synthetic corpus — what demo/production evaluates

```
## cms122 — 5 subject(s)

| | distribution |
|---|---|
| before (authored) | {"COMPLIANT":1,"OVERDUE":3,"EXCLUDED":1} |
| after (official)  | {"COMPLIANT":1,"OVERDUE":3,"EXCLUDED":1} |

- official initial population: 5 of 5
- authored finds 3 actionable subject(s)

No subject's roster row changes. The flip is inert for this data.

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
population is empty. Both measures admit **5 of 5**, and both agree with the authored engine on every
subject across COMPLIANT / OVERDUE / EXCLUDED.

## 2. WebChart dev-DB fixture — recorded, not the flip target

```
## cms125 — 56 subject(s)

| | distribution |
|---|---|
| before (authored) | {"MISSING_DATA":52,"OVERDUE":4} |
| after (official)  | {"MISSING_DATA":52,"OVERDUE":4} |

- official initial population: 4 of 56
- authored finds 4 actionable subject(s)

No subject's roster row changes. The flip is inert for this data.
```

`cms122` over this fixture reports **INCONCLUSIVE** — official admits 0 of 56 and authored finds nobody
actionable either, because the seed carries zero Conditions and cms122 is deliberately outside
`ROSTER_ELIGIBLE_MEASURES` (its "enrollment" is a diabetes *diagnosis* the roster must never fabricate).
That is a **data gap, not a divergence**, and it constrains staging rather than this flip (ADR-043
decision 6).

---

## 3. Checklist status

| step | status |
|---|---|
| 1 — sidecar-gated gates green | **PASS** — CI `official-cases` job: 35 tests, 35 pass, **0 skipped**; MADiE 121/121 |
| 2 — non-zero initial population | **PASS** — 5/5 for both measures on the corpus this stack evaluates |
| 3 — numerator checked, not just membership | **PASS** — the mammography gap is closed by dual-stamping (ADR-044); cms122's numerator (HbA1c > 9%) scores correctly across all five corpus targets |
| 4 — before/after distribution snapshot | **PASS** — this document |
| 5 — workflow edit | this PR |
| 6 — redeploy + read the signals | post-merge, see below |

## 4. What to check after the deploy

1. **Grep the logs for `OFFICIAL_ROUTING_MISCONFIGURED`.** A misconfiguration does **not** refuse at boot
   — the throw is at engine construction, per request, while the DB-free `/actuator/health` keeps
   answering 200. A green container is not evidence.
2. **`seams: … official-measures=on`** in the boot line confirms the variable was read. It does **not**
   name which measures are routed, so it confirms the seam, not the value.
3. **Run one population run** and read `run_logs` for `cms122: N subject(s) evaluated in one official
   batch` (and the same for cms125). That INFO line is the proof the artifact actually ran.
4. **`WORKWELL_SCHEDULER_ENABLED=true` on this stack**, so the nightly `ALL_PROGRAMS` run will exercise
   the flip without anyone triggering it. Check the first scheduled run as well as a manual one.
5. **No ADR-043 `WARN`** should appear. If `not one of N subjects entered the official initial
   population` shows up, the roster this stack evaluates differs from the corpus measured here.

## 5. Rollback

Remove the `WORKWELL_OFFICIAL_MEASURES` line from `deploy-twh-mieweb.yml` and redeploy. `logic_version`
carries the artifact's identity (`official-fqm:<version>:<artifactSha>:<terminologySha>`, ADR-040), so
flip-on, flip-off and re-vendor each invalidate `eval_state` by construction — **no manual cache
`DELETE`**. Outcomes written while routed stay in place and remain valid evidence; the next run after a
rollback re-evaluates with the authored engine.

## 6. Limits of this evidence

- The synthetic corpus is **five probes**, not the roster. Agreement across the outcome space is strong
  evidence that routing is inert, but it is not a per-employee forecast.
- The oracle is **our own authored engine**, not external truth. Agreement means the flip changes nothing
  for this data — not that either engine is correct. The external check is the MADiE gate (121/121), which
  is over CMS's test patients, not ours.
- **Cypress CVU+ has not run.** It remains the verification bar (roadmap M-B).
- This says nothing about a **live third-party WebChart tenant**: both the `us-core-sex` and
  dual-stamped-mammography fixes sit upstream of the live FHIR transport, and `normalizeWebChartBundle`
  is untouched by design. Production has no WebChart seam, so that limit does not bear on this flip.
