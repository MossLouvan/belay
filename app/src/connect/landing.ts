// Where the connect screen sends someone who did not come to pair.
//
// The screen is the app's front door, so it opens on everyone: a fresh
// install, a launch with computers already saved, and — since the second
// computer became a first-class citizen — someone who tapped "Add a computer"
// with a connection already live. The first belongs here; the second belongs
// on whatever it was already set up for; the third must NOT be bounced away,
// or the button that brought them here becomes a door that opens onto itself.
//
// Pure, so the routing decision can be unit tested under node.

export type ConnectLanding = '/(home)/screen' | '/devices' | null;

export interface LandingInputs {
  /** The saved-computer store has been read; before that, nothing can move. */
  readonly ready: boolean;
  /** A live connection exists — the tabs have somewhere real to stand. */
  readonly connected: boolean;
  readonly deviceCount: number;
  /** An address race is in flight; its outcome decides, not this screen. */
  readonly connecting: boolean;
  /** The user came to pair another computer on purpose (the `add` param). */
  readonly adding: boolean;
}

/**
 * Null means stay and show the pairing flow. Anything else is a redirect:
 * a live connection goes to the tabs, saved-but-unconnected goes to the list
 * — the only screen that can explain "your Mac did not answer" and offer
 * somewhere to go next.
 */
export function connectLanding(i: LandingInputs): ConnectLanding {
  if (!i.ready || i.adding) return null;
  if (i.connected) return '/(home)/screen';
  if (i.deviceCount > 0 && !i.connecting) return '/devices';
  return null;
}

/** Where a fresh pair drops the user in. */
export type PairDestination = '/(home)/screen' | '/(home)/system';

/**
 * The first tab shown right after pairing. A Mac that has not granted the
 * screen-capture permission serves a black Screen tab — a broken-looking first
 * impression for a brand-new user (docs/FRONTEND-REVAMP.md §4.3 / §5 #4). When
 * `/health` says the capture helper is not available (`native: false`), land on
 * System instead: it always works, and the Screen tab keeps its own recovery
 * card for when the user does open it.
 *
 * `native` is `HostCheck.native`. An older host that reports neither way leaves
 * it `undefined`; we do not assume the tab is broken then, so the destination
 * stays Screen exactly as before — only an explicit `false` reroutes.
 */
export function postPairDestination(native: boolean | undefined): PairDestination {
  return native === false ? '/(home)/system' : '/(home)/screen';
}
