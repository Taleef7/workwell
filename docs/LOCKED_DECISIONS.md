# Locked decisions (always-loaded extract)

> **Authoritative.** This file is `@`-imported into every session so the *locked* decisions are always
> in context — they are the things a session must not silently contradict. Everything here binds;
> anything that did not bind has been moved out (see §5).
>
> **§4** was rewritten 2026-08-04 (ADR-058, `ROADMAP_2026-08-04.md`). **§4A** was added 2026-08-30
> (ADR-070, active plan `ROADMAP_2026-08-30.md`); §4 still stands except where a dated SINCE note
> inside it says otherwise.
>
> The rest of the active roadmap — context, north star, milestones, architecture, risks, verification,
> deliverables — stays on demand. Edit the decisions here, not in the roadmap.

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
## 5. Key audit facts (verified 2026-07-24) — ARCHIVED

The dated 2026-07-24 audit snapshot that used to sit here has moved to
**`docs/archive/AUDIT_FACTS_2026-07-24.md`**, verbatim and with its SINCE notes intact.

It moved because it was the one section of an always-loaded file that **bound nobody**: its own
preamble said "§4 above is binding; this section is not", and "where this section and the code
disagree, the code wins". A finding that a session must not contradict belongs here; a dated
observation that the code has since superseded is provenance, and provenance can be read on demand.
Everything it recorded as still-open has since been closed and is captured in `CLAUDE.md`'s
"Where the project stands".
