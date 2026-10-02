# a11y-nav Specification

## Purpose
TBD - created by archiving change fix-playtest-bugs. Update Purpose after archive.

## Requirements

### Requirement: Selected state is announced on web (#70, #81)
The app SHALL ensure: selected state is announced on web.
#### Scenario: tabs and segments
- **WHEN** a bottom tab, Update-rate segment or Screen mode tab is selected
- **THEN** its DOM element has aria-selected="true" and the others "false"

### Requirement: Contrast meets WCAG AA (#71)
The app SHALL ensure: contrast meets WCAG AA.
#### Scenario: themes
- **THEN** textFaint (Current, Fieldwork) and the Fieldwork danger button meet AA

### Requirement: Navigation never dead-ends (#73, #84, #85)
The app SHALL ensure: navigation never dead-ends.
#### Scenario: Screen tab on Computers list
- **WHEN** the user taps Screen there
- **THEN** it navigates
#### Scenario: deep link Go back
- **WHEN** Handoff / What changed was opened by URL and the user taps Go back/Cancel/Done
- **THEN** it navigates to a fallback route
#### Scenario: cold load
- **WHEN** What changed / Handoff loads before the connection is up
- **THEN** it fetches once the connection becomes connected
