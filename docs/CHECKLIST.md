# Implementation checklist

Status of every capability. The spec you pasted with `/goal` did not survive as
text (it arrived as an unrecoverable `[Pasted text #2]` placeholder), so this
checklist tracks the agreed feature set: a private repo, a downloadable
React-Native iOS app, a self-hosted "your PC as a server" control layer with a
clean UI, verified end-to-end with vision and Playwright. If your original spec
had items not listed here, send it and they'll be added.

## Core product

- [x] Self-hosted host agent — your PC is the server, no third-party relay
- [x] React Native (Expo) app, one codebase for iOS and web
- [x] Clean, consistent dark UI across every screen
- [x] Pair once with a 6-digit code, then a saved token (no re-pairing)
- [x] Pairing code auto-refreshes on the PC so it never goes stale
- [x] Works on the same Wi-Fi; Tailscale documented for anywhere access

## Screen control ("your own Parsec", v1)

- [x] Live screen streaming to the phone (JPEG over WebSocket)
- [x] Self-pacing frame loop (slow link lowers fps instead of lagging)
- [x] Cursor composited into the stream
- [x] Tap to click (normalized 0..1 coords, DPI- and multi-monitor-correct)
- [x] Drag to drag
- [x] Right-click toggle
- [x] On-screen key bar (Esc, Tab, Enter, Bksp, Ctrl+C/V, Win, arrows)
- [x] Send arbitrary typed text (Unicode)
- [x] Live fps / connection indicator
- [ ] Hardware-encoded 60fps video (WebRTC + NVENC) — roadmap, see ARCHITECTURE

## Terminal

- [x] Interactive shell over WebSocket
- [x] Real ConPTY via node-pty, with a piped-shell fallback
- [x] Command input + Run, quick keys (Ctrl+C, Tab, Enter, arrows, clear)
- [x] ANSI stripped for a clean scrollback; scrollback capped

## Files

- [x] Browse the PC's folders from the phone
- [x] Root shortcuts (Home, Desktop, Documents, Downloads)
- [x] Up navigation + current path display
- [x] Open and read text files in a viewer
- [x] Confined to allow-listed roots, traversal-safe, read-only

## System

- [x] Live CPU, memory, disk, uptime, OS
- [x] Pull-to-refresh
- [x] Disconnect / revoke this device

## Security

- [x] Single-use, expiring pairing codes
- [x] 256-bit tokens, constant-time comparison, revocable
- [x] Token required on every route and WebSocket
- [x] File API path confinement
- [x] Native input helper is a locally-compiled binary (documented AV note)

## Verification

- [x] Server smoke-tested live (pairing, stats, capture, files) on this PC
- [x] App runs on web (react-native-web) and in Expo Go on iOS
- [x] Playwright suite — every button on every screen — passing (5/5)
- [x] Vision review of all six screens; Files layout bug found and fixed
- [x] TypeScript typechecks clean (server and app)

## Distribution

- [x] Private GitHub repo
- [x] Expo Go path (use today, no Apple account)
- [x] EAS build config (`eas.json`) for TestFlight / installable IPA
- [x] iOS bundle id set (`com.mosslouvan.tether`)
- [x] Setup, iOS, and architecture docs

## Not done / needs you

- [ ] Push to GitHub requires `gh auth login` (one-time, interactive) — see README
- [ ] TestFlight build requires your Apple Developer account
