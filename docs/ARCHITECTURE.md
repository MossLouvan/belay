# Architecture

## Pieces

```
app/                 Expo / React Native, one codebase for iOS and web
  app/               expo-router routes
    index.tsx        connect + pair
    (tabs)/          screen · agent · terminal · files · system
  src/               api client, connection context, theme, UI kit

server/              Node host agent (TypeScript) — runs on macOS and Windows
  src/index.ts       HTTP + WebSocket server, auth, routes
  src/banner.ts      boot output, incl. the macOS permission reminder
  src/native.ts      manages the compiled helper subprocess
  src/terminal.ts    pty (node-pty) or piped-shell sessions
  src/agent.ts       Claude Code sessions driven from the phone — with
                     agent-flow/agent-events/agent-routes; see AGENT.md
  src/files.ts       confined file browser
  src/projects.ts    project creation — the only write path; confined to the same roots as files.ts
  src/system.ts      live stats (composes cpu/disk/osinfo)
  src/cpu.ts         CPU load sampling
  src/disk.ts        disk usage: `df -kP` on POSIX, PowerShell on Windows
  src/osinfo.ts      friendly OS name (sw_vers) and battery (pmset)
  native/            the screen-capture + input helper, one per platform
  test/              node:test unit tests (parsers, path confinement, shell)

desktop/             Electron client — the host's displays as windows on
                     another computer
  main.js            windows, IPC, aspect-ratio locking
  preload.cjs        the renderer's only privileged surface
  renderer/          connect (pair + display list) and display (stream + input)
  src/               session storage, display choice, key mapping, URL parsing

tests/               Playwright suite driving the web build
```

## Data flow

- **REST** for request/response: pairing, system stats, files, one-shot input
  (click, key, text, scroll, drag).
- **WebSocket `/ws/screen`** for the live picture: the host captures the primary
  display, scales it, JPEG-encodes it, and streams frames. The loop is
  self-pacing — it only grabs the next frame after the current one is sent, so a
  slow link lowers the frame rate instead of building a backlog.
- **WebSocket `/ws/window`** for one window of the host, streamed into a window
  of the client's own. Same frames as `/ws/screen` plus the window's current
  rectangle and title, which is the only way a client learns the window moved,
  resized or was renamed. See [SEAMLESS-WINDOWS.md](SEAMLESS-WINDOWS.md).
- **WebSocket `/ws/terminal`** for the shell: bytes in both directions.
- **WebSocket `/ws/agent`** for Claude Code sessions: prompts and answers up,
  feed events and approval asks down. See [AGENT.md](AGENT.md).

Both clients — the phone app and the desktop client — speak this same API.
Nothing on the host is desktop-specific.

## Platform layer

Everything except screen capture and input injection is portable Node. The
places that are not are isolated behind small modules, each of which keeps both
platform paths intact:

| Concern | macOS | Windows |
|---|---|---|
| Shell (`terminal.ts`) | `$SHELL` (absolute + existing), else `/bin/zsh`, spawned as a login shell with `TERM=xterm-256color` | `powershell.exe -NoLogo -NoProfile`, or `%ComSpec%` when `BELAY_SHELL=cmd` |
| Disk (`disk.ts`) | `df -kP /System/Volumes/Data` — the writable APFS volume, which is what Finder reports; `/` is a sealed snapshot whose "used" figure is meaningless | `Get-PSDrive` on `%SystemDrive%` via PowerShell |
| OS name (`osinfo.ts`) | `sw_vers` → "macOS 26.3.1" instead of the kernel version `25.3.0` | `"Windows " + os.release()` |
| Battery (`osinfo.ts`) | `pmset -g batt`, cached for 5s | not reported (`null`) |
| Native helper build | `npm run build:native:mac` | `npm run build:native:win` |
| Window enumeration + capture | `CGWindowListCopyWindowInfo` (layer 0 only), `CGWindowListCreateImage` with `.optionIncludingWindow`, raise through AXUIElement | `EnumWindows` (Z order), DWM `EXTENDED_FRAME_BOUNDS`, `PrintWindow(PW_RENDERFULLCONTENT)`, raise through `SetForegroundWindow` |
| Display identity (`displays.ts`) | `NSScreen.localizedName` + `CGDisplayIsBuiltin`; virtual displays recognised by name | `EnumDisplayDevices` at adapter and monitor level; a software display enumerates under `ROOT#` rather than `DISPLAY#` |

`npm run build:native` dispatches on `process.platform`. Every probe resolves to
`null` on failure rather than throwing, and logs the reason once, so a broken
platform tool degrades one Status card instead of the whole payload.

## Displays

Each helper reports every monitor in a stable index order, and the client passes
that index back as `screen` on both capture and input — which is what keeps the
frame someone is looking at and the pixels their click lands on the same ones.

Alongside geometry the helpers report *identity*: the adapter, the monitor name
and the OS device path. They classify none of it. `src/displays.ts` turns those
strings into `virtualDisplay` and a human `label` on the way out of
`/screen/info`, because "is this a virtual display?" is a heuristic that needs
correcting as new display drivers appear, and correcting it there costs a server
restart rather than a native rebuild on two platforms. See
[VIRTUAL-MONITOR.md](VIRTUAL-MONITOR.md).

## Seamless windows

`windows` / `capturewindow` / `focuswindow` are the per-window counterparts of
`info` / `capture` / input. `src/windows.ts` validates the handles (digits only,
never zero — zero means "every window" to CoreGraphics and "no window" to Win32)
and shapes the helper's answers. The rest is documented in
[SEAMLESS-WINDOWS.md](SEAMLESS-WINDOWS.md).

## The native helper

Screen capture and input injection are the only things Node can't do on its own.
Rather than a compiled npm addon (fragile across Node versions), each platform
gets a tiny locally-compiled helper binary in `server/native/`, and Node talks to
it over stdio: one JSON command per line in, one JSON reply per line out. The
protocol is identical on both platforms, so `src/native.ts` and every call site
are platform-agnostic.

On Windows the helper is a C# console app built with the .NET Framework compiler
already present on every Windows box (a PowerShell script would trip Defender's
AMSI heuristics for input injection). It does four things via Win32:
- **capture** — GDI `CopyFromScreen`, composites the cursor, scales (bilinear),
  JPEG-encodes, returns base64.
- **mouse** — `SendInput` with absolute virtual-desktop coordinates, so clicks
  land correctly across multiple monitors and any DPI.
- **keyboard** — `SendInput` with virtual-key codes (for shortcuts like ctrl+c)
  and Unicode scan codes (for arbitrary typed text).
- **info** — screen geometry.

On macOS the helper is built by `native/build-mac.sh` and provides the same four
commands through the system frameworks. macOS additionally gates both
capabilities behind TCC, so the host must be granted **Screen Recording** and
**Accessibility** — and the grant attaches to the process that *launched* node
(Terminal, iTerm, …), not to node itself. `src/banner.ts` prints this on boot
because it is the most common setup failure. See `docs/SETUP.md`.

Coordinates cross the wire **normalized 0..1**, so the phone never needs to know
the host's resolution.

## Security model

- **Pairing:** the PC shows a 6-digit code (single-use, 5-minute expiry). The
  phone trades it once for a 256-bit token. The code is only ever shown on the
  PC, never sent to the phone by the server.
- **Auth:** every route and WebSocket requires the bearer token; it's compared
  in constant time. Tokens are revocable from the host.
- **File access:** read-only and confined to an allow-list of roots (Home,
  Desktop, Documents, Downloads, plus `/Volumes` on macOS). Every path is passed
  through `fs.realpath` and re-checked against the realpath'd roots before it is
  touched, so neither `..` nor a **symlink** can escape — `path.resolve` alone
  collapses `..` but happily follows a link out of the root, and a macOS home
  directory is full of links. Symlinks whose target is outside the roots are
  omitted from listings entirely rather than shown with the target's metadata.
- **Network:** the agent is meant to sit on your LAN or Tailscale, not the public
  internet. Over Tailscale the link is encrypted end to end.

## Deliberate limits

- The file browser is read-only — a phone shouldn't be able to delete your work
  by mistake.
- Screen streaming is JPEG-over-WebSocket, not hardware-encoded video. It's
  smooth for coding, terminals and browsing. For 60fps gaming/playtesting, pair
  Belay with Parsec or Sunshine+Moonlight (see the roadmap).

## Roadmap

- WebRTC hardware-encoded path for true 60fps video — in progress: the
  server-side slice (signaling, packetization, relay under `server/src/webrtc/`)
  and the macOS VideoToolbox encoder (`server/native/mac/encode/`) are written,
  but the phone client does not yet mount a real `RTCPeerConnection`, and the
  native path is unverified on hardware. See [WEBRTC-SLICE.md](WEBRTC-SLICE.md).
- Seamless windows follow the host's window *position* as well as its size, for
  users who want the two desktops laid out alike.
- Window-event hooks (WinEvent / AX notifications) so the window list updates
  itself instead of being refreshed by hand.
- ScreenCaptureKit's `SCScreenshotManager` for macOS window capture, once a
  macOS 14 deployment target is acceptable — `CGWindowListCreateImage` is
  deprecated, though it still works.
