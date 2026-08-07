/*
  OSHA Hearing Conservation — Standard Threshold Shift (STS) surveillance.

  Authored by WorkWell against 29 CFR 1910.95. No official CQL exists for this measure; the
  regulatory traceability that licenses every define below is in
  docs/measures/OSHA_1910_95_STS.md, which is the artifact to read before changing anything here.

  SCOPE IS ONE OBLIGATION, DELIBERATELY. This measure answers exactly one question: does the
  employee's most recent audiogram show a Standard Threshold Shift relative to their baseline?
  It does NOT cover the annual-audiogram deadline (g)(6), the 21-day written notification
  (g)(8)(i), the protector refitting (g)(8)(ii)(A)-(B) or the referral (g)(8)(ii)(C). Those are
  separate obligations with different triggers, deadlines and evidence, and rolling them into one
  "hearing conservation compliance" number would hide partial failure — a program could refit every
  employee and notify none, and still score well.

  TERMINOLOGY IS REAL FOR THE MEASUREMENTS, WITH TWO ADMINISTRATIVE EXCEPTIONS. The thresholds are LOINC from
  the Pure tone air conduction threshold audiometry panel (89015-2), so this measure is portable and
  representable in QRDA (ADR-051 — a QRDA Category I is only meaningful for data in real
  terminology). Program membership is the exception and cannot be otherwise: the regulation's own
  trigger is an 8-hour TWA at or above 85 dBA (1910.95(c)(1)), which is an industrial-hygiene
  measurement, not a clinical observation. It will never appear in a clinical data feed. So
  membership is an employer-asserted fact, and this measure says so rather than pretending to
  compute exposure. The (g)(8)(ii) exclusion is the SECOND exception and has the same consequence:
  being non-standard, it is invisible to QRDA Category I under ADR-051's own finding, so an excluded
  worker cannot be represented in an exported document. An earlier draft of this comment claimed one
  exception and was wrong (review, #408).

  LIMIT OF THE LOINC CODES. They identify frequency and ear but NOT the conduction method — the FSNs
  carry an empty Method field, and the bone-conduction panel (100652-7) lists the same 22 members. A
  bare Observation carrying 89019-4 is therefore ambiguous between air and bone conduction, and this
  measure retrieves bare Observations with no enclosing-panel check. 1910.95(h)(1) requires AIR
  conduction, and bone-conduction thresholds are typically lower — so a site recording both for one
  visit could both mask and manufacture a shift. Disambiguating needs panel or `derivedFrom` context
  the data model does not currently carry; until then this is a stated limitation, not a solved
  problem.
*/
library OshaHearingStandardThresholdShift version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

codesystem "LOINC": 'http://loinc.org'

// 1910.95(g)(10)(i) names 2000, 3000 and 4000 Hz and no others. The panel also carries 500, 1000
// and 6000 Hz — required to be TESTED by 1910.95(h)(1), but excluded from the STS arithmetic. Using
// the tested set instead of the named three is a documented failure mode, so the three codes per
// ear are declared individually rather than as a value set that could silently gain a member.
code "Hearing threshold right 2000 Hz": '89019-4' from "LOINC" display 'Hearing threshold Ear - right --2000 Hz'
code "Hearing threshold right 3000 Hz": '89021-0' from "LOINC" display 'Hearing threshold Ear - right --3000 Hz'
code "Hearing threshold right 4000 Hz": '89023-6' from "LOINC" display 'Hearing threshold Ear - right --4000 Hz'
code "Hearing threshold left 2000 Hz": '89018-6' from "LOINC" display 'Hearing threshold Ear - left --2000 Hz'
code "Hearing threshold left 3000 Hz": '89020-2' from "LOINC" display 'Hearing threshold Ear - left --3000 Hz'
code "Hearing threshold left 4000 Hz": '89022-8' from "LOINC" display 'Hearing threshold Ear - left --4000 Hz'

/*
  Cohort identification, in real terminology where real terminology exists.

  ICD-10-CM Z57.0 "Occupational exposure to noise" is a coded clinical fact that a certified EHR can
  already carry, and it is the closest standard concept to the hearing-conservation cohort. It is a
  PROXY and is documented as one: Z57.0 records that a clinician noted occupational noise exposure,
  NOT that an industrial-hygiene survey measured an 8-hour TWA at or above 85 dBA. The regulation's
  actual trigger (1910.95(c)(1)) is an IH measurement that no clinical system holds.

  The employer-asserted enrolment coding is kept as an alternative because on a real deployment it is
  the more reliable signal — the employer knows who is in the program; the chart may not. Accepting
  either avoids the failure where a genuinely enrolled worker is invisible to the measure because
  nobody coded Z57.0.
*/
codesystem "ICD10CM": 'http://hl7.org/fhir/sid/icd-10-cm'
// The two administrative facts below carry no standard code system, so they use the corpus's own
// namespace. `hearing-enrollment` IS already stamped by the roster builder, the value-set seed and
// the synthetic bundles; `sts-not-occupational` is stamped by NOTHING today and exists only here and
// in this measure's tests. An earlier comment claimed both were already stamped (review, #408).
codesystem "WorkWellOccupational": 'urn:workwell:vs:hearing-enrollment'
codesystem "WorkWellOccupationalExclusion": 'urn:workwell:vs:sts-not-occupational'
code "Occupational exposure to noise": 'Z57.0' from "ICD10CM" display 'Occupational exposure to noise'

// Declared as direct codes rather than value sets on purpose. A value set needs an expansion at
// evaluation time; a direct code does not, so this measure runs with no terminology service
// configured at all. For two single-concept administrative facts a value set buys nothing and costs
// a resolution dependency — and a consumer of the published measure should not need our expansions.
code "Hearing conservation program enrolment": 'hearing-enrollment' from "WorkWellOccupational"
code "STS determined not occupational": 'sts-not-occupational' from "WorkWellOccupationalExclusion"

parameter "Measurement Period" Interval<DateTime>
context Patient

/*
  1910.95(c)(1) / (g)(1). Membership is asserted by the employer, never inferred from clinical data.
  Inferring "in the program" from "has an audiogram" would be circular — it would define the
  denominator as the people who already got the test, which is the population most likely to be
  compliant.
*/
define "In Hearing Conservation Program":
  exists([Condition: "Occupational exposure to noise"])
    or exists([Condition: "Hearing conservation program enrolment"])

/*
  Every threshold this measure may read. Bounding on the period end rather than Now() keeps a
  historical evaluation reproducible.

  Only CLINICALLY FINAL observations count — the same `final | amended | corrected` gate cms122.cql
  and the WebChart normalizer apply. Without it a `preliminary` or `entered-in-error` threshold can
  become the baseline or the current audiogram, and since the baseline is the EARLIEST record, a
  single erroneous early row would silently re-anchor every future shift for that worker (review,
  #408).
*/
define "Right Ear Thresholds":
  ([Observation: "Hearing threshold right 2000 Hz"]
    union [Observation: "Hearing threshold right 3000 Hz"]
    union [Observation: "Hearing threshold right 4000 Hz"]) O
    where O.status.value in { 'final', 'amended', 'corrected' }
      and (O.effective as FHIR.dateTime) on or before end of "Measurement Period"

define "Left Ear Thresholds":
  ([Observation: "Hearing threshold left 2000 Hz"]
    union [Observation: "Hearing threshold left 3000 Hz"]
    union [Observation: "Hearing threshold left 4000 Hz"]) O
    where O.status.value in { 'final', 'amended', 'corrected' }
      and (O.effective as FHIR.dateTime) on or before end of "Measurement Period"

/*
  An audiogram is a test session. Thresholds carry no session identifier in FHIR, so the test DATE is
  the grouping key — the same convention an audiometric record uses on paper.

  THE DATES ARE PER EAR, and that is a correctness requirement rather than tidiness. Deriving one
  shared baseline/current pair from both ears combined lets one ear's test date govern the other
  ear's comparison window: a right-ear-only recheck moves the shared "current" date forward, the left
  ear has no thresholds on that date, its average goes null, and a CONFIRMED left-ear shift silently
  disappears from OVERDUE (review, #408). That is under-detection caused by an unrelated
  observation arriving — the direction this measure refuses to fail in, and it also breaks the
  asymmetry rule below, under which a positive finding needs only one computable ear.
*/
define "Right Audiogram Dates":
  distinct("Right Ear Thresholds" O return date from (O.effective as FHIR.dateTime))

define "Left Audiogram Dates":
  distinct("Left Ear Thresholds" O return date from (O.effective as FHIR.dateTime))

/*
  1910.95(g)(5)(i) — the baseline is the audiogram against which subsequent ones are compared. This
  takes the EARLIEST audiogram as the baseline.

  KNOWN DIVERGENCE, and it fails in the permissive direction. 1910.95(g)(9) lets a professional
  substitute a later annual audiogram as the revised baseline when a shift is persistent or hearing
  has significantly improved — per ear, and at their discretion. That decision is a human act which
  may never reach the clinical record. Where a revision happened but was not recorded, this measure
  compares against a baseline that is too old and therefore OVER-detects STS. Over-detection sends a
  worker for evaluation they may not need; under-detection lets a real shift go unactioned. The
  first error is the one to prefer, but it is an error, and it is why this measure is a surveillance
  aid and not a legal determination.
*/
define "Right Baseline Date":
  Min("Right Audiogram Dates")

define "Right Current Date":
  Max("Right Audiogram Dates")

define "Left Baseline Date":
  Min("Left Audiogram Dates")

define "Left Current Date":
  Max("Left Audiogram Dates")

// The latest audiogram date in either ear — used ONLY to date the (g)(8)(ii) determination, never
// to select thresholds.
define "Current Audiogram Date":
  Max({ "Right Current Date", "Left Current Date" })

define "Right Has Two Audiograms":
  "Right Baseline Date" is not null and "Right Current Date" > "Right Baseline Date"

define "Left Has Two Audiograms":
  "Left Baseline Date" is not null and "Left Current Date" > "Left Baseline Date"

/*
  Every recorded value for one (ear, frequency, date).

  UNITS ARE CHECKED, not assumed. `(O.value as FHIR.Quantity).value` discards the unit entirely, so a
  threshold stamped in any other unit would be consumed as decibels (review, #408). An ABSENT unit is
  accepted — real feeds frequently omit it and these LOINC codes have no other plausible reading —
  but a unit that is explicitly something else is refused rather than silently coerced.
*/
define function "Threshold Values"(thresholds List<Observation>, onDate Date, frequency System.Code):
  distinct(thresholds O
    where date from (O.effective as FHIR.dateTime) = onDate
      and exists(O.code.coding C where C.code = frequency.code and C.system = frequency.system)
      and ((O.value as FHIR.Quantity).code is null
           or (O.value as FHIR.Quantity).code.value in { 'dB', 'dB[HL]', 'dB(HL)' })
    return (O.value as FHIR.Quantity).value)

/*
  One value, or none. `Last()` over an unsorted query resolves duplicates by DOCUMENT ORDER, so an
  original and its correction on the same date would be decided by bundle sequence (review, #408) —
  and widening the status filter to `amended | corrected` makes that pairing routine rather than
  exotic. There is no reliable recency signal to sort on here, so contradictory duplicates REFUSE:
  the worker becomes MISSING_DATA and a human decides. Identical duplicates are harmless and collapse
  via `distinct`.
*/
define function "Threshold On"(thresholds List<Observation>, onDate Date, frequency System.Code):
  if Count("Threshold Values"(thresholds, onDate, frequency)) = 1
    then First("Threshold Values"(thresholds, onDate, frequency))
    else null

/*
  1910.95(g)(10)(i): "an average of 10 dB or more at 2000, 3000, and 4000 Hz". The average is of the
  three SHIFTS, which is arithmetically identical to the difference of the two three-frequency
  averages — but only when all three frequencies are present on both dates. When one is missing the
  two formulations diverge, and this measure refuses to compute rather than averaging over whatever
  happens to be there. A shift computed from two frequencies is not the regulation's shift.
*/
define function "Ear Average"(thresholds List<Observation>, onDate Date, f2000 System.Code, f3000 System.Code, f4000 System.Code):
  if "Threshold On"(thresholds, onDate, f2000) is null
    or "Threshold On"(thresholds, onDate, f3000) is null
    or "Threshold On"(thresholds, onDate, f4000) is null
  then null
  else ("Threshold On"(thresholds, onDate, f2000)
        + "Threshold On"(thresholds, onDate, f3000)
        + "Threshold On"(thresholds, onDate, f4000)) / 3.0

define "Right Baseline Average":
  "Ear Average"("Right Ear Thresholds", "Right Baseline Date", "Hearing threshold right 2000 Hz", "Hearing threshold right 3000 Hz", "Hearing threshold right 4000 Hz")

define "Right Current Average":
  "Ear Average"("Right Ear Thresholds", "Right Current Date", "Hearing threshold right 2000 Hz", "Hearing threshold right 3000 Hz", "Hearing threshold right 4000 Hz")

define "Left Baseline Average":
  "Ear Average"("Left Ear Thresholds", "Left Baseline Date", "Hearing threshold left 2000 Hz", "Hearing threshold left 3000 Hz", "Hearing threshold left 4000 Hz")

define "Left Current Average":
  "Ear Average"("Left Ear Thresholds", "Left Current Date", "Hearing threshold left 2000 Hz", "Hearing threshold left 3000 Hz", "Hearing threshold left 4000 Hz")

/*
  AGE CORRECTION IS NOT APPLIED, and that is a decision rather than an omission.

  1910.95(g)(10)(ii) says allowance "MAY be made" for presbycusis, and Appendix F is informational
  only (1910.95(n)(2)). OSHA has since permitted age-correction tables derived from other datasets,
  so two employers can lawfully reach OPPOSITE conclusions on identical audiograms. STS is therefore
  not a pure function of the audiogram — it is a function of the audiogram and employer policy.

  Applying no correction yields a LARGER shift and detects MORE employees, which is the protective
  direction. Silently applying Appendix F would be worse than not offering it at all: it would
  present one employer's lawful policy choice as an objective finding.
*/
define "Right Ear Shift":
  "Right Current Average" - "Right Baseline Average"

define "Left Ear Shift":
  "Left Current Average" - "Left Baseline Average"

// "in either ear" (g)(10)(i) — the ears are evaluated independently and either one suffices.
// This is not exclusive-or; 1904.10(a) says "one or both ears" for the same concept.
define "Right Ear STS":
  "Right Ear Shift" is not null and "Right Ear Shift" >= 10.0

define "Left Ear STS":
  "Left Ear Shift" is not null and "Left Ear Shift" >= 10.0

define "Standard Threshold Shift":
  "Right Ear STS" or "Left Ear STS"

/*
  1910.95(g)(8)(ii) chapeau — every follow-up action is excused where a physician or audiologist
  determines the shift is neither work related nor aggravated by occupational noise exposure.
  (The chapeau says "Unless a physician determines"; audiologists are named in (g)(9) and 1904.10(b)(6),
  not here — review, #408.) The
  regulation attaches no form, timing or retention to that determination, so it may be clinically
  invisible; when it IS recorded, it is a genuine scope exclusion rather than missing data.

  THE DETERMINATION IS ABOUT ONE SHIFT, NOT ABOUT THE WORKER. The first cut asked only whether such a
  Condition existed, which made it permanent: a worker excused for a shift in 2019 would have every
  later shift suppressed as EXCLUDED, including a genuinely occupational one (review, #408). That is
  silent UNDER-detection — the direction this measure otherwise refuses to fail in, and the one that
  leaves a real hearing loss unactioned.

  A determination recorded BEFORE the current audiogram cannot be a determination about it, so the
  exclusion requires `recordedDate` on or after the current audiogram date. An UNDATED determination
  does not exclude: nothing ties it to a shift, and treating it as applying would restore exactly the
  permanence being fixed. The cost is that a worker with a genuine but undated determination reports
  OVERDUE and needs human review — the protective error rather than the silent one.
*/
define "Determined Not Occupational":
  exists([Condition: "STS determined not occupational"] C
    where C.recordedDate is not null
      and date from C.recordedDate on or after "Current Audiogram Date")

/*
  The measure refuses to conclude when the data cannot support a conclusion. An employee with one
  audiogram, or with an incomplete frequency set on either date, is NOT "no STS" — they are
  undetermined, and calling that COMPLIANT would improve the apparent rate by hiding the people
  nobody has enough information about.
*/
/*
  Determinability is ASYMMETRIC, and the asymmetry is the point.

  A positive finding is definitive from one ear: if the right ear shifted 15 dB it does not matter
  what the left ear did — 1910.95(g)(8) follow-up is owed either way. So "Standard Threshold Shift"
  needs only one computable ear.

  A NEGATIVE finding needs BOTH ears complete. Concluding "no shift" while one ear's data is missing
  asserts something about an ear nobody measured — and the first cut of this measure did exactly
  that, returning COMPLIANT for a worker whose right ear had two of three frequencies and whose left
  ear was clean. The adversarial test caught it. That bug is precisely the shape that makes a
  compliance product dangerous: it improves the apparent rate by silently absorbing the people whose
  data is incomplete.
*/
define "Right Ear Determinable":
  "Right Has Two Audiograms" and "Right Baseline Average" is not null and "Right Current Average" is not null

define "Left Ear Determinable":
  "Left Has Two Audiograms" and "Left Baseline Average" is not null and "Left Current Average" is not null

define "Determinable":
  "Right Ear Determinable" and "Left Ear Determinable"

define "Initial Population":
  "In Hearing Conservation Program"

define "Denominator":
  "Initial Population"

define "Denominator Exclusion":
  "Denominator" and "Determined Not Occupational"

// Higher is better: the numerator is employees whose surveillance shows NO shift. A hearing
// conservation program exists to prevent threshold shifts, so their absence is the outcome.
// Conjoined with the denominator so the population sets nest correctly. Without it the numerator is
// true for subjects outside the initial population, and any consumer computing
// `group.population[].count` from these defines — which is exactly what publishing this as IG content
// means (ADR-065) — would get numerator > denominator (review, #408).
define "Numerator":
  "Denominator"
    and not "Denominator Exclusion"
    and "Determinable"
    and not "Standard Threshold Shift"

define "Excluded":
  "Determined Not Occupational"

define "Missing Data":
  "In Hearing Conservation Program"
    and not "Determined Not Occupational"
    and not "Standard Threshold Shift"
    and not "Determinable"

define "Overdue":
  "In Hearing Conservation Program"
    and not "Determined Not Occupational"
    and "Standard Threshold Shift"

define "Compliant":
  "In Hearing Conservation Program"
    and not "Determined Not Occupational"
    and "Determinable"
    and not "Standard Threshold Shift"

/*
  There is no DUE_SOON. A threshold shift either meets the 10 dB average or it does not; the
  regulation defines no warning band, and inventing one would present a WorkWell convention as a
  regulatory threshold. OVERDUE means "an STS is present and 1910.95(g)(8) follow-up is owed",
  not that a date has passed.
*/
define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Missing Data" then 'MISSING_DATA'
  else if "Overdue" then 'OVERDUE'
  else if "Compliant" then 'COMPLIANT'
  else 'MISSING_DATA'
