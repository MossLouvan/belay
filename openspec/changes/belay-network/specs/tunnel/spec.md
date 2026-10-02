## ADDED Requirements
### Requirement: Reach the computer anywhere
The app SHALL connect to a linked computer from any network, directly when possible and through a relay otherwise, with all features working.
#### Scenario: phone on cellular
- **WHEN** the phone is on cellular and the computer is behind home NAT
- **THEN** Screen, Terminal, Files, Agent and System all work
### Requirement: Only the account's phones get in
The host sidecar SHALL accept tunnel connections only from phone node IDs registered to the same account.
#### Scenario: stranger
- **WHEN** an unknown node dials the host
- **THEN** the connection is refused before any byte reaches the host
### Requirement: No loopback trust through the tunnel
The host SHALL treat tunneled requests as remote, never as loopback.
#### Scenario: plain HTTP through tunnel
- **WHEN** a tunneled request uses plain HTTP or the pairing route
- **THEN** it gets the same refusal a LAN client would
