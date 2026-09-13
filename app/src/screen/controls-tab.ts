// The landscape controls tab — geometry and visibility, as pure numbers.
//
// Sideways the control bar auto-hides after four seconds (autohide.ts) and the
// only way back was a swipe up from the very bottom edge. That gesture is
// correct — it can never be mistaken for remote input — but it is INVISIBLE,
// and the founder's verdict on finding it was "right now it's not very
// user-friendly". So landscape also gets something you can see: a small tab
// stuck to the LEFT edge near the top, which says the word "Controls" and
// brings the bar back on one tap.
//
// Three constraints shape it, and each is a function here rather than a magic
// number in JSX:
//
//  1. It must not sit on top of the picture's useful middle. It is pinned to
//     the left edge, one touch target tall, and `controlsTabFrame` is the only
//     place its box is decided — so a test can assert it never covers the
//     centre of the stage.
//  2. It must not eat gestures the trackpad needs. It is mounted ONLY while the
//     bar is hidden (`controlsTabVisible`), and its box is small enough that a
//     pad drag starting anywhere but that corner is untouched.
//  3. It must clear the immersive HUD's own top row (the Connected pill and the
//     orientation latch), which already owns the very top band — hence the offset
//     rather than a flush corner.
//
// Pure module: no React, no react-native.

/** One touch target tall, wide enough for the word plus its chevron. */
export const CONTROLS_TAB_SIZE = Object.freeze({ width: 112, height: 44 });

/**
 * Clearance below the immersive HUD, which is two stacked blocks: the top row
 * (link pill / orientation latch) and, beneath it, the record strip and notices.
 * 56 cleared only the first and landed squarely on the second, hiding the
 * recording indicator behind the tab — and that indicator is a privacy state,
 * so it is the one thing that must never be covered.
 */
export const CONTROLS_TAB_TOP_GAP = 108;

export interface ControlsTabVisibility {
  /** The chrome is floating (landscape, or the portrait Full toggle). */
  readonly immersive: boolean;
  /** Gaming owns the whole screen and has its own exits. */
  readonly gaming: boolean;
  /** The control bar is already on screen — the tab would be noise. */
  readonly dockShown: boolean;
}

/**
 * The tab exists exactly when the controls are away and could be wanted: while
 * immersive, outside gaming, with the bar hidden. Anywhere else the bar itself
 * is the affordance and a second one would be clutter.
 */
export const controlsTabVisible = ({ immersive, gaming, dockShown }: ControlsTabVisibility): boolean =>
  immersive && !gaming && !dockShown;

export interface Frame {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface ControlsTabInsets {
  /** Safe-area top inset (the notch band in landscape is the left inset). */
  readonly top: number;
  readonly left: number;
}

/** Where the tab sits, in screen points: flush left, under the HUD's top row. */
export const controlsTabFrame = (insets: ControlsTabInsets): Frame => ({
  top: insets.top + CONTROLS_TAB_TOP_GAP,
  left: insets.left,
  width: CONTROLS_TAB_SIZE.width,
  height: CONTROLS_TAB_SIZE.height,
});

/** Whether a touch at (x, y) lands on the tab — the "does it eat my drag?" test. */
export const frameContains = (frame: Frame, x: number, y: number): boolean =>
  x >= frame.left && x <= frame.left + frame.width && y >= frame.top && y <= frame.top + frame.height;

/** Share of a screen the tab covers. Used to hold the footprint honest. */
export const controlsTabCoverage = (frame: Frame, width: number, height: number): number =>
  width <= 0 || height <= 0 ? 0 : (frame.width * frame.height) / (width * height);
