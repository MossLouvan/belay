# files Specification

## Purpose
TBD - created by archiving change fix-playtest-bugs. Update Purpose after archive.

## Requirements

### Requirement: Files show the latest navigation
Only the most recent listDir/readFile request SHALL update the view or history.
#### Scenario: slow folder (#92)
- **WHEN** a slow folder load is overtaken by a newer navigation
- **THEN** the newer location stays and the late response is dropped

### Requirement: Viewer preserves whitespace (#89)
The app SHALL ensure: viewer preserves whitespace.
#### Scenario: No-wrap mode
- **WHEN** a file with indentation is opened with wrap off
- **THEN** indentation and repeated spaces are preserved

### Requirement: Files usable in landscape (#91)
The app SHALL ensure: files usable in landscape.
#### Scenario: 844x390
- **WHEN** Files is open in landscape
- **THEN** the list shows rows and scrolls
