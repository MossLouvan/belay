# Virtual monitors

A virtual monitor is a display your computer believes it has, with no panel
attached to it. Windows and macOS both treat one as a real screen: you can drag
windows onto it, maximise on it, and set its resolution. Nobody can see it.

That is exactly what a remote client wants. Opening a *physical* display in the
Belay desktop client takes over a screen someone at that computer is looking
at — your cursor becomes their cursor. Open a virtual one and the remote
session gets a workspace of its own, side by side with whoever is using the
machine.

Belay does not install a driver for you. It detects the ones you install, and
labels them, so the desktop client can offer the right screen by default.

## How Belay decides a display is virtual

The native helper reports what the OS says about each display and judges
nothing (`server/native/BelayHostDisplays.cs`, `server/native/mac/DisplayIdentity.swift`).
The classification happens in `server/src/displays.ts`, on two signals:

- **The Windows device interface path.** A physical panel enumerates under
  `DISPLAY#`; a software display has no bus to hang off and enumerates under
  `ROOT#`. A driver cannot rename its way out of this, so it is trusted on its
  own.
- **The adapter and monitor names.** macOS exposes no equivalent enumerator, so
  there the name is the only signal — happily every virtual display tool people
  run says so in its name.

Deliberately *not* treated as virtual: DisplayLink docks, AirPlay and Sidecar
targets. Those are real screens someone may be looking at.

If your virtual display is not recognised, add its name to `VIRTUAL_NAME_HINTS`
in `server/src/displays.ts` and restart the host — no native rebuild needed.
`GET /screen/info` shows exactly what the helper saw:

```bash
curl -s -H "Authorization: Bearer <token>" http://localhost:8787/screen/info | jq .screens
```

## Windows

Any IddCx indirect display driver works. Two that are commonly used:

- **[Virtual Display Driver](https://github.com/itsmikethetech/Virtual-Display-Driver)** —
  open source, actively maintained, configurable resolutions and refresh rates.
  Installs as a root-enumerated device, so Belay identifies it structurally
  rather than by name.
- **[Parsec VDD](https://github.com/nomi-san/parsec-vdd)** — the driver Parsec
  ships, usable on its own. Its adapter reports as "Parsec Virtual Display
  Adapter".

Both need an administrator install and a signed driver package; follow the
project's own instructions rather than a copy of them here, which would go
stale. After installing, the new display appears in **Settings → System →
Display** and Belay picks it up on the next `/screen/info` call.

Set its resolution to something your client can actually show — a 4K virtual
display streamed to a 1080p window costs the host encoding time for pixels
nobody sees.

## macOS

macOS has no third-party display drivers in the Windows sense; the tools use
`CGVirtualDisplay` instead, so there is nothing to install into the kernel:

- **[DeskPad](https://github.com/Stengo/DeskPad)** — open source, single
  purpose, creates one virtual display. Names it "DeskPad Display".
- **[BetterDisplay](https://github.com/waydabber/BetterDisplay)** — larger tool;
  its free tier can create dummy displays.

The host still needs **Screen Recording** and **Accessibility** granted to the
terminal app it was launched from, exactly as for a physical display — see
[SETUP.md](SETUP.md). A virtual display does not bypass TCC.

## Using one

1. Create the virtual display on the host.
2. Start the host: `cd server && npm start`.
3. Start the desktop client: `cd desktop && npm start`, pair, and the virtual
   display is the one offered with a **virtual** badge and the highlighted
   **Open** button.
4. Drag the apps you want to work with onto that display on the host, or launch
   them there.

## Limits worth knowing

- **The host's cursor is shared.** Input goes in through the OS's global input
  queue (`SendInput` / `CGEvent`), which has exactly one cursor. Moving the
  pointer in the desktop client moves the real pointer on the host, wherever the
  displays are arranged. A virtual display keeps the *windows* out of the way,
  not the cursor. If someone is using the machine, you will fight them for it.
- **Nothing enforces the separation.** A virtual display is a convention, not a
  sandbox. Anything with the bearer token can capture any display and click
  anywhere.
- **Frames cost what pixels cost.** The virtual display's resolution, not the
  client window's size, drives capture and encode cost on the host.
