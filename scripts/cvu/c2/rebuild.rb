# Rebuild the C2 product from clean, running setup EXACTLY ONCE per test.
#
# Teardown must delete CQM::IndividualResult explicitly: `reset_product_test_patients` deletes Patients
# but not results, and `ExpectedResultsCalculator` aggregates every result carrying the test's
# correlation_id — so a leftover set double-counts every population (spike §9 trap 3).
#
# MeasureTest's after_create enqueues ProductTestSetupJob.perform_later. So: create, then WAIT for the
# queued job. Never also call perform_now — that runs setup twice.
require 'json'

Vendor.where(name: 'WorkWell Measure Studio').each do |v|
  v.products.each do |prod|
    prod.product_tests.each { |pt| CQM::IndividualResult.where(correlation_id: pt.id.to_s).delete_all }
    prod.destroy
  end
end
# Belt and braces: any result whose correlation_id is not a bundle patient's own precalculation.
puts "individual_results after teardown: #{CQM::IndividualResult.count}"

b = Bundle.where(active: true).first
ms = b.measures.select { |m| m.cms_id.to_s =~ /\ACMS(122|125)v/ }.uniq(&:hqmf_id)
vendor = Vendor.find_or_create_by!(name: 'WorkWell Measure Studio')
product = vendor.products.new(
  name: 'WorkWell C2 Calculation Check', bundle_id: b.id,
  c1_test: false, c2_test: true, c3_test: false, c4_test: false, randomize_patients: false,
  measure_ids: ms.map(&:hqmf_id)
)
product.save!
ms.each { |m| product.product_tests.build({ name: m.title, measure_ids: [m.hqmf_id], cms_id: m.cms_id }, MeasureTest) }
product.save!
puts "CREATED product=#{product.id} tests=#{product.product_tests.count} (setup enqueued by after_create)"

deadline = Time.now + 600
loop do
  product.reload
  states = product.product_tests.map { |pt| [pt.cms_id, pt.state.to_s] }
  pending = states.count { |(_, s)| !%w[ready errored].include?(s) }
  queued = Delayed::Job.count
  puts "  waiting: #{states.map { |c, s| "#{c}=#{s}" }.join(' ')} jobs=#{queued}"
  break if pending.zero? && queued.zero?
  raise 'timed out waiting for ProductTestSetupJob' if Time.now > deadline

  sleep 5
end
puts 'SETUP DONE'
