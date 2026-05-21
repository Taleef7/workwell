library HypertensionBPScreeningCQL version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

valueset "BP Screening Procedures": 'urn:workwell:vs:bp-screening'
valueset "Wellness Program Enrollment": 'urn:workwell:vs:wellness-enrollment'
valueset "Wellness Exemption": 'urn:workwell:vs:wellness-exemption'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "In Wellness Program":
  exists([Condition])

define "Has Medical Exemption":
  Count([Condition]) > 1

define "Most Recent BP Screening Date":
  Last(
    [Procedure] P
      sort by (performed as FHIR.dateTime)
  ).performed as FHIR.dateTime

define "Days Since Last BP Screening":
  difference in days between
    Coalesce("Most Recent BP Screening Date", @1900-01-01T00:00:00.0)
    and Now()

define "Compliant":
  "In Wellness Program"
    and not "Has Medical Exemption"
    and "Days Since Last BP Screening" <= 335

define "Due Soon":
  "In Wellness Program"
    and not "Has Medical Exemption"
    and "Days Since Last BP Screening" > 335
    and "Days Since Last BP Screening" <= 365

define "Overdue":
  "In Wellness Program"
    and not "Has Medical Exemption"
    and "Days Since Last BP Screening" > 365

define "Missing Data":
  "In Wellness Program"
    and not "Has Medical Exemption"
    and "Most Recent BP Screening Date" is null

define "Excluded":
  "Has Medical Exemption"

define "Initial Population":
  "In Wellness Program" or "Has Medical Exemption"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Missing Data" then 'MISSING_DATA'
  else if "Overdue" then 'OVERDUE'
  else if "Due Soon" then 'DUE_SOON'
  else if "Compliant" then 'COMPLIANT'
  else 'MISSING_DATA'
