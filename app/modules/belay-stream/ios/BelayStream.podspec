require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'BelayStream'
  s.version        = package['version']
  s.summary        = package['description']
  s.license        = 'MIT'
  s.author         = 'Belay'
  s.homepage       = 'https://github.com/MossLouvan/belay'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: 'https://github.com/MossLouvan/belay' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # The protocol is the same Rust the host was tested against, built for iOS as
  # a static library. Reimplementing it in Swift would mean two implementations
  # that must agree byte-for-byte forever, and they would not.
  #
  # Produced by scripts/build-ios-client.sh, which must be run on a Mac before
  # the app will link.
  s.vendored_libraries = 'lib/libbelay_client.a'
  s.source_files = '**/*.{h,swift}'
  s.preserve_paths = 'lib/**/*', 'include/**/*'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/include"',
    'SWIFT_INCLUDE_PATHS' => '"$(PODS_TARGET_SRCROOT)/include"',
  }
end
