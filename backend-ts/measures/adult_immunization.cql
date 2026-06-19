library AdultImmunizationTdap version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

valueset "Tdap Vaccines": 'urn:workwell:vs:tdap-vaccines'
valueset "Adult Immunization Enrollment": 'urn:workwell:vs:adult-immz-enrollment'
valueset "Tdap Contraindication": 'urn:workwell:vs:tdap-contraindication'
valueset "Tdap Refusal": 'urn:workwell:vs:tdap-refusal'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "Enrolled Adult":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:adult-immz-enrollment' and x.code = 'adult-immz-enrolled'))

define "Has Contraindication":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:tdap-contraindication' and x.code = 'tdap-contraindication'))

define "Refused":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:tdap-refusal' and x.code = 'tdap-refusal'))

define "Most Recent Tdap Date":
  Last(
    [Immunization] I
      where exists(I.vaccineCode.coding C where C.system = 'urn:workwell:vs:tdap-vaccines' and C.code = 'tdap-vaccine')
      sort by (occurrence as FHIR.dateTime)
  ).occurrence as FHIR.dateTime

define "Days Since Last Tdap":
  difference in days between
    Coalesce("Most Recent Tdap Date", @1900-01-01T00:00:00.0)
    and Now()

define "Up To Date":
  "Enrolled Adult" and not "Has Contraindication"
    and "Most Recent Tdap Date" is not null
    and "Days Since Last Tdap" <= 3590

define "Due Soon":
  "Enrolled Adult" and not "Has Contraindication"
    and "Most Recent Tdap Date" is not null
    and "Days Since Last Tdap" > 3590
    and "Days Since Last Tdap" <= 3650

define "Overdue":
  "Enrolled Adult" and not "Has Contraindication"
    and "Most Recent Tdap Date" is not null
    and "Days Since Last Tdap" > 3650

define "Missing Data":
  "Enrolled Adult" and not "Has Contraindication"
    and "Most Recent Tdap Date" is null

define "Excluded": "Has Contraindication"

define "Initial Population": "Enrolled Adult" or "Has Contraindication"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Overdue" then 'OVERDUE'
  else if "Due Soon" then 'DUE_SOON'
  else if "Up To Date" then 'COMPLIANT'
  else if "Missing Data" then 'MISSING_DATA'
  else 'MISSING_DATA'
