# Locked decisions (always-loaded)

> The owner's locked decisions — the things a session must not silently contradict. Stated as they stand
> today; the dated amendments that got them here are in git history (an `ADR-0NN` id resolves as CLAUDE.md
> says). Section and item numbers are cited elsewhere ("locked decision 2", "§4A.3") and stay fixed; a
> new decision is APPENDED.

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
2. **The pilot's catalog is the ACO's computable set, and the sandbox routes all five** — cms122, cms125,
   cms2, cms130, cms165 (ADR-078, owner decision 2026-09-08). **cms137 is retired on Maui** (owner decision
   2026-11-05, #889): the CY2027 final rule (CMS-1848-F) removed Quality ID 305 from APP Plus. Its artifact
   and 2027 translation stay vendored and gated, routed nowhere; the profile names it retired, and an
   all-programs run closes its open cases. One condition gates the **PHI phase**, not the sandbox: cms165
   needs real blood pressures profile-stamped at ingest (#591). The vendored artifacts are 2026-vintage; PY2027
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
7. **Which staff member works each provider's panel is kept in WorkWell**, not taken from WebChart
   departments; MIE data may only seed it through a reviewed import (owner decision, 2026-09-12).
8. **A QRDA I blood pressure becomes one US Core panel only when the document states exactly one**
   (owner decision, 2026-10-10; conditions completed 2026-10-11). Pairing is a mapping, not an invention:
   two Physical Exam, Performed readings become one Observation (code 85354-9, category `vital-signs`,
   `status: final`, the two stated readings as its components; preparation then stamps
   `us-core-blood-pressure` from those codes) only when ALL of these hold:
   - both are positive (not negated) entries in one document, each its entry's own act (not inside an
     organizer or another act) and each an event that happened (`EVN`, `completed`);
   - one states 8480-6 and the other 8462-4, each kept verbatim as its component's code (a reading stating
     both is neither). A systolic is 8480-6 and a diastolic 8462-4, the codes CMS165 reads: a reading under
     another code (sitting, standing, invasive, SNOMED) neither pairs nor blocks;
   - they share an identical time that includes a time of day: the same instant, or the same closed low and
     high (never a date alone or an open interval), stated at the same precision (a tenth of a second is not
     a thousandth) and both with or both without an offset;
   - no other systolic or diastolic, of any template, states a time that could fall within theirs, judged
     across time zones (a date with no zone could be any zone's day);
   - each states exactly one value of its own, a numeric `PQ` in mm[Hg] (a `nullFlavor`, a unitless value,
     another unit, a second value, or a Result coded as the other half is never paired). A stated value is
     not judged: 0/0 pairs;
   - they state the same performer, participants (QDM Performer and devices included), method and site, or
     none.

   The panel replaces both readings and keeps both source ids, their time in its stated offset with its
   fraction as written, and their shared site and method. Anything short of that stays as separate
   readings, which CMS165 cannot see, and is counted in the import diagnostics. No half-panel is emitted
   and no `Observation.encounter` is inferred. This does not lift the PHI gate: cms165 over real data still
   needs §4A.2's and §4A.5's conditions (#591, #572).
9. **The lead and the staff seat are different roles** (owner decision, 2026-11-02, #880). The staff seat
   (`ROLE_QUALITY_STAFF`) works one case at a time (assign, outreach, escalate, resolve, appointment,
   re-check, the patient's one message), exports the CSVs and reads the scorecard. Bulk assign, campaigns,
   attributed lists, panel owners, population runs, identity and the People directory, QRDA and
   MeasureReport files, and MCP stay with the lead (`ROLE_CASE_MANAGER`) and admins. Single assign stays
   with staff: the split limits the volume of a change, not who may make it. A rule that does not name the
   staff role refuses it. Logging a contact and setting a patient's contact preference are the staff
   seat's too (owner decision, 2026-11-03, #886).
10. **The year change** (owner decision, 2026-11-02, #882). The 1 January rollover stays: the year's first
    run closes every open case of the year before. From then on a cycle that has ended never opens or reopens
    a case: a run, a re-check or outreach over it records what it found and leaves its cases closed, and
    campaigns target only a current cycle. A run that scores an ended cycle is marked by the server and is
    never anyone's "latest", so the work list, roster, Programs, the trend, the cards and MCP stay on the
    current year. The lead re-scores last year on demand from January to March, which the scorecard and the
    list report read. "Today" is the practice's date everywhere it decides a year or a cycle; Maui's zone is
    `Pacific/Honolulu`, pending MIE's confirmation, and the nightly stays at 12:00 UTC (2:00 AM in Hawaii).
    The comparisons against the year's exact edges stay UTC, a documented limitation (MEASURES.md), until
    MIE confirms WebChart's zone.
