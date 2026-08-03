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
# The global count, which still includes the BUNDLE's own precalculated results (7891 for
# bundle-2025) — it is a sanity print, not a check, and naming it one would be a guard that cannot fire.
puts "individual_results after teardown (incl. the bundle's own precalculations): #{CQM::IndividualResult.count}"

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

# `Delayed::Job.count` is GLOBAL, so an unrelated queued job keeps this spinning to the timeout rather
# than failing fast. Preferred over per-job bookkeeping anyway: setup enqueues follow-on work, and a
# loop that stopped at "my two jobs finished" would snapshot a half-built test.
deadline = Time.now + 600
states = []
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

# `errored` is terminal, so the loop above exits on it just as it does on `ready`. Trap 2 (the
# root-owned /app/public/data) errors the test AFTER generating and evaluating patients, and the job log
# still says COMPLETED — so without this the script would print SETUP DONE over a test that has no
# archive, and the snapshot would record `state: errored` that nobody reads.
errored = states.reject { |(_, s)| s == 'ready' }
raise "setup did not complete: #{errored.map { |c, s| "#{c}=#{s}" }.join(' ')}" if errored.any?

puts 'SETUP DONE'
