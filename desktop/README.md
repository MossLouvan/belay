# Belay for Mac and Windows

Two roles in one app:

- **Host** (default, in the menu bar): runs the Belay host agent so your phone
  can reach this computer. Shows the pairing QR, walks through the macOS
  Screen Recording / Accessibility grants (they land on *Belay*, not on
  Terminal), and starts at login once a phone has linked. This is the
  one-download install: `Belay-mac-universal.dmg` / `Belay-Setup.exe` from
  GitHub Releases, see [`docs/RELEASE.md`](../docs/RELEASE.md).
- **Viewer** ("Control another computer…" in the menu): open another computer's
  displays as ordinary windows on this desktop — resizable, alt-tabbable,
  snappable beside your local apps. Everything below this section is about
  the viewer.

## The host role

`host.js` forks the compiled agent (`server/dist/index.js`, staged into
`Resources/host` by `scripts/stage-host.mjs`) as an Electron `utilityProcess`
and talks to it over the parent port (`server/src/host-ipc.ts`): the host
posts its pairing link and QR matrix, the app answers the phone's autostart
toggle with the login-item state. Node is Electron's own; the user installs
nothing else. The prebuilt universal `BelayHostMac` ships inside the bundle,
so the TCC grant attaches to the app.

```bash
npm start                        # host + viewer from this checkout (needs ../server built)
BELAY_PORT=8790 npm start        # beside a running npx/LaunchAgent host
npm run stage                    # server build + prod deps + helper → desktop/host/
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac   # unsigned local Belay.app + dmg
```

State lives in the app's userData (`belay-state.json`, `host.log`,
`host-prefs.json`), not in `server/`. If another host already answers on the
port (the `com.belay.host` LaunchAgent, say), the app waits and says so
instead of racing it, and offers "Use Belay.app instead", which unloads the
agent and parks its plist as `.plist.disabled` (`src/launch-agent.js`). A
second launch of the app just shows the first one's window.

## Sign in on the computer (no QR)

Unlinked, the host window offers **Sign in to link this computer** above the
claim QR. Signing in with the same account as the phone links this computer
directly: the app (`src/account-signin.js`) gets a session from the accounts
API, hands it to the host child once (`link-session` over the parent port),
the host signs the `belay-claim:v1:` node proof with the sidecar and calls
`POST /hosts/link`, stores the host credential at 0600 (same file as the claim
path) and the session is dropped. It is never written to disk and never
reaches the window. The window then says "Linked to us***@example.com", and the
computer shows up in the phone's list by itself (`GET /devices`).

Email code works out of the box. **Sign in with Apple** and **Sign in with
Google** use the system browser and show only once configured, either in
`SIGN_IN` at the top of `src/account-signin.js` (shipped builds) or with the
`BELAY_*` variables below (local runs). None of these values is a secret
kept on a server; they ship inside the app.

Google (`BELAY_GOOGLE_CLIENT_ID`, `BELAY_GOOGLE_CLIENT_SECRET`):
1. Google Cloud Console → the project that holds the iOS client → APIs &
   Services → Credentials → Create credentials → OAuth client ID → type
   **Desktop app**, name "Belay desktop". No redirect URI to register: desktop
   clients accept any `http://127.0.0.1:<port>` loopback redirect.
2. Copy the client ID and client secret into `SIGN_IN.googleClientId` /
   `googleClientSecret`. (Google documents a desktop client's secret as not
   confidential; PKCE protects the code.)
3. Add the client ID to `GOOGLE_AUDIENCES` in `infra/accounts/wrangler.toml`
   and `npm run deploy` there, or `/auth/google` rejects its tokens.
4. The OAuth consent screen must be published (or your account added as a
   test user) with the `openid` and `email` scopes.

Apple (`BELAY_APPLE_SERVICES_ID`, optional `BELAY_APPLE_REDIRECT_URL`):
1. developer.apple.com → Certificates, Identifiers & Profiles → Identifiers →
   **+** → **Services IDs**, e.g. `com.mosslouvan.belay.signin`, description
   "Belay desktop sign-in". Register it.
2. Open it, tick **Sign in with Apple** → Configure: primary App ID
   `com.mosslouvan.belay` (so accounts match the iPhone app's: Apple's `sub`
   is the same across one team), Domains `gobelay.com`, Return URLs
   `https://gobelay.com/auth/desktop-callback`. Save, then Continue → Save.
3. Publish `desktop/oauth/apple-callback.html` on the site at
   `/auth/desktop-callback` (Cloudflare Pages: as
   `auth/desktop-callback/index.html` or with a `_redirects` rewrite). It reads
   the fragment Apple returns and forwards the id_token to the app's one-shot
   127.0.0.1 listener; it stores nothing.
4. Put the Services ID in `SIGN_IN.appleServicesId`, and add it to
   `APPLE_AUDIENCE` in `infra/accounts/wrangler.toml` (comma-separated after
   the bundle id), then `npm run deploy` there.

No email address is requested from Apple (that would force `form_post`, which a
static page cannot read); a first-time Apple user on the computer who signed up
on the phone with Apple still lands in the same account by `sub`.

## The viewer role

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
npm test          # pure-logic unit tests, no Electron needed
npm run test:harness   # the real display renderer, hidden, against a mock host that injects faults
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
- **Controllers and Gaming.** Each display window has a Gaming toggle and a
  controller/backend indicator. DualSense and DualShock 4 use PlayStation
  glyphs; standard Xbox/generic pads use ABXY. Gaming sends the first connected
  controller through the paired host's controller lane, returns rumble when
  the browser supports it, and applies the phone's low-latency JPEG preset.
  See [`docs/GAMEPAD.md`](../docs/GAMEPAD.md#from-the-desktop-client) for setup,
  multi-window ownership, device checks and limitations.
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
| `host.js` | the host role: utilityProcess child, tray menu, QR window, permissions, login item |
| `preload-host.cjs` / `renderer/host.*` | the host window and its narrow bridge |
| `src/host-status.js` | pure host pieces: pairing link parse, QR→SVG, status line, login-item rule |
| `scripts/stage-host.mjs`, `electron-builder.config.mjs`, `build/` | packaging (see `docs/RELEASE.md`) |
| `preload.cjs` | the renderer's only privileged surface — four IPC calls |
| `renderer/tokens.css` | GENERATED from `app/src/theme.ts` — every palette, type, spacing, radius, motion and HUD token; all four looks: Harbour on `:root`, Night under `data-theme="dark"`, Current and Fieldwork under `data-look` |
| `renderer/fonts/` | the Harbour faces the phone loads (Fredoka 600, Nunito 500/600/700), plus their OFL licences |
| `scripts/sync-tokens.mjs` | regenerates `renderer/tokens.css` and `src/ground.js` from the phone theme (`npm run sync-tokens`) |
| `src/ground.js` | GENERATED — the window grounds `main.js` paints before CSS loads |
| `src/address-feedback.js` | the live line under the address field, in the app's words |
| `renderer/connect.*` | pairing and the display list |
| `renderer/display.*` | a whole display: stream canvas and input forwarding |
| `renderer/seamless.*` | one remote window: same, plus size/title following |
| `src/session.js` | host + token persistence, owner-only (`0600`) |
| `src/displays.js` | display list sanitizing, preference, window fitting |
| `src/windows.js` | window list, labels, resize/scale rules, cascade |
| `src/keymap.js` | KeyboardEvent → the host's key/text endpoints |
| `src/modmap.js` | which modifier means what, per client/host pairing |
| `src/url.js` | what someone types → a host origin |
| `src/binary-frame.js` | the host's binary pixel frame and the legacy base64 one → JPEG bytes |
| `src/frame-latch.js` | newest-wins decode slot: one decode in flight, one waiting, older frames dropped |
| `src/stream-link.js` | link health: stall detection, reconnect backoff, an honest status line |
| `src/gamepad-*.js` | standard mapping, controller kind, binary frame, timing, rumble and Gaming config |
| `renderer/gamepad.js` | Gamepad API polling, ticket/socket lifecycle and controller chrome |
| `test/` | `node --test` over every `src/` module |
| `test/smoke.cjs` | manual end-to-end check against a live host (see the header) |
| `test/harness/` | `npm run test:harness`: display.html in a hidden Electron window against a mock host (`ws` from `../server`) that injects bursts, slow frames, closes, stalls and a half-open socket |

The look is the phone app's, token for token. `renderer/tokens.css` is not
written by hand: `npm run sync-tokens` evaluates `app/src/theme.ts` under
node (with two tiny stubs standing in for react and react-native, see
`scripts/stubs/`) and renders every palette role, type variant, spacing step,
radius, layout constant, motion duration and easing as a CSS custom property,
plus the stream HUD's inks from `app/src/screen/parts.tsx`. `test/tokens.test.mjs`
regenerates it in memory on every `npm test` and fails, naming the token,
when the committed file and the theme disagree — so a theme change on the
phone that is not followed by a sync breaks the desktop build rather than
quietly leaving it behind.

The components are the phone's too: the Button in the look's button type,
the 44/56px Button, the mono hero Input with its accent rope on focus,
TrackLabel words with their 2px track, 52px hairline ledger rows, the
SegmentedControl, the cartoon beluga (Harbour, Night) or flat mark (Current,
Fieldwork) on the hero, the Dock's keys and BoxedToggle on the HUD scrim.

Appearance is the phone's four looks — Harbour, Night, Current, Fieldwork —
picked in the host and connect windows or the tray's Appearance menu, stored
in `appearance.json` in userData (`src/look.js`, `main.js`). The default
follows the OS: Harbour by day, Night when dark. `renderer/look.js` sets
`data-look`/`data-theme` on `<html>` before the first paint and follows
changes live. Streams sit on a dark machine panel in every look (Night's,
or Fieldwork's under the flat looks). `test/renderer-assets.test.mjs` fails
on a raw hex colour outside tokens.css or any reference to the 3D render. Every
stylesheet and font is local; the CSPs allow no inline styles and nothing
remote.

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
