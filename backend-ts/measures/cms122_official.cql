library DiabetesHbA1cPoorControlOfficialCQL version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

// Official CMS122v14 VSAC value sets, referenced by bare OID. These resolve at runtime from the
// imported `value_sets` rows (source='VSAC') via StoreValueSetResolver (bare-OID match). This is a
// FAITHFUL-BUT-SIMPLIFIED transcription of the official measure's population logic — NOT the literal
// multi-library QICore artifact (spike-proven un-compilable under @cqframework/cql 4.0.0-beta.1).
// Descriptive only (ADR-008): never decides a stored compliance outcome.
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
valueset "Palliative Care Diagnosis": '2.16.840.1.113883.3.464.1003.1167'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "Age At End":
  AgeInYearsAt(end of "Measurement Period")

define "Age 18 To 75":
  "Age At End" >= 18 and "Age At End" <= 75

define "Has Qualifying Visit":
  exists([Encounter: "Office Visit"])
    or exists([Encounter: "Annual Wellness Visit"])
    or exists([Encounter: "Preventive Care Established Office Visit 18+"])
    or exists([Encounter: "Preventive Care Initial Office Visit 18+"])
    or exists([Encounter: "Home Healthcare Services"])
    or exists([Encounter: "Telephone Visits"])
    or exists([Encounter: "Nutrition Services"])

define "Has Diabetes":
  exists([Condition: "Diabetes"])

define "Initial Population":
  "Age 18 To 75" and "Has Qualifying Visit" and "Has Diabetes"

define "Has Hospice":
  exists([Encounter: "Hospice Encounter"])

define "Has Palliative":
  exists([Condition: "Palliative Care Diagnosis"])

define "Denominator Exclusions":
  "Initial Population" and ("Has Hospice" or "Has Palliative")

define "Most Recent HbA1c":
  Last([Observation: "HbA1c Laboratory Test"] O
    where O.status.value in {'final', 'amended', 'corrected'}
    sort by (effective as FHIR.dateTime))

define "Most Recent HbA1c Value":
  ("Most Recent HbA1c".value as FHIR.Quantity).value

define "HbA1c Missing":
  "Most Recent HbA1c" is null

define "Numerator":
  "Initial Population"
    and not "Denominator Exclusions"
    and ("HbA1c Missing" or "Most Recent HbA1c Value" > 9.0)

define "Outcome Status":
  if not "Initial Population" then 'MISSING_DATA'
  else if "Denominator Exclusions" then 'EXCLUDED'
  else if "Numerator" then 'OVERDUE'
  else 'COMPLIANT'
