# Seamless windows

Instead of viewing the whole remote desktop in one rectangle, each application
window on the host gets **its own window on this computer** — resizable,
alt-tabbable, snappable beside local apps. VMware called this Unity mode.

```
   this computer                             the host
  ┌───────────────┐ ┌──────────────┐        ┌────────────────────────────┐
  │ local editor  │ │ REMOTE Slack │◄───────│  Slack's own pixels        │
  └───────────────┘ └──────────────┘        │  (PrintWindow / CGWindow)  │
  ┌──────────────────────────────┐          │                            │
  │ REMOTE browser               │◄─────────│  the browser's own pixels  │
  └──────────────────────────────┘          └────────────────────────────┘
```

## Using it

1. Start the host on the other computer (`cd server && npm start`).
2. `cd desktop && npm start`, pair, and the **Windows** section lists what is
   open over there.
3. **Open** one, or **Open all** — each arrives as a borderless local window.

Drag a remote window by its own title bar (the top 28px of the local window is a
drag strip). The ↑ button raises it on the host; ✕ closes the local window and
leaves the remote one running.

## How a window gets here

**Enumeration** — `GET /windows`. The helper walks the host's top-level windows
and filters out everything a person would not call a window:

| Windows | macOS |
|---|---|
| `EnumWindows` in Z order | `CGWindowListCopyWindowInfo(.optionOnScreenOnly)`, already front-to-back |
| skips invisible, the shell window, `WS_EX_TOOLWINDOW`, DWM-**cloaked** ghosts (suspended UWP apps that pass every other test), untitled and zero-area windows | keeps layer 0 only (menus, the Dock and tooltips live on other layers), skips transparent and tiny windows |
| bounds from DWM `EXTENDED_FRAME_BOUNDS`, not `GetWindowRect` — the latter includes an invisible resize border, and a local window sized from it shows a fringe of whatever is behind the remote window | bounds from the window list, captured with `.boundsIgnoreFraming` so the drop shadow is not streamed as a translucent border |

**Capture** — `WS /ws/window?window=<id>`. Frames are JPEG over the socket, the
same shape as `/ws/screen`, plus two things a display frame does not need: the
window's current **rectangle** and **title**, on every frame.

That matters because the only way a client learns the user dragged, resized or
renamed a window on the host is the next frame saying so. The client follows the
size (keeping whatever zoom the user chose locally) and the title, and never the
*position* — the local desktop has its own monitor layout and its own idea of
where that window belongs.

Both platforms capture the window's **own pixels**, not a crop of the screen:
`PrintWindow(PW_RENDERFULLCONTENT)` on Windows, `CGWindowListCreateImage` with
`.optionIncludingWindow` on macOS. So a remote window that is buried behind
three others on the host still streams correctly, and the client stacks its
windows in its own order.

**Input** — the existing `/input/*` routes, with `window` instead of `screen`.
Coordinates are normalized 0..1 against the window, and the helper maps them
onto that window's current rectangle, wherever it has moved to.

**Focus** — `POST /windows/focus`. Typed input goes to whatever has focus on the
host, not to a window handle, so the client raises the remote window on first
interaction. It does not raise on every click: that would fight the person at
the host for the foreground.

## Limits worth knowing

- **One cursor, one foreground.** The host has a single input queue. Typing into
  a seamless window raises that window on the host, which takes focus from
  whatever was in front. Seamless mode makes windows independent to *look* at;
  it does not make two people able to use the machine at once. A
  [virtual monitor](VIRTUAL-MONITOR.md) is the closest thing to that.
- **Windows refuses some raises.** `SetForegroundWindow` fails when the calling
  process does not own the current foreground window. The client reports it
  instead of retrying; clicking the host once clears it.
- **Minimized windows cannot be streamed.** There are no pixels to print. They
  are listed but not openable, and a window minimized while open shows its last
  frame and says so.
- **The GDI fallback leaks overlaps.** If `PrintWindow` fails (some
  hardware-accelerated windows on older drivers), the Windows helper copies the
  screen at the window's coordinates instead — so anything covering the window
  on the host appears in the frame. Better than a black rectangle, worse than
  the real thing.
- **macOS window titles need Screen Recording.** Without that grant the window
  list still enumerates, but every title is empty and only the application name
  shows.
- **Cost scales with windows.** Each open window is its own capture and encode
  loop on the host. Six windows at 24fps is six times one window.
