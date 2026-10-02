## A. Terminal (agent A)
- [ ] #87 piped shell bare LF returns to column 0
- [ ] #88 surrogate pairs kept whole; wide chars take 2 cols and wrap
- [ ] #89 terminal rows preserve runs of spaces (white-space: pre)
- [ ] #90 terminal session survives tab switches
- [ ] #91 terminal transcript keeps usable height in landscape

## B. Files (agent B)
- [ ] #89 file viewer (No wrap) preserves indentation/spaces
- [ ] #91 file list keeps usable height in landscape
- [ ] #92 stale listDir/readFile responses are ignored

## C. Screen (agent C)
- [ ] #75 portrait stage never collapses below a usable minimum
- [ ] #76 notice banners don't overlap panel message; Controls tab clears them
- [ ] #78 Exit button and mascot button don't overlap
- [ ] #80 platform-correct keys (Notify on Mac, Mac-only keys hidden on Windows)
- [ ] Owner request: Parsec-style controls — the mascot is a draggable floating button (default top-right, snaps to edges, position remembered); tap opens the controls; the separate Controls tab is removed

## D. Agent (agent D)
- [ ] #72 approval card state resets per pending ask (key by id)
- [ ] #74 failed /agent/sessions shows error + retry, not skeletons
- [ ] #77 composer grows with content on web
- [ ] #79 project scan failure shows error + retry, not "no repos"

## E. Devices & System (agent E)
- [ ] #67 macOS memory reading excludes cache/inactive
- [ ] #68 "this phone" marked via hashed-token prefix
- [ ] #69 System "Lost contact" state reachable
- [ ] #82 Add computer sheet closes before navigating
- [ ] #83 Forget revokes token on host (best effort) + button labels not clipped
- [ ] #86 non-Belay 200 response reads "isn't Belay"

## F. A11y, theme & nav (agent F)
- [ ] #70 tab bar + Update rate expose aria-selected on web
- [ ] #81 Screen mode tabs expose aria-selected on web
- [ ] #71 textFaint + Fieldwork danger meet WCAG AA
- [ ] #73 Screen tab in Computers bottom bar navigates
- [ ] #84 Go back works when there is no history (fallback route)
- [ ] #85 What changed / Handoff refetch once connected
