# What can verify FHIR-lineage measure execution — the landscape, 2026-08-04

Sourcing behind `docs/ROADMAP_2026-08-04.md` and ADR-058. Three parallel research passes (CMS/ONC
regulatory position; FHIR-lineage test tooling; DEQM and the quality-reporting ecosystem) plus direct reads
of Cypress's validator source and the vendored artifacts. Every claim below is marked **CONFIRMED** or
**UNCERTAIN**; where sources disagree, that is stated rather than resolved.

---

## 1. The mechanism: why Cypress cannot read our document

Read directly from `projecttacoma/cqm-validators`, `lib/reported_result_extractor.rb`:

```ruby
def extract_results_by_ids(measure, poulation_set_id, doc, stratification_id = nil)
  nodes = find_measure_node(measure.hqmf_id, doc)
  if nodes.nil? || nodes.empty?
    return {}          # <-- short-circuit
  end
  ...
```

`find_measure_node` matches the organizer whose
`reference/externalDocument/id[@extension = <HQMF id>][@root = "2.16.840.1.113883.4.738"]`.

**CONFIRMED consequences:**

1. **Everything downstream is gated on that match.** Supplemental data is built only inside the matched
   node, by `extract_supplemental_data(cv)`, and read back as
   `reported_sup = (reported_result[:supplemental_data] || {})[pop_key]`. With an empty extraction there is
   nothing to key into — so **the 45/53 supplemental-data errors in `CVU_C2_SUBMISSION_2026-08-03.md` are
   downstream of the identity mismatch, not an independent second gap.** Emitting correct supplemental data
   today would not change the verdict by one error.
2. **Populations are matched on `@root` carrying a per-population UUID**, in `extract_component_value`:
   `reference/externalObservation/id[@root = <population hqmf_id>]`. Our Cat III writes
   `<id root="<WorkWell criterion root>" extension="InitialPopulation_1"/>`. That is the *"Population …
   reported more than once"* error — Cypress sees one root four times.
3. **The QI-Core artifact has no per-population UUIDs to supply.** Read from the vendored bundles: both
   CMS122FHIR and CMS125FHIR name their populations `InitialPopulation_1`, `Denominator_1`,
   `DenominatorExclusion_1`, `Numerator_1`. There is nothing in our lineage to put in `@root`.
4. **The two "invalid id" errors are exactly our own artifact's identifiers**, confirming the document is
   internally honest:

   | | CMS125FHIR v1.0.000 (vendored) | Cypress error |
   |---|---|---|
   | version-specific | `ae8bc6fe-718d-4c4f-af2f-22aaf9c7844d` | `Invalid HQMF ID Found: AE8BC6FE-…` |
   | version-independent | `f766afa2-f780-45d2-b224-c1bdb733fa6f` | `Invalid HQMF Set ID Found: F766AFA2-…` |

   (CMS122FHIR: version-specific `2ea22cb2-9bcc-4ca6-b2f2-68fc964365ad`, version-independent
   `f04ee808-8ece-4936-8b26-fafa462e1594`.)

**Conclusion: QRDA Category III is structurally an HQMF/QDM-identity format.** Its identity model has no
counterpart in the FHIR measure lineage. Not a defect in our work.

---

## 2. There is no FHIR-lineage Cypress

**CONFIRMED.**

- **`projecttacoma/cvu-fhir`** — MITRE's fork of Cypress, README verbatim: *"An open source tool for testing
  electronic Clinical Quality Measure calculation."* 3,771 commits; README wires in `deqm-test-server` and
  `fhir-validator-wrapper`. **Last push 13 Apr 2023.** Not archived, plainly abandoned. This is the thing
  that would have answered the question, and it was shelved.
- **Cypress itself is actively maintained and QRDA-only.** v7.5.1 (30 Jul 2026); v7.5 (18 Jun 2026) added
  full CVU+ integration and 2026–2027 eCQM support. The release page, about page and tool page contain
  **zero** mentions of FHIR, QI-Core or dQM. The `projectcypress` GitHub org has **no** FHIR repositories;
  its JS engine repos (`js-ecqm-engine`, `cqm-execution-service`) are archived or last touched 2020/2023.
- **No successor tool has been announced.**
- There is **no** tool named "eCQM Testing Tool" — the name conflates Cypress, `mitre/cedar` (QRDA
  receiving-system tests), `mitre/ecqm` (2014-era, dead), Bonnie (superseded by MADiE) and Inferno.

## 3. What DOES exist, and exactly what each grades

| Tool | Grades our calculation? | Validates our document? | Maintained | Independent of `fqm-execution`? |
|---|---|---|---|---|
| `dqm-content-qicore-2025` test cases | **YES** — third-party expected answers, self-run | No | Yes | Content only |
| Java `cqf-fhir-cr` / HAPI `$evaluate-measure` | **YES** — second implementation | No | Yes | **Yes** |
| `cqf-tooling` `ExecuteMeasureTestOperation` | Likely, via the Java engine | No | Yes | **Yes** |
| FHIR validator + `hl7.fhir.us.davinci-deqm` | No | **YES** — profile conformance, offline | Yes (STU5) | Yes |
| `deqm-test-kit` (Inferno, Ruby) | No | **YES** — DEQM v1/v3/v5 operations + profiles | Yes (29 Jul 2026) | Yes |
| Touchstone DEQM / QualMeas scripts | No | **YES** — API + MeasureReport shape | Yes | Yes |
| Inferno **US Quality Core Test Kit** | No | Data layer only, draft | Yes (13 Jul 2026) | Yes |
| `fqm-testify` | Your expectations, **your engine** | No | Yes (14 Jun 2026) | **No** |
| `deqm-test-server` | — | reference server | Yes (29 Jul 2026) | **No** — wraps `fqm-execution` |
| MADiE | Authors the answers; cannot read ours | No | Yes | Yes |
| `cql-tests` / runner | CQL **language** only | No | Yes | Yes |
| `cvu-fhir` | Designed to; never finished | Partially | **No** (Apr 2023) | Yes |

**The load-bearing point for V4:** `fqm-testify` and `deqm-test-server` both wrap `fqm-execution`, the
library we run. Neither is an independent arithmetic check. **Java `cqf-fhir-cr` is** — different CQL engine,
different FHIR data provider, separate codebase.

**UNCERTAIN:** `cqf-tooling`'s `ExecuteMeasureTestOperation` / `ExecuteMeasureTestArgumentProcessor` exist in
the javadoc, but the README documents only bundling/refresh/valueset operations and no CLI usage was found.
Budget for driving it programmatically.

**Notable for M-D:** the **Inferno US Quality Core Test Kit** (v0.1.2, updated 13 Jul 2026, maturity "Low")
tests the **2026 US Quality Core IG v0.5.0** — USCDI+ Quality data elements, profile support, read/search,
terminology bindings, CapabilityStatement. It grades the **data layer a measure reads from**, which is
exactly the surface ADR-042/044/057 kept finding defects in. It is **not tied to any certification
criterion**.

## 4. Regulatory position

**CONFIRMED**

- **45 CFR 170.315(c)(1)–(c)(4)** — (c)(1) record and export per §170.205(h)(2) [QRDA I]; (c)(2) import and
  calculate per the same; (c)(3) report using CMS QRDA I (inpatient) / QRDA III (ambulatory); (c)(4) filter.
  Test method baseline: the **2020** CMS QRDA IGs, with the 2025 IGs SVAP-optional. **No FHIR alternative
  is offered for any of them.** eCQI's certification page contains no mention of FHIR-based eCQM certification.
- **HTI-5 Proposed Rule** — released 22 Dec 2025, FR 29 Dec 2025, comments closed 27 Feb 2026. Proposes
  removing **34 of 60** criteria and revising 7; ASTP/ONC's stated intent is to remove non-FHIR criteria and
  re-center on FHIR APIs. **NOT FINAL.** ASTP/ONC withdrew the HTI-2 proposed rule the same day.
- **QPP accepts QPP JSON and QRDA III XML only** — `submissionFormat` enum is `JSON`/`XML`; schemas at
  `CMSgov/qpp-submissions-schema`. No MeasureReport endpoint exists. CMS's QRDA III Converter converts
  QRDA III → **QPP JSON**, a CMS-proprietary schema, not FHIR.
- **Draft CMS FHIR dQMs** went to public comment **21 Jan – 25 Feb 2026**: 49 Eligible Clinician, 17 Hospital
  Inpatient, 4 Hospital Outpatient, with packages, test cases and VSAC value sets. CMS: "draft documents and
  may change."
- **FY2026 IPPS** carried an **RFI** on FHIR-based eCQM reporting. No mandate, **no QRDA sunset date**.

**UNCERTAIN / DISPUTED**

- **The "~2030" date is not CMS-attributable.** CMS's live dQM page (updated 9 Apr 2026) states the goal of
  transitioning all measures to dQMs with **no year**. The CMS dQM Strategic Roadmap is **March 2022** and
  has no published successor. The widely-repeated 2030 figure traces largely to **NCQA's HEDIS**
  digitalization goal and secondary coverage; the original CMS RFI was framed "all dQMs by **2025**," which
  slipped. A Feb 2026 trade report on CMS's dQM webinar notes CMS **did not disclose a completion deadline
  or phased rollout**. → say **"no published date."**
- **HTI-5's exact treatment of (c)(1)–(c)(3)** is **single-source** (a vendor blog: (c)(1)/(c)(2) unchanged,
  (c)(3) revised, (c)(4) removed). The (c)(4) removal is corroborated by comment letters; the (c)(3)
  revision is not. Read the HTI-5 chart or the FR text before relying on it.
- A claim that "QPP accepts QRDA III **or** FHIR JSON" appears in secondary sources. **No primary evidence
  found, and direct evidence against it.** Treat as false unless CMS documents it.

## 5. DEQM and the reporting ecosystem

**CONFIRMED**

- **DEQM v5.0.0 = STU5**, status `trial-use`, FHIR R4, dated **2025-05-19**. Nothing in this stack is
  normative (DEQM STU5, QI-Core STU7, QM IG STU5 are all trial-use).
- Profiles: **Individual MeasureReport** (the QRDA I analogue), **Summary MeasureReport** (the QRDA III
  analogue), **Data Exchange MeasureReport**, plus Subject List and the gaps-in-care set. Operations:
  `$submit-data`, `$collect-data`, `$bulk-submit-data`, `$care-gaps`; `$evaluate-measure` lives in base
  FHIR / the QM IG.
- **DEQM is a Da Vinci payer↔provider exchange IG, not a CMS submission standard.** Its actors are
  Producer/Consumer and Reporter/Receiver; its canonical example is a payer use case. **Payers are the only
  real-world DEQM receivers today, bilaterally.** The CMS7-FQR deck states the CMS future state as
  `MeasureReport` → a "Measure Receiving Service," governed by QM IG (specification) + DEQM IG (reporting)
  — a target state, not a live channel.
- **QI-Core v7.0.2 (STU7)**, generated 2026-04-04, aligns with US Core STU 7. **But CMS's 2025 AU FHIR
  content was authored on QI-Core 6**, and the `dqm-content-cms-2025` refactor targets **US Core 6.1.0 +
  US Quality Core 0.5.0**. → the CLAUDE.md line "QI-Core STU7 = US Core 7 = WebChart's exact surface" is
  half right and misleading about which version the content is on.

**UNCERTAIN:** DEQM appears to be migrating from US realm to **universal realm** — the CI build reports
`1.0.0-cibuild` and points its version directory at `hl7.org/fhir/uv/deqm`. No published uv version or firm
ballot date confirmed.

**Live probes, 2026-08-04** (metadata reads only; nothing was POSTed to a third party):

| Endpoint | Software | CapStmt | Content |
|---|---|---|---|
| `connectathon-fhir.lantanagroup.com/fhir` | HAPI 8.10.0 | 2026-07-15 | **76 Measures, 3,070 MeasureReports, 3,032 Patients** |
| `cloud.alphora.com/sandbox/r4/cqm/fhir` | HAPI 8.8.0 | 2026-05-15 | 2 Measures, 34 MeasureReports, 123 Patients |

Both declare `$submit-data`, `$collect-data`, `$care-gaps`, `$evaluate-measure`, `$data-requirements`
(Lantana adds `$export`). **Lantana serves every measure WorkWell has vendored or gated, at v1.0.000**,
canonical `https://madie.cms.gov/Measure/<name>`. Its MeasureReports are `test-case-cqfm` MADiE expecteds,
`type=individual` — a `_profile:below=…davinci-deqm` search returns **0**. Bellese
(`connectathon.fhir-sandbox.bellese.dev`) and Flame (`flame-demo.c3ib.org`) gave no TCP response.
**Untested:** whether either live sandbox accepts unauthenticated `$submit-data` writes outside a track window.

## 6. The connectathon opening

From the CMS7-FQR decks in `HL7 Connectathon/` (Bryn Rhodes, 2026-07-14; the Confluence pages 405 to every
fetch method, so the local decks are the primary source):

- **74 measures × 3,964 MADiE test cases, Java engine vs JavaScript engine: 3,891 pass = 98.16%.** Three
  measures with remaining discrepancies (2 with missing results across 71 cases, 1 mismatched in 2 cases).
- **The track's stated participation ask:** verify results **on an alternate engine**, help diagnose the
  remaining discrepancies, and classify each into (A) spec clarification, (B) tooling fix, (C) content fix,
  (D) pattern/profile change.
- Scenario measure set: **CMS122**, CMS124, **CMS125**, CMS165, CMS71, CMS1028 — overlapping our routed and
  gated set.

WorkWell is an alternate JavaScript-based engine with a complete pipeline. In a space with no certification
tool, **peer verification at connectathons is the third-party verification.**

## 7. What this does not license

- None of V3–V6 produces a pass/fail **certificate**. Every claim built on them must name who graded what.
- V1 (MADiE) and V2 (Cypress C2 offline) are already the strongest calculation evidence we hold, and both
  have documented limits recorded in `docs/STANDARDS_CONFORMANCE.md`.
- Nothing here says our calculations are right over **real patient data**. Every measurement to date is over
  synthetic corpora, a WebChart dev-DB fixture, or Cypress's generated patients.
