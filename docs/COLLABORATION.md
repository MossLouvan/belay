# Collaboration: many cursors, one desktop

More than one person can be on a Belay host at once. This document is about
what that can and cannot mean, and why the design is shaped the way it is.

## The constraint everything follows from

**Windows and macOS have exactly one system cursor and one keyboard focus.**
There is no supported API to create a second hardware pointer. Windows shipped
one once — the MultiPoint Server SDK — and retired it; macOS has never had one.
X11 can do it with XInput2 MPX, and neither host platform is X11.

So a feature described as "give every user their own cursor" splits into two
halves that have to be built differently:

| Half | What it is | What it costs |
|---|---|---|
| **Pointing** | Where each person's cursor *is* | Nothing. It is a coordinate. |
| **Acting** | Clicking, typing, dragging | The one real pointer. Contended. |

Belay makes pointing free and unlimited, and rations acting.

## Virtual cursors

Every connected device gets a virtual cursor: a normalized `0..1` position held
in `server/src/cursors.ts` and broadcast to everyone on `/ws/cursors`. Moving
one touches no OS state whatsoever. Any number of people can point at the same
desktop simultaneously, and none of it takes the pointer away from whoever is
physically sitting at the machine.

Each cursor gets a light colour and a name tag:

- The hue is seeded from the device's own id, so a phone that drops off a flaky
  network comes back the **same colour** rather than making everyone re-learn
  who is who.
- Hues are kept at least 26° apart, walking the circle by the golden angle
  until a free slot is found. Two people never get the same pastel blue.
- The band around Belay's accent orange is reserved, so a user cursor is never
  mistaken for a piece of the UI.
- Colours are pastel — lightness 0.76 — because they sit over arbitrary desktop
  content. The clients draw a dark seam under the arrow so a pale cursor stays
  visible on a white document, and pick tag ink by WCAG relative luminance
  rather than assuming dark-on-light.

A cursor that has not moved for 45 seconds stops being broadcast, and a cursor
whose socket closes disappears at once. Presence dies with the connection.

## The input floor

Acting is gated by a floor — `server/src/input-floor.ts` — that exactly one
person holds at a time. Two rules, in order.

### 1. The person at the machine always wins

The host's own idle counter is sampled every 300 ms while remote input is live
(`idle` verb, `GetLastInputInfo` on Windows). Real input at the host freezes
remote input for 3 seconds and evicts whoever held the floor.

There is a subtlety worth stating plainly: **`GetLastInputInfo` counts injected
input too.** Without accounting for that, every remote click would look like a
local user and freeze the next one. So the server records when it injects, and
`isLocalActivity` treats input landing within 400 ms of its own injection as its
own. The cost is bounded and one-sided — a human who touches the mouse in the
same 400 ms window as a remote click is missed once, and caught on their next
movement.

Cursors keep moving through a freeze. Collaborators can still point and follow
along; they just cannot click. Pointing was never the thing that interfered.

**Windows only, today.** The `idle` verb is implemented in `BelayHost.cs`; the
macOS helper answers `unknown command`, `native.idleMs()` catches that and
returns `null`, and `isLocalActivity` treats a missing probe as *no evidence of
a local user*. So on a macOS host rule 1 does not engage and only rule 2 is in
force. That degradation is deliberate and one-directional: freezing on no
evidence would leave a desktop nobody could drive. The macOS equivalent is
`CGEventSourceSecondsSinceLastEventType`, and wiring it up is a small, separate
change.

### 2. Otherwise, one driver at a time

A grant lasts 1.5 seconds and is renewed by each further action, so one person's
drag or typed burst completes as a unit. An abandoned lease lapses on its own —
a phone that walks into a lift does not hold the desktop hostage.

Before this existed, every device's input went straight to `native.*` and the
helper's single command queue decided the order. Two people clicking at once
produced an arbitrary interleaving of both, on whichever pixels the last move
happened to land on. A drag was worst: `down`, `move`, `up` are three separate
helper commands, and a second user's click could land between the press and the
release — on the first user's button, at the second user's coordinates. Holding
the floor across all three makes the gesture atomic.

## What each route does now

| Route | Needs the floor | Refused how |
|---|---|---|
| `/input/move` | For the real pointer only | Never fails — `200 {virtual: true}` |
| `/input/click` | Yes | `409` naming the holder |
| `/input/drag` | Yes, across all three legs | `409` |
| `/input/scroll` | Yes | `409` |
| `/input/key` | Yes | `409` |
| `/input/text` | Yes | `409` |

`/input/move` is deliberately the exception. The virtual cursor always updates —
that is the whole point, since pointing must not depend on holding the desktop —
and only the leg that warps the real pointer is gated. A refused move still
returns `200`, saying it stayed virtual.

A refusal body names who has it, so the app can say *"Jack is driving"* rather
than silently dropping the tap:

```json
{ "error": "Jack is acting on this desktop", "reason": "held",
  "holder": "9f2c1ab0de", "holderName": "Jack", "retryInMs": 812 }
```

`reason` is `local` when the freeze is the host's own user, and that body
carries no `holder` — the person at the keyboard is not a connected device and
has no cursor id.

### A solo user is unaffected

One person on an idle host is granted the floor on every request. Every route
behaves exactly as it did before this feature existed. The machinery only
becomes visible when someone else shows up.

## The wire

`/ws/cursors`, authenticated by the same ticket as every other socket.

Host to client, once on connect:

```json
{ "type": "hello", "id": "9f2c1ab0de", "name": "Moss", "color": "#a8d8ff" }
```

Host to client, at most 20 Hz and only when something changed:

```json
{ "type": "cursors", "cursors": [
  { "id": "9f2c1ab0de", "name": "Moss", "color": "#a8d8ff",
    "x": 0.41, "y": 0.62, "screen": 0, "acting": true }
] }
```

Client to host:

```json
{ "type": "move", "x": 0.41, "y": 0.62, "screen": 0 }
```

Every socket receives the same payload, self included, and each client drops its
own id when painting — one serialization, one diff, one send per tick, rather
than a per-socket rendering that would scale with the square of the party size.
An unchanged set is not sent at all, so a room where nobody is moving costs
nothing.

`id` is a SHA-256 prefix of the bearer token, never the token itself: these rows
go to every other connected device, and broadcasting the key would hand every
paired phone the credentials of every other one.

## Not done here

**The host's own monitor shows no overlay.** Remote cursors are painted by the
clients, over the streamed frame. Someone sitting at the machine sees their own
pointer and nothing else — they get the tray icon and the connect popup from the
presence work, but not the cursors themselves. Painting those needs a
click-through layered window on Windows and an `NSWindow` at
`.screenSaver` level on macOS. That is the natural next step and it is
deliberately not in this change.

**Nothing here makes two people able to type at once.** It cannot be made to.
The floor decides who goes first; it does not create a second keyboard.
