# Submit a QRDA Category III to the C2 task and report what ExpectedResultsValidator says, verbatim.
#
# Driven in-process rather than over HTTP: the upload path is a Rails controller with CSRF and a
# turbo-stream response, and what we want measured is the VALIDATOR's verdict, not the form.
require 'json'

path = ARGV[0]
cms_id = ARGV[1]
raise 'usage: c2_submit.rb <qrda3 path> <CMSxxxvNN>' unless path && cms_id

product = Product.where(name: 'WorkWell C2 Calculation Check').first
pt = product.product_tests.find { |t| t.cms_id == cms_id }
task = pt.tasks.detect { |t| t._type == 'C2Task' }
raise "no C2Task for #{cms_id}" unless task

user = User.first
require 'rack/test/uploaded_file'
upload = Rack::Test::UploadedFile.new(path, 'text/xml')
te = task.execute(upload, user)

# TestExecutionJob is enqueued; run it inline so the verdict is available now.
TestExecutionJob.perform_now(te, task)
te.reload

puts "== #{cms_id}: execution #{te.id} state=#{te.state}"
puts "   expected: #{te.expected_results.to_a.map { |h, s| s.map { |k, v| "#{k}=#{v.reject { |kk, _| %w[supplemental_data observations pop_set_hash measure_id].include?(kk) }}" } }.flatten.join(' ')}"
puts "   reported: #{te.reported_results.inspect[0, 400]}"
puts "   errors=#{te.execution_errors.count}"
te.execution_errors.group_by(&:validator).each do |validator, errs|
  puts "   --- #{validator} (#{errs.size})"
  errs.map { |e| "[#{e.validator_type}] #{e.message.to_s.gsub(/\s+/, ' ')[0, 200]}" }.tally.each { |m, n| puts "       #{n}x #{m}" }
end
