# Architecture

## Pieces

```
app/                 Expo / React Native, one codebase for iOS and web
  app/               expo-router routes
    index.tsx        connect + pair
    (tabs)/          screen · terminal · files · system
  src/               api client, connection context, theme, UI kit

server/              Node host agent (TypeScript)
  src/index.ts       HTTP + WebSocket server, auth, routes
  src/native.ts      manages the compiled helper subprocess
  src/terminal.ts    pty (node-pty) or piped-shell sessions
  src/files.ts       confined file browser
  src/system.ts      live stats
  native/            TetherHost.cs -> TetherHost.exe (capture + input)

tests/               Playwright suite driving the web build
```

## Data flow

- **REST** for request/response: pairing, system stats, files, one-shot input
  (click, key, text, scroll, drag).
- **WebSocket `/ws/screen`** for the live picture: the host captures the primary
  display, scales it, JPEG-encodes it, and streams frames. The loop is
  self-pacing — it only grabs the next frame after the current one is sent, so a
  slow link lowers the frame rate instead of building a backlog.
- **WebSocket `/ws/terminal`** for the shell: bytes in both directions.

## The native helper

Screen capture and input injection are the only things Node can't do on its own.
Rather than a compiled npm addon (fragile across Node versions) or a PowerShell
script (Defender's AMSI flags input-injection scripts), the helper is a small C#
console app compiled once with the .NET Framework compiler already on every
Windows box. Node talks to it over stdio: one JSON command per line in, one JSON
reply per line out.

It does four things via Win32:
- **capture** — GDI `CopyFromScreen`, composites the cursor, scales (bilinear),
  JPEG-encodes, returns base64.
- **mouse** — `SendInput` with absolute virtual-desktop coordinates, so clicks
  land correctly across multiple monitors and any DPI.
- **keyboard** — `SendInput` with virtual-key codes (for shortcuts like ctrl+c)
  and Unicode scan codes (for arbitrary typed text).
- **info** — screen geometry.

Coordinates cross the wire **normalized 0..1**, so the phone never needs to know
the host's resolution.

## Security model

- **Pairing:** the PC shows a 6-digit code (single-use, 5-minute expiry). The
  phone trades it once for a 256-bit token. The code is only ever shown on the
  PC, never sent to the phone by the server.
- **Auth:** every route and WebSocket requires the bearer token; it's compared
  in constant time. Tokens are revocable from the host.
- **File access:** confined to an allow-list of roots; every path is re-resolved
  and re-checked, so `..` can't escape. Read-only.
- **Network:** the agent is meant to sit on your LAN or Tailscale, not the public
  internet. Over Tailscale the link is encrypted end to end.

## Deliberate limits

- The file browser is read-only — a phone shouldn't be able to delete your work
  by mistake.
- Screen streaming is JPEG-over-WebSocket, not hardware-encoded video. It's
  smooth for coding, terminals and browsing. For 60fps gaming/playtesting, pair
  Tether with Parsec or Sunshine+Moonlight (see the roadmap).

## Roadmap

- WebRTC + NVENC path for true 60fps video (the RTX-class "own Parsec" mode).
- Two-finger scroll and pinch on the screen surface.
- Optional clipboard sync.
- Multi-monitor picker (the host already reports virtual-desktop geometry).
