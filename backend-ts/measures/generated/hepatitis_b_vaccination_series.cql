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

define "Heplisav-B Dose Dates":
  [Immunization] I
    where I.status = 'completed'
      and exists(I.vaccineCode.coding C where C.system = 'urn:workwell:vs:hepb-vaccines' and (C.code = '189'))
    return (I.occurrence as FHIR.dateTime)

define "Heplisav-B Complete":
  exists(from "Heplisav-B Dose Dates" d0, "Heplisav-B Dose Dates" d1
    where d0 < d1
      and difference in days between d0 and d1 >= 28)

define "Traditional Dose Dates":
  [Immunization] I
    where I.status = 'completed'
      and exists(I.vaccineCode.coding C where C.system = 'urn:workwell:vs:hepb-vaccines' and (C.code = '08' or C.code = '43' or C.code = '44' or C.code = '45'))
    return (I.occurrence as FHIR.dateTime)

define "Traditional Complete":
  exists(from "Traditional Dose Dates" d0, "Traditional Dose Dates" d1, "Traditional Dose Dates" d2
    where d0 < d1 and d1 < d2
      and difference in days between d0 and d1 >= 28
      and difference in days between d1 and d2 >= 56)

define "Dose Count":
  Count([Immunization] I
    where I.status = 'completed'
      and exists(I.vaccineCode.coding C where C.system = 'urn:workwell:vs:hepb-vaccines' and (C.code = '189' or C.code = '08' or C.code = '43' or C.code = '44' or C.code = '45')))

define "Series Complete":
  "Enrolled" and not "Has Contraindication" and ("Heplisav-B Complete" or "Traditional Complete")

define "Excluded": "Has Contraindication"

define "Initial Population": "Enrolled" or "Has Contraindication"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Series Complete" then 'COMPLIANT'
  else 'MISSING_DATA'
