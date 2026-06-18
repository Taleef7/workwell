library BreastCancerScreeningCQL version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

valueset "Mammography Procedures": 'urn:workwell:vs:cms125-mammogram'
valueset "Breast Cancer Screening Eligible": 'urn:workwell:vs:cms125-eligible'
valueset "Breast Cancer Screening Exclusions": 'urn:workwell:vs:cms125-excluded'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "In Screening Population":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:cms125-eligible' and x.code = 'cms125-eligible'))

define "Has Exclusion":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:cms125-excluded' and x.code = 'cms125-excluded'))

define "Most Recent Mammogram Date":
  Last(
    [Procedure] P
      where exists(P.code.coding C where C.system = 'urn:workwell:vs:cms125-mammogram' and C.code = 'mammogram')
      sort by (performed as FHIR.dateTime)
  ).performed as FHIR.dateTime

define "Days Since Last Mammogram":
  difference in days between
    Coalesce("Most Recent Mammogram Date", @1900-01-01T00:00:00.0)
    and Now()

define "Compliant":
  "In Screening Population"
    and not "Has Exclusion"
    and "Days Since Last Mammogram" <= 790

define "Due Soon":
  "In Screening Population"
    and not "Has Exclusion"
    and "Days Since Last Mammogram" > 790
    and "Days Since Last Mammogram" <= 820

define "Overdue":
  "In Screening Population"
    and not "Has Exclusion"
    and "Days Since Last Mammogram" > 820

define "Missing Data":
  "In Screening Population"
    and not "Has Exclusion"
    and "Most Recent Mammogram Date" is null

define "Excluded":
  "Has Exclusion"

define "Initial Population":
  "In Screening Population" or "Has Exclusion"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Missing Data" then 'MISSING_DATA'
  else if "Overdue" then 'OVERDUE'
  else if "Due Soon" then 'DUE_SOON'
  else if "Compliant" then 'COMPLIANT'
  else 'MISSING_DATA'
