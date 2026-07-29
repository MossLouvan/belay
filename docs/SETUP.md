# Setup

Everything runs on two machines: your **PC** (the host) and your **iPhone**
(the app). This walks through both, plus reaching the PC from anywhere.

## 1. PC: prerequisites

- Windows 10/11
- [Node.js 20+](https://nodejs.org/)
- The .NET Framework (already on every Windows machine) — used to build the
  tiny native helper that captures the screen and injects input.

## 2. PC: build and run the host

```powershell
cd server
npm install
npm run build:native   # compiles native/TetherHost.exe
npm start
```

`npm start` prints something like:

```
  Tether host agent running
  Host name : DESKTOP-XXXX
  Port      : 8787
  Native    : ready (screen + input)

  Reachable at:
    http://192.168.1.20:8787
    http://100.101.102.103:8787   (Tailscale)

  Pairing code: 481920   (expires in 300s)
```

Leave this window open. The pairing code refreshes itself until a phone pairs.

### Antivirus note

The native helper injects mouse and keyboard input — the same Win32 calls a
remote-desktop tool uses. Windows Defender may flag `TetherHost.exe` the first
time. It is your own locally-compiled binary; if Defender quarantines it, add an
exclusion for the `server\native` folder in Windows Security → Virus & threat
protection → Exclusions, then rebuild. Only do this on a machine you control.

## 3. Phone: run the app

Install **Expo Go** from the App Store, then on the PC:

```powershell
cd app
npm install
npx expo start
```

Scan the QR code with the iPhone Camera app. The app opens in Expo Go. Enter the
PC address and the pairing code. Done — the token is saved, you won't pair again.

## 4. Reaching your PC from anywhere

On the same Wi-Fi, use the `192.168.x.x` address directly.

To use it on cellular or any other network, install
[Tailscale](https://tailscale.com/) on **both** the PC and the phone, sign into
the same account, and use the PC's `100.x.y.z` address in the app. Tailscale
builds an encrypted peer-to-peer link, so:

- no port forwarding
- works behind CGNAT (most home ISPs)
- traffic is encrypted end to end and never exposed to the public internet

**Do not** port-forward 8787 to the internet as a shortcut. Use Tailscale.

## 5. Keeping the PC on 24/7

- Power plan: set sleep to *Never* while plugged in.
- Disable Fast Startup (Control Panel → Power → "Choose what the power buttons
  do") so the machine restarts into a reachable state.
- In BIOS, set "Restore on AC power loss" to *On* so it comes back after an
  outage. A small UPS avoids unclean shutdowns.
- Run the host on boot: create a Task Scheduler task that runs `npm start` in
  `server\` at logon (or wrap it with a tool like [pm2](https://pm2.keymetrics.io/)).

## Troubleshooting

| Symptom | Fix |
|---|---|
| App says "could not reach host" | Wrong IP, or PC firewall blocking 8787. Allow Node through the Windows firewall on private networks. |
| Screen tab stuck on "Waiting…" | `Native: NOT BUILT` in the host output — run `npm run build:native`. |
| Terminal shows raw text oddly | node-pty didn't build; the host falls back to a piped shell. Reinstall with build tools for full pty. |
| Code expired | Just read the new code from the host window; it refreshes automatically. |
