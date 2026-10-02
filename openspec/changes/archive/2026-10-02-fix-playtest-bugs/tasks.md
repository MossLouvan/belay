## A. Terminal (agent A)
- [x] #87 piped shell bare LF returns to column 0
- [x] #88 surrogate pairs kept whole; wide chars take 2 cols and wrap
- [x] #89 terminal rows preserve runs of spaces (white-space: pre)
- [x] #90 terminal session survives tab switches
- [x] #91 terminal transcript keeps usable height in landscape

## B. Files (agent B)
- [x] #89 file viewer (No wrap) preserves indentation/spaces
- [x] #91 file list keeps usable height in landscape
- [x] #92 stale listDir/readFile responses are ignored

## C. Screen (agent C)
- [x] #75 portrait stage never collapses below a usable minimum
- [x] #76 notice banners don't overlap panel message; Controls tab clears them
- [x] #78 Exit button and mascot button don't overlap
- [x] #80 platform-correct keys (Notify on Mac, Mac-only keys hidden on Windows)
- [x] Owner request: Parsec-style controls — the mascot is a draggable floating button (default top-right, snaps to edges, position remembered); tap opens the controls; the separate Controls tab is removed

## D. Agent (agent D)
- [x] #72 approval card state resets per pending ask (key by id)
- [x] #74 failed /agent/sessions shows error + retry, not skeletons
- [x] #77 composer grows with content on web
- [x] #79 project scan failure shows error + retry, not "no repos"

## E. Devices & System (agent E)
- [x] #67 macOS memory reading excludes cache/inactive
- [x] #68 "this phone" marked via hashed-token prefix
- [x] #69 System "Lost contact" state reachable
- [x] #82 Add computer sheet closes before navigating
- [x] #83 Forget revokes token on host (best effort) + button labels not clipped
- [x] #86 non-Belay 200 response reads "isn't Belay"

## F. A11y, theme & nav (agent F)
- [x] #70 tab bar + Update rate expose aria-selected on web
- [x] #81 Screen mode tabs expose aria-selected on web
- [x] #71 textFaint + Fieldwork danger meet WCAG AA
- [x] #73 Screen tab in Computers bottom bar navigates
- [x] #84 Go back works when there is no history (fallback route)
- [x] #85 What changed / Handoff refetch once connected
