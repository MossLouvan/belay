# Tether desktop client

Connect to a computer running the Tether host **from another computer**, and
open its displays as ordinary windows on your desktop — resizable, alt-tabbable,
snappable beside your local apps.

```
   this computer (Electron)                 the paired computer (host agent)
  ┌──────────────────────────┐             ┌────────────────────────────┐
  │  connect window          │──REST──────►│  /pair, /screen/info       │
  │   displays + windows     │             │  /windows                  │
  │  display window (×N)     │◄──frames────│  capture of one display    │
  │  seamless window (×N)    │◄──frames────│  capture of one window     │
  │   canvas + input         │───REST─────►│  SendInput / CGEvent       │
  └──────────────────────────┘             └────────────────────────────┘
```

It speaks the same API as the phone app — nothing host-side is desktop-specific
beyond the display identity work in
[`docs/VIRTUAL-MONITOR.md`](../docs/VIRTUAL-MONITOR.md).

## Run it

```bash
cd desktop
npm install     # downloads Electron; the only dependency
npm start
```

Enter the address the host printed on boot (`192.168.1.20:8787`) and the
6-digit pairing code shown on that computer. The pairing is remembered, so
after the first time it opens straight to the display list.

```bash
npm test        # pure-logic unit tests, no Electron needed
```

## What it does

- **One window per display.** Each display opens in its own window, locked to
  that display's aspect ratio so the picture is never letterboxed and a click
  lands where you aimed it.
- **Virtual displays first.** A display the host classifies as virtual is
  badged and offered as the default, because opening a physical one takes over
  a screen somebody may be sitting at. See
  [`docs/VIRTUAL-MONITOR.md`](../docs/VIRTUAL-MONITOR.md).
- **Full mouse and keyboard.** Move, click, right-click, double-click, drag,
  scroll, text, and shortcuts. Ctrl/Cmd combinations are forwarded to the remote
  desktop rather than acted on locally — Ctrl+W closes the remote tab, not this
  window.
- **Seamless windows.** The host's individual windows, each in a borderless
  window of its own here — the VMware Unity trick. Each follows its remote
  window's size and title, raises it on the host when you interact, and closes
  when it does. See [`docs/SEAMLESS-WINDOWS.md`](../docs/SEAMLESS-WINDOWS.md).

## How it is put together

| File | Role |
|---|---|
| `main.js` | Electron main process: windows, IPC, aspect-ratio locking |
| `preload.cjs` | the renderer's only privileged surface — four IPC calls |
| `renderer/connect.*` | pairing and the display list |
| `renderer/display.*` | a whole display: stream canvas and input forwarding |
| `renderer/seamless.*` | one remote window: same, plus size/title following |
| `src/session.js` | host + token persistence, owner-only (`0600`) |
| `src/displays.js` | display list sanitizing, preference, window fitting |
| `src/windows.js` | window list, labels, resize/scale rules, cascade |
| `src/keymap.js` | KeyboardEvent → the host's key/text endpoints |
| `src/url.js` | what someone types → a host origin |
| `test/` | `node --test` over every `src/` module |
| `test/smoke.cjs` | manual end-to-end check against a live host (see the header) |

Renderers run with `contextIsolation` on, `nodeIntegration` off and `sandbox`
on. The bearer token is kept by the main process and never touches
`localStorage`; the WebSocket authenticates with a single-use ticket from
`/ws-ticket` so the token never appears in a URL.

## Not here yet

- The window list does not update itself; press **Refresh** after opening
  something new on the host. Live updates need window-event hooks (WinEvent on
  Windows, AX notifications on macOS) in the helpers.
- Seamless windows follow the remote window's size, not its position.
- The macOS host side is written but has never been compiled — see
  [`MAC_HANDOFF.md`](../MAC_HANDOFF.md).
