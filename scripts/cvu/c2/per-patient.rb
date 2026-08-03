# Per-PATIENT expected results, keyed by the identifier that survives the archive's duplication.
#
# The aggregate `expected_results` say only that N patients differ; this says WHICH, which is the
# difference between "our exclusions under-fire" and a diagnosis.
#
# NOTE: run this against the SAME rebuild the archive came from. Cypress regenerates the
# `medicare_beneficiary_identifier` on every setup run — measured: joining pass A's documents to pass B's
# rows matched 4 of 64 (only the MBI-less patients, whose key is name+birth). The aggregate expected
# results are pass-invariant; these per-patient rows are not.
require 'json'

out_path = ARGV[0] || '/tmp/per-patient.json'
out = {}
p = Product.where(name: 'WorkWell C2 Calculation Check').first
p.product_tests.sort_by(&:cms_id).each do |pt|
  rows = {}
  pt.patients.each do |patient|
    ir = CQM::IndividualResult.where(correlation_id: pt.id.to_s, patient_id: patient.id).to_a
    # The unstratified set, selected on `population_set_key` — the field that actually carries it.
    # A first cut keyed on `r['stratification'].nil?`, which is nil on EVERY row (the field does not
    # exist), so for CMS125 it picked whichever of the patient's two rows Mongo returned first: the
    # unstratified one or their own stratum. Both carry IPP=1, so a mixed selection can still sum to the
    # right aggregate and read as correct. Asserted rather than defaulted for the same reason.
    unstratified = ir.select { |r| r['population_set_key'].to_s == 'PopulationSet_1' }
    raise "#{pt.cms_id}: expected exactly 1 PopulationSet_1 result for #{patient.id}, got #{unstratified.size}" if unstratified.size != 1

    base = unstratified.first

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
File.write(out_path, JSON.pretty_generate(out))
puts "wrote #{out_path}"
