// Seamless-window logic for the desktop client.
//
// The host streams one window at a time over /ws/window, and every frame
// carries that window's current rectangle on the host. This module decides what
// the local window should look like in response — kept apart from the Electron
// and DOM code so the decisions can be tested without either.

/** One window as /windows reports it, sanitized again on this side. */
export function windowsOf(payload) {
  const raw = payload?.windows;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const id = typeof entry.id === 'string' && /^[0-9]{1,20}$/.test(entry.id) ? entry.id : null;
    if (!id || out.some((w) => w.id === id)) continue;
    out.push({
      id,
      title: typeof entry.title === 'string' ? entry.title : '',
      app: typeof entry.app === 'string' ? entry.app : '',
      w: Number.isFinite(entry.W) ? entry.W : 0,
      h: Number.isFinite(entry.H) ? entry.H : 0,
      minimized: entry.minimized === true,
      z: Number.isFinite(entry.z) ? entry.z : out.length,
    });
  }
  return out.sort((a, b) => a.z - b.z);
}

/**
 * What to show as a window's name.
 *
 * The app name leads because it is stable and short, and the title follows
 * because it is what distinguishes two windows of the same app. A window with
 * neither still gets something rather than an empty title bar.
 */
export function windowLabel(window) {
  const app = (window?.app || '').trim();
  const title = (window?.title || '').trim();
  if (app && title) return `${app} — ${title}`;
  return app || title || 'Untitled window';
}

/**
 * The scale a local window is currently showing a remote window at.
 *
 * Kept as an explicit number rather than re-derived from each new frame,
 * because the two things it is derived from change independently: the user
 * resizes the local window, and the remote window resizes itself. Deriving the
 * scale from the newest rectangle would read a remote resize as the user having
 * zoomed, and the window would never actually follow the remote size.
 */
export function scaleOf(current, rect) {
  if (!(current?.width > 0) || !(rect?.W > 0)) return 1;
  return current.width / rect.W;
}

/**
 * The local window size for a remote rectangle at a given scale.
 *
 * A remote window that grows by 20% grows the local window by 20%; it does not
 * jump to the remote pixel size, which on a laptop is often larger than the
 * whole local screen. The floor keeps a window that reports something absurd
 * from becoming impossible to grab.
 */
export function aspectFit(rect, scale = 1) {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    width: Math.max(160, Math.round(rect.W * factor)),
    height: Math.max(120, Math.round(rect.H * factor)),
  };
}

/**
 * Whether a frame's rectangle means the local window should be resized.
 *
 * Only the *size* is mirrored, never the position: the local desktop has its
 * own monitor layout and its own idea of where the user put this window, and
 * yanking it to the host's coordinates every time somebody nudges the remote
 * window would make it impossible to place. Size has to be mirrored, because it
 * changes what the stream contains.
 *
 * The tolerance exists because the host reports integer pixels and the local
 * window has its own DPI scaling; without it a one-pixel disagreement becomes a
 * resize on every single frame, and the window shivers.
 */
export function shouldResize(current, rect, scale = 1, tolerance = 2) {
  if (!rect || !(rect.W > 0) || !(rect.H > 0)) return false;
  if (!current || !(current.width > 0) || !(current.height > 0)) return true;
  const target = aspectFit(rect, scale);
  return Math.abs(target.width - current.width) > tolerance
    || Math.abs(target.height - current.height) > tolerance;
}

/**
 * Initial size for a newly opened remote window, fitted to the local screen.
 *
 * Never upscaled: a 400x300 remote window opens at 400x300, not blown up to
 * fill a monitor. Margins leave room for the local taskbar and for the window
 * not to sit flush against the screen edge.
 */
export function initialSize(window, workArea, margin = 120) {
  const sourceW = window?.w > 0 ? window.w : 1024;
  const sourceH = window?.h > 0 ? window.h : 768;
  const maxW = Math.max(320, (workArea?.width ?? 1600) - margin);
  const maxH = Math.max(240, (workArea?.height ?? 900) - margin);
  const scale = Math.min(1, maxW / sourceW, maxH / sourceH);
  return { width: Math.round(sourceW * scale), height: Math.round(sourceH * scale) };
}

/**
 * Where to place the nth window opened in one go, so a batch does not stack
 * every window on the same pixel. Cascades and wraps rather than running off
 * the screen.
 */
export function cascadeOffset(index, step = 32, wrapAfter = 8) {
  const position = index % wrapAfter;
  return { x: position * step, y: position * step };
}
