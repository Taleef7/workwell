library CholesterolLDLScreeningCQL version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

valueset "LDL Lab Procedures": 'urn:workwell:vs:ldl-labs'
valueset "Cholesterol Program Enrollment": 'urn:workwell:vs:cholesterol-program'
valueset "Cholesterol Program Exemption": 'urn:workwell:vs:cholesterol-exemption'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "In Cholesterol Program":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:cholesterol-program' and x.code = 'cholesterol-enrolled'))

define "Has Medical Exemption":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:cholesterol-exemption' and x.code = 'cholesterol-exempt'))

define "Most Recent LDL Screening Date":
  Last(
    [Procedure] P
      where exists(P.code.coding C where C.system = 'urn:workwell:vs:ldl-labs' and C.code = 'ldl-lab')
      sort by (performed as FHIR.dateTime)
  ).performed as FHIR.dateTime

define "Days Since Last LDL Screening":
  difference in days between
    Coalesce("Most Recent LDL Screening Date", @1900-01-01T00:00:00.0)
    and Now()

define "Compliant":
  "In Cholesterol Program"
    and not "Has Medical Exemption"
    and "Days Since Last LDL Screening" <= 335

define "Due Soon":
  "In Cholesterol Program"
    and not "Has Medical Exemption"
    and "Days Since Last LDL Screening" > 335
    and "Days Since Last LDL Screening" <= 365

define "Overdue":
  "In Cholesterol Program"
    and not "Has Medical Exemption"
    and "Days Since Last LDL Screening" > 365

define "Missing Data":
  "In Cholesterol Program"
    and not "Has Medical Exemption"
    and "Most Recent LDL Screening Date" is null

define "Excluded":
  "Has Medical Exemption"

define "Initial Population":
  "In Cholesterol Program" or "Has Medical Exemption"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Missing Data" then 'MISSING_DATA'
  else if "Overdue" then 'OVERDUE'
  else if "Due Soon" then 'DUE_SOON'
  else if "Compliant" then 'COMPLIANT'
  else 'MISSING_DATA'
