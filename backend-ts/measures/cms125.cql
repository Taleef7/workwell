library BreastCancerScreeningCQL version '2.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

// Production CMS125v14 (2026 eCQI) — faithful official-subset.
// Population criteria from CMS125-v14.0.000-QDM.html:
//   IPP: women 42-74 by end of MP with a visit during MP
//   NUMER: ≥1 mammogram Oct 1 two years prior to MP through end of MP
//   DENEX: hospice; bilateral mastectomy / history / L+R unilateral; palliative
//   (66+ frailty/LTC deferred to Phase 2)
// Higher rate is better → COMPLIANT if numerator, OVERDUE if in denom and not numerator.

valueset "Mammography": '2.16.840.1.113883.3.464.1003.108.12.1018'
valueset "Office Visit": '2.16.840.1.113883.3.464.1003.101.12.1001'
valueset "Annual Wellness Visit": '2.16.840.1.113883.3.526.3.1240'
valueset "Preventive Care Established Office Visit 18+": '2.16.840.1.113883.3.464.1003.101.12.1025'
valueset "Preventive Care Initial Office Visit 18+": '2.16.840.1.113883.3.464.1003.101.12.1023'
valueset "Home Healthcare Services": '2.16.840.1.113883.3.464.1003.101.12.1016'
valueset "Telephone Visits": '2.16.840.1.113883.3.464.1003.101.12.1080'
valueset "Virtual Encounter": '2.16.840.1.113883.3.464.1003.101.12.1089'
valueset "Hospice Encounter": '2.16.840.1.113883.3.464.1003.1003'
valueset "Hospice Care Ambulatory": '2.16.840.1.113883.3.526.3.1584'
valueset "Hospice Diagnosis": '2.16.840.1.113883.3.464.1003.1165'
valueset "Palliative Care Diagnosis": '2.16.840.1.113883.3.464.1003.1167'
valueset "Palliative Care Encounter": '2.16.840.1.113883.3.464.1003.101.12.1090'
valueset "History of bilateral mastectomy": '2.16.840.1.113883.3.464.1003.198.12.1068'
valueset "Bilateral Mastectomy": '2.16.840.1.113883.3.464.1003.198.12.1005'
valueset "Status Post Left Mastectomy": '2.16.840.1.113883.3.464.1003.198.12.1069'
valueset "Status Post Right Mastectomy": '2.16.840.1.113883.3.464.1003.198.12.1070'
valueset "Unilateral Mastectomy Left": '2.16.840.1.113883.3.464.1003.198.12.1133'
valueset "Unilateral Mastectomy Right": '2.16.840.1.113883.3.464.1003.198.12.1134'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "Is Female":
  Patient.gender.value = 'female'

define "Age At End":
  AgeInYearsAt(end of "Measurement Period")

define "Age 42 To 74":
  "Age At End" >= 42 and "Age At End" <= 74

define "Has Qualifying Visit":
  exists([Encounter: "Office Visit"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Annual Wellness Visit"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Preventive Care Established Office Visit 18+"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Preventive Care Initial Office Visit 18+"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Home Healthcare Services"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Telephone Visits"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Virtual Encounter"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")

define "Initial Population":
  "Is Female" and "Age 42 To 74" and "Has Qualifying Visit"

// Official numerator window: Oct 1 two years prior to the measurement period through end of MP.
define "Mammogram Interval Start":
  DateTime(
    year from start of "Measurement Period" - 2,
    10, 1, 0, 0, 0, 0
  )

define "Has Qualifying Mammogram":
  exists([Procedure: "Mammography"] P
    where P.status.value = 'completed'
      and FHIRHelpers.ToDateTime(P.performed as FHIR.dateTime) in
        Interval["Mammogram Interval Start", end of "Measurement Period"])

define "Has Hospice":
  exists([Encounter: "Hospice Encounter"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Hospice Care Ambulatory"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Condition: "Hospice Diagnosis"])

define "Has Palliative":
  exists([Condition: "Palliative Care Diagnosis"])
    or exists([Encounter: "Palliative Care Encounter"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")

define "Has Bilateral Mastectomy History":
  exists([Condition: "History of bilateral mastectomy"])

define "Has Bilateral Mastectomy Procedure":
  exists([Procedure: "Bilateral Mastectomy"] P
    where P.status.value = 'completed'
      and FHIRHelpers.ToDateTime(P.performed as FHIR.dateTime) on or before end of "Measurement Period")

define "Has Left Mastectomy":
  exists([Condition: "Status Post Left Mastectomy"])
    or exists([Procedure: "Unilateral Mastectomy Left"] P
      where P.status.value = 'completed'
        and FHIRHelpers.ToDateTime(P.performed as FHIR.dateTime) on or before end of "Measurement Period")

define "Has Right Mastectomy":
  exists([Condition: "Status Post Right Mastectomy"])
    or exists([Procedure: "Unilateral Mastectomy Right"] P
      where P.status.value = 'completed'
        and FHIRHelpers.ToDateTime(P.performed as FHIR.dateTime) on or before end of "Measurement Period")

define "Has Mastectomy Exclusion":
  "Has Bilateral Mastectomy History"
    or "Has Bilateral Mastectomy Procedure"
    or ("Has Left Mastectomy" and "Has Right Mastectomy")

define "Denominator Exclusions":
  "Initial Population" and ("Has Hospice" or "Has Palliative" or "Has Mastectomy Exclusion")

define "Numerator":
  "Initial Population"
    and not "Denominator Exclusions"
    and "Has Qualifying Mammogram"

// WorkWell Outcome Status: higher-is-better process measure.
define "Outcome Status":
  if not "Initial Population" then 'MISSING_DATA'
  else if "Denominator Exclusions" then 'EXCLUDED'
  else if "Numerator" then 'COMPLIANT'
  else 'OVERDUE'
