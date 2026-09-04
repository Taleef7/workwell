library HypertensionBPScreeningCQL version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

valueset "BP Screening Procedures": 'urn:workwell:vs:bp-screening'
valueset "Wellness Program Enrollment": 'urn:workwell:vs:wellness-enrollment'
valueset "Wellness Exemption": 'urn:workwell:vs:wellness-exemption'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "In Eligible Population":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:wellness-enrollment' and x.code = 'wellness-enrolled'))

define "Has Documented Exclusion":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:wellness-exemption' and x.code = 'wellness-exempt'))

define "Most Recent BP Screening Date":
  Last(
    [Procedure] P
      where exists(P.code.coding C where C.system = 'urn:workwell:vs:bp-screening' and C.code = 'bp-screen')
      sort by (performed as FHIR.dateTime)
  ).performed as FHIR.dateTime

define "Days Since Last BP Screening":
  difference in days between
    Coalesce("Most Recent BP Screening Date", @1900-01-01T00:00:00.0)
    and Now()

define "Compliant":
  "In Eligible Population"
    and not "Has Documented Exclusion"
    and "Days Since Last BP Screening" <= 335

define "Due Soon":
  "In Eligible Population"
    and not "Has Documented Exclusion"
    and "Days Since Last BP Screening" > 335
    and "Days Since Last BP Screening" <= 365

define "Overdue":
  "In Eligible Population"
    and not "Has Documented Exclusion"
    and "Days Since Last BP Screening" > 365

define "Missing Data":
  "In Eligible Population"
    and not "Has Documented Exclusion"
    and "Most Recent BP Screening Date" is null

define "Excluded":
  "Has Documented Exclusion"

define "Initial Population":
  "In Eligible Population" or "Has Documented Exclusion"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Missing Data" then 'MISSING_DATA'
  else if "Overdue" then 'OVERDUE'
  else if "Due Soon" then 'DUE_SOON'
  else if "Compliant" then 'COMPLIANT'
  else 'MISSING_DATA'
