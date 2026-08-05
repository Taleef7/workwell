library TetanusBooster version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers
context Patient

define "Initial Population":
  AgeInYears() >= 18

define "Has Recent Booster":
  exists (
    [Immunization] I
      where I.status = 'completed'
        and I.occurrence as FHIR.dateTime is not null
  )

define "Outcome Status":
  if not "Initial Population" then 'MISSING_DATA'
    else if "Has Recent Booster" then 'COMPLIANT'
    else 'OVERDUE'
