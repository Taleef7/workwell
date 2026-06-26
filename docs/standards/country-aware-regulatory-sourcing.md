# Country-aware regulatory sourcing — design memo

**Epic:** E14 (#186) — standards fidelity (PR-1).
**Status:** Design-first / aspirational. PR-1 ships only the `jurisdiction` measure-metadata field
(default `US`) + this memo; everything below the "Today" section is groundwork, not built code.
**Date:** 2026-06-26

This memo answers Doug's June-15 question — *"does it look for the latest regulatory updates based on
your country?"* — by laying out how WorkWell would source, select, and track an authoritative regulatory
definition **per jurisdiction**, and why PR-1 deliberately stops at the metadata field. It is intentionally
design-first: the issue Notes say *"scope the build conservatively,"* so the country-switching rule sets and
the update watcher are described here, not implemented.

---

## 1. Today (PR-1) — jurisdiction as measure metadata

PR-1 introduces a single, non-breaking field:

- `jurisdiction?: string` on the registry `MeasureMeta` (`backend-ts/src/engine/cql/measure-registry.ts`),
  defaulting to `"US"` when absent.
- Surfaced on the measure-detail read model (`MeasureDetail.jurisdiction`, default `"US"`).

That is the whole runtime change. Every WorkWell measure today is a US measure — OSHA occupational-safety
measures (CFR-cited) and CMS/HEDIS clinical-quality measures (eCQI/CMS-published) — so `"US"` is the correct
universal default and no per-measure wiring is required yet. The field exists so that the *modeling* for
country-aware rule selection has a home; it is the seam the rest of this memo builds on.

This pairs with the PR-1 fidelity work: the first **official reference** (`OfficialMeasureReference` for
CMS122v14, in `backend-ts/src/standards/references/`) is a sourced, versioned, provenance-carrying
transcription of a US-jurisdiction official spec. A non-US jurisdiction would supply its own analogous
reference object behind the same shape.

---

## 2. The model — `RegulatorySource`

A measure's authoritative definition comes from a **regulatory source**, and the source differs by
jurisdiction and by measure family. The (future) concept:

```
RegulatorySource {
  jurisdiction:  string            // ISO-3166 alpha-2, e.g. "US", "CA", "GB"
  authority:     string            // "CMS/eCQI", "OSHA", "NICE", "PHAC", …
  kind:          "ecqm" | "safety-reg" | "immunization-schedule" | …
  referenceId:   string            // e.g. "CMS122v14" — keys an OfficialMeasureReference
  citation:      string            // CFR section, eCQI URL, or national-guideline cite
  provenance:    { sourceUrl; retrieved; … }
}
```

Mapped onto WorkWell's existing measure families:

| Measure family | US regulatory source (today) | Where it lives now |
|---|---|---|
| CMS/HEDIS eCQMs (`cms122`, `cms125`, …) | **eCQI Resource Center / CMS** published measure spec (CQL + ELM + VSAC value sets) | the E14 `OfficialMeasureReference` (PR-1 vendors CMS122v14) |
| OSHA occupational-safety measures (`audiogram`, `hazwoper`, …) | **CFR / OSHA** — the regulation citation | the measure's `policyRef` (e.g. `29 CFR 1910.95`) + `osha_references` |
| HEDIS wellness / immunization (`adult_immunization`, …) | **NCQA / ACIP** guidance | `policyRef` + the measure's authored CQL |

So WorkWell *already* records a US regulatory source for every measure — as `policyRef` (safety) or the
eCQI-published spec the E14 reference transcribes (eCQMs). `RegulatorySource` generalizes that into one
typed concept keyed by jurisdiction. **Non-US analogues are named-but-unbuilt:** a jurisdiction's national
immunization schedule (e.g. a country's public-health agency calendar), or its occupational-health regulator
in place of OSHA/CFR. No non-US source object is shipped in PR-1.

---

## 3. A country switch (future)

With `jurisdiction` on the measure and a `RegulatorySource` registry keyed by `(measureFamily,
jurisdiction)`, selecting a country would:

1. **Pick the alternate official reference.** The fidelity diff (`GET /api/measures/:id/fidelity`) would
   resolve the `OfficialMeasureReference` for the active jurisdiction rather than the hard-wired US one — the
   same `computeFidelity(ref)` assembler, a different sourced reference in.
2. **Pick the alternate rule set (further future).** A measure stays **one logical measure** with
   per-jurisdiction **bindings** — the population intent ("workers current on a tetanus-containing vaccine")
   is shared, while the thresholds, value sets, and exclusions bind per country (e.g. a different booster
   interval or national vaccine code system). This mirrors the existing E11.1 model (ADR-015) where the CQL
   is canonical and rule-params bind to it; a jurisdiction would select the param/binding set.

Crucially this is **additive and reversible**, like the rest of the standards work: absent a non-US source,
everything resolves to `US` and behaves exactly as today. No measure is forked; a jurisdiction is a selector,
not a copy.

---

## 4. "Latest regulatory updates by country" (aspirational)

Official measures are republished on a cadence (eCQMs annually — CMS122**v14** for the 2026 performance
period supersedes v13; CFR sections are amended; immunization schedules revise). The aspirational watcher:

- Periodically checks each measure's regulatory source for a **newer published version** than the vendored
  `OfficialMeasureReference.version` (e.g. CMS122v14 → v15), using the reference's `version` + `provenance`
  URLs as the comparison anchor.
- On a delta, runs the **same structural fidelity diff** machinery against the newest published reference and
  surfaces a **fidelity-drift alert** — "the official CMS122 spec advanced to v15; WorkWell's authored measure
  + its vendored reference are at v14; N criteria changed." It reuses `computeFidelity` and the version field
  the reference already carries; nothing new in the compliance path.
- Scoped per jurisdiction: the watcher would track the US eCQI/CMS feed for US measures and the analogous
  national source for a non-US jurisdiction.

This is **design-only**. It needs a fetch/poll layer and a published-version index per authority, both out of
scope for PR-1. It is recorded here so the `version`/`provenance` fields the PR-1 reference carries are
understood as the deliberate hook for it.

---

## 5. Scope boundary (explicit)

- **PR-1 ships:** the `jurisdiction` metadata field (default `US`) + this memo. Nothing else here is built.
- **Not built (design-first):** the `RegulatorySource` registry, non-US official references, per-jurisdiction
  rule/binding selection, and the latest-version watcher.
- **Invariant:** all of this is descriptive/selective sourcing. It never decides compliance — CQL
  `Outcome Status` remains the sole authority (ADR-008/ADR-016). A jurisdiction selects which official
  definition a measure is sourced from and diffed against; it does not evaluate a worker.
