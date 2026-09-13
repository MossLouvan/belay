// The ink a control uses when it is drawn on MACHINE GLASS.
//
// Belay keeps two surfaces deliberately near-black in both appearances: the
// terminal/pty panel and the live desktop stream, plus the HUD scrim that
// floats over them (docs/DESIGN.md §3.4). Paper inks fail there, so everything
// on that glass borrowed the dark palette with `getTheme('dark')`.
//
// That was right about the GROUND and wrong about the ACCENT. `getTheme('dark')`
// resolves to Fieldwork, whose accent is orange — so a user in Current, a blue
// app, got an orange terminal cursor, orange active dock keys, orange HUD
// chips and orange glass-state marks. The appearance stopped at the edge of
// the black rectangle.
//
// Nor is the fix to reach for the PAGE accent on glass. Current's
// `accentGraphic` (#245CCC) clears the 3:1 WCAG 1.4.11 bar for non-text marks
// on near-black, but only just (3.5:1) — it is tuned to sit on paper. What is
// wanted is the appearance's accent in its dark-ground variant, and that
// already exists: `darkPalette` is the neutral dark base carrying the BLUE
// accent (#5B9CF8, 7.6:1 on glass), and `fieldworkPalette` is that same base
// with the orange substituted (#F99657, 9.5:1). So the mapping is one line and
// invents no new colour.

import { darkPalette, fieldworkPalette } from '../theme';
import type { ColorScheme, Palette } from '../theme';

/**
 * The palette to draw with on machine glass, for the app's current appearance.
 *
 * Always a dark palette — the glass is near-black in both appearances — but
 * the accent family follows the appearance: blue under Current, orange under
 * Fieldwork. Pure lookup, safe outside React.
 */
export function machineInk(scheme: ColorScheme): Palette {
  return scheme === 'light' ? darkPalette : fieldworkPalette;
}
