# Locked decisions + audit facts (always-loaded extract)

> **Authoritative for §4–5.** This file is `@`-imported into every session so the *locked* decisions are
> always in context — they are the things a session must not silently contradict.
>
> **§4 was rewritten on 2026-08-04** to match `docs/ROADMAP_2026-08-04.md` (driving ADR: **ADR-058**).
> **§4A was added on 2026-08-30** (driving ADR: **ADR-070**; active plan now
> `docs/ROADMAP_2026-08-30.md`) — the §4 decisions **stand** except where a dated SINCE note inside them
> says otherwise. **§5 is unchanged**: a dated audit snapshot extracted from the superseded
> `docs/archive/ROADMAP_2026-07-24.md`, binding on nobody — see its own preamble.
>
> The rest of the active roadmap (context, north star, milestones, architecture, risks, verification,
> deliverables) stays on demand. Edit the decisions here, not in the roadmap.

## 4. Owner decisions (locked 2026-08-04 — supersedes the 2026-07-24 set)

Driving ADR: **ADR-058**. *(SINCE 2026-08-30: the active plan is **`docs/ROADMAP_2026-08-30.md`** — see
§4A. The decisions below stand except where a SINCE note says otherwise; `ROADMAP_2026-08-04.md` §4
remains the normative verification set that decision 2 cites.)*

1. **WorkWell is SUPPLEMENTARY to WebChart and does NOT pursue ONC certification.** WebChart carries
   certification (~33/49 measures). WorkWell carries the engine. **No work is justified by "certification
   needs it."**
2. **The verification bar is the FHIR-column verification SET** (`ROADMAP_2026-08-04.md` §4), not a single
   external pass/fail. A **Cypress Calculation Check green is retired as a goal** — reaching it requires a
   QDM execution path we are deliberately not building (ADR-058). *(This replaces the 2026-07-24 bar,
   "import → evaluate → export → Cypress CVU+ green.")*
3. **We do not relabel, and we do not build a QDM engine.** Emitting a QDM-lineage measure identity over
   QI-Core-executed counts stays forbidden (ADR-046 d3/d4, reaffirmed by ADR-058). Revisit decision 4 of
   ADR-058 **only** if MIE states that certification of WorkWell's engine is a business goal.
4. **QRDA I/III is KEPT as an interoperability bridge**, not a certification target. Both document types
   validate at 0 findings against the HL7 base ruler; nothing is deleted.
5. **The engine and its packaging are the primary deliverable** — M-C is promoted ahead of measure breadth.
   Packaging = **pnpm workspace, neutral scope `@work-well/*`**, pitch Doug on `@mieweb/*` later. The
   **versioned compliance API** is the contract MIE consumes.
   > **The scope was decided as `@workwell/*` on 2026-08-04 and is `@work-well/*` since 2026-08-06**, for
   > a reason outside anyone's judgement: an unrelated unscoped package named `workwell` already exists on
   > npm, and npm refuses an org name that collides with an existing package name. The *decision* — a
   > neutral scope rather than `@mieweb/*` — is unchanged; only the spelling is.

   > **SINCE (2026-08-30, ADR-070): the "versioned compliance API is the contract MIE consumes" half of
   > this decision is SUPERSEDED.** The API is kept — versioned, documented, tested — but the integration
   > contract is now the card/CDS surface plus the Maui pilot deployment, and no work is justified by the
   > API contract alone. The packaging half (M-C, `@work-well/*`) stands, complete and published.
6. **The differentiator is the measures nobody publishes** (M-E occupational/OSHA). Official eCQMs prove the
   engine; occupational content is the part no competitor obtains by downloading CMS artifacts.
   *(SINCE 2026-08-30, ADR-070: stands as the long-term differentiator, but M-E1's execution DEFERS behind
   milestone M-M — the Maui pilot. Deferred, not cancelled.)*
7. Authored cms122/125 subsets **retire from the catalog into the fidelity/Standards lab** post-flip
   *(unchanged from 2026-07-24 #4; issue #377)*.

> **Superseded 2026-07-24 decision, kept for provenance:** *"Spearhead = M-A official-first execution."*
> M-A is largely complete (six measures gated, two routed); the spearhead is now M-C.
> *(And SINCE 2026-08-30: the spearhead is M-M — M-C completed 2026-08-05/07.)*

## 4A. Owner decisions (locked 2026-08-30 — the Maui pilot; driving ADR: ADR-070)

Active plan: **`docs/ROADMAP_2026-08-30.md`** (supersedes `ROADMAP_2026-08-04.md` as direction; that
document's §4 verification set stays the bar per §4 decision 2 above).

1. **The Maui pilot is the spearhead.** A patient-driven deployment for a primary-care group on WebChart
   entering an MSSP ACO (PY2027 begins 2027-01-01). Milestone **M-M supersedes M-E1 as next-up**; M-E1
   defers, not cancelled. **Scope limit:** the milestones deliver a *sandbox*; the pilot running its real
   year (PHI) is a separate, later, `PRODUCTION_READINESS`-gated decision nothing in M-M authorizes.
2. **The pilot's measure catalog is the ACO's computable set** — CMS122, CMS2, CMS165, CMS125, CMS130
   (already vendored + MADiE-gated; CMS2/CMS130/CMS165 additionally need **official-only onboarding**
   before they can run — gated ≠ routable ≠ runnable, ROADMAP §1.1/§4) plus **CMS137 only if measure 305
   survives the ACO's final set** — the CY2027 proposed rule (CMS-1848-P) proposes removing 305 from APP
   Plus for PY2027, so confirmation precedes the multi-rate spike, which precedes any promise (ADR-047's
   MADiE-gate precondition applies unchanged). The MIPS↔CMS crosswalk becomes a first-class UI surface.
   The vendored artifacts are 2026-vintage (`effectivePeriod` 2026-only): PY2027 needs a re-vendor +
   full re-gate (ROADMAP MM-1d).
3. **Cards resolve, not alert** — order suggestions (gated on APPROVED terminology mappings; **an order
   is a proposal and never changes compliance** — the gap closes only when the qualifying result data
   arrives and CQL re-evaluates) and exception documentation (structured data the measure logic reads
   next run; WorkWell never overrides CQL). ADR-067's refusals are unchanged: no `critical`, no
   `systemActions`, a card renders a completed evaluation — encounter-time freshness comes from
   evaluating sooner on ingest, never from card-triggered evaluation.
4. **The compliance API is demoted** from "the contract MIE consumes" (§4 decision 5's SINCE note) to a
   kept, versioned, served surface — the integration contract is the card/CDS surface plus the Maui
   deployment, and no work is justified by the API contract alone. (The CDS service is a parallel surface
   reading the finalized-outcome stores directly, not an API consumer.)
5. **Cheap-first sequencing:** MM-0 (instance + UX wins) before externally-blocked work; within MM-1,
   **no known-unverified measure is routed to the pilot** — CMS2's 7 mismatches are run down and
   CMS130/CMS165 swept before their flips.
6. **Naming policy:** repo documents say "Maui" (deployment name) and "the pilot group" only — no
   **client-side** legal or staff names, no client-provided documents (MIE-side names such as Doug and
   Nicole are unaffected, consistent with repo practice); pilot user accounts use pseudonymous
   identifiers in configuration; source materials stay under the gitignored local-only path.

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

