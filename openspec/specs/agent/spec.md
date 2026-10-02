# agent Specification

## Purpose
TBD - created by archiving change fix-playtest-bugs. Update Purpose after archive.

## Requirements

### Requirement: Each approval starts collapsed (#72)
The app SHALL ensure: each approval starts collapsed.
#### Scenario: next queued ask
- **WHEN** an approval resolves and the next queued ask is promoted
- **THEN** its "Always allow" options and hold state start collapsed/reset

### Requirement: Agent failures are visible and retryable (#74, #79)
The app SHALL ensure: agent failures are visible and retryable.
#### Scenario: sessions fetch fails
- **WHEN** `/agent/sessions` fails
- **THEN** an error with Retry shows instead of skeletons
#### Scenario: project scan fails
- **WHEN** the project scan fails
- **THEN** an error with Retry shows instead of "No git repositories were found"

### Requirement: Composer grows on web (#77)
The app SHALL ensure: composer grows on web.
#### Scenario: long draft
- **WHEN** the user types several lines
- **THEN** the composer grows up to its max height and no line is clipped
