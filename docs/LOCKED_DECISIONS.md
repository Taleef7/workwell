# Locked decisions + audit facts (always-loaded extract)

> **Authoritative for §4–5.** Extracted from `docs/ROADMAP_2026-07-24.md` (the APPROVED active plan)
> so the *locked* decisions are in context every session — these are the things a session must not
> silently contradict. The rest of the roadmap (§1–3 context/critique/north-star, §6–11 milestones,
> architecture, risks, verification, deliverables — ~44k chars) stays on demand.
>
> Edit here, not in the roadmap — ROADMAP §4–5 now point at this file.

## 4. Owner decisions (locked 2026-07-24)

1. Spearhead = **M-A official-first execution**.
2. QRDA bar = **CVU+-validated loop** (import → evaluate → export → Cypress CVU+ green, local Docker).
3. Packaging = **pnpm workspace now, neutral scope `@workwell/*`**, pitch Doug on `@mieweb/*` later.
4. Authored cms122/125 subsets **retire from the catalog into the fidelity/Standards lab** post-flip.

## 5. Key audit facts (verified 2026-07-24 — a DATED SNAPSHOT, not a live constraint)

> **§4 above is binding; this section is not.** These are the findings that *motivated* the plan, recorded
> as of 2026-07-24. Work since then has superseded some of them, and each such bullet carries an inline
> **SINCE** note. A stale finding here is not something a session must avoid contradicting — where this
> section and the code disagree, **the code wins.** Verify against the tree before relying on any bullet.
>
> This distinction matters because of where the text came from: inside `ROADMAP_2026-07-24.md` it was
> plainly a dated audit. Extracting it into an always-loaded file whose preamble says "must not silently
> contradict" promoted stale observations to standing rules, which is the opposite of the intent
> (Codex review of PR #351).

- **Engine extractability:** `src/engine/` had exactly 4 app-layer couplings — `engine-factory.ts`'s
  `getStores` value import (app wiring), two type-only imports of the 30-method `ValueSetStore` (engine
  used only `listAll()`), and `evaluate-measure.ts`'s `@mieweb/cloud` import (served only
  `UnconfiguredEngine`). Severed → the tree reaches nothing outside itself; the **eval core**'s deps are
  `cql-execution` + `cql-exec-fhir` only and it is node:fs-free/Workers-portable;
  `evaluate(input.elm, input.metaOverride)` already supports consumer-supplied measures.
  **(Severance shipped as extraction PR-1, 2026-07-24.)** Two items of **extraction debt remain in the
  tree** and are PR-2's job, not PR-1's — they are why the package manifest is not yet a two-dep file:
  `@cqframework/cql/cql-to-elm` in `cql/cql-translator.ts` (the ELM Explorer, reached from
  `routes/measures.ts`; §7.1 keeps it in the app) and `node:fs`/`node:path`/`node:url` in the four
  `*-cli.ts` entrypoints. Both are pinned by the boundary test's allowlist, so neither can spread.
  > **SINCE (2026-07-30, ADR-048): the FIRST of the two debts is PAID.** `cql-translator.ts` and its
  > `resources/` moved to `src/measure/`, the `@cqframework/cql` allowlist entry is **deleted**, and the
  > boundary test now REFUSES that dep anywhere in the engine tree (mutation-checked). So the sentence
  > above — "both are pinned by the boundary test's allowlist" — is true of the `node:` entry only.
  > That second debt stands and is not a `git mv`: `generate-sql-cli.ts` and `devdb-cli.ts` export library
  > values consumed by 7+ modules including production `live-cli.ts`. Also measured and worth carrying:
  > `cql/codegen/generate-sql-cli.ts` reaches `ingress/webchart/terminology.ts` → `synthetic/measure-bindings.ts`,
  > so `cql/` is NOT wholesale-liftable; the eval core minus those CLI files is.
  >
  > **SINCE (2026-07-24, same day):** PR-2 — the physical `packages/measure-engine` extraction — was
  > **resequenced to land with M-C** and has NOT shipped. `backend-ts/packages/` today contains only
  > `official-executor/`. The debt described above is therefore still in the tree, still allowlisted, and
  > still PR-2's job — just later than this bullet implies.
- **Official-path machinery exists** (literal-diff + official-cases over fqm-execution, 121/121 MADiE
  green) but is CMS122-hardcoded, vendored at stale v0.5.000 (CMS125 not vendored), and ADR-026-fenced
  diagnostic-only. `MeasureExecutor` seam is clean but env-global; official-first needs per-measure
  routing. MeasureReport D1/D2 were already fixed (PR #294/ADR-031) — PR-3 below only generalizes.
  > **SINCE (2026-07-30): every deficiency in this bullet is closed.** Both CMS122 and CMS125 are vendored
  > at **v1.0.000** (PR-5), the executor **adapter** (PR-7a) and the **per-measure router** with
  > construction-time validation (PR-7b) shipped, PR-3 generalized MeasureReport membership, and the
  > capped `AdvancedIllness` expansion is completed (PR-9a / ADR-041) so
  > `officialRoutingProblems(["cms122"])` and `(["cms125"])` both return **no problems** — the two measures
  > are ROUTABLE.
  >
  > **SINCE (2026-07-30, PR-9c / ADR-045 + ADR-046): cms122 AND cms125 ARE ROUTED on demo/production.**
  > `deploy-twh-mieweb.yml` and `reconcile-twh-mieweb.yml` both set
  > `WORKWELL_OFFICIAL_MEASURES="cms122,cms125"`. cms122 shipped one PR later than cms125, once ADR-046
  > made canonical/improvementNotation/membership all derive from the outcome's own evidence — routing it
  > before that would have emitted a MeasureReport declaring higher-is-better over a poor-control numerator. Every OTHER environment —
  > staging included — still leaves the variable unset, so there `routedEngineForEnv` returns
  > `engineForEnv`'s value by identity and every measure evaluates authored CQL. The flip is **inert on
  > this stack's data** (no roster row changes; cms125 5/5 in the official initial population and
  > agreeing with authored across the corpus — `docs/evidence/PR9C_FLIP_SNAPSHOT_2026-07-30.md`). Current state: the
  > ADR-036..045 run in `docs/DECISIONS.md` (newest first) and the Current Focus block in `CLAUDE.md`.
- **QRDA-I does not exist anywhere**; QRDA-III is a stub. Cypress + CVU+ are open source
  (github.com/projectcypress/cypress), Docker-runnable; projecttacoma/cqm-reports (Ruby) is the QRDA-I
  reference implementation (spec reference only, not a dependency).
- **All 8 priority measures have official QICore v1.0.000 artifacts + MADiE test cases** in
  `cqframework/dqm-content-qicore-2025` (CMS2FHIRPCSDepScreenAndFollowUp, CMS68FHIRDocumentationCurrentMeds,
  CMS122FHIRDiabetesAssessGT9Pct, CMS125FHIRBreastCancerScreen, CMS130FHIRColorectalCancerScrn,
  CMS138FHIRTobaccoScrnCessation, CMS165FHIRControllingHighBP, CMS951FHIRKidneyHealthEval — "Kidney
  Health Evaluation", MIPS 488). 6 of 8 are Draft catalog stubs today.
- **WebChart data gaps for the 6 new measures:** shim serves Patient/Observation/Procedure only
  (Condition/Encounter advertised but empty; no medications path). Closest: CMS165 + CMS951 (labs
  present, need Condition). CMS68/138 blocked on a medications path. The PR #316 AI-YAML ingest loop is
  the tool to seed missing data types into dev-wcdb.
- **Honesty nuance:** what ONC certifies *today* is the QDM/QRDA form; the QICore artifacts are the
  official dQM (future-column) form of the same measures, validated against MADiE expecteds. WorkWell
  is not an EHR seeking ONC certification — running the official FHIR artifacts is both the right
  engineering choice (we're FHIR-native) and the direction-of-travel choice. Say it exactly that way.

