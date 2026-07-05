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

// Official CMS122 requires the qualifying visit to occur DURING the measurement period, so the
// Encounter retrieves are period-filtered (FHIRHelpers.ToInterval(E.period) during "Measurement Period").
// A stale/future Encounter in a replayed run's bundle therefore no longer overstates official eligibility.
define "Has Qualifying Visit":
  exists([Encounter: "Office Visit"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Annual Wellness Visit"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Preventive Care Established Office Visit 18+"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Preventive Care Initial Office Visit 18+"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Home Healthcare Services"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Telephone Visits"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")
    or exists([Encounter: "Nutrition Services"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")

// Condition retrieves stay presence-based: the synthetic Diabetes/Palliative Conditions carry no
// onset/period dates, so a measurement-period filter would wrongly exclude them (known synthetic-data
// simplification). Only the Encounter retrieves above/below are period-constrained.
define "Has Diabetes":
  exists([Condition: "Diabetes"])

define "Initial Population":
  "Age 18 To 75" and "Has Qualifying Visit" and "Has Diabetes"

define "Has Hospice":
  exists([Encounter: "Hospice Encounter"] E where FHIRHelpers.ToInterval(E.period) during "Measurement Period")

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
