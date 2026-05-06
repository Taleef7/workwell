library TbSurveillance version '1.3.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

valueset "TB Screening Procedures": 'urn:workwell:vs:tb-screening'
valueset "TB Medical Exemption": 'urn:workwell:vs:tb-exemption'
valueset "TB Eligible Roles": 'urn:workwell:vs:tb-eligible-roles'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "In TB Screening Program":
  exists([Condition])

define "Has Medical Exemption":
  Count([Condition]) > 1

define "Most Recent TB Screen Date":
  Last(
    [Procedure: "TB Screening Procedures"] P
      sort by (performed as FHIR.dateTime)
  ).performed as FHIR.dateTime

define "Days Since Last TB Screen":
  difference in days between
    Coalesce("Most Recent TB Screen Date", @1900-01-01T00:00:00.0)
    and Now()

define "Compliant": "In TB Screening Program" and not "Has Medical Exemption" and "Days Since Last TB Screen" <= 330
define "Due Soon": "In TB Screening Program" and not "Has Medical Exemption" and "Days Since Last TB Screen" > 330 and "Days Since Last TB Screen" <= 365
define "Overdue": "In TB Screening Program" and not "Has Medical Exemption" and "Days Since Last TB Screen" > 365
define "Missing Data": "In TB Screening Program" and not "Has Medical Exemption" and "Most Recent TB Screen Date" is null
define "Excluded": "Has Medical Exemption"

define "Initial Population": "In TB Screening Program" or "Has Medical Exemption"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Missing Data" then 'MISSING_DATA'
  else if "Overdue" then 'OVERDUE'
  else if "Due Soon" then 'DUE_SOON'
  else if "Compliant" then 'COMPLIANT'
  else 'MISSING_DATA'
