// The desktop's appearance choice, as the phone offers it
// (app/src/settings/theme-toggle.tsx): Harbour, Night, Current, Fieldwork.
//
// The stored mode is one of those four, or 'system' (the default), which is
// Harbour by day and Night when the OS is dark. Pure: main.js owns the file
// and the broadcast, renderer/look.js paints whatever this resolves to.

/** The four choices the picker shows, in the phone's order and words. */
export const LOOK_CHOICES = Object.freeze([
  Object.freeze({ mode: 'harbour', label: 'Harbour' }),
  Object.freeze({ mode: 'night', label: 'Night' }),
  Object.freeze({ mode: 'current', label: 'Current' }),
  Object.freeze({ mode: 'fieldwork', label: 'Fieldwork' }),
]);

export const DEFAULT_MODE = 'system';
const MODES = new Set(['system', ...LOOK_CHOICES.map((choice) => choice.mode)]);

/** A stored or requested mode, or the default for anything unknown. */
export const normalizeMode = (mode) => (MODES.has(mode) ? mode : DEFAULT_MODE);

/**
 * `{ mode, name, look, scheme }` for a mode and the OS scheme.
 * `name` is the choice the picker highlights (system resolves to one), `look`
 * the data-look family (Night is Harbour's dark scheme), `scheme` light/dark.
 */
export function resolveLook(mode, systemDark) {
  const chosen = normalizeMode(mode);
  const name = chosen === 'system' ? (systemDark ? 'night' : 'harbour') : chosen;
  const look = name === 'night' ? 'harbour' : name;
  const scheme = name === 'night' || name === 'fieldwork' ? 'dark' : 'light';
  return Object.freeze({ mode: chosen, name, look, scheme });
}
