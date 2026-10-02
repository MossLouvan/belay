## ADDED Requirements
### Requirement: Keep running with the lid closed
The host SHALL keep the computer awake with the lid closed while lid-closed mode is on and a phone is streaming.
#### Scenario: Mac lid closed during stream
- **WHEN** the mode is on, a phone is streaming, and the lid closes
- **THEN** the Mac stays awake and the phone keeps streaming a virtual display at its resolution
#### Scenario: Windows lid closed during stream
- **WHEN** the same happens on a Windows laptop
- **THEN** the lid action does nothing until release, then the saved action is restored

### Requirement: Safe release
The host SHALL restore normal sleep when the mode turns off, after 30 minutes without a stream, at 20% battery on battery power, and on host start or exit.
#### Scenario: battery cutoff
- **WHEN** on battery and the level reaches 20%
- **THEN** keep-awake is released and the phone shows a plug-in warning
#### Scenario: crash recovery
- **WHEN** the host starts and the mode is not armed
- **THEN** it forces normal sleep back on

### Requirement: Minimal privilege
The macOS host SHALL gain root only for the two exact pmset commands, via a validated sudoers file installed after one admin prompt.
#### Scenario: prompt cancelled
- **WHEN** the user cancels the admin prompt
- **THEN** the mode stays off and the phone says why

### Requirement: Virtual display is standard
The app SHALL offer the virtual display without any experimental flag, degrading with a clear message when the driver or elevation is missing.
#### Scenario: Windows without driver
- **WHEN** a Windows host lacks the signed driver
- **THEN** the phone explains that the virtual display isn't available on this computer yet
