# Belay — Windows host install (agent-runnable)

This guide installs and runs the **Belay host** on a Windows PC so your phone
(or another computer) can control it. It is written so a Claude/agent on the
Windows machine can execute it step by step. Run every command in **PowerShell**
unless noted. Stop and report if any step fails rather than guessing.

## 0. What you'll end up with
A host agent listening on port **8787** that prints a pairing code. You pair the
phone once; after that the phone reaches this PC on the LAN, or from anywhere via
Tailscale.

## 1. Prerequisites (check, then install what's missing)

```powershell
# Node.js 20+ (required)
node -v            # want v20 or higher. If missing: winget install OpenJS.NodeJS.LTS
# git (to get the code)
git --version      # if missing: winget install Git.Git
# .NET Framework C# compiler (csc.exe) — ships with Windows, used to build the
# tiny screen/input helper. Verify it exists:
Test-Path "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"   # expect True
```

- If `node -v` prints below 20, install the LTS: `winget install OpenJS.NodeJS.LTS`, then **open a new PowerShell window** so PATH refreshes.
- If the `Test-Path` for `csc.exe` is `False`, install the .NET Framework 4.x (Windows Features → ".NET Framework 4.8"), then re-check.

## 2. Get the code

The repo is **private** (`MossLouvan/belay`). Authenticate first if needed:

```powershell
# Option A: GitHub CLI (easiest)
winget install GitHub.cli   # if gh isn't installed
gh auth login               # follow the browser prompt, choose HTTPS
gh repo clone MossLouvan/belay "$HOME\belay"

# Option B: plain git (you'll be prompted for a GitHub username + a Personal
# Access Token as the password)
git clone https://github.com/MossLouvan/belay.git "$HOME\belay"
```

## 3. Build the native helper and start the host

```powershell
cd "$HOME\belay\server"
npm install
npm run build:native      # compiles native\BelayHost.exe with the Windows C# compiler
npm start
```

`npm start` should print something like:

```
  Belay host agent running on your PC
  Host name : DESKTOP-XXXX
  Port      : 8787
  Native    : ready (screen + input)
  Reachable at:
    http://192.168.1.20:8787
    http://100.x.x.x:8787   (Tailscale)
  Pairing code: 481920   (expires in 300s)
```

**Leave this window open** — the host runs as long as it's open, and the pairing
code refreshes itself until a phone pairs. When Windows Firewall prompts to allow
Node/the host on the network, **click Allow** (Private networks) or pairing on
the LAN won't work.

## 4. Verify it's actually up (in a second PowerShell window)

```powershell
Invoke-RestMethod http://localhost:8787/health   # expect ok:true and this PC's name
```

## 5. Pair the phone
On the Belay app, add a computer and either scan the QR / enter the 6-digit
pairing code shown by `npm start`, or — if the phone is on the same Tailscale
tailnet — it can pair with no code at all.

## 6. Reach it from anywhere (optional but recommended)
On the **same LAN**, no extra setup — the phone uses the `192.168.x.x` address.
For **anywhere** (cellular, another network), install Tailscale on this PC and
the phone, sign into the same account, and the phone uses the `100.x.x.x`
address the host prints. Belay never opens an inbound port to the internet.

## 7. Keep it running 24/7 (optional)
Instead of leaving the window open, register it to start on boot:

```powershell
cd "$HOME\belay\server"
npm run autostart install     # registers scheduled task via scripts\autostart-windows.ps1
# later: npm run autostart status   |   npm run autostart uninstall
```

## Troubleshooting
- **`csc.exe not found`** during `build:native` → install .NET Framework 4.8 (Windows Features), reopen PowerShell, retry.
- **Windows Defender flags `BelayHost.exe`** → it injects mouse/keyboard like any remote-desktop tool, and it's your own locally-compiled binary. Add an exclusion for `server\native` in Windows Security → Virus & threat protection → Exclusions, then re-run `npm run build:native`. Only do this on a machine you control.
- **`npm run build:native` blocked by execution policy** → the scripts are already invoked with `-ExecutionPolicy Bypass`; if a policy still blocks it, run `Set-ExecutionPolicy -Scope Process Bypass` in that window and retry.
- **Phone can't reach the host on the LAN** → make sure you clicked Allow on the Firewall prompt; confirm both devices are on the same network; test `http://<PC-LAN-IP>:8787/health` from another device.
- **Port 8787 already in use** → set another: `$env:BELAY_PORT=8799; npm start` (use that port on the phone too).
- **Native prints "not built"** → `npm run build:native` didn't produce `server\native\BelayHost.exe`; re-run it and read its error.

## Notes for the agent running this
- Do not commit `BelayHost.exe` or any `*-state.json` — they're gitignored (the state file holds live pairing tokens).
- Prefer `winget` for installs; if `winget` is unavailable, tell the user which prerequisite to install manually rather than downloading installers unprompted.
- `npm start` is a long-running foreground process — run it in its own window/session and report the printed pairing code back to the user; don't block waiting for it to exit.
