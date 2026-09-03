// The one honest description of "what is true about this screen right now".
//
// Every tab header speaks its state through this single descriptor, so the
// phrasing can never drift from tab to tab (docs/FRONTEND-REVAMP.md §4.1).
// `describeSurface` merges the app-wide link phase (src/connection.tsx) with
// an optional per-surface phase (the stream, the pty, the stats poll) into a
// CLOSED vocabulary — LIVE / OPENING / RECONNECTING / OFFLINE / NOT PAIRED,
// plus SHELL ENDED for the terminal — with one rule: link-down beats
// surface-state. A surface may not claim LIVE while the link is unreachable,
// nor cry OFFLINE while the link is still forming; whatever the link says is
// the ceiling on what any surface may say.
//
// Kept as a pure function in its own `.ts` module so it is unit-testable
// under `node --test` without JSX.

import type { Status } from './feedback';

/** The four states the app-wide connection can be in. Mirrors ConnectPhase. */
export type ConnectionPhase = 'idle' | 'connecting' | 'connected' | 'unreachable';

/**
 * What a tab's own surface knows, in five words. Callers map their richer
 * local vocabularies down to these (the stream's `stalled` → 'reconnecting',
 * the terminal's `exited` → 'ended') — the mapping is the tab's, the words
 * are everyone's.
 */
export type SurfacePhase = 'live' | 'opening' | 'reconnecting' | 'offline' | 'ended';

/** Optional facts a caller may ride along with the state. */
export interface SurfaceExtras {
  /**
   * `false` means no computer is paired at all — the one state that outranks
   * even the link, because there is nothing for the link to be down TO.
   */
  readonly paired?: boolean;
  /** A short trailing fact ("42 fps"), rendered dimmer after the word. */
  readonly detail?: string;
}

export interface SurfaceView {
  /** Hollow ring = transitioning (opening/reconnecting); filled = steady. */
  readonly ring: boolean;
  /** Dot tint — accent only while a link is forming, never for a fault. */
  readonly status: Status;
  /** One word from the closed vocabulary, already upper-case. */
  readonly word: string;
  /** A dim trailing fact; absent while transitioning — the ring says it. */
  readonly detail?: string;
}

const view = (ring: boolean, status: Status, word: string, detail?: string): SurfaceView =>
  detail === undefined ? { ring, status, word } : { ring, status, word, detail };

/** How each surface word renders once the link is up. Premium 2026: text-first, no dots. */
const SURFACE_VIEWS: Record<SurfacePhase, SurfaceView> = {
  live: view(false, 'good', 'Connected'),
  opening: view(true, 'accent', 'Connecting'),
  reconnecting: view(true, 'warn', 'Reconnecting'),
  offline: view(false, 'bad', 'Offline'),
  // An ended shell is a fact, not a fault — warn, so it reads calm.
  ended: view(false, 'warn', 'Shell ended'),
};

/**
 * Merge the link phase and a surface phase into the one status voice.
 *
 * Precedence, top wins:
 *   1. `paired: false`        → NOT PAIRED (nothing below applies)
 *   2. link `idle`            → OFFLINE (neutral — no attempt yet)
 *   3. link `unreachable`     → OFFLINE (bad, "asleep or off")
 *   4. link `connecting`      → OPENING — or RECONNECTING when the surface
 *                               was already retrying, the truer of the two
 *   5. link `connected`       → the surface speaks; no surface means LIVE
 *
 * `ring` is true for exactly the transitioning words (OPENING/RECONNECTING);
 * every steady word — good or bad — is a filled disc. A caller `detail` rides
 * only on steady words: while the ring spins the word is the whole truth.
 */
export function describeSurface(
  connPhase: ConnectionPhase,
  surfacePhase?: SurfacePhase,
  extras?: SurfaceExtras,
): SurfaceView {
  if (extras?.paired === false) return view(false, 'neutral', 'Not paired', extras.detail);

  if (connPhase === 'idle') return view(false, 'neutral', 'Offline', extras?.detail);

  if (connPhase === 'unreachable') {
    return view(false, 'bad', 'Offline', extras?.detail ?? 'asleep or off');
  }

  if (connPhase === 'connecting') {
    // The link re-racing while the surface was already retrying is one event,
    // not two; RECONNECTING is the word that admits there was something before.
    return surfacePhase === 'reconnecting' ? SURFACE_VIEWS.reconnecting : SURFACE_VIEWS.opening;
  }

  // Link up: the surface speaks. A tab with no surface of its own (stats,
  // files) is as live as its link.
  const base = SURFACE_VIEWS[surfacePhase ?? 'live'];
  return base.ring ? base : view(base.ring, base.status, base.word, extras?.detail);
}

/** @deprecated Shape kept for old callers — new code reads SurfaceView. */
export interface ConnectionView {
  readonly status: Status;
  /** Legacy name for "transitioning"; the Dot renders it as a ring now. */
  readonly pulse: boolean;
  readonly label: string;
}

/**
 * Back-compat wrapper over `describeSurface` for link-only callers.
 *
 * Same words, old shape: `pulse` carries `ring`, and the label folds the
 * detail (or the machine name, when steady and no detail speaks) in after a
 * mid-dot the way the old labels did.
 */
export function describeConnection(phase: ConnectionPhase, machine?: string): ConnectionView {
  const v = describeSurface(phase);
  const suffix = v.detail ?? (v.ring ? undefined : machine);
  return {
    status: v.status,
    pulse: v.ring,
    label: suffix ? `${v.word} · ${suffix}` : v.word,
  };
}
