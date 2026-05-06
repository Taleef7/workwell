library HazwoperSurveillance version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

valueset "HAZWOPER Surveillance Exams": 'urn:workwell:vs:hazwoper-exams'
valueset "HAZWOPER Program Enrollment": 'urn:workwell:vs:hazwoper-enrollment'
valueset "HAZWOPER Medical Exemption": 'urn:workwell:vs:hazwoper-exemption'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "In HAZWOPER Program":
  exists([Condition: "HAZWOPER Program Enrollment"] C
    where C.clinicalStatus.coding.code = 'active')

define "Has Medical Exemption":
  exists([Condition: "HAZWOPER Medical Exemption"] C
    where C.clinicalStatus.coding.code = 'active')

define "Most Recent Surveillance Exam Date":
  Last(
    [Procedure: "HAZWOPER Surveillance Exams"] P
      where P.status = 'completed'
      sort by (performed as FHIR.dateTime)
  ).performed as FHIR.dateTime

define "Days Since Last Exam":
  difference in days between
    Coalesce("Most Recent Surveillance Exam Date", @1900-01-01)
    and Today()

define "Compliant": "In HAZWOPER Program" and not "Has Medical Exemption" and "Days Since Last Exam" <= 335
define "Due Soon": "In HAZWOPER Program" and not "Has Medical Exemption" and "Days Since Last Exam" > 335 and "Days Since Last Exam" <= 365
define "Overdue": "In HAZWOPER Program" and not "Has Medical Exemption" and "Days Since Last Exam" > 365
define "Missing Data": "In HAZWOPER Program" and not "Has Medical Exemption" and "Most Recent Surveillance Exam Date" is null
define "Excluded": "Has Medical Exemption"

define "Initial Population": "In HAZWOPER Program" or "Has Medical Exemption"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Missing Data" then 'MISSING_DATA'
  else if "Overdue" then 'OVERDUE'
  else if "Due Soon" then 'DUE_SOON'
  else if "Compliant" then 'COMPLIANT'
  else 'MISSING_DATA'
