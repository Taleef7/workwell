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

// Official v14 numerator is the most recent GLYCEMIC STATUS ASSESSMENT during the period — an HbA1c
// laboratory test OR a Glucose Management Indicator (GMI). VSAC ships both inside one combined
// "Glycemic Status Assessment" value set; here HbA1c stays the VSAC-resolved value-set retrieve and GMI
// is modeled with a direct LOINC 97506-0 code filter (the synthetic corpus carries no GMI value set, so
// no dedicated/VSAC OID is invented — mirrors WorkWell's coding-filter idiom). Each assessment type's
// most-recent-in-period is computed separately, then the later of the two by effective date wins — so a
// newer GMI supersedes an older HbA1c (and vice versa). A list `union` is avoided deliberately: cql-execution
// de-duplicates FHIR resources across a union, which drops one assessment type when both are present.
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

define "Outcome Status":
  if not "Initial Population" then 'MISSING_DATA'
  else if "Denominator Exclusions" then 'EXCLUDED'
  else if "Numerator" then 'OVERDUE'
  else 'COMPLIANT'
