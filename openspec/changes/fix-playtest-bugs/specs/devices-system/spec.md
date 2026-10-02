## ADDED Requirements
### Requirement: Memory reading is truthful on macOS (#67)
The app SHALL ensure: memory reading is truthful on macOS.
#### Scenario: idle Mac
- **WHEN** macOS reports most memory free or cached
- **THEN** the card shows active+wired+compressed as used, not ~100%
### Requirement: This phone is recognised (#68)
The app SHALL ensure: this phone is recognised.
#### Scenario: paired devices list
- **WHEN** the list loads
- **THEN** the row whose tokenPrefix equals sha256(ownToken) prefix is marked "this phone"
### Requirement: Lost contact is shown in place (#69)
The app SHALL ensure: lost contact is shown in place.
#### Scenario: host goes away while on System
- **THEN** System shows its Lost contact state rather than stale data or ejection
### Requirement: Forget revokes (#83)
The app SHALL ensure: forget revokes.
#### Scenario: reachable host
- **WHEN** the user forgets a reachable computer
- **THEN** the host revokes this phone's token before local removal; labels are not clipped
#### Scenario: unreachable host
- **THEN** the computer is still forgotten locally
### Requirement: Add flow and connect errors (#82, #86)
The app SHALL ensure: add flow and connect errors.
#### Scenario: typed/scan add
- **WHEN** the user picks Type or Scan in Add computer
- **THEN** the sheet closes before navigating
#### Scenario: non-Belay server
- **WHEN** an address returns 200 non-JSON
- **THEN** the message says it isn't Belay, without the raw parser error
