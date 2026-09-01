# Belay desktop client

Connect to a computer running the Belay host **from another computer**, and
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
- **Modifiers that mean what your thumb means.** When the two computers run
  different platforms, modifiers are remapped by *role*, not forwarded by
  name — see below.
- **Seamless windows.** The host's individual windows, each in a borderless
  window of its own here — the VMware Unity trick. Each follows its remote
  window's size and title, raises it on the host when you interact, and closes
  when it does. See [`docs/SEAMLESS-WINDOWS.md`](../docs/SEAMLESS-WINDOWS.md).

## Keyboard: driving one platform from the other

Forwarding modifier names verbatim puts ⌘ on the Windows key, so ⌘C — the key
a Mac thumb presses to copy — opens the Start menu, and every shortcut the
user knows is displaced by one key. So by default the client remaps *roles*:

| You press (Mac → Windows PC) | The PC receives |
|---|---|
| ⌘ (Command) | **Ctrl** — ⌘C copies, ⌘T opens a tab, ⌘W closes it |
| ⌥ (Option) | **Win** — held for Win+E / Win+L, or *tapped alone* to open the Start menu |
| ⌃ (Control) | **Alt** — ⌃Tab is Alt+Tab, ⌃F4 is Alt+F4, ⌃-letter hits menu accelerators |
| ⇧ (Shift) | Shift |

The trade: giving ⌥ to the Windows key moves Alt off the key labelled alt.
Alt chords ride ⌃ instead — a fair price, because ⌃ is the Mac's least-used
modifier and ⌥'s day job (composing é and €) only exists for *text*, which
still works: ⌥-composed characters are typed as text whenever ⌥ is not part
of a chord bound for the Windows key.

Driving a **Mac from a Windows PC** mirrors it: Ctrl becomes ⌘ (so Ctrl+C
copies rather than interrupting a terminal), Alt stays ⌥, and the Win key
sends literal ⌃ — the road back to Control when it is really wanted, though
the local OS swallows some Win chords before any app sees them. The client
speaks only the host's unambiguous names (`cmd`, `rawctrl`), so this never
fights the host's own phone-oriented `BELAY_MAC_CTRL` remap — one remap is
in charge, chosen client-side, whatever the host env says.

The mapping is stated in the connect window's **Keyboard** section and in
each display window's overlay, and a **Remap modifiers** toggle turns it off
per host — verbatim mode sends every key as itself. Same-platform pairs are
never translated. The choice is saved with the pairing and applies to windows
opened after the change.

## How it is put together

| File | Role |
|---|---|
| `main.js` | Electron main process: windows, IPC, aspect-ratio locking |
| `preload.cjs` | the renderer's only privileged surface — four IPC calls |
| `renderer/tokens.css` | the Ledger palette and type voices, shared with the phone (docs/DESIGN.md); light/dark follow the OS |
| `renderer/connect.*` | pairing and the display list |
| `renderer/display.*` | a whole display: stream canvas and input forwarding |
| `renderer/seamless.*` | one remote window: same, plus size/title following |
| `src/session.js` | host + token persistence, owner-only (`0600`) |
| `src/displays.js` | display list sanitizing, preference, window fitting |
| `src/windows.js` | window list, labels, resize/scale rules, cascade |
| `src/keymap.js` | KeyboardEvent → the host's key/text endpoints |
| `src/modmap.js` | which modifier means what, per client/host pairing |
| `src/url.js` | what someone types → a host origin |
| `test/` | `node --test` over every `src/` module |
| `test/smoke.cjs` | manual end-to-end check against a live host (see the header) |

The look is the phone app's Ledger system (docs/DESIGN.md) re-cut for a
pointer: the same paper/ink palette and one-orange-accent rules, but hover
tints, focus rings and desktop-dense rows instead of touch targets and the
track rule, because a mouse can hover and a thumb cannot. Streams sit on the
same true-dark machine panel in both themes. Every stylesheet is local; the
CSPs allow no inline styles and nothing remote.

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
