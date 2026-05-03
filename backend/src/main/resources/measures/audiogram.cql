library AnnualAudiogramCompleted version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

codesystem "LOINC": 'http://loinc.org'

valueset "Audiogram Procedures": 'urn:oid:2.16.840.1.113883.3.464.1003.118.11.1'
valueset "Medical Waiver Conditions": 'urn:workwell:vs:medical-waiver'
valueset "Hearing Conservation Enrollment": 'urn:workwell:vs:hearing-enrollment'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "In Hearing Conservation Program":
  exists([Condition: "Hearing Conservation Enrollment"])

define "Has Active Waiver":
  exists([Condition: "Medical Waiver Conditions"] C where C.clinicalStatus ~ 'active')

define "Recent Audiogram":
  exists([Procedure: "Audiogram Procedures"] P
    where P.performed during "Measurement Period")
