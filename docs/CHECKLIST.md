# Implementation checklist

Status of every capability. The spec you pasted with `/goal` did not survive as
text (it arrived as an unrecoverable `[Pasted text #2]` placeholder), so this
checklist tracks the agreed feature set: a private repo, a downloadable
React-Native iOS app, a self-hosted "your PC as a server" control layer with a
clean UI, verified end-to-end with vision and Playwright. If your original spec
had items not listed here, send it and they'll be added.

## Core product

- [x] Self-hosted host agent — your computer is the server, no third-party relay
- [x] Windows host support
- [x] macOS host support (shell, disk, files, boot banner, permission guidance)
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
- [x] Real pty via node-pty (ConPTY on Windows, Unix pty on macOS), with a
      piped-shell fallback that also survives node-pty being installed-but-broken
- [x] macOS spawns the user's login shell ($SHELL / zsh) with a sane TERM
- [x] Command input + Run, quick keys (Ctrl+C, Tab, Enter, arrows, clear)
- [x] ANSI stripped for a clean scrollback; scrollback capped

## Files

- [x] Browse the PC's folders from the phone
- [x] Root shortcuts (Home, Desktop, Documents, Downloads; plus /Volumes on macOS)
- [x] Up navigation + current path display
- [x] Open and read text files in a viewer
- [x] Confined to allow-listed roots, traversal-safe, read-only
- [x] Symlink-safe: paths are realpath'd before the allow-list check, so a link
      inside an allowed folder cannot escape it (fixed; see ARCHITECTURE)

## System

- [x] Live CPU, memory, disk, uptime, OS
- [x] Real disk figures on macOS (`df -kP` on the APFS data volume)
- [x] Friendly OS name (`osName`, e.g. "macOS 26.3.1") and battery in the payload
- [x] Pull-to-refresh
- [x] Disconnect / revoke this device

## Security

- [x] Single-use, expiring pairing codes
- [x] 256-bit tokens, constant-time comparison, revocable
- [x] Token required on every route and WebSocket
- [x] File API path confinement (lexical **and** symlink)
- [x] Native input helper is a locally-compiled binary (documented AV note on
      Windows, TCC permission grants on macOS)

## Verification

- [x] Server smoke-tested live (pairing, stats, capture, files) on Windows
- [x] Server smoke-tested live on macOS 26 / Apple silicon: boots, pairs via
      curl, `/system` disk matches `df -h`, `/files/list` confined, terminal
      echoes through a real zsh pty over the WebSocket
- [x] `npm test` — node:test unit suite for the df/sw_vers/pmset parsers, shell
      resolution and the path/symlink confinement guard
- [x] App runs on web (react-native-web) and in Expo Go on iOS
- [x] Playwright suite — every button on every screen — passing (5/5)
- [x] Vision review of all six screens; Files layout bug found and fixed
- [x] TypeScript typechecks clean (server and app)

## Distribution

- [x] Private GitHub repo
- [x] Expo Go path (use today, no Apple account)
- [x] EAS build config (`eas.json`) for TestFlight / installable IPA
- [x] iOS bundle id set (`com.mosslouvan.tether`)
- [x] Setup, iOS, and architecture docs (macOS + Windows)
- [x] macOS launchd LaunchAgent recipe, verified by loading it

## Not done / needs you

- [ ] Push to GitHub requires `gh auth login` (one-time, interactive) — see README
- [ ] TestFlight build requires your Apple Developer account
