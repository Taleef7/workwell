library CholesterolLDLScreeningCQL version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

parameter "Measurement Period" Interval<DateTime>
context Patient

define "Enrolled":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:cholesterol-program' and x.code = 'cholesterol-enrolled'))

define "Has Waiver":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:cholesterol-exemption' and x.code = 'cholesterol-exempt'))

define "Most Recent Event Date":
  Last(
    [Procedure] P
      where exists(P.code.coding C where C.system = 'urn:workwell:vs:ldl-labs' and C.code = 'ldl-lab')
      sort by (performed as FHIR.dateTime)
  ).performed as FHIR.dateTime

define "Days Since Last Event":
  difference in days between
    Coalesce("Most Recent Event Date", @1900-01-01T00:00:00.0)
    and Now()

define "Compliant":
  "Enrolled" and not "Has Waiver" and "Days Since Last Event" <= 335

define "Due Soon":
  "Enrolled" and not "Has Waiver" and "Days Since Last Event" > 335 and "Days Since Last Event" <= 365

define "Overdue":
  "Enrolled" and not "Has Waiver" and "Days Since Last Event" > 365

define "Missing Data":
  "Enrolled" and not "Has Waiver" and "Most Recent Event Date" is null

define "Excluded": "Has Waiver"

define "Initial Population": "Enrolled" or "Has Waiver"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Missing Data" then 'MISSING_DATA'
  else if "Overdue" then 'OVERDUE'
  else if "Due Soon" then 'DUE_SOON'
  else if "Compliant" then 'COMPLIANT'
  else 'MISSING_DATA'
