library ObesityBMIScreeningCQL version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

valueset "BMI Screening Procedures": 'urn:workwell:vs:bmi-screening'
valueset "Wellness Program Enrollment": 'urn:workwell:vs:wellness-enrollment'
valueset "Wellness Exemption": 'urn:workwell:vs:wellness-exemption'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "In Wellness Program":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:wellness-enrollment' and x.code = 'wellness-enrolled'))

define "Has Medical Exemption":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:wellness-exemption' and x.code = 'wellness-exempt'))

define "Most Recent BMI Screening Date":
  Last(
    [Procedure] P
      where exists(P.code.coding C where C.system = 'urn:workwell:vs:bmi-screening' and C.code = 'bmi-screen')
      sort by (performed as FHIR.dateTime)
  ).performed as FHIR.dateTime

define "Days Since Last BMI Screening":
  difference in days between
    Coalesce("Most Recent BMI Screening Date", @1900-01-01T00:00:00.0)
    and Now()

define "Compliant":
  "In Wellness Program"
    and not "Has Medical Exemption"
    and "Days Since Last BMI Screening" <= 335

define "Due Soon":
  "In Wellness Program"
    and not "Has Medical Exemption"
    and "Days Since Last BMI Screening" > 335
    and "Days Since Last BMI Screening" <= 365

define "Overdue":
  "In Wellness Program"
    and not "Has Medical Exemption"
    and "Days Since Last BMI Screening" > 365

define "Missing Data":
  "In Wellness Program"
    and not "Has Medical Exemption"
    and "Most Recent BMI Screening Date" is null

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
