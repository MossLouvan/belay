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

  # The protocol is the same Rust the host was tested against, built for iOS.
  # Reimplementing it in Swift would mean two implementations that must agree
  # byte-for-byte forever, and they would not.
  #
  # An XCFramework rather than a fat .a on purpose: a lipo archive cannot hold
  # an arm64 device slice AND an arm64 simulator slice, so on an Apple-silicon
  # Mac the simulator build picks up the device slice and fails to link with a
  # platform mismatch. An XCFramework keeps them apart and lets Xcode choose.
  #
  # Produced by scripts/build-ios-client.sh, which must be run on a Mac before
  # this will link.
  s.vendored_frameworks = 'lib/BelayClient.xcframework'

  # Swift only. The C header is NOT a source file: it is declared by
  # include/module.modulemap and imported as `BelayClientFFI`. Compiling it
  # here as well would give the same header two module definitions.
  s.source_files   = '*.swift'
  s.preserve_paths = 'include/**/*', 'lib/**/*'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/include"',
    'SWIFT_INCLUDE_PATHS' => '"$(PODS_TARGET_SRCROOT)/include"',
  }
end
