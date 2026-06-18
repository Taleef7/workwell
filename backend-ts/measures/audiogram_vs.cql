library AnnualAudiogramCompletedVS version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

codesystem "LOINC": 'http://loinc.org'
valueset "Audiogram Procedures": 'urn:workwell:vs:audiogram-procedures'
valueset "Hearing Conservation Enrollment": 'urn:workwell:vs:hearing-enrollment'
valueset "Audiogram Medical Waiver": 'urn:workwell:vs:audiogram-waiver'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "In Hearing Conservation Program":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:hearing-enrollment' and x.code = 'hearing-enrollment'))

define "Has Active Waiver":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:audiogram-waiver' and x.code = 'audiogram-waiver'))

define "Most Recent Audiogram Date":
  Last(
    [Procedure: "Audiogram Procedures"] P
      sort by (performed as FHIR.dateTime)
  ).performed as FHIR.dateTime

define "Days Since Last Audiogram":
  difference in days between
    Coalesce("Most Recent Audiogram Date", @1900-01-01T00:00:00.0)
    and Now()

define "Compliant":
  "In Hearing Conservation Program"
    and not "Has Active Waiver"
    and "Days Since Last Audiogram" <= 335

define "Due Soon":
  "In Hearing Conservation Program"
    and not "Has Active Waiver"
    and "Days Since Last Audiogram" > 335
    and "Days Since Last Audiogram" <= 365

define "Overdue":
  "In Hearing Conservation Program"
    and not "Has Active Waiver"
    and "Days Since Last Audiogram" > 365

define "Missing Data":
  "In Hearing Conservation Program"
    and not "Has Active Waiver"
    and "Most Recent Audiogram Date" is null

define "Excluded":
  "Has Active Waiver"

define "Initial Population":
  "In Hearing Conservation Program" or "Has Active Waiver"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Missing Data" then 'MISSING_DATA'
  else if "Overdue" then 'OVERDUE'
  else if "Due Soon" then 'DUE_SOON'
  else if "Compliant" then 'COMPLIANT'
  else 'MISSING_DATA'
