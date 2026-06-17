library DiabetesHbA1cMonitoringCQL version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

valueset "HbA1c Lab Procedures": 'urn:workwell:vs:hba1c-labs'
valueset "Diabetes Program Enrollment": 'urn:workwell:vs:diabetes-program'
valueset "Diabetes Program Exemption": 'urn:workwell:vs:diabetes-exemption'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "In Diabetes Program":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:diabetes-program' and x.code = 'diabetes-enrolled'))

define "Has Medical Exemption":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:diabetes-exemption' and x.code = 'diabetes-exempt'))

define "Most Recent HbA1c Date":
  Last(
    [Procedure] P
      where exists(P.code.coding C where C.system = 'urn:workwell:vs:hba1c-labs' and C.code = 'hba1c-lab')
      sort by (performed as FHIR.dateTime)
  ).performed as FHIR.dateTime

define "Days Since Last HbA1c":
  difference in days between
    Coalesce("Most Recent HbA1c Date", @1900-01-01T00:00:00.0)
    and Now()

define "Compliant":
  "In Diabetes Program"
    and not "Has Medical Exemption"
    and "Days Since Last HbA1c" <= 160

define "Due Soon":
  "In Diabetes Program"
    and not "Has Medical Exemption"
    and "Days Since Last HbA1c" > 160
    and "Days Since Last HbA1c" <= 180

define "Overdue":
  "In Diabetes Program"
    and not "Has Medical Exemption"
    and "Days Since Last HbA1c" > 180

define "Missing Data":
  "In Diabetes Program"
    and not "Has Medical Exemption"
    and "Most Recent HbA1c Date" is null

define "Excluded":
  "Has Medical Exemption"

define "Initial Population":
  "In Diabetes Program" or "Has Medical Exemption"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Missing Data" then 'MISSING_DATA'
  else if "Overdue" then 'OVERDUE'
  else if "Due Soon" then 'DUE_SOON'
  else if "Compliant" then 'COMPLIANT'
  else 'MISSING_DATA'
