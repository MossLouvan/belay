// The track — the state logic behind the 2pt underline that marks tappable
// text (docs/DESIGN.md §11.1, "the track rule").
//
// In a system where a section marker, a ledger key and a quiet button are all
// the same 11pt tracked uppercase mono, the underline track is the one
// reserved mark that separates a control from a caption: accentGraphic when
// the control is selected or active, accentDim at rest, and never — ever —
// under inert text. The resolution lives here as pure functions so the rule
// itself is testable without a renderer, and so every surface that draws a
// track (TrackLabel, the dock, the ghost button) resolves it identically.

/** The four inks a tracked label can draw with. */
export interface TrackInkSet {
  /** Label ink at rest — usually `textDim`. */
  readonly restLabel: string;
  /** Label ink when selected/active — usually `accent`. */
  readonly activeLabel: string;
  /** The resting track — usually `accentDim`; quiet, but present. */
  readonly restTrack: string;
  /** The lit track — usually `accentGraphic`, the selection mark itself. */
  readonly activeTrack: string;
}

export interface TrackState {
  readonly active?: boolean;
  readonly disabled?: boolean;
}

/** What a tracked label actually paints for a given state. */
export interface TrackInks {
  readonly label: string;
  readonly track: string;
  readonly opacity: number;
}

/**
 * A disabled control dims as a whole — label AND track together — so it still
 * reads as a dimmed control rather than decaying into the inert-caption class
 * (the exact failure the audit found in disabled label buttons). Matches the
 * 0.45 used by Button and IconButton.
 */
export const DISABLED_TRACK_OPACITY = 0.45;

/** Resolves the inks for one tracked label. Pure; state in, colours out. */
export function trackInks(state: TrackState, inks: TrackInkSet): TrackInks {
  const active = Boolean(state.active);
  return {
    label: active ? inks.activeLabel : inks.restLabel,
    track: active ? inks.activeTrack : inks.restTrack,
    opacity: state.disabled ? DISABLED_TRACK_OPACITY : 1,
  };
}
