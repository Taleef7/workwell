# OSHA Hearing Conservation — Standard Threshold Shift

**Regulatory traceability for `OshaHearingStandardThresholdShift-1.0.0`.**
Roadmap M-E1. Driving ADR: **ADR-065**. Source: `backend-ts/measures/osha_hearing_sts.cql`.

> **Read this before changing the CQL.** The measure encodes a reading of federal regulation. Every
> define below is traced to the paragraph that licenses it, and the paragraphs the measure
> deliberately does **not** implement are listed too — because a traceability table that only lists
> what was built is exactly how a measure ends up being a coherent implementation of the wrong legal
> object.

---

## 1. Why this measure exists

**Nobody publishes a computable version of any OSHA medical-surveillance requirement.** Searching the
2026 CMS eligible-clinician eCQMs (49), the hospital eCQMs (17), HEDIS MY2026 (93 measures), every
public `.cql` file on GitHub, the whole `cqframework` organisation, and the complete HL7 FHIR IG
registry returns **zero** occupational-health quality measures. The one occupational FHIR IG that
exists — [Occupational Data for Health](http://hl7.org/fhir/us/odh) — is a *data representation* IG,
not measure content.

Two near-misses are worth knowing, because they show the shape of the gap rather than filling it:

- **Healthcare-personnel influenza vaccination (CBE #0431)** is a real occupational measure in
  national use — but it is an NHSN aggregate facility report, one screen per season, not an eCQM.
- **CSTE/NIOSH Occupational Health Indicators** (25 of them) are real and well documented, but CSTE
  defines an indicator as a measurement over *a state workforce*, sourced from hospital discharge
  data and workers' compensation. Not one is expressible as a numerator over a patient bundle.

The field has **indicators** — counts of what already happened, across a population — and no
**measures** — what should happen to a named worker by a named date. OSHA supplies that second thing
in unusually computable form: explicit cohorts, explicit tests, explicit deadlines, explicit
arithmetic. That is what this measure encodes.

---

## 2. What this measure does NOT cover, and why that is deliberate

29 CFR 1910.95 creates **several distinct obligations**. This measure implements exactly one. Rolling
them together would produce a single "hearing conservation compliance" percentage that hides partial
failure — a program could refit every worker with hearing protection and notify none, and still score
well.

| Obligation | Paragraph | Status here | Why |
|---|---|---|---|
| **Standard Threshold Shift detection** | `(g)(10)(i)` | **IMPLEMENTED** | Fully computable from audiometric data |
| Baseline audiogram within 6 months of first exposure | `(g)(5)(i)` | Not implemented | Needs the first-exposure date, which is an employment fact, not a clinical one |
| Annual audiogram | `(g)(6)` | Not implemented | Separate obligation with its own due-date logic; see §6 A1 for the ambiguity that must be resolved first |
| Written notification within 21 days | `(g)(8)(i)` | **NOT COMPUTABLE** | The clock starts at the *determination*, not the test — see §6 A2 |
| Hearing protector fitting / refitting / retraining | `(g)(8)(ii)(A)–(B)` | Not implemented | The required evidence is a training and PPE-issue record, not clinical data |
| Referral for audiological/otological evaluation | `(g)(8)(ii)(C)` | Not implemented | Doubly discretionary and carries **no regulatory deadline** — see §6 A6 |
| Training program, recordkeeping, monitoring | `(k)`, `(m)`, `(d)` | Out of scope by design | Process requirements with no clinical data representation |

---

## 3. Traceability — define by define

| CQL define | Paragraph | What the regulation says | Encoding decision |
|---|---|---|---|
| `In Hearing Conservation Program` | `(c)(1)`, `(g)(1)` | Program required at an 8-hr TWA **≥ 85 dBA**; audiometric testing made available to all such employees | **Cannot be computed.** The trigger is an industrial-hygiene measurement no clinical system holds. Uses ICD-10-CM **Z57.0** *Occupational exposure to noise* as a documented proxy, OR an employer-asserted enrolment coding. See §5. |
| `Right/Left Ear Thresholds` | `(h)(1)` | Pure tone, air conduction, **separately for each ear** | LOINC codes from panel **89015-2**; the two ears are never combined |
| `Audiogram Dates` | — | — | Thresholds carry no session id in FHIR, so the **test date** groups an audiogram — the same convention a paper audiometric record uses |
| `Baseline Date` | `(g)(5)(i)` | Baseline is the audiogram "against which subsequent audiograms can be compared" | **Earliest** audiogram. Diverges from `(g)(9)` revised baselines — see §6 A4, and note the divergence is *permissive* |
| `Ear Average` | `(g)(10)(i)` | "an average of 10 dB or more at **2000, 3000, and 4000 Hz**" | Exactly those three frequencies. 500/1000/6000 Hz are **tested** under `(h)(1)` but excluded from the arithmetic |
| `Right/Left Ear Shift` | `(g)(10)(i)` | "a change in hearing threshold **relative to the baseline audiogram**" | Average of the three *shifts*, which equals the difference of the two three-frequency averages **only when all three frequencies are present on both dates** — hence the completeness rule below |
| `Right/Left Ear STS` | `(g)(10)(i)` | "10 dB or more" | `>= 10.0`. Inclusive; `> 10` would miss every shift landing exactly on the definition |
| `Standard Threshold Shift` | `(g)(10)(i)` | "in **either ear**" | Logical OR across ears. `1904.10(a)` phrases the same concept as "one or both ears" — **not** exclusive-or |
| `Determined Not Occupational` | `(g)(8)(ii)` chapeau | Follow-up excused where a physician/audiologist determines the shift is not work related or aggravated by occupational noise | A genuine **scope exclusion**, not missing data. See §6 A8 — it may be clinically invisible |
| `Determinable` | — | — | **Asymmetric by design**: a positive finding needs one computable ear, a negative finding needs **both**. See §4 |
| `Outcome Status` | `(g)(8)` | — | `OVERDUE` means "an STS is present and `(g)(8)` follow-up is owed", not that a date passed. There is **no `DUE_SOON`** — the regulation defines no warning band, and inventing one would present a WorkWell convention as a regulatory threshold |

---

## 4. The asymmetry rule, stated plainly

A **positive** STS is definitive from a single ear: if the right ear shifted 15 dB, `(g)(8)` follow-up
is owed regardless of the left.

A **negative** finding requires **both** ears complete. Concluding "no shift" while one ear's data is
missing asserts something about an ear nobody measured.

The first implementation got this wrong — it used OR across ears for determinability, so a worker with
two of three frequencies on the right and a clean left ear returned `COMPLIANT`. An adversarial test
caught it. That bug is the shape that makes a compliance product dangerous: it improves the apparent
rate by silently absorbing the people whose data is incomplete.

Likewise, an incomplete frequency set does not get averaged over whatever is present. A shift computed
from two frequencies is not the regulation's shift.

---

## 5. Where the regulation and the data model do not meet

**The cohort cannot be computed.** `(c)(1)`'s trigger is an 8-hour TWA at or above 85 dBA — an
industrial-hygiene measurement produced by a noise survey, stored in an IH system, and absent from
every clinical feed. This is structurally the same gap as ADR-042's `us-core-sex` problem: the
clinical data is present, the *eligibility attribute* is not.

Z57.0 records that a clinician noted occupational noise exposure. It does **not** record that anyone
measured 85 dBA. It is a proxy and is labelled as one everywhere it appears. The employer-asserted
enrolment coding is accepted as an alternative because on a real deployment the employer knows who is
in the programme even when the chart does not.

**One thing that did NOT need inventing.** All 22 pure-tone air-conduction LOINC codes are members of
`http://hl7.org/fhir/us/core/ValueSet/us-core-clinical-test-codes`, bound by the US Core Observation
Clinical Test Result profile. An audiogram therefore already has a standard, US-Core-conformant FHIR
representation, and a certified EHR has a defined place to put one.

> Note: LOINC **100653-5** appears in search results as the air-conduction panel and is **deprecated**.
> The live panel is **89015-2**.

---

## 6. Ambiguities — where the regulation does not decide, and this measure had to

These are the entries most likely to differ between two lawful implementations. They are the reason
this document exists.

**A1 — "At least annually" has no defined window.** `(g)(6)` sets a floor with no anniversary, no
grace period and no upper bound in days. It is also unresolved whether the clock runs from the
baseline (the literal reading) or from the most recent annual (universal practice) — these diverge
after any late test. *This measure does not implement the annual obligation, so it takes no position.*

**A2 — The 21-day notification clock is not computable.** `(g)(8)(i)` runs 21 days from the
**determination**, and OSHA has stated the standard contains no time limit between the audiogram and
the determination. Given only a test date, `(g)(8)(i)` compliance **cannot be computed** — only
proxied. Any future notification measure needs the determination date captured as a discrete element.

**A3 — Age correction is optional and not uniquely specified.** `(g)(10)(ii)` says allowance "**may**"
be made; Appendix F is informational only (`(n)(2)`); and OSHA has since permitted age-correction
tables derived from other datasets. **Two employers can lawfully reach opposite conclusions on
identical audiograms.** STS is therefore not a pure function of the audiogram — it is a function of
the audiogram *and employer policy*.

**This measure applies no age correction.** That yields a larger shift and detects more workers, which
is the protective direction. Silently applying Appendix F would be worse than not offering it: it
would present one employer's lawful policy choice as an objective finding.

**A4 — Revised baselines are discretionary, per-ear, and may be invisible.** `(g)(9)` permits
substituting a later audiogram as the baseline when a shift is persistent or hearing significantly
improved — at professional discretion, per ear, with "persistent" undefined. Where a revision happened
but was never recorded, this measure compares against a baseline that is too old and **over-detects**.
Over-detection sends a worker for evaluation they may not need; under-detection lets a real shift go
unactioned. The first error is preferable — but it is an error, and it is why this is a surveillance
aid, not a legal determination.

**A6 — The referral obligation has no deadline.** `(g)(8)(ii)(C)` requires referral "as appropriate"
where additional testing is necessary or pathology is suspected. Both limbs are judgment calls and no
time window attaches. A "referred after STS" numerator would have to invent its due date.

**A8 — The exclusion may be clinically invisible.** The `(g)(8)(ii)` chapeau lets a physician or
audiologist switch off every follow-up action, but 1910.95 specifies no form, timing or retention for
that determination. A worker legitimately excluded may look non-compliant, and vice versa.

**Not implemented, and flagged for anyone extending this:** `1904.10` recordability requires **both**
an STS **and** a total hearing level ≥ 25 dB averaged at the same three frequencies in the same ear —
and age correction is **permitted for the STS test but forbidden for the 25 dB test**. That asymmetry
is load-bearing and easy to get wrong.

---

## 7. What verification here does and does not establish

**There is no external oracle for this measure, and there is no way to manufacture one.**

The official eCQMs are checked against the measure stewards' own MADiE expected results — 410/410
across eight measures. The engine is checked against `cqframework/cql-tests` — 1,622 of 1,835. QRDA is
checked against the HL7 schematron. **No equivalent exists for any OSHA standard**, because OSHA
publishes regulations, not computable artifacts with expected results.

So the test suite establishes that the measure computes **what we read the CFR to require**. It does
not establish that our reading is correct. That is a weaker evidentiary position than CMS122/125
enjoy, and `docs/STANDARDS_CONFORMANCE.md` says so in those words rather than letting the M-A/M-B
verification language carry over by association.

What *can* be made rigorous without an oracle is the **choice of cases**, and two kinds are used:

1. **Boundary cases at the regulation's own numbers** — 9.99 dB negative, 10.0 dB positive.
2. **Adversarially wrong-by-construction cases**, each killing a specific plausible
   misimplementation: averaging the tested frequencies instead of the named three; requiring both
   ears; comparing against the previous audiogram instead of the baseline; averaging absolute
   thresholds instead of shifts; concluding from partial data; defining the cohort as "everyone with
   an audiogram".

Two of those adversarial cases **found real bugs** in the first implementation. That is the argument
for writing them.

**The strongest verification available is not a test.** It is independent re-derivation: a second
author building a decision table from the CFR without seeing this CQL, and comparing. Disagreement
would identify an unresolved specification question rather than a coding error. That is named as
follow-up work in ADR-065 and has not been done.

---

## 8. Publication shape

The community form for measure content is an HL7 FHIR Implementation Guide built on the
`cqf.fhir.template` template — as `cqframework/dqm-content-qicore-2026` and
`dqm-content-usqcore-2026` are. Relevant constraints for when this is published:

- **Naming is load-bearing.** One PascalCase token is reused as the CQL filename, `Library.name`,
  `Measure.name`, the bundle directory and the test directory. `Measure.name` must match
  `[A-Z]([A-Za-z0-9_]){0,254}` — so `OshaHearingStandardThresholdShift` survives, while our
  `urn:workwell:measure|…` identity style would not.
- **A test case is a directory named for the patient id**, holding loose `<Type>-<id>.json` files plus
  an expected-results MeasureReport marked with the `cqfm-isTestCase` modifier extension. Expected
  results are just `group.population[].count`.
- The 2026 content repositories are **hand-authored via the VSCode CQL plugin** rather than exported
  from MADiE — which is our situation exactly, since no MADiE export will ever exist for an OSHA
  measure.
- Value sets can be published to **VSAC** by an external author with a UMLS login, and a measure
  steward is a self-assumable role: an organisation that owns a measure, maintains it, and is the
  named point of contact. Nothing gates that.

Endorsement is a different matter and is **not** a near-term goal: measure development is commonly
cited at three to eight years and on the order of $1M per measure, HEDIS has no external submission
route, and the QCDR path fits an employee denominator badly. Publishing openly and self-assuming the
steward role is the step that is actually available.
