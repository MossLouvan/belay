# latency Specification

## Purpose
TBD - created by archiving change cut-latency. Update Purpose after archive.

## Requirements

### Requirement: Taps are not delayed
The app SHALL send a tap's click immediately; a second tap within the double-tap window SHALL produce a double-click via click state.
#### Scenario: single tap
- **WHEN** the user taps once
- **THEN** the click is sent with no double-tap wait

### Requirement: Mac streams hardware H.264
The Mac host SHALL stream VideoToolbox H.264 over the existing screen socket when the phone supports it, falling back to JPEG.
#### Scenario: iPhone on Mac host
- **WHEN** an iPhone opens the Screen tab on a Mac host
- **THEN** frames are H.264, decoded natively, and never cross the JS thread

### Requirement: No stale-frame queues
Host and phone SHALL drop stale frames instead of queueing them.
#### Scenario: slow link
- **WHEN** the socket is backed up or the JS thread stalls
- **THEN** only the newest frame is captured and shown
