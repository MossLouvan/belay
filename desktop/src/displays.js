// Choosing which of the host's displays a desktop window should show.
//
// Kept apart from the UI because the preference rule is the interesting part
// and deserves a test: a desktop client's whole appeal over the phone app is
// that it can take a display the person at the host is *not* using, so a
// virtual display outranks the primary whenever one exists.

/**
 * Sanitized display list from a /screen/info reply.
 *
 * Mirrors app/src/screen/monitors.ts screensOf — an entry that cannot be
 * requested (no usable index) is dropped rather than repaired, and a host too
 * old to enumerate monitors yields [], which the UI reads as "no picker, send
 * no index" so the host falls back to its primary exactly as it always did.
 */
export function displaysOf(info) {
  const raw = info?.screens;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { index, primary, W, H, virtualDisplay, label } = entry;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) continue;
    if (out.some((d) => d.index === index)) continue;
    out.push({
      index,
      primary: primary === true,
      w: typeof W === 'number' && Number.isFinite(W) && W > 0 ? W : 0,
      h: typeof H === 'number' && Number.isFinite(H) && H > 0 ? H : 0,
      virtual: virtualDisplay === true,
      name: typeof label === 'string' ? label.slice(0, 64) : `Display ${index + 1}`,
    });
  }
  return out;
}

/**
 * The display to open first.
 *
 * A virtual display if the host has one — that is the point of the feature —
 * otherwise the primary, otherwise whatever is listed first. Undefined only
 * when the host enumerates nothing at all.
 */
export function preferredDisplay(displays) {
  if (!Array.isArray(displays) || displays.length === 0) return undefined;
  return displays.find((d) => d.virtual) ?? displays.find((d) => d.primary) ?? displays[0];
}

/**
 * Window size for a display, fitted inside the local screen's work area.
 *
 * Aspect ratio is preserved rather than clamped per-axis, because a window
 * whose shape differs from the remote display's shows the stream letterboxed
 * inside itself — which then makes every pointer coordinate the user aims at
 * land somewhere the maths has to undo.
 */
export function fitWindow(display, workArea, margin = 80) {
  const sourceW = display?.w > 0 ? display.w : 1600;
  const sourceH = display?.h > 0 ? display.h : 900;
  const maxW = Math.max(480, (workArea?.width ?? 1600) - margin);
  const maxH = Math.max(320, (workArea?.height ?? 900) - margin);
  const scale = Math.min(1, maxW / sourceW, maxH / sourceH);
  return { width: Math.round(sourceW * scale), height: Math.round(sourceH * scale) };
}
