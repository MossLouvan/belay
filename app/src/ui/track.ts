// The track — the state logic behind the 2pt underline that marks tappable
// text (docs/DESIGN.md §11.1, "the track rule", as amended by
// docs/REVAMP-SPEC.md §5.3 "quieter rope" + §6.3 "the rope as structure").
//
// In a system where a section marker, a ledger key and a quiet button are all
// the same 11pt tracked uppercase mono, the underline track is the one
// reserved mark that separates a control from a caption. The rope metaphor
// (REVAMP-SPEC §1) assigns each state a colour:
//
//   rest    → `trackRest` (neutral granite — the rope slack). NOT orange:
//             "orange means engaged" (REVAMP-SPEC §7 rule 4). The MARK is the
//             affordance; the colour is reserved for load.
//   pressed → `accentGraphic`, instantly ("the rope takes load", §3.5) with
//             the label snapping to full ink; released, it relaxes back.
//   active  → `accentGraphic` — selected/armed keys stay lit.
//   never   → under inert text.
//
// The resolution lives here as pure functions so the rule itself is testable
// without a renderer, and so every surface that draws a track (TrackLabel,
// the dock, the ghost button) resolves it identically.

/** The inks a tracked label can draw with. */
export interface TrackInkSet {
  /** Label ink at rest — usually `textDim`. */
  readonly restLabel: string;
  /** Label ink when selected/active — usually `accent`. */
  readonly activeLabel: string;
  /** The resting track — `trackRest`: granite, quiet, but present
   *  (REVAMP-SPEC §5.3 — never orange at rest). */
  readonly restTrack: string;
  /** The loaded track — usually `accentGraphic`: the selection mark itself,
   *  and the press-in ignition colour (REVAMP-SPEC §3.5). */
  readonly activeTrack: string;
  /** Label ink while pressed — usually full `text` ink ("the rope takes
   *  load", REVAMP-SPEC §3.5). Optional so bespoke ink sets (HUD) may omit
   *  it; falls back to `activeLabel`. */
  readonly pressLabel?: string;
}

export interface TrackState {
  readonly active?: boolean;
  readonly disabled?: boolean;
  /** Finger down on the control right now (REVAMP-SPEC §3.5 ignition). */
  readonly pressed?: boolean;
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

/**
 * Resolves the inks for one tracked label. Pure; state in, colours out.
 * Always returns a new object — never mutates its inputs.
 *
 * Precedence: disabled ignores `pressed` (a disabled key cannot take load);
 * `active` outranks `pressed` for the label (an already-lit key keeps its
 * accent label under the finger); both light the track to `activeTrack`.
 */
export function trackInks(state: TrackState, inks: TrackInkSet): TrackInks {
  const active = Boolean(state.active);
  const pressed = Boolean(state.pressed) && !state.disabled;
  const label = active
    ? inks.activeLabel
    : pressed
      ? (inks.pressLabel ?? inks.activeLabel)
      : inks.restLabel;
  return {
    label,
    // Ignition: press-in loads the rope to the same orange as selection —
    // one mark, one meaning (engaged), per REVAMP-SPEC §7 rule 4.
    track: active || pressed ? inks.activeTrack : inks.restTrack,
    opacity: state.disabled ? DISABLED_TRACK_OPACITY : 1,
  };
}
