# The full oracle picture, in enough detail that every number can be DERIVED rather than recorded.
#
# Beyond the counts: the measurement period the expected results were computed over, the per-test
# rand_seed that drives archive duplication, and the archive's composition (documents vs distinct
# patient MRNs) — because `archive docs != patients` is the whole C2 duplicate test and reading it as
# noise is how a correct engine gets reported as wrong.
require 'json'
require 'zip'

out_path = ARGV[0] || '/tmp/snapshot.json'

b = Bundle.where(active: true).first
snapshot = {
  'bundle' => {
    'version' => b.version,
    'major_version' => b.major_version,
    'measure_period_start' => Time.at(b.measure_period_start).utc.iso8601,
    'effective_date' => Time.at(b.effective_date).utc.iso8601,
    'measures' => b.measures.count
  },
  'tests' => {}
}

p = Product.where(name: 'WorkWell C2 Calculation Check').first
snapshot['product'] = {
  'duplicate_patients' => p.duplicate_patients,
  'randomize_patients' => p.randomize_patients,
  'shift_patients' => p.shift_patients,
  'measure_period_start' => Time.at(p.measure_period_start).utc.iso8601,
  'effective_date' => Time.at(p.effective_date).utc.iso8601
}

p.product_tests.sort_by(&:cms_id).each do |pt|
  ir = CQM::IndividualResult.where(correlation_id: pt.id.to_s)

  docs = nil
  mrn_counts = nil
  if pt.patient_archive.path && File.exist?(pt.patient_archive.path)
    mrns = []
    Zip::File.open(pt.patient_archive.path) do |z|
      z.entries.select { |e| e.name.end_with?('.xml') }.each do |e|
        xml = e.get_input_stream.read
        # recordTarget/patientRole/id/@extension is the MRN a receiver would dedupe on.
        seg = xml[/<recordTarget>.*?<\/recordTarget>/m].to_s
        mrn = seg[/<id[^>]*extension="([^"]+)"/, 1]
        mrns << (mrn || "NO_MRN:#{e.name}")
      end
    end
    docs = mrns.size
    mrn_counts = mrns.tally
  end

  pops = {}
  sup = {}
  pt.expected_results.to_a.each do |_hqmf, sets|
    sets.each do |set_name, vals|
      pops[set_name] = vals.reject { |k, _| %w[supplemental_data observations pop_set_hash measure_id].include?(k) }
      s = vals['supplemental_data']
      sup[set_name] = s.nil? ? nil : Digest::SHA256.hexdigest(JSON.generate(s))[0, 16]
    end
  end

  snapshot['tests'][pt.cms_id] = {
    'test_id' => pt.id.to_s,
    'hqmf_id' => pt.measure_ids.first,
    'state' => pt.state.to_s,
    'rand_seed' => pt.rand_seed,
    'start_date' => pt.start_date.utc.iso8601,
    'end_date' => pt.end_date.utc.iso8601,
    'patients' => pt.patients.count,
    'individual_results' => ir.count,
    'distinct_patients_in_results' => ir.distinct(:patient_id).size,
    'population_sets_in_results' => ir.distinct(:population_set_key).size,
    'archive_xml_docs' => docs,
    'archive_distinct_mrns' => mrn_counts&.size,
    'archive_repeated_mrns' => mrn_counts&.select { |_, n| n > 1 },
    'expected' => pops,
    'expected_supplemental_sha' => sup
  }
end

File.write(out_path, JSON.pretty_generate(snapshot))
puts JSON.pretty_generate(snapshot)
puts "wrote #{out_path}"
