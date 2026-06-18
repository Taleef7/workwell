library DiabetesHbA1cPoorControlCQL version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

valueset "HbA1c Lab Tests": 'urn:workwell:vs:cms122-hba1c'
valueset "Diabetes Diagnosis": 'urn:workwell:vs:cms122-diabetes'
valueset "CMS122 Exclusions": 'urn:workwell:vs:cms122-excluded'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "Has Diabetes Diagnosis":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:cms122-diabetes' and x.code = 'cms122-diabetes'))

define "Has Exclusion":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:cms122-excluded' and x.code = 'cms122-excluded'))

define "Most Recent HbA1c Observation":
  Last(
    [Observation] O
      where exists(O.code.coding C where C.system = 'urn:workwell:vs:cms122-hba1c' and C.code = 'hba1c-obs')
      sort by (effective as FHIR.dateTime)
  )

define "Most Recent HbA1c Value":
  "Most Recent HbA1c Observation".value as FHIR.Quantity

define "HbA1c Poor Control":
  "Most Recent HbA1c Value".value > 9

define "Has Recent HbA1c Result":
  "Most Recent HbA1c Observation" is not null

define "Compliant":
  "Has Diabetes Diagnosis"
    and not "Has Exclusion"
    and "Has Recent HbA1c Result"
    and not "HbA1c Poor Control"

define "Due Soon":
  false

define "Overdue":
  "Has Diabetes Diagnosis"
    and not "Has Exclusion"
    and "Has Recent HbA1c Result"
    and "HbA1c Poor Control"

define "Missing Data":
  "Has Diabetes Diagnosis"
    and not "Has Exclusion"
    and not "Has Recent HbA1c Result"

define "Excluded":
  "Has Exclusion"

define "Initial Population":
  "Has Diabetes Diagnosis" or "Has Exclusion"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Missing Data" then 'MISSING_DATA'
  else if "Overdue" then 'OVERDUE'
  else if "Compliant" then 'COMPLIANT'
  else 'MISSING_DATA'
