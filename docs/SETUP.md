# Setup

Everything runs on two machines: your **host** (a Mac or a Windows PC) and your
**iPhone** (the app). This walks through both, plus reaching the host from
anywhere.

Pick your host platform:

- [macOS](#macos-host)
- [Windows](#windows-host)

Then continue with [the phone](#3-phone-run-the-app),
[remote access](#4-reaching-your-host-from-anywhere) and
[keeping it running](#5-keeping-the-host-up).

---

## macOS host

### 1. Prerequisites

- macOS 13 or newer (developed and verified on macOS 26 / Apple silicon)
- [Node.js 20+](https://nodejs.org/) — `node -v` to check
- Xcode command line tools, for building the native screen/input helper:
  `xcode-select --install`

### 2. Build and run

```bash
cd server
npm install
npm run build:native   # builds the native helper for this platform
npm start
```

`npm run build:native` dispatches on `process.platform`, so the same command
works on macOS and Windows. If you prefer to be explicit there is also
`npm run build:native:mac` and `npm run build:native:win`.

`npm start` prints something like:

```
  Belay host agent running on your Mac
  ─────────────────────────
  Host name : Mosss-MacBook-Air.local
  Port      : 8787
  Native    : ready (screen + input)

  Reachable at:
    http://192.168.1.183:8787
    http://100.101.102.103:8787   (Tailscale)

  macOS permissions (required for the Screen tab):
    1. System Settings → Privacy & Security → Screen & System Audio Recording
    2. System Settings → Privacy & Security → Accessibility
    ...

  Pairing code: 481920   (expires in 300s)
```

Leave the window open. The pairing code refreshes itself until a phone pairs.

### 3. macOS permissions (the #1 thing that goes wrong)

macOS gates screen capture and synthetic input behind TCC. Belay needs **two**
grants, both under **System Settings → Privacy & Security**:

| Permission | Pane | Needed for |
|---|---|---|
| Screen Recording | **Screen & System Audio Recording** | the Screen tab (capturing the display) |
| Accessibility | **Accessibility** | tap / drag / scroll / keyboard injection |

**The gotcha:** macOS attaches the permission to the process that *launched*
node, not to node itself. If you started the host by typing `npm start` in
Terminal, then it is **Terminal** you must approve — you will see "Terminal",
"iTerm", "Ghostty" or "Visual Studio Code" in the list, never "node" and never
"Belay". Approving the wrong entry silently does nothing.

The reliable sequence:

1. Run `npm start` from the terminal app you will always use.
2. Open the Screen tab in the phone app. macOS shows a permission prompt naming
   that terminal app. Allow it. (If no prompt appears, add the app manually with
   the **+** button in the pane and enable its switch.)
3. **Fully quit and reopen the terminal app** — macOS only re-reads the grant
   when the process restarts. `Cmd-Q`, not just closing the window.
4. Start the host again.

If capture returns black frames or input does nothing, it is almost always step
3 that was skipped, or the grant landed on a different terminal app than the one
you are launching from now.

### 4. Terminal quality (node-pty)

The Terminal tab prefers `node-pty`, a real Unix pty, and falls back to a piped
shell if it is unavailable. `node-pty` is an `optionalDependency` and works well
on macOS, so you should normally see `mode: pty`.

If the host logs

```
[terminal] node-pty spawn failed (posix_spawnp failed.); falling back to a piped shell
```

then `node-pty`'s postinstall script never ran and its `spawn-helper` binary is
missing the execute bit. Some npm configurations block install scripts by
default. Fix with either:

```bash
npm approve-scripts          # npm 11+, review and allow the install scripts
# or, directly:
chmod +x server/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
```

The fallback still runs commands and streams output; you just lose full TTY
semantics (interactive `vim`, `htop`, and friends).

The host spawns your real login shell: `$SHELL` if it is an absolute path that
exists, otherwise `/bin/zsh`. Set `BELAY_SHELL=/opt/homebrew/bin/fish` (an
absolute path) to override. Sessions start in your home directory with
`TERM=xterm-256color`.

---

## Windows host

### 1. Prerequisites

- Windows 10/11
- [Node.js 20+](https://nodejs.org/)
- The .NET Framework (already on every Windows machine) — used to build the
  tiny native helper that captures the screen and injects input.

### 2. Build and run

```powershell
cd server
npm install
npm run build:native   # compiles native\BelayHost.exe
npm start
```

`npm start` prints something like:

```
  Belay host agent running on your PC
  ─────────────────────────
  Host name : DESKTOP-XXXX
  Port      : 8787
  Native    : ready (screen + input)

  Reachable at:
    http://192.168.1.20:8787
    http://100.101.102.103:8787   (Tailscale)

  Pairing code: 481920   (expires in 300s)
```

Leave this window open. The pairing code refreshes itself until a phone pairs.

### 3. Antivirus note

The native helper injects mouse and keyboard input — the same Win32 calls a
remote-desktop tool uses. Windows Defender may flag `BelayHost.exe` the first
time. It is your own locally-compiled binary; if Defender quarantines it, add an
exclusion for the `server\native` folder in Windows Security → Virus & threat
protection → Exclusions, then rebuild. Only do this on a machine you control.

Windows needs no equivalent of the macOS permission grants.

---

## 3. Phone: run the app

Install **Expo Go** from the App Store, then on the host:

```bash
cd app
npm install
npx expo start
```

Scan the QR code with the iPhone Camera app. The app opens in Expo Go. Enter the
host address and the pairing code. Done — the token is saved, you won't pair
again.

## 4. Reaching your host from anywhere

Install [Tailscale](https://tailscale.com/download) on the computer and on the
phone and sign both in to the same account. The host then has a stable
`100.x.y.z` address (and a MagicDNS name) that works from any network, and only
devices on your tailnet can reach it at all.

Once both are on the tailnet, **you never need the pairing code again**: the
host verifies the phone's Tailscale identity and pairs it on the spot. So if the
app is reinstalled, the phone is revoked, or you are on the other side of the
world, entering the host's Tailscale address in the app is enough.

For the host to be there when you are away, also:

- run it on login (`npm run autostart` in `server/`, see below);
- set the power plan to never sleep, and enable automatic logon if the machine
  may reboot unattended.

## 5. Keeping the host up

### macOS

Stop the Mac sleeping while you might want to reach it:

- **System Settings → Battery → Options** → "Prevent automatic sleeping on power
  adapter when the display is off" → **on**. A sleeping Mac is unreachable.
- On a MacBook the lid must stay open, *or* the Mac must be on power with an
  external display attached — a closed lid otherwise means clamshell sleep.
- `caffeinate -s` in a spare terminal is the quick, temporary version.

Run it at login with a **LaunchAgent**. One command does the whole thing:

```bash
cd server
npm run autostart            # install and start
npm run autostart -- status  # is it running
npm run autostart -- logs    # what it printed
npm run autostart -- remove  # undo all of this
```

The script resolves the real `node` path and repo location itself, so there is
nothing to fill in. It deliberately runs `node` directly rather than
`npm start`: with npm in between, launchd's child is npm and the server is a
*grandchild*, so unloading the agent kills npm and leaves node orphaned, still
holding port 8787 — the next install then cannot bind while reporting itself
healthy. This was observed in practice, not theorised.

The rest of this section is the manual equivalent, if you would rather see what
the script does. Create `~/Library/LaunchAgents/com.belay.host.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.belay.host</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/npm</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/path/to/tether/server</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/belay.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/belay.err.log</string>
</dict>
</plist>
```

Replace `/Users/YOU/path/to/tether/server` with the real path, and check
`which npm` for the right `npm` path (`/opt/homebrew/bin/npm` on Apple silicon
Homebrew, `/usr/local/bin/npm` on Intel). launchd does not read your shell
profile, so both the absolute path and the explicit `PATH` matter.

Load, check and unload it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.belay.host.plist
launchctl print   gui/$(id -u)/com.belay.host | head        # state = running
tail -f /tmp/belay.out.log                                  # the boot banner
launchctl bootout gui/$(id -u)/com.belay.host               # stop + unload
```

Use `bootstrap gui/$(id -u)` (a per-user *Agent*), not `system/` — a system
daemon runs outside your login session and cannot capture your screen at all.

**Caveat, stated honestly:** a LaunchAgent starts without any terminal involved,
so the Screen Recording and Accessibility grants have to attach to the process
launchd starts (the `npm`/`node` binary), not to Terminal. macOS cannot show a
permission prompt for a background job, so grant the permissions by running the
host from Terminal *first* (see the permissions section), and expect to add the
node binary manually with the **+** button in each pane before the Screen tab
works under launchd. The Terminal, Files and Status tabs work under launchd
regardless.

### Windows

- Power plan: set sleep to *Never* while plugged in.
- Disable Fast Startup (Control Panel → Power → "Choose what the power buttons
  do") so the machine restarts into a reachable state.
- In BIOS, set "Restore on AC power loss" to *On* so it comes back after an
  outage. A small UPS avoids unclean shutdowns.
- Run the host on boot: create a Task Scheduler task that runs `npm start` in
  `server\` at logon (or wrap it with a tool like [pm2](https://pm2.keymetrics.io/)).

## Troubleshooting

| Symptom | Platform | Fix |
|---|---|---|
| App says "could not reach host" | both | Wrong IP, or a firewall blocking 8787. On Windows, allow Node through the firewall on private networks. On macOS, System Settings → Network → Firewall → Options → allow incoming connections for `node`. |
| Screen tab stuck on "Waiting…" | both | `Native: NOT BUILT` in the host output — run `npm run build:native`. |
| Screen tab black, or input does nothing | macOS | Screen Recording / Accessibility not granted, granted to the wrong app, or the terminal app was not fully quit and reopened after granting. See the permissions section. |
| Terminal works but `vim`/`htop` are broken | both | Session is `mode: pipe` instead of `pty`. On macOS see the node-pty note above; on Windows reinstall with build tools. |
| Disk shows 0 in the Status tab | both | The host could not read disk usage; it logs one `[disk] …` line with the reason. |
| Code expired | both | Just read the new code from the host window; it refreshes automatically. |
| Files tab won't open a folder | both | The file API is confined to Home, Desktop, Documents, Downloads (and `/Volumes` on macOS) and refuses anything that *resolves* outside them — including symlinks that point out. |

## Environment variables

> Belay used to be called **Tether**, and every variable below used to be
> `TETHER_*`. The old names are still read as a fallback (the `BELAY_*`
> spelling wins when both are set), so a shell profile, LaunchAgent plist or CI
> config written before the rename keeps working unchanged. Use the new names
> for anything you write from now on.

| Variable | Default | Purpose |
|---|---|---|
| `BELAY_PORT` | `8787` | Port to listen on |
| `BELAY_ALLOWED_ORIGINS` | `http://localhost:8081,http://127.0.0.1:8081` | Browser origins allowed by CORS (the local web build) |
| `BELAY_HOSTS` | *(empty)* | Extra hostnames accepted in the `Host` header, comma-separated. IP literals, `localhost` and `*.local` are always accepted; anything else is refused to defeat DNS rebinding. Add your Tailscale MagicDNS name here if you connect by name |
| `BELAY_TAILNET_PAIR` | `1` | Pair without a code for devices on the host's own Tailscale account (`0` to always require the code) |
| `BELAY_TAILSCALE_CLI` | auto | Path to the `tailscale` CLI if it is somewhere unusual |
| `BELAY_SHELL` | platform default | Shell for the Terminal tab (`cmd` on Windows, or an absolute path on macOS) |
| `BELAY_TEST_CODE` | *(unset)* | Fixed pairing code for the Playwright suite; honoured only when `BELAY_ALLOW_TEST_CODE=1` is also set |
| `BELAY_ALLOW_TEST_CODE` | *(unset)* | Explicit opt-in the test harness sets to activate `BELAY_TEST_CODE`; without it the fixed code is ignored |
| `BELAY_APPROVAL_TIMEOUT_MS` | `1800000` (30 min) | How long an agent approval waits for the phone before auto-deny; `0` waits forever |
| `BELAY_NOTIFY_URL` | *(unset — off)* | Webhook the host POSTs to when Claude needs a decision — an [ntfy](https://ntfy.sh) topic URL, Slack/Discord webhook, or your own endpoint. See [`AGENT.md`](AGENT.md#push-notifications-when-the-phone-is-asleep) |
| `BELAY_NOTIFY_FORMAT` | `ntfy` | `ntfy` or `json` |
| `BELAY_NOTIFY_EVENTS` | `approval,error` | Which events ping: `approval`, `done`, `error` |
| `BELAY_NOTIFY_DETAIL` | *(off)* | `on` to include the command/path in the notification (keep off on public ntfy.sh) |
| `BELAY_NOTIFY_TOKEN` | *(unset)* | Bearer token for the webhook (ntfy access token etc.); never logged |

## Agent tab and voice

The Agent tab needs the `claude` CLI on the PC's PATH (`npm i -g @anthropic-ai/claude-code`). Voice prompts need nothing on the computer — the phone recognises speech on-device. See [`AGENT.md`](AGENT.md).

To get pinged when Claude needs a decision while the phone is locked, install
the free [ntfy](https://ntfy.sh) app, subscribe to a long random topic, and set
`BELAY_NOTIFY_URL=https://ntfy.sh/<your-topic>` before `npm start` — the boot
banner's `Notify :` line confirms it. Full details, the privacy trade-offs, and
the generic-webhook payload are in
[`AGENT.md`](AGENT.md#push-notifications-when-the-phone-is-asleep).
