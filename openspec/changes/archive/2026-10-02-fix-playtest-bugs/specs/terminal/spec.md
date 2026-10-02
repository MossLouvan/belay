## ADDED Requirements
### Requirement: Terminal renders output faithfully
The terminal SHALL render piped-shell output with LF returning to column 0, keep surrogate pairs in one cell, give wide characters two columns, and preserve runs of spaces.
#### Scenario: piped shell cat (#87)
- **WHEN** the host has no pty and the user runs `seq 1 200000 | tail -3`
- **THEN** each number appears whole on its own line
#### Scenario: wide and emoji text (#88)
- **WHEN** a line containing CJK text and emoji wraps
- **THEN** no � glyph appears and no row exceeds `cols`
#### Scenario: indentation (#89)
- **WHEN** output contains leading or repeated spaces
- **THEN** they render at their original widths on web and native

### Requirement: Terminal session outlives the tab
The shell session SHALL persist across bottom-bar tab switches.
#### Scenario: tab round trip (#90)
- **WHEN** the user runs `cd /tmp`, switches to Files and back, and runs `pwd`
- **THEN** it prints `/tmp` and earlier scrollback is still there

### Requirement: Terminal usable in landscape
The app SHALL ensure: terminal usable in landscape.
#### Scenario: 844x390 (#91)
- **WHEN** the terminal is open in a landscape phone viewport
- **THEN** the transcript is at least several rows tall; banners compact or scroll away
