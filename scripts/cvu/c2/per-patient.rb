# Per-PATIENT expected results, keyed by the identifier that survives the archive's duplication.
#
# The aggregate `expected_results` say only that N patients differ; this says WHICH, which is the
# difference between "our exclusions under-fire" and a diagnosis.
require 'json'

out = {}
p = Product.where(name: 'WorkWell C2 Calculation Check').first
p.product_tests.sort_by(&:cms_id).each do |pt|
  rows = {}
  pt.patients.each do |patient|
    ir = CQM::IndividualResult.where(correlation_id: pt.id.to_s, patient_id: patient.id).to_a
    # The unstratified population set — the one the aggregate PopulationSet_1 is computed from.
    base = ir.find { |r| r['stratification'].nil? } || ir.first
    next if base.nil?

    key = patient.medicare_beneficiary_identifier
    if key.blank?
      # Same fallback shape the harness builds from the QRDA document: name + the HL7 birthTime string,
      # so a patient Cypress ships without an MBI is still comparable instead of silently skipped.
      birth = patient.qdmPatient&.birthDatetime
      key = "dem:#{patient.givenNames.join(' ')} #{patient.familyName}|#{birth ? birth.utc.strftime('%Y%m%d%H%M%S') : ''}"
    end
    rows[key] = {
      'name' => "#{patient.givenNames.join(' ')} #{patient.familyName}",
      'mrn' => patient.id.to_s,
      'IPP' => base['IPP'].to_i,
      'DENOM' => base['DENOM'].to_i,
      'NUMER' => base['NUMER'].to_i,
      'DENEX' => base['DENEX'].to_i,
      'DENEXCEP' => base['DENEXCEP'].to_i
    }
  end
  out[pt.cms_id] = rows
  puts "#{pt.cms_id}: #{rows.size} patients"
end
File.write('/tmp/per-patient.json', JSON.pretty_generate(out))
puts 'wrote /tmp/per-patient.json'
