## ADDED Requirements
### Requirement: Link a computer by QR
The host SHALL show a claim QR that a signed-in phone scans to link the computer to the account.
#### Scenario: first run
- **WHEN** the host starts unlinked
- **THEN** it shows a QR; scanning it from a signed-in phone links it within seconds, nothing typed on the computer
