## ADDED Requirements
### Requirement: Screen stage and chrome never collide
The app SHALL ensure: screen stage and chrome never collide.
#### Scenario: small phone portrait (#75)
- **WHEN** the screen is 375x667 with the Keyboard row open
- **THEN** the stage keeps a usable minimum height
#### Scenario: banners in immersive (#76, #78)
- **WHEN** a permission notice shows in landscape or portrait fullscreen
- **THEN** it does not overlap the panel message, the How-to-fix link is tappable, and Exit does not cover the mascot
### Requirement: Controls open from a movable mascot button
The app SHALL ensure: the mascot is a Parsec-style floating button that opens the controls and can be moved.
#### Scenario: tap
- **WHEN** the user taps the mascot while immersive
- **THEN** the control dock appears
#### Scenario: drag
- **WHEN** the user drags the mascot and releases it
- **THEN** it snaps to the nearest side edge within the safe area, sends no input to the host, and keeps that spot next time

### Requirement: Keys match the host platform (#80)
The app SHALL ensure: keys match the host platform.
#### Scenario: Mac host
- **WHEN** the user taps Notify on a Mac host
- **THEN** Notification Center opens (not Cmd+A)
#### Scenario: Windows host
- **WHEN** the host is Windows
- **THEN** Mac-only keys are not offered and gestures never send a bare Mac key
