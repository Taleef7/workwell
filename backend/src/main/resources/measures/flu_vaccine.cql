library FluVaccineSeasonal version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

valueset "Influenza Vaccines": 'urn:workwell:vs:flu-vaccines'
valueset "Clinical Facing Roles": 'urn:workwell:vs:clinical-roles'
valueset "Flu Vaccine Exemption": 'urn:workwell:vs:flu-exemption'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "Clinical Facing Employee":
  exists([Condition])

define "Has Valid Exemption":
  Count([Condition]) > 1

define "Flu Vaccine This Season":
  exists([Immunization] I
    where (I.occurrence as FHIR.dateTime) during "Measurement Period")

define "Compliant": "Clinical Facing Employee" and not "Has Valid Exemption" and "Flu Vaccine This Season"
define "Due Soon": "Clinical Facing Employee" and not "Has Valid Exemption" and not "Flu Vaccine This Season"
define "Overdue": false
define "Missing Data": "Clinical Facing Employee" and not "Has Valid Exemption" and not "Flu Vaccine This Season"
define "Excluded": "Has Valid Exemption"

define "Initial Population": "Clinical Facing Employee" or "Has Valid Exemption"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Compliant" then 'COMPLIANT'
  else if "Missing Data" then 'MISSING_DATA'
  else 'MISSING_DATA'
