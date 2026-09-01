# Key audit facts (verified 2026-07-24) — archived 2026-09-01

> Moved out of `docs/LOCKED_DECISIONS.md`, which is `@`-imported into every session. This section was
> never binding — its own preamble says so — and it was costing ~2.3k tokens per session to carry a
> dated snapshot that the code supersedes. Every bullet is preserved verbatim below. Read it for
> provenance: it records the findings that MOTIVATED the 2026-08-04 plan. **Where this and the code
> disagree, the code wins.**

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
  > **resequenced to land with M-C** and had NOT shipped as of that date. *(Superseded 2026-08-05 — see
  > below.)*
  >
  > **SINCE (2026-08-05, ADR-059): the extraction SHIPPED as M-C / C1.**
  > `backend-ts/packages/measure-engine/` exists with `cql-execution` + `cql-exec-fhir` as its entire
  > manifest, published through one `src/index.ts`. **Measure content is INJECTED, never shipped** — the
  > catalog, the 17 compiled ELM libraries and the corpus expansions stay in `src/engine/cql/`, wired once
  > by `createWorkwellEngine()`. ADR-052's stated blocker (nine core-test→app edges) **dissolved rather than
  > being paid**: under injection every one of those tests is content-configured and therefore app-side, so
  > none was stranded and the package took no devDependency back on the app. **The second debt named above
  > — `node:` in the four `*-cli.ts` entrypoints — is UNCHANGED and still open**: those files stayed
  > app-side, so the debt did not move; it is C2's. `engine-boundary.test.ts` still allowlists it there.
- **Official-path machinery exists** (literal-diff + official-cases over fqm-execution, 121/121 MADiE
  green — **SINCE 2026-07-31 the gate is 410/410 exact across EIGHT measures**: CMS122 55, CMS125 66,
  CMS2 36, CMS68 19, CMS951 55, CMS138 47, CMS130 64, CMS165 68, 0 unexpected, 0 errors, per-measure
  detail and the CMS138 caveat in `docs/STANDARDS_CONFORMANCE.md`; **gated ≠ routed** — only CMS122 and
  CMS125 route, demo/production only) but is CMS122-hardcoded, vendored at stale v0.5.000 (CMS125 not vendored), and ADR-026-fenced
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
  > **SINCE (2026-08-02): QRDA-I EXISTS, both directions, and has been measured by CVU+.** Export
  > (ADR-049 → ADR-050) and import (ADR-051) both ship. A local Cypress v7.5.1 took 22 submissions and
  > **QRDA Category I now scores 0 against the HL7 base ruler** — XSD and Schematron alike — after three
  > CDA schema defects were fixed and re-measured (#380/#381,
  > `docs/evidence/CVU_VALIDATION_RUN_2026-08-02.md`). The remaining 4-per-document findings are the CMS
  > **Hospital** templateIds ADR-050 deliberately does not claim.
  >
  > **"QRDA-III is a stub" is STILL TRUE and now quantified: 48 CVU+ findings** across the two documents
  > (2 XSD + 46 Cat III Schematron) — templateId version drift plus absent `recordTarget`, `custodian`,
  > `author/time`, `methodCode`, `MSRAGG`, `statusCode`, `reference` and Aggregate Count.
  >
  > **Decision #2's bar above is NOT met by any of this.** That bar is the LOOP; this measured the
  > export leg over the synthetic corpus via the externally-supplied-document route. The Cypress
  > **Calculation Check** path has never run.
  >
  > **SINCE (2026-08-03 → 2026-08-04): the loop RAN, the calculation comparison PASSED exactly, the
  > submission came back RED on measure-identity lineage, and decision #2's bar has now been REPLACED.**
  > Offline against Cypress's own per-patient expected results: **64/64 and 150/150 subjects agreeing on
  > every population** (ADR-055). Through the product API end to end, emitting Cypress's exact counts
  > (ADR-056). The submission is red because `extract_results_by_ids` short-circuits on measure identity —
  > Cypress holds CMS125v14 (QDM), we run CMS125FHIR v1.0.000 (QI-Core) — and the QI-Core artifact has **no
  > per-population UUIDs** for QRDA III's identity model to carry. **ADR-058** retires the Calculation Check
  > green as a goal and moves the bar to the FHIR-column set; §4 above is rewritten accordingly.
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


