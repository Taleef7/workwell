library HepatitisBSeries version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

parameter "Measurement Period" Interval<DateTime>
context Patient

define "Enrolled":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:immz-enrollment' and x.code = 'immz-enrolled'))

define "Has Contraindication":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:hepb-contraindication' and x.code = 'hepb-contraindication'))

define "Refused":
  exists([Condition] C
    where exists(C.code.coding x where x.system = 'urn:workwell:vs:hepb-refusal' and x.code = 'hepb-refusal'))

define "Dose Count":
  Count([Immunization] I
    where I.status = 'completed'
      and exists(I.vaccineCode.coding C where C.system = 'urn:workwell:vs:hepb-vaccines' and C.code = 'hepb-vaccine'))

define "Series Complete":
  "Enrolled" and not "Has Contraindication" and "Dose Count" >= 2

define "Excluded": "Has Contraindication"

define "Initial Population": "Enrolled" or "Has Contraindication"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Series Complete" then 'COMPLIANT'
  else 'MISSING_DATA'
