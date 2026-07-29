# Tether

Control your Windows PC from your iPhone. Self-hosted, private, no third-party relay.

Your PC runs a small host agent. Your phone runs a React Native app that connects
straight to it over your own network (LAN or Tailscale). Nothing goes through
anyone else's servers.

```
   iPhone (Expo / React Native)            Windows PC (host agent)
  ┌──────────────────────────┐            ┌────────────────────────────┐
  │  Screen   remote control │◄──frames───│  screen capture (JPEG)     │
  │  Terminal shell access   │◄──pty io──►│  PowerShell / pty sessions │
  │  Files    browse + read  │◄──REST────►│  file API                  │
  │  System   live stats     │◄──REST────►│  cpu / mem / disk / uptime │
  │           input events   │───────────►│  SendInput injection       │
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
| Interactive terminal | ✅ ConPTY when available, piped shell otherwise |
| File browser + text file viewer | ✅ |
| Live system stats | ✅ |
| Runs on iPhone via Expo Go | ✅ |
| Runs in a browser (same UI) | ✅ used for automated tests |

## Quick start

**1. On the PC**

```powershell
cd server
npm install
npm start
```

It prints a pairing code and the URLs it is reachable on.

**2. On the phone**

```powershell
cd app
npm install
npx expo start
```

Scan the QR with the Camera app (Expo Go must be installed). Enter the host URL
and the pairing code. That's it — the token is stored, you won't pair again.

## Reaching it from anywhere

On the same Wi-Fi it works immediately. To use it on cellular, install
[Tailscale](https://tailscale.com/) on both the PC and the phone and use the
PC's Tailscale IP (`100.x.y.z`) as the host. No port forwarding, works behind
CGNAT, and the link is encrypted end to end.

Do **not** port-forward the host agent to the public internet.

## Docs

- [`docs/SETUP.md`](docs/SETUP.md) — full install, Tailscale, 24/7 machine config
- [`docs/IOS.md`](docs/IOS.md) — installing on your iPhone, TestFlight and IPA builds
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — protocol, threat model, roadmap
- [`docs/CHECKLIST.md`](docs/CHECKLIST.md) — implementation status of every requirement

## Layout

```
server/   Windows host agent (TypeScript, Express + ws)
app/      Expo / React Native app — iOS and web from one codebase
tests/    Playwright suite driving the web build
docs/     setup, iOS distribution, architecture
```

## Security

- Pairing codes are single-use and expire after 5 minutes.
- Tokens are random 256-bit values, compared in constant time, revocable from the PC.
- The agent binds to all interfaces but is intended to sit behind LAN or Tailscale.
- Every screen, input, terminal and file route requires a valid token.
- The file API is confined to an allow-list of roots and rejects traversal.

## License

MIT
