library DiabetesHbA1cPoorControlCQL version '2.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

// Production CMS122v14 (2026 eCQI) — faithful official-subset.
// Population criteria from CMS122-v14.0.000-QDM.html (eCQI). GMI = LOINC 97506-0.
// VSAC OIDs expand via bundled offline expansions + optional store/VSAC resolver.
// Maps eCQM populations → WorkWell Outcome Status (ADR-008): NUMER (poor control) → OVERDUE.

valueset "Diabetes": '2.16.840.1.113883.3.464.1003.103.12.1001'
valueset "HbA1c Laboratory Test": '2.16.840.1.113883.3.464.1003.198.12.1013'
valueset "Office Visit": '2.16.840.1.113883.3.464.1003.101.12.1001'
valueset "Annual Wellness Visit": '2.16.840.1.113883.3.526.3.1240'
valueset "Preventive Care Established Office Visit 18+": '2.16.840.1.113883.3.464.1003.101.12.1025'
valueset "Preventive Care Initial Office Visit 18+": '2.16.840.1.113883.3.464.1003.101.12.1023'
valueset "Home Healthcare Services": '2.16.840.1.113883.3.464.1003.101.12.1016'
valueset "Telephone Visits": '2.16.840.1.113883.3.464.1003.101.12.1080'
valueset "Nutrition Services": '2.16.840.1.113883.3.464.1003.1006'
valueset "Hospice Encounter": '2.16.840.1.113883.3.464.1003.1003'
valueset "Hospice Care Ambulatory": '2.16.840.1.113883.3.526.3.1584'
valueset "Hospice Diagnosis": '2.16.840.1.113883.3.464.1003.1165'
valueset "Palliative Care Diagnosis": '2.16.840.1.113883.3.464.1003.1167'
valueset "Palliative Care Encounter": '2.16.840.1.113883.3.464.1003.101.12.1090'
valueset "Palliative Care Intervention": '2.16.840.1.113883.3.464.1003.198.12.1135'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "Age At End":
  AgeInYearsAt(end of "Measurement Period")

define "Age 18 To 75":
  "Age At End" >= 18 and "Age At End" <= 75

define "Has Qualifying Visit":
  exists([Encounter: "Office Visit"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Annual Wellness Visit"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Preventive Care Established Office Visit 18+"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Preventive Care Initial Office Visit 18+"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Home Healthcare Services"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Telephone Visits"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Nutrition Services"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")

// Diabetes Condition: presence-based (synthetic Conditions often lack onset periods).
define "Has Diabetes":
  exists([Condition: "Diabetes"])

define "Initial Population":
  "Age 18 To 75" and "Has Qualifying Visit" and "Has Diabetes"

define "Has Hospice":
  exists([Encounter: "Hospice Encounter"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Hospice Care Ambulatory"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Condition: "Hospice Diagnosis"])

define "Has Palliative":
  exists([Condition: "Palliative Care Diagnosis"])
    or exists([Encounter: "Palliative Care Encounter"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Procedure: "Palliative Care Intervention"] P
      where FHIRHelpers.ToDateTime(P.performed as FHIR.dateTime) during "Measurement Period")

define "Denominator Exclusions":
  "Initial Population" and ("Has Hospice" or "Has Palliative")

// Official numerator: most recent glycemic status (HbA1c VSAC set OR GMI LOINC 97506-0) in MP
// is > 9.0%, missing result, or not performed. Lower rate is better.
define "Most Recent HbA1c":
  Last([Observation: "HbA1c Laboratory Test"] O
    where O.status.value in {'final', 'amended', 'corrected'}
      and FHIRHelpers.ToDateTime(O.effective as FHIR.dateTime) in "Measurement Period"
    sort by (effective as FHIR.dateTime))

define "Most Recent GMI":
  Last([Observation] O
    where exists(O.code.coding c where c.system = 'http://loinc.org' and c.code = '97506-0')
      and O.status.value in {'final', 'amended', 'corrected'}
      and FHIRHelpers.ToDateTime(O.effective as FHIR.dateTime) in "Measurement Period"
    sort by (effective as FHIR.dateTime))

define "Most Recent Glycemic Assessment":
  if "Most Recent HbA1c" is null then "Most Recent GMI"
  else if "Most Recent GMI" is null then "Most Recent HbA1c"
  else if FHIRHelpers.ToDateTime("Most Recent GMI".effective as FHIR.dateTime)
        >= FHIRHelpers.ToDateTime("Most Recent HbA1c".effective as FHIR.dateTime)
    then "Most Recent GMI"
  else "Most Recent HbA1c"

define "Most Recent Glycemic Value":
  ("Most Recent Glycemic Assessment".value as FHIR.Quantity).value

define "Glycemic Assessment Missing":
  "Most Recent Glycemic Assessment" is null

define "Numerator":
  "Initial Population"
    and not "Denominator Exclusions"
    and ("Glycemic Assessment Missing" or "Most Recent Glycemic Value" > 9.0)

// WorkWell Outcome Status vocabulary (not QDM population names).
define "Outcome Status":
  if not "Initial Population" then 'MISSING_DATA'
  else if "Denominator Exclusions" then 'EXCLUDED'
  else if "Numerator" then 'OVERDUE'
  else 'COMPLIANT'
