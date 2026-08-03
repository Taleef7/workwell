require 'fileutils'
suffix = ARGV[0] || ''
p = Product.where(name: 'WorkWell C2 Calculation Check').first
p.product_tests.each do |pt|
  dest = "/tmp/#{pt.cms_id}#{suffix}.zip"
  FileUtils.cp(pt.patient_archive.path, dest)
  puts "#{pt.cms_id} -> #{dest} bytes=#{File.size(dest)}"
end
