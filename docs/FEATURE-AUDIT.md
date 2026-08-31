# Feature Audit — the full session list, verified against the code

*Audited 2026-08-31 against a moving tree: the audit began at `96aca2a` and three commits
landed while it ran (`630c9a2` tool results + transcript resume, `695cdb1` desktop modifier
map, `dbfe5df` the "what changed" view). Every verdict below is against the newest state
found on disk, including the still-uncommitted terminal "Type" work. Nothing was trusted
from commit messages or agent claims; every DONE was traced from the pure logic to the
mounted control a user can reach. Verdicts: **DONE / PARTIAL / MISSING**; PARTIAL states
exactly what is absent.*

**Test reality at audit time:** `app` typecheck clean, **365/365** tests pass (including the
uncommitted primed-terminal tests); `server` typecheck clean, **320/320** pass; `desktop`
**58/58** pass. Zero failures anywhere, dirty tree included.

---

## 1. The table

| # | Feature | Status | Evidence |
|---|---|---|---|
| 1 | Copy current folder path | **DONE** | Visible `Copy path` TrackLabel in the path bar, flips to ✓/✗ — `app/src/files/path-bar.tsx:132-141`, wired at `app/app/(tabs)/files.tsx:292-302`; per-file copy in the `⋯` info panel too (`app/src/files/info-card.tsx:49-55`) |
| 2 | Paste a path and navigate | **DONE** | `Go to…` header control (`files.tsx:245-251`) → sheet with explicit **Paste** button and Go (`app/src/files/go-to-sheet.tsx:65-92`); host rejection keeps the sheet open with the verbatim message |
| 3 | Finder-like Files tab | **PARTIAL** | Breadcrumbs (`path-bar.tsx:90-127`), back/forward/up history (`app/src/files/history.ts`), sortable Name/Kind/Size/Date with flip (`sort-header.tsx:25-88`), kind strings (`files-format.ts:100-125`), folders-first on both ends (`files-format.ts:151`, `server/src/files.ts:227-230`), details panel via visible `⋯` (`files-row.tsx:98-119`). **Absent: a Kind column** — rows show only name/size/date, so you can sort by Kind but never see it in the list (deliberate trade-off documented at `sort-header.tsx:1-16`) |
| 4 | Open images incl. heic/svg | **DONE** | `viewerKindOf` covers png/jpg/gif/webp/heic/bmp/svg (`files-format.ts:185,201-209`); server MIME table has heic + svg (`server/src/files-raw.ts:46-56`); zoomable native viewer, SVG in a JS-disabled WebView (`app/src/files/image-view.tsx`). Caveats: HEIC fails with an honest message on non-Safari web; ico/tiff fall through to the binary net |
| 5 | Open PDFs | **DONE** | iPhone: WKWebView with auth header (`app/src/files/pdf-view.tsx:44`); web: authed fetch → blob → iframe (`pdf-view.web.tsx:26-72`); dispatch at `files-viewer.tsx:233` |
| 6 | Markdown fancy/raw toggle, remembered | **DONE** | `Rendered/Source` SegmentedControl (`files-viewer.tsx:154-163`); persisted in AsyncStorage `tether.filesMarkdownMode` (`app/src/files/markdown-mode-store.ts:10-24`), loaded on open |
| 7 | Binaries described, not mojibake | **DONE** | Extension net: "No preview for this file type · ZIP archive · 4.2 MB" + "Show as text anyway" (`files-viewer.tsx:179-209`); second net `looksBinary` for extensionless files (`files-format.ts:245-259`) |
| 8 | New project from the picker | **DONE** | `+ New project` TrackLabel + empty-state button (`session-list.tsx:435-441,476`) → sheet → `POST /agent/projects` (`server/src/index.ts:529-538`, confined mkdir in `projects.ts:100-118`); default parent ranked from known projects (`new-project.ts:99-114`). Nit: server's `defaultParent` field is sent but never read by the client |
| 9 | Approval window longer + configurable | **DONE** | 30 min default (`server/src/agent.ts:35`), `TETHER_APPROVAL_TIMEOUT_MS` env (0 = forever, floored at 60s; `agent.ts:48-54`); expiry is no longer silent — feed error line + `permission-clear` + deny message saying it was absence not refusal (`expireApproval`, `agent.ts:479-492`); live countdown on the phone. Nit: env var documented nowhere |
| 10 | Badge + cross-tab banner, inline answer | **DONE** | Banner mounted outside `<Tabs>` so it overlays every tab (`app/app/(tabs)/_layout.tsx:280`); accent `tabBarBadge` count (`:263-275`); real Deny/Allow in the banner → `POST /agent/sessions/:id/approve` (`needs-you-banner.tsx:105-123`). Nits: no "Always" from the banner; absolute-positioned over other tabs' scroll content |
| 11 | Live session-list statuses | **DONE** | Ref-counted 3s poll, paused on background (`attention-store.ts:91-126`), consumed by the list (`session-list.tsx:39`), freshness stamp shown (`:144-146`) |
| 12 | Tool results in the feed, expandable | **DONE** (landed as `630c9a2` mid-audit) | Server emits `tool-result` events capped at 2000 chars (`server/src/agent-events.ts:81-96`); client pairs by `callId` (`feed-model.ts:26-46`) and renders a `▸ output · N lines` expand/collapse toggle with failure ink (`feed.tsx:21-63`) |
| 13 | Transcript history on resume | **DONE** (same commit) | `loadClaudeHistory` scans `~/.claude/projects/*/<uuid>.jsonl` (`server/src/transcript.ts:93-113`), replayed into the feed on attach (`agent.ts:356-363`) with an honest found/not-found line. Caveat: replay happens at attach time only; `docs/AGENT.md:68` still claims the opposite (stale) |
| 14 | On-device speech, whisper gone | **PARTIAL** | Implementation done: `expo-speech-recognition` with `requiresOnDeviceRecognition` (`app/src/agent/mic.tsx:140-150`), hold-to-talk (`:237-239`); no server transcribe/dictate route, no whisper dep, no boot-banner nag. **Absent: the docs cleanup** — `docs/AGENT.md:73-79` still documents a Screen-tab dictation "transcribed on the PC" that no longer exists; `.gitignore:45,50` still carries `server/whisper/`; `docs/PRODUCT-REVIEW.md` still describes the old split |
| 15 | One-finger SCROLL mode | **DONE** | Third `PointerMode` (`scroll-mode.ts:18`), visible three-way Touch/Pad/Scroll radio in the dock (`dock.tsx:139-175`), classify → wheel → momentum (`viewport.ts:467-492,583-584`) |
| 16 | Scroll sensitivity raised (both paths) | **DONE** | `scrollGain: 1.6` + throttle 60→45ms (`model.ts:79-91`); applied at the single shared emit point so one-finger, two-finger and momentum all get it (`scroll-mode.ts:36`, `viewport.ts:319-334`) |
| 17 | Three-finger swipes → spaces / Mission Control | **DONE** | `detectSwipe` (`swipe.ts:41-47`) → Ctrl+←/→ + Ctrl+↑ on Mac (via `rawctrl` so the host's Ctrl remap can't eat it, `server/src/keys.ts:100`), Win+Ctrl+←/→ + Win+Tab on Windows (`model.ts:210-212`); fires once per trio; key-bar page 5 is the visible twin |
| 18 | Pinch-zoom pans | **DONE** (`753383d`) | `zoomAbout` identity fix + per-frame centroid translate (`pinch.ts:53-77`, `viewport.ts:444-451`); two-finger drag while zoomed pans instead of scrolling (`pinch.ts:93-99`) |
| 19 | Key-bar shortcuts, platform-aware | **DONE** | Snip ⌘⇧4/Win+Shift+S, Shot ⌘⇧3/Win+PrtSc, Ctrl+T/W/S/F, Search, Quit, Lock — all in `model.ts:180-207`, labels and mods resolved from the **remote host's** OS (`modsFor/labelFor/keyFor`, `model.ts:216-224`; `screen.tsx:150,230-243`) |
| 20 | Tab completion via the real shell | **DONE** (`965b8e7`) | The server "dances": widens the pty, writes `text\t`, captures the echo, restores the empty line (`server/src/terminal-complete.ts:135-181`); client parses line/candidates/none/unreadable (`app/src/terminal/complete.ts:279-331`) and shows a candidate row with `+N MORE` (`candidate-row.tsx:23-55`). Nit: a `busy` reply is silently dropped (`terminal.tsx` `handleCompletion`) |
| 21 | Visible TAB control | **DONE** | `tab` cap in the always-visible primary key row (`terminal-keymap.ts:17`, `terminal-keys.tsx:129-131`); unmodified press runs the completion dance, Ctrl/Alt-modified falls through raw |
| 22 | Send without executing (prime the line) | **DONE — uncommitted** | In the working tree: a **Type** button (`testID term-type`) sends exactly the field's text with no return; **Run** beside it sends text+return, or just return when empty (`app/app/(tabs)/terminal.tsx`, `typeInput`/`runInput`); a "primed" ledger (`app/src/terminal/primed.ts`) stops the completion dance corrupting a primed line — tab then flushes and passes through raw. Tests in `primed.test.mjs`; typecheck + all 365 app tests pass on this tree. It is real, but not yet committed |
| 23 | No impossible 6-digit code ask | **DONE** | Dead end detected from `/health` `paired`/`pairing` (`app/src/connect/dead-end.ts:51-79`); the phone offers a Tailscale route and the honest reset command per platform (`no-code-step.tsx`); code entry survives, demoted and re-captioned (`pair-step.tsx:90-92`) |
| 24 | Codeless Tailscale pairing, no 100.x typing | **DONE** | Host trusts CGNAT/ULA source **plus** `tailscale whois` same-login (`server/src/tailnet.ts:131-136`) → token with no code (`index.ts:217-231`); phone auto-upgrades to the host-advertised tailnet address with retries (`app/app/index.tsx:268-306`); MagicDNS first-class; QR pair-link races every address |
| 25 | iOS ATS unblocked | **DONE** | `NSAllowsArbitraryLoads: true` (`app/app.json:17-18`, propagated to `app/ios/Tether/Info.plist:43-45`). Note: the blunt instrument, not per-domain exceptions — defensible given plain-HTTP hosts on arbitrary IPs |
| 26 | See/switch computer from inside the tabs | **PARTIAL** | `SwitchComputerLink` (dot + tappable summary → `/devices`; `app/src/devices/switch-link.tsx:26-50`) mounted on Screen, Terminal, Files and System headers. **Absent from the Agent tab** — `app/app/(tabs)/agent.tsx` has no header and no mount, so the one tab where "which machine is Claude on?" matters most can't answer it |
| 27 | Multiple computers saved + switchable | **DONE** | `DeviceStore` with upsert/setActive/remove/rename (`app/src/devices/model.ts`), AsyncStorage + tokens in the OS keychain (`storage.ts:24-39`), legacy migration, per-device Mac/Windows labels + reachability dots (`devices.tsx:27-31,152-178`), address racing on switch (`connection.tsx:148-193`) |
| 28 | Desktop client drives another machine | **DONE** | Functional, not scaffolding: display + frameless seamless windows (`desktop/main.js:56-126`), ticketed WebSocket stream painting frames (`renderer/display.js:191-234`), full input send (move/drag/click/scroll/text/key), pairing from the desktop, sandboxed renderers, token stored 0600 |
| 29 | Cross-platform modifier mapping | **DONE** (landed as `695cdb1` mid-audit) | Mac→Windows remap: ⌘→Ctrl, **⌥→Win**, ⌃→Alt (`desktop/src/modmap.js:76-81`); mirror for Windows→Mac using unambiguous `rawctrl`/`cmd`; bare-⌥ tap opens Start (`:104-107`); ⌥-composes recovered from `event.code`; visible legend "⌘ sends Ctrl · ⌥ sends Win · ⌃ sends Alt" (`:125-137`); wired into all three renderers, toggleable, persisted; 153-line test file passes |
| 30 | Desktop shares the mobile theme | **MISSING** | Owner's belief is correct. `desktop/renderer/style.css:3-12` is its own dark-only blue-black palette with the blue accent `#6ea8fe` and **rounded-card rows** — the exact identity `app/src/theme.ts:5` says the mobile app killed ("A single orange accent replaced the old blue identity, and the card died"). No shared tokens, no light mode, no Ledger anything; `main.js` hardcodes `#101014` besides |
| 31 | One consistent design system | **DONE** | Zero gradients; shadows structurally impossible (`FLAT_ELEVATION`, `theme.ts:309-348`); `Card` is a deprecated shim with zero call sites; one burnt-orange accent in three contrast roles; every screen imports `app/src/ui/`; the only off-theme hexes are the ANSI table and a justified HUD ink pair |
| 32 | Track rule (interactive vs inert text) | **PARTIAL** | `track.ts`/`TrackLabel` built, tested, adopted across every P1/P2 findability finding (dock, roots, sort header, COPY, ghost buttons, picker). **Absent: two stragglers** — `"Show full input ▾"` in the **approval card** is still a bare tappable Label (`session-view.tsx:238`), and the connect screen's "Away from home" disclosure row (`onboarding.tsx:75-91`) |
| 33 | Visible keyboard dismiss everywhere | **PARTIAL** | Fixed well on Terminal (`⌄ hide` key, `terminal-keys.tsx:163-174`), Screen TYPE row (trailing `×`), Files (interactive drag-dismiss), sheets, and the shared `Screen` scroller. **Absent on the Agent composer** — multiline (no Done key), Send disabled when empty or while the session runs, feed has no `keyboardDismissMode`, blur only fires after a *successful* send: the one surface with **neither** route, i.e. the day-one trap reborn on the owner's main tab. Connect screen and project picker also lack drag-dismiss (they at least have `returnKeyType="go"`) |
| 34 | Empty/error states name-observe-offer | **DONE** | `EmptyState`/`Banner` enforce title+observation+action (`feedback.tsx:254-282`), 39 call sites; best-in-class Screen `panelCopyFor` maps observed facts to distinct copy with a proof line (`panel-state.tsx:44-80`); Files errors distinguish host-refused vs unreadable with Retry |
| 35 | One-tap open of a session on the computer | **MISSING** | Confirmed never built. No endpoint spawns anything; no osascript/`open -a`/Terminal.app anywhere in `server/` or `desktop/`. The nearest thing is manual: `npm run sessions` prints paste-ready `cd … && claude --resume <id>` lines at the keyboard (`docs/AGENT.md:70-71`, `server/scripts/list-sessions.mjs`) |
| 36 | Rendered diffs in the approval card | **MISSING** | The approval card shows tool name + detail + raw JSON input only (`session-view.tsx`, approval block) — an Edit is indistinguishable from a Bash. Diff rendering exists (`app/src/changes/diff-body.tsx`) but only the post-hoc `/changes` screen uses it, and nothing in the approval path can produce a diff for a not-yet-applied edit |
| 37 | Queue / steer a prompt while running | **MISSING** | Blocked on both ends: client `canPrompt` false while running/waiting (`model.ts:180-182`, Send disabled), server `sendPrompt` throws "session is busy" (`agent.ts:400`). No queue structure exists |
| 38 | Scoped approvals | **MISSING** | `autoAllow` is a `Set<string>` of bare tool names (`agent.ts:87,437,500`); the wire carries only `{approvalId, allow, always}`. One tap on "Always Bash" still whitelists every future command for the session; no command/folder dimension anywhere |
| 39 | Background notifications | **MISSING** | Confirmed doc-only: no expo-notifications/APNs/local-notification code anywhere in `app/`; `attention-store.ts:17-23` admits it in a comment; the four-option menu lives at `docs/PRODUCT-REVIEW.md:394-404`. Foreground 3s poll + badge + banner is all that exists |
| 40 | "What changed" plain-English view | **DONE** (landed as `dbfe5df` mid-audit) | Reachable: a **Changes** TrackLabel in the session header (`session-view.tsx:115-130`) → `/changes` screen with cautions-before-headline ordering (`app/app/changes.tsx`) → `GET /agent/sessions/:id/changes` (`server/src/index.ts:578-584`); `collectChanges` is read-only fixed-argv git, `summarizeChanges` bans git vocabulary; both ends tested |

**Tally: 29 DONE · 5 PARTIAL (3, 14, 26, 32, 33) · 6 MISSING (30, 35, 36, 37, 38, 39).**
(Item 22 counted DONE but is uncommitted; item 40 and 29 landed as commits while this audit ran.)

---

## 2. Everything not DONE, ranked by how much the owner seemed to care

1. **#39 Background notifications — MISSING.** The product review calls the app "deaf when
   it isn't open" and rates it the number-one failure. The 30-minute approval window (#9)
   and the banner (#10) soften it, but the differentiator — "pings you when it needs a
   decision" — still does not exist. Only the options write-up exists.
2. **#36 Diffs in the approval card — MISSING.** You are still asked to approve edits you
   cannot see. All the rendering machinery now exists in `app/src/changes/` — the gap is
   producing a diff for a *pending* edit and mounting `DiffBody` in the card.
3. **#38 Scoped approvals — MISSING.** "Always Bash" remains a blanket session-wide grant.
4. **#37 Queue/steer a prompt — MISSING.** While Claude works, the phone can only watch or kill.
5. **#30 Desktop theme — MISSING (as the owner predicted).** The desktop client is
   functionally strong and visually a different, older app: blue accent, cards, dark-only.
6. **#33 Keyboard dismiss — PARTIAL.** The fix shipped on Screen/Terminal/Files and
   *missed the Agent composer*, which now has neither drag-dismiss nor a visible control
   and a Send button that is often disabled — the exact trap the owner reported on day one,
   surviving on the tab he uses most.
7. **#35 One-tap open on the computer — MISSING.** Never built; only the manual
   `npm run sessions` list exists.
8. **#26 Switch-computer link — PARTIAL.** On four tabs; absent from the Agent tab.
9. **#32 Track rule — PARTIAL.** Two stragglers, one of them ("Show full input ▾") inside
   the approval card.
10. **#14 Whisper removal — PARTIAL.** Code fully migrated; `docs/AGENT.md` still sells a
    Screen-tab dictation feature that no longer exists, and `.gitignore` still reserves
    `server/whisper/`.
11. **#3 Finder parity — PARTIAL.** No Kind column in the list; you can sort by a value
    you cannot see. Deliberate, documented, but it is the one visible gap from "look like
    Finder".

---

## 3. Built but unreachable, stale, or quietly broken

**Host features no client can reach (the product review's list, re-checked today):**
- **Device revocation — still phone-unreachable.** `POST /devices/revoke` exists and works
  (`server/src/index.ts:500-509`, even closes the revoked device's live sockets), and
  `api.revokeDevice` is still written and still uncalled; the System tab still says
  "Revoke a device from the Tether window on the computer itself"
  (`app/src/system/sections.tsx:91`). Unchanged since the review.
- **Window list/focus — now half-reachable.** `GET /windows` + `POST /windows/focus` are
  finally consumed — but only by the desktop client's seamless windows
  (`desktop/renderer/seamless.js:86`). The phone's Screen tab still has no window picker.
- **Dictation — resolved by deletion.** The `/dictate` route is gone from the server; the
  remaining problem is the stale docs (item 14).

**Stale or missing documentation that will actively mislead:**
- `docs/AGENT.md:68` says resumed sessions do **not** replay history — false since `630c9a2`.
- `docs/AGENT.md:73-79` documents Screen-tab dictation that no longer exists anywhere.
- `TETHER_APPROVAL_TIMEOUT_MS` is documented only in source comments.
- `docs/PRODUCT-REVIEW.md` still describes the 5-minute silent deny and the whisper split
  as live (both fixed) — fine for a dated review, but nothing marks them resolved.

**Small genuine defects found while verifying:**
- Terminal completion: a `busy` reply from the server is silently swallowed — the user
  presses Tab and nothing at all happens (`app/app/(tabs)/terminal.tsx`, `handleCompletion`).
- `POST /agent/projects`' sibling `GET` sends a `defaultParent` the client's type strips —
  dead field, the host's opinion of the default location is never used (`app/src/api.ts:379`).
- The Needs-You banner is absolutely positioned with no content-padding compensation, so it
  overlays the bottom of other tabs' scroll content while an approval waits.
- `ico`/`tiff` files fall into the text branch and are then caught by the binary heuristic —
  they get the honest fallback rather than a viewer, slightly worse than the other formats.
- HEIC previews fail (with an honest message) on non-Safari web browsers.
- `toggledMarkdownMode` is imported but unused in `files-viewer.tsx` — dead import.
- Playwright e2e coverage of the Files tab exercises almost none of the new features
  (`tests/specs/tether.spec.ts:133-141`); everything new leans on unit tests only.

**In-flight at time of writing:** item 22 (terminal Type/prime) is implemented, tested and
green but **uncommitted** — `app/src/terminal/primed.ts`, `primed.test.mjs`, and edits to
`terminal.tsx`/`help-sheet.tsx` sit in the working tree. If that agent's work is lost,
item 22 reverts to MISSING.
