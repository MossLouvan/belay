# Belay — Windows build & verify handoff (for a Claude agent on Windows)

You are a Claude Code agent running **on the Windows PC**. Everything in Belay
has been built and unit-tested on macOS and merged to `main`; several Windows
native pieces are **written but have never been compiled or run**, because the
authoring machine had no Windows. Your job is to compile them, run them, verify
each one against a real phone, fix what's broken, and report back — one tier at a
time, stopping to report rather than guessing when a step fails.

Run every command in **PowerShell** unless noted. Base host setup (prereqs,
clone, first run, pairing) is in [`WINDOWS-INSTALL.md`](./WINDOWS-INSTALL.md) —
do that first, then come back here.

---

## Ground rules (read first)

- **Never commit or print secrets.** `belay-state.json` / `tether-state.json`
  (device tokens), `.env`, and built binaries (`*.exe`, `*.dll`, `*.sys`,
  `*.cat`) are already in `.gitignore` — keep it that way. Before any commit run
  `git status` and confirm only source/docs are staged; prefer `git add <path>`
  over `git add -A`. **Never** paste a pairing code, device token, or the
  contents of a state file into a commit, a PR, or your report.
- **Work on a branch, open a PR.** Branch `win/<topic>` off `main`; never
  force-push `main`. Small, focused commits with clear messages.
- **Be honest about verification.** "Compiled" ≠ "works." Only mark a tier green
  after the phone actually did the thing (saw the screen, pasted the clipboard,
  heard audio, got the new resolution). If you can't verify, say so.
- **Don't break the default path.** The shipping transport is JPEG-over-WebSocket
  and it must keep working with every flag OFF. The WebRTC and virtual-display
  paths are opt-in.
- **Known-risky code:** three native WebRTC teardown fixes were made blind
  (see `git log` for `fix(native): three WebRTC-build teardown crashes`). If you
  build the WebRTC path (Tier 4), that build is the first chance to actually
  exercise them — watch for crashes on disconnect and report.

---

## Tier 0 — base host (screen + input)

Follow `WINDOWS-INSTALL.md` through pairing. Success =
`Invoke-RestMethod http://localhost:8787/health` returns `ok:true`, and the phone
shows the live desktop and can move the mouse / type. **Report the `/health`
output (it has no secrets) and whether the phone streamed + controlled.**

The build command that compiles the whole C# helper (screen, input, clipboard,
audio, displays, virtual-display host side) is:

```powershell
cd "$HOME\belay\server"
npm run build:native:win     # csc.exe from the built-in .NET Framework — no SDK needed
```

If `csc.exe` is missing, enable ".NET Framework 4.8" in Windows Features.

---

## Tier 1 — clipboard (should already work once Tier 0 builds)

`BelayHostClipboard.cs` is compiled into the helper by Tier 0. The Node route is
gated by normal auth (not a flag). Verify:

```powershell
# Route exists (expect 401 Unauthorized, NOT 404):
try { Invoke-RestMethod http://localhost:8787/clipboard } catch { $_.Exception.Response.StatusCode }
```

Then on the **phone**: Screen tab → dock → **CLIP** → "Pull from PC" and "Send to
PC". Confirm text moves both directions, including emoji and an empty (clear).
**Report pass/fail; if the helper answers `unknown command`, the C# verb didn't
compile in — check `BelayHost.cs` dispatch wiring and rebuild.**

---

## Tier 2 — system audio (WASAPI loopback)

`BelayHostAudio.cs` (WASAPI loopback capture) needs the audio routes, which are
gated behind `BELAY_WEBRTC=1` at **runtime**:

```powershell
cd "$HOME\belay\server"
$env:BELAY_WEBRTC = "1"
npm start
```

Verify the route (second window): `GET http://localhost:8787/audio/status`
returns without 404. Then on the **phone**: Screen tab → "..." menu → **Host
audio** toggle → play something on the PC → confirm sound comes out of the phone.
The phone side (WebView Web Audio, pcm16) is already merged. **Report whether you
actually heard audio; note the ringer/silent-switch behavior.** Opus is not
implemented yet (pcm16 only) — that's expected.

---

## Tier 3 — WebRTC transport (optional, lower latency)

Needs `belay_transport.dll` (libdatachannel) built for Windows and the helper
compiled with `BELAY_WEBRTC_BUILD=1`. See `docs/WEBRTC-SLICE.md`.

1. Build libdatachannel for Windows (CMake + VS2022) from the pinned source in
   the runbook; produce `belay_transport.dll` and place it beside `BelayHost.exe`.
2. Rebuild the helper with the native WebRTC path folded in:
   ```powershell
   $env:BELAY_WEBRTC_BUILD = "1"
   npm run build:native:win     # prints a note that it's folding in the gated path
   ```
3. Run with `$env:BELAY_WEBRTC = "1"` and let the phone negotiate WebRTC.

**This is where the three blind teardown fixes get exercised.** Connect and
disconnect repeatedly, switch monitors, end sessions — watch for a helper crash
on `bye`/teardown and report the exact scenario + any crash log. If unstable,
the JPEG path (flag off) is the fallback and must still be fine.

---

## Tier 4 — virtual display driver (true host-resolution, the hard one)

`server\native\win-display\` is a **UMDF2 indirect display driver** (user-mode,
not kernel). This is what lets the phone pick a resolution and have Windows
actually render at it (Parsec-style), instead of downscaling.

Prereqs: **Visual Studio 2022** + **Windows Driver Kit (WDK)** extension.

```powershell
cd "$HOME\belay\server\native\win-display"
# Build + test-sign the driver (creates a throwaway self-signed cert if none given):
.\build-driver.ps1
```

Installing an unsigned/test-signed driver requires **test-signing mode**:

```powershell
# Elevated PowerShell. This weakens driver signing enforcement — dev machines
# only. Requires a reboot; a "Test Mode" watermark appears on the desktop.
bcdedit /set testsigning on
# reboot, then install the INF from .\dist\<arch>\BelayVdd\ (right-click Install,
# or pnputil /add-driver BelayVdd.inf /install), per docs\VIRTUAL-DISPLAY.md.
```

Then run the host with the feature on:

```powershell
$env:BELAY_VIRTUAL_DISPLAY = "1"
npm start
```

Verify: `GET /screen/virtual-display` (authed) should report
`{ enabled:true, available:true, ... }`. On the **phone**: "..." → resolution
sheet → pick a resolution / "Match my phone" → confirm Windows creates a virtual
monitor at that size, the stream fills the phone with no letterbox, and switching
back / disconnecting leaves **no orphaned monitor** in Settings → Display.

**Honesty:** test-signing is for dev only; shipping needs an EV cert + Microsoft
attestation signing (see `docs/VIRTUAL-DISPLAY.md`). Do not attempt to ship-sign.

---

## Report format (paste back to the Mac session / PR)

For each tier attempted:

```
Tier N — <name>: PASS | FAIL | PARTIAL
  Built:    <yes/no + command>
  Verified: <what the phone actually did, or why not>
  Fixes:    <files changed + why, if any>
  Blocked:  <exact error + step, if stuck>
```

Commit any fixes on `win/<topic>` and open a PR. Do **not** merge to `main`
yourself — leave it for review. Confirm in the PR body that `git status` showed
no state files / secrets staged.
