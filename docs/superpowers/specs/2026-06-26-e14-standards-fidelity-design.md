# E14 — Standards Fidelity: diff WorkWell's authored eCQM CQL against the official spec — Design

**Epic:** E14 (#186) — Standards fidelity: import & diff official eCQI/CMS CQL (+ country-aware regs)
**Date:** 2026-06-26
**Status:** Design (PR-1 scoped for implementation; PR-2 documented, deferred)
**Author:** Taleef (via Claude Code, autonomous)
**Depends on:** E3 (#73) eCQM artifacts; reuses the E3.2 (#90) `ValueSetResolver` seam.

---

## 1. Context & problem

WorkWell's eCQM measures (`cms122`, `cms125`) are **hand-authored, simplified** CQL: local value sets
(`urn:workwell:vs:cms122-*`, 1–5 codes each), WorkWell-specific define names, and outcome-mapped logic
that captures the *gist* of the official measure. For example, WorkWell's `cms122.cql` keys on a diabetes
diagnosis + most-recent HbA1c > 9% (poor control) + missing-data, but **omits** the official measure's
age 18–75 restriction, its qualifying-visit requirement, the GMI alternative, and its four denominator
exclusions (hospice / long-term-care 66+ / advanced-illness+frailty 66+ / palliative) — collapsing them
into one generic `"Has Exclusion"`. It references 3 local value sets vs the official ~20 VSAC value sets.

Doug (June 15): *"use and compare official ECQI documented CQL"* and *"does it look for the latest
regulatory updates based on your country?"* E14 makes the **officially published** measure definition the
**reference**, produces a **documented fidelity diff** of WorkWell's authored version against it, and lays
**country-aware** groundwork as measure metadata.

The official artifacts are **publicly obtainable with clean provenance** (verified): the eCQI Resource
Center human-readable HTML, the QDM package ZIP (`.cql` + ELM + HQMF + value-set lists), and the QPP MIPS
PDFs (frozen literal code lists, **no VSAC login**). Primary source for the first measure:
`https://ecqi.healthit.gov/ecqm/ec/2026/cms0122v14` (CMS122v14, version 14.0.000, steward NCQA).

## 2. The pivotal scope decision (recorded)

> **PR-1 = a structural/definitional fidelity diff, NOT execution of the official CQL.**

Full *execution* of the official CMS122v14 CQL is research-grade: it needs the QDM→FHIR translation (the
engine runs `cql-exec-fhir`), expansion of ~20 VSAC value sets, the shared exclusion libraries
(Hospice / AdvancedIllnessandFrailty / PalliativeCare / SupplementalDataElements / QICoreCommon), and
QI-Core patient bundles carrying encounter/hospice/frailty/palliative resources. The issue explicitly says
**"scope the build conservatively."** So PR-1 delivers the **documented diff** (acceptance item 1's
"documented diff vs our authored version") via a **structural** comparison — official population criteria +
required value sets (vendored, sourced) vs WorkWell's authored measure (its CQL defines, outcome mapping,
and value-set references). Full official-CQL **execution + outcome diff** is **PR-2**, deferred behind the
existing `ValueSetResolver` seam (E3.2), with frozen QPP code lists as a no-VSAC expansion source.

This is honest: WorkWell already *evaluates its own* measure; PR-1 documents exactly where that authored
measure **diverges in definition** from the official spec. CQL `Outcome Status` stays authoritative
(ADR-008) — the fidelity report is advisory/descriptive and never changes any outcome.

## 3. Goals & acceptance (from #186)

- **(a)** An **import/reference path** for an official eCQI/CMS measure definition (≥1 measure — CMS122v14)
  with provenance; **a documented fidelity diff** vs WorkWell's authored version is produced.
  *(PR-1 delivers the diff via structural comparison; PR-2 adds official-CQL execution + outcome diff.)*
- **(b)** **Country/jurisdiction modeled as measure metadata** (rule set selectable by country) + a
  **documented design** for "latest regulatory updates by country." *(PR-1: the metadata field + the
  design memo; the build of country-switching rules is design-first/aspirational per the issue Notes.)*

**Non-goals (YAGNI / deferred):** executing the official CQL (PR-2); a live VSAC adapter (PR-2 uses frozen
QPP codes); auto-deriving semantic coverage purely from CQL text (the curated coverage map is authored once
per measure, grounded in the official source); building actual country-specific alternate rule sets (a
design memo only); any UI beyond surfacing the report (a small read-only measure-detail panel is optional).

## 4. Decomposition — two PRs

| PR | Scope | Risk | Delivers |
|----|-------|------|----------|
| **PR-1** (this design, build now) | The `standards/` module: a **vendored, sourced CMS122v14 reference** (structured official population criteria + required VSAC value sets + provenance); a **fidelity diff engine** (`computeFidelity`) comparing WorkWell's authored measure against the reference → a `FidelityReport`; `GET /api/measures/:id/fidelity`; a `jurisdiction` measure-metadata field (default `US`); the country-aware **design memo**. No schema, no new deps. | Low–medium — additive, structural, sourced. | (a) the documented diff; (b) the metadata + memo. |
| **PR-2** (documented, deferred) | **Execute** the official CMS122v14 (FHIR-derived) CQL: compile official CQL→ELM, expand its value sets from **frozen QPP code lists** via a `ValueSetResolver` adapter, build QI-Core bundles with the encounter/exclusion resources, run, and produce an **outcome diff** (official vs authored on the same patients). | High — QDM→FHIR, many libraries, value-set volume. | (a) the outcome diff for real. |

## 5. Architecture (PR-1)

A new `backend-ts/src/standards/` module — measure-definition references + the fidelity diff. It reads
WorkWell's existing measure metadata + value-set references; it does **not** touch the engine or any
outcome.

### 5.1 The official reference (vendored, sourced)
`standards/references/cms122v14.ts` — a structured, hand-transcribed-from-the-official-source representation
of the official population definition, with provenance. Shape:

```ts
export interface OfficialValueSetRef { name: string; oid: string; concept: string; } // concept = our grouping tag
export interface OfficialCriterion {
  population: "IPP" | "DENOM" | "DENEX" | "NUMER" | "NUMEX";
  key: string;                 // stable id, e.g. "age-18-75", "hospice-exclusion"
  description: string;         // official logic in plain terms (sourced)
  valueSets?: string[];        // OIDs this criterion references
}
export interface OfficialMeasureReference {
  measureId: string;           // WorkWell registry id this references, e.g. "cms122"
  ecqmId: string;              // "CMS122v14"
  title: string;               // official v14 title
  version: string;             // "14.0.000"
  steward: string;             // "NCQA"
  scoring: string;             // "proportion"
  provenance: { sourceUrl: string; frozenCodesUrl?: string; retrieved: string };
  criteria: OfficialCriterion[];
  valueSets: OfficialValueSetRef[];
}
```

The CMS122v14 reference encodes: IPP (age 18–75, diabetes, qualifying visit), DENOM (= IPP), DENEX
(hospice; LTC 66+; advanced-illness+frailty 66+; palliative), NUMER (most-recent HbA1c/GMI > 9% **or
missing/not-performed**), NUMEX (none) — each criterion citing its VSAC value sets. **Every value/claim is
transcribed from the official source URLs in `provenance`** (a code comment cites them); this is a sourced
reference artifact, not invented logic.

### 5.2 WorkWell's authored-measure view
`standards/authored-measure.ts` — derives a comparable view of WorkWell's authored measure from existing
data (no new source of truth): its registry `MeasureMeta`, its YAML binding (value-set refs), and its
authored CQL define names (parsed lightly from `measures/<id>.cql` — define names + `valueset` declarations,
a shallow text scan, not a CQL parser). Yields `{ measureId, defineNames: string[], valueSetRefs: string[],
outcomeMapping: ... }`.

### 5.3 The fidelity diff engine
`standards/measure-fidelity.ts` — `computeFidelity(reference, authored): FidelityReport`. For each official
criterion, classify WorkWell's coverage:

```ts
export type Coverage = "COVERED" | "SIMPLIFIED" | "OMITTED";
export interface CriterionFidelity {
  population: string; key: string; description: string;
  coverage: Coverage; note: string;          // why — grounded, e.g. "WorkWell has no age filter"
}
export interface ValueSetFidelity {
  concept: string;                            // "Diabetes", "Hospice", "HbA1c", "Frailty", …
  officialOids: string[];
  workwellRepresented: boolean;               // does WorkWell reference any value set for this concept?
  note: string;
}
export interface FidelityReport {
  measureId: string; ecqmId: string; title: string; version: string;
  provenance: OfficialMeasureReference["provenance"];
  criteria: CriterionFidelity[];
  valueSets: ValueSetFidelity[];
  summary: {
    covered: number; simplified: number; omitted: number;
    officialValueSetCount: number; workwellValueSetCount: number;
    headline: string;                          // one-line plain-English fidelity summary
  };
  disclaimer: string;                          // "structural/definitional diff; not an execution/outcome diff (PR-2)"
}
```

**Coverage classification is partly authored, partly derived.** The value-set fidelity is **derived**
(does WorkWell reference a value set for each official concept? — auto from the binding/CQL). The criterion
coverage uses a small **curated coverage map** in the reference (each official criterion tagged how
WorkWell's authored CQL handles it, with a grounded note) — authored once for CMS122, because semantic
equivalence ("WorkWell's `Has Exclusion` ≈ which official exclusions?") can't be reliably auto-derived from
CQL text. The engine assembles + counts; the curated map is the sourced judgement.

### 5.4 Jurisdiction metadata
Add an optional `jurisdiction?: string` to the registry `MeasureMeta` (`measure-registry.ts`), defaulting
to `"US"` when absent, and surface it on the measure-detail read model (`MeasureDetail`). PR-1 keeps this
**registry + read-model only** (not threaded through the synthetic `measure-bindings.ts`, which is unrelated
FHIR-bundle-generation data) — the simplest non-breaking home. The measure YAML may *also* carry an additive
`jurisdiction:` line as the authoring source of truth (the loader ignores unknown fields today), but
plumbing YAML→registry for it is optional polish, not required for PR-1. It is the *modeling* groundwork for
country-aware rule selection; the actual per-country rule sets are design-memo only (§5.6).

### 5.5 Endpoint
`GET /api/measures/:id/fidelity` → the `FidelityReport` for a measure that has an official reference
(CMS122 in PR-1); for measures without one, `{ available: false }` (200) so the caller can show "no official
reference yet." Read-only, authenticated under `/api/**`, read-time, **no schema**. Slots in beside the
existing `/traceability` + `/data-readiness` measure sub-routes.

### 5.6 Country-aware design memo
`docs/standards/country-aware-regulatory-sourcing.md` — a design-first memo: jurisdiction as measure
metadata (done in PR-1); a `RegulatorySource` concept (eCQI/CMS for US eCQMs, OSHA for US safety, with
named-but-unbuilt non-US analogues); how a country switch would select an alternate reference + rule set;
and the "latest regulatory updates by country" aspiration (a future watcher that diffs a measure against the
newest published version). No code beyond the metadata field.

## 6. Data flow (PR-1)

```
official source (eCQI/QPP, vendored once) ─► references/cms122v14.ts  (OfficialMeasureReference)
                                                              │
WorkWell registry + YAML binding + measures/cms122.cql ─► authored-measure.ts (authored view)
                                                              │
                                  computeFidelity(reference, authored)
                                                              ▼
                                            FidelityReport  ──►  GET /api/measures/:id/fidelity
```

No DB, no engine call, no outcome mutation. Pure read-time assembly.

## 7. Error handling

- No reference for the measure → endpoint returns `{ available: false }` (200), not an error.
- `authored-measure.ts` CQL scan is best-effort (define-name + `valueset` regex); if `measures/<id>.cql`
  is unreadable, it degrades to the binding-only view (value-set refs still compared) and notes it.
- The reference's `provenance.retrieved` date + source URLs are static (vendored); no network at runtime.

## 8. Testing (PR-1)

- **Reference integrity:** the CMS122v14 reference has all 5 populations represented, every criterion cites
  ≥1 value set where the official measure does, and provenance URLs are present.
- **`computeFidelity`:** for CMS122, the report marks the core numerator (HbA1c>9%) **COVERED**, the age
  18–75 + visit + the 3 extra exclusions **OMITTED**, the generic exclusion **SIMPLIFIED**; value-set
  fidelity shows diabetes+HbA1c represented and hospice/frailty/palliative/encounter **not** represented;
  the summary counts reconcile (`covered+simplified+omitted === criteria.length`).
- **Endpoint:** `GET /api/measures/cms122/fidelity` → 200 with the report; `GET /api/measures/audiogram/fidelity`
  → `{ available: false }`.
- **Jurisdiction:** the read model exposes `jurisdiction: "US"` for the seeded measures (default applied).

## 9. File structure (PR-1)

```
backend-ts/src/standards/
  reference-types.ts            # OfficialMeasureReference + criterion/value-set types
  references/cms122v14.ts       # the vendored, sourced CMS122v14 reference
  references/index.ts           # measureId → OfficialMeasureReference | undefined
  authored-measure.ts           # derive WorkWell's authored-measure view (registry + binding + light CQL scan)
  measure-fidelity.ts           # computeFidelity + FidelityReport types
  measure-fidelity.test.ts
  references/cms122v14.test.ts  # reference integrity
backend-ts/src/routes/measures.ts          # + GET /api/measures/:id/fidelity branch
backend-ts/src/engine/cql/measure-registry.ts  # + optional jurisdiction on MeasureMeta (default "US")
backend-ts/src/measure/measure-read-models.ts   # surface jurisdiction on MeasureDetail
docs/standards/country-aware-regulatory-sourcing.md   # the design memo
```

Docs: `docs/STANDARDS_CONFORMANCE.md` (+ an E14 fidelity row), `docs/JOURNAL.md`, a `DECISIONS.md` ADR
(structural-fidelity-first; official-CQL execution deferred). **No schema, no new deps.**

## 10. Risks & mitigations

- **"Diff" is partly curated, not fully auto-derived.** Mitigated/honest: value-set fidelity is derived;
  criterion coverage is a *sourced* curated map (semantic equivalence isn't reliably auto-derivable from CQL
  text). The report's `disclaimer` states this, and PR-2's execution diff is the objective complement.
- **Reference drift (official measure updates yearly).** The reference carries `version` + `provenance`; the
  country-aware memo describes the future "latest-version watcher." A test asserts the encoded `version`.
- **Scope creep toward execution.** Explicitly fenced: PR-1 is structural-only; PR-2 owns execution.

## 11. Out of scope (explicit)

Executing official CQL; a live VSAC adapter; auto-derived semantic coverage; real per-country rule sets;
UI work beyond optionally surfacing the report. All deferred per §2/§3.
