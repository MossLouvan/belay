# Belay

To belay is to hold your climbing partner's rope: this holds the line from
your iPhone to your Mac or Windows PC — watching the work and catching it
when it needs a decision. Private and end-to-end encrypted.

The control room for your AI agents: your computer runs Belay.app, your phone
runs the Belay app, and an end-to-end encrypted tunnel connects them at your
desk or anywhere else. Sign in once, scan a QR, done.

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
| Join a phone-started Claude session at the keyboard | ✅ `npx belay-host attach` (or `cd server && npm run attach` in a checkout) — same live session, nothing restarts |
| Voice prompts + global dictation | ✅ hold-to-talk, transcribed on the phone, on-device |
| Resume any past Claude session | ✅ "On this PC" list in the Agent tab, or `npm run sessions` |
| Runs on iPhone via Expo Go | ✅ |
| Desktop client — open the PC's displays as windows on another computer | ✅ Electron, `desktop/` |
| Virtual monitor — work on a display nobody at the host can see | ✅ detected and preferred; you install the driver |
| Seamless windows — the host's apps as individual windows on your desktop | ✅ Windows host; macOS host written, needs a Mac build |
| Multiple people at once — a named, coloured cursor each | ✅ in the app; the host's own screen shows no overlay yet ([docs](docs/COLLABORATION.md)) |
| Runs in a browser (same UI) | ✅ used for automated tests |
| Windows host | ✅ |
| macOS host | ✅ Apple silicon and Intel |

## Quick start

1. **On the computer:** install **Belay.app** from [gobelay.com](https://gobelay.com)
   and open it. On macOS, allow Screen Recording and Accessibility when it asks.
2. **On the phone:** install **Belay** (the Belay.app window shows a QR to the
   download), then sign in with Apple or an email code.
3. **Link them:** in the phone app tap **Add computer › Scan to link** and scan
   the QR in the Belay.app window (or type the code under it). Then enter the
   6-digit pairing code it shows. That's it — at home or away, no port
   forwarding, no VPN.

Do **not** port-forward the host agent to the public internet.

### Advanced: run the host from a terminal, connect by address

For developers and headless machines, the host also runs without Belay.app:

```bash
npx belay-host                      # needs Node.js 20+
# or from a checkout:
cd server && npm install && npm run build:native && npm start
```

It builds the native screen/input helper on first run (needs the Xcode
command line tools on macOS, `csc.exe` on Windows), then prints the link QR,
a pairing code and the addresses it answers on. State and the TLS certificate
live in `~/Library/Application Support/Belay` (macOS), `%APPDATA%\Belay`
(Windows) or `~/.config/belay` (Linux). On macOS grant Screen & System Audio
Recording and Accessibility to the *terminal app* you launch it from, not to
`node` — details in [`docs/SETUP.md`](docs/SETUP.md).

The phone can also connect by address (**Add computer › Advanced: connect
by address**): any address the phone can reach works — the same
network, or a VPN such as [Tailscale](https://tailscale.com/), where the host
skips the pairing code for devices on your own tailnet.

The phone app from source: `cd app && npm install && npx expo start`.

**From another computer:** `cd desktop && npm install && npm start`, pair with
the same 6-digit code, and each of that computer's displays opens as an
ordinary window on this one. If the host has a virtual monitor, that is the
display offered first. The same window can also put each of the host's open
windows in a window of its own. See
[`docs/VIRTUAL-MONITOR.md`](docs/VIRTUAL-MONITOR.md),
[`docs/SEAMLESS-WINDOWS.md`](docs/SEAMLESS-WINDOWS.md) and
[`desktop/README.md`](desktop/README.md).

## Docs

- [`docs/AGENT.md`](docs/AGENT.md) — the Agent tab: how Claude Code runs on the PC and how every action is approved from the phone

- [`docs/SETUP.md`](docs/SETUP.md) — full install for macOS and Windows, permissions, advanced connect-by-address, 24/7 config
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

> Using it safely is a separate, shorter read: **[docs/SAFETY.md](docs/SAFETY.md)**
> — what pairing really gives away, rules for the code, agent sessions, and
> where it is and is not appropriate to install the host.

Pairing a phone gives it **complete control of the computer** — mouse,
keyboard, a shell, and a read-only view of your home folder. Treat the device
token like a password to the machine.

- Over your own Tailscale network the code is skipped entirely: the host asks
  the Tailscale daemon (`tailscale whois`) who is connecting, and pairs any
  device signed in to the *same* Tailscale account with no code. Nobody outside
  your tailnet can reach the port, so re-pairing from anywhere is safe. Set
  `BELAY_TAILNET_PAIR=0` to insist on the code anyway.
- On LAN, pairing codes are single-use and expire after 5 minutes. Wrong guesses lock
  the client out after 5 attempts, and 20 wrong guesses from anywhere burn the
  code, so a 6-digit code cannot be brute-forced.
- Tokens are random 256-bit values, compared in constant time, revocable from
  any paired device — and revoking closes that device's live screen and
  terminal sockets immediately.
- Every screen, input, terminal and file route requires a valid bearer token in
  the `Authorization` header. WebSockets use a one-shot ticket so the token
  never appears in a URL.
- Browser origins are an explicit allow-list (`BELAY_ALLOWED_ORIGINS`), and
  every request's `Host` header must be an IP literal, `localhost`, a `.local`
  name, or a name in `BELAY_HOSTS` — this defeats DNS rebinding, where a
  malicious web page re-points its own domain at your PC to sidestep CORS.
- The file API is read-only, confined to an allow-list of roots, resolves
  symlinks before checking, and additionally refuses the Belay install
  directory (whose state file holds the device tokens) and credential folders
  such as `~/.ssh`, `~/.aws` and `~/.claude`.
- On the LAN the host serves HTTPS with a self-signed certificate it mints on
  first run; the phone and desktop pin its SHA-256 fingerprint (delivered in
  the pairing QR and shown in the banner) and refuse any other certificate.
  Plain HTTP is accepted only from loopback and Tailscale peers, which are
  already encrypted, and refused with a clear error elsewhere. Before a client
  sends its token it also challenges the host to prove a per-device secret
  issued at pairing (HMAC-SHA256), so an impostor at a reused address gets
  nothing. See docs/TRANSPORT-SECURITY.md.
- `belay-state.json` (device tokens) is written owner-only and gitignored.
  A host that paired back when the product was called Tether keeps its
  pairings: the old `tether-state.json` is read once, carried forward on the
  next change, and never deleted.

## License

MIT
