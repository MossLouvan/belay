require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |s|
  s.name = 'BelayGamepad'
  s.version = package['version']
  s.summary = package['description']
  s.license = 'MIT'
  s.author = 'Belay'
  s.homepage = 'https://github.com/MossLouvan/belay'
  s.platforms = { :ios => '15.1' }
  s.source = { git: 'https://github.com/MossLouvan/belay' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'GameController', 'CoreHaptics', 'UIKit', 'QuartzCore'
  s.swift_version = '5.0'
end
