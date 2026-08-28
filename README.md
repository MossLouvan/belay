# Tether

Control your Mac or Windows PC from your iPhone. Self-hosted, private, no
third-party relay.

Your computer runs a small host agent. Your phone runs a React Native app that
connects straight to it over your own network (LAN or Tailscale). Nothing goes
through anyone else's servers.

```
   iPhone (Expo / React Native)            macOS / Windows (host agent)
  ┌──────────────────────────┐            ┌────────────────────────────┐
  │  Screen   remote control │◄──frames───│  screen capture (JPEG)     │
  │  Terminal shell access   │◄──pty io──►│  zsh / PowerShell sessions │
  │  Files    browse + read  │◄──REST────►│  file API                  │
  │  System   live stats     │◄──REST────►│  cpu / mem / disk / battery│
  │           input events   │───────────►│  native input injection    │
  └──────────────────────────┘            └────────────────────────────┘
         paired once with a 6-digit code, then a bearer token
```

## What works

| Feature | Status |
|---|---|
| Pairing with a 6-digit code | ✅ |
| Live screen streaming to the phone | ✅ JPEG over WebSocket |
| Tap / drag / scroll / right-click | ✅ SendInput injection |
| Full keyboard + text entry | ✅ |
| Interactive terminal | ✅ real pty when available, piped shell otherwise |
| File browser + text file viewer | ✅ |
| Live system stats | ✅ |
| Agent tab — drive Claude Code on the PC | ✅ pick a project, prompt from the phone, approve every action |
| Voice prompts + global dictation | ✅ hold-to-talk, transcribed on the PC with whisper.cpp |
| Resume any past Claude session | ✅ "On this PC" list in the Agent tab, or `npm run sessions` |
| Runs on iPhone via Expo Go | ✅ |
| Runs in a browser (same UI) | ✅ used for automated tests |
| Windows host | ✅ |
| macOS host | ✅ Apple silicon and Intel |

## Quick start

**1. On the computer** (macOS or Windows — same commands)

```bash
cd server
npm install
npm run build:native   # screen capture + input helper for this platform
npm start
```

It prints a pairing code and the URLs it is reachable on.

On **macOS** you must also grant two permissions before the Screen tab works —
**System Settings → Privacy & Security → Screen & System Audio Recording** and
**→ Accessibility** — to the *terminal app* you launch the host from, not to
`node`. The host prints a reminder on boot; the details are in
[`docs/SETUP.md`](docs/SETUP.md).

**2. On the phone**

```bash
cd app
npm install
npx expo start
```

Scan the QR with the Camera app (Expo Go must be installed). Enter the host URL
and the pairing code. That's it — the token is stored, you won't pair again.

## Reaching it from anywhere

On the same Wi-Fi it works immediately. To use it on cellular, install
[Tailscale](https://tailscale.com/) on both the computer and the phone and use
the computer's Tailscale IP (`100.x.y.z`) as the host. No port forwarding, works behind
CGNAT, and the link is encrypted end to end.

Do **not** port-forward the host agent to the public internet.

## Docs

- [`docs/AGENT.md`](docs/AGENT.md) — the Agent tab: how Claude Code runs on the PC and how every action is approved from the phone

- [`docs/SETUP.md`](docs/SETUP.md) — full install for macOS and Windows, permissions, Tailscale, 24/7 config
- [`docs/IOS.md`](docs/IOS.md) — installing on your iPhone, TestFlight and IPA builds
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — protocol, threat model, roadmap
- [`docs/CHECKLIST.md`](docs/CHECKLIST.md) — implementation status of every requirement

## Layout

```
server/   host agent for macOS and Windows (TypeScript, Express + ws)
app/      Expo / React Native app — iOS and web from one codebase
tests/    Playwright suite driving the web build
docs/     setup, iOS distribution, architecture
```

## Security

Pairing a phone gives it **complete control of the computer** — mouse,
keyboard, a shell, and a read-only view of your home folder. Treat the device
token like a password to the machine.

- Over your own Tailscale network the code is skipped entirely: the host asks
  the Tailscale daemon (`tailscale whois`) who is connecting, and pairs any
  device signed in to the *same* Tailscale account with no code. Nobody outside
  your tailnet can reach the port, so re-pairing from anywhere is safe. Set
  `TETHER_TAILNET_PAIR=0` to insist on the code anyway.
- On LAN, pairing codes are single-use and expire after 5 minutes. Wrong guesses lock
  the client out after 5 attempts, and 20 wrong guesses from anywhere burn the
  code, so a 6-digit code cannot be brute-forced.
- Tokens are random 256-bit values, compared in constant time, revocable from
  any paired device — and revoking closes that device's live screen and
  terminal sockets immediately.
- Every screen, input, terminal and file route requires a valid bearer token in
  the `Authorization` header. WebSockets use a one-shot ticket so the token
  never appears in a URL.
- Browser origins are an explicit allow-list (`TETHER_ALLOWED_ORIGINS`), and
  every request's `Host` header must be an IP literal, `localhost`, a `.local`
  name, or a name in `TETHER_HOSTS` — this defeats DNS rebinding, where a
  malicious web page re-points its own domain at your PC to sidestep CORS.
- The file API is read-only, confined to an allow-list of roots, resolves
  symlinks before checking, and additionally refuses the Tether install
  directory (whose state file holds the device tokens) and credential folders
  such as `~/.ssh`, `~/.aws` and `~/.claude`.
- Transport is plain HTTP: use it over Tailscale or a network you trust. On an
  open network anyone on the segment could read the token off the wire.
- `tether-state.json` (device tokens) is written owner-only and gitignored.

## License

MIT
