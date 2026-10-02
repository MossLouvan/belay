## Why
A 5-agent playtest filed 26 bugs (#67–#92). Each issue has repro steps, screenshots and a likely file:line. Two are safety bugs (#72 pre-expanded "Always allow", #83 forget doesn't revoke); the rest break core panels (terminal dies on tab switch, views collapse to 0px, wrong keys on Mac/Windows).

## What Changes
Fix all 26 at the root cause, one PR per area group (A–F in tasks.md). No new features, no new dependencies, no redesigns.

## Capabilities
- terminal (#87 #88 #89-terminal #90 #91-terminal)
- files (#89-viewer #91-files #92)
- screen (#75 #76 #78 #80)
- agent (#72 #74 #77 #79)
- devices-system (#67 #68 #69 #82 #83 #86)
- a11y-nav (#70 #81 #71 #73 #84 #85)

## Impact
`app/` mostly; `server/src/system.ts` (#67) and possibly `server/src/terminal.ts` (#87). Legacy `tether`/`TETHER_*` shims stay untouched.
