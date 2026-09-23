# Locked decisions (always-loaded)

> The owner's locked decisions — the things a session must not silently contradict. Stated as they stand
> today; the dated amendments that got them here are in git history and in the ADRs named. Section and item
> numbers are cited elsewhere ("locked decision 2", "§4A.3") and stay fixed.

## 4. Owner decisions (locked 2026-08-04, ADR-058)

1. **WorkWell is SUPPLEMENTARY to WebChart and does NOT pursue ONC certification.** WebChart carries
   certification. **No work is justified by "certification needs it."**
2. **The verification bar is the FHIR-column verification SET** (`ROADMAP_2026-08-04.md` §4), not a single
   external pass/fail. A Cypress Calculation Check green is **retired as a goal** — it needs a QDM execution
   path we are deliberately not building.
3. **We do not relabel, and we do not build a QDM engine.** Emitting a QDM-lineage measure identity over
   QI-Core-executed counts is forbidden, unconditionally (ADR-046 d3/d4, ADR-058). The no-QDM-engine half
   (ADR-058 decision 4) is revisited only if MIE states that certifying WorkWell's engine is a business goal.
4. **QRDA I/III is kept as an interoperability bridge**, not a certification target (both validate at 0
   findings against the HL7 base ruler).
5. **The engine and its packaging are the primary deliverable** (M-C was promoted ahead of measure
   breadth, and is complete and published): a pnpm workspace under the neutral npm scope **`@work-well/*`**
   (not `@workwell/*`, which npm refuses; not `@mieweb/*` for now). *(Its other half — "the versioned
   compliance API is the contract MIE consumes" — is superseded by §4A.4.)*
6. **The long-term differentiator is the measures nobody publishes** (occupational/OSHA, M-E). M-E1's
   execution is **deferred behind the Maui pilot — deferred, not cancelled** (ADR-070).
7. The authored cms122/cms125 subsets **retire from the catalog into the fidelity/Standards lab** after
   the flip (#377; not scheduled).

## 4A. Owner decisions (locked 2026-08-30 — the Maui pilot, ADR-070)

The plan is `docs/ROADMAP_2026-08-30.md`; the verification bar stays §4 decision 2.

1. **The Maui pilot is the spearhead**: a patient-driven deployment for a primary-care group on WebChart
   entering an MSSP ACO (PY2027 begins 2027-01-01). **Scope limit:** the milestones deliver a *sandbox*;
   the pilot running its real year on real data (PHI) is a separate, later, `PRODUCTION_READINESS`-gated
   decision nothing here authorizes.
2. **The pilot's catalog is the ACO's computable set, and the sandbox routes all six** — cms122, cms125,
   cms2, cms130, cms165, cms137 (ADR-078, owner decision 2026-09-08). Two conditions gate the **PHI phase**,
   not the sandbox: cms137 stays only if Quality ID 305 survives the CY2027 final rule, and cms165 needs
   real blood pressures profile-stamped at ingest (#591). The vendored artifacts are 2026-vintage; PY2027
   needs new content and a full re-gate (MM-1d). The MIPS↔CMS crosswalk is a first-class UI surface.
3. **Cards resolve, not alert.** Order suggestions are gated on APPROVED terminology mappings, and **an
   order is a proposal that never changes compliance** — the gap closes only when the result arrives and
   CQL re-evaluates. Exceptions are documented as structured data the measure reads on the next run;
   WorkWell never overrides CQL. ADR-067 stands: no `critical`, no `systemActions`, and a card renders a
   completed evaluation (freshness comes from evaluating sooner on ingest, never from the card).
4. **The compliance API is a kept, versioned, served surface — not the integration contract.** The
   contract is the card/CDS surface plus the Maui deployment; no work is justified by the API alone.
5. **No known-unverified measure runs over the pilot's real data.** (Read against the PHI phase since
   ADR-078 — e.g. cms165's cross-engine gap, #572, must be closed first. Cheap, unblocked work goes before
   externally blocked work.)
6. **Naming policy:** repo documents say "Maui" (the deployment) and "the pilot group" only — no
   client-side legal or staff names and no client-provided documents (MIE-side names are fine); pilot user
   accounts use pseudonymous identifiers; source materials stay under the gitignored local-only path.
