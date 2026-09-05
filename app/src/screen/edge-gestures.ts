// Edge gesture detection for 2-finger swipes from screen edges/corners.
// Used to trigger OS-level actions like Notification Center on macOS or
// Action Center on Windows, matching real trackpad behavior.

export type EdgeZone = 'top-left' | 'top-right' | 'top' | 'left' | 'right' | 'none';

/** Tuning constants for edge detection. */
export interface EdgeTuning {
  /** Distance from edge (in px) that qualifies as an edge start. */
  readonly edgeThresholdPx: number;
  /** Distance from corner (in px) that qualifies as a corner start. */
  readonly cornerThresholdPx: number;
  /** Minimum travel distance to commit an edge gesture. */
  readonly edgeSwipeThresholdPx: number;
}

export interface EdgeGestureResult {
  /** Which edge zone the gesture started in. */
  zone: EdgeZone;
  /** Direction of the swipe ('down', 'right', etc). */
  direction: 'down' | 'right' | 'left' | 'up' | null;
}

/**
 * Detect which edge zone a touch started in based on its position relative
 * to the stage boundaries. Returns 'none' if not near an edge.
 */
export function detectEdgeZone(
  x: number,
  y: number,
  stageWidth: number,
  stageHeight: number,
  tuning: EdgeTuning,
): EdgeZone {
  const { edgeThresholdPx, cornerThresholdPx } = tuning;
  
  const nearTop = y <= edgeThresholdPx;
  const nearLeft = x <= edgeThresholdPx;
  const nearRight = x >= stageWidth - edgeThresholdPx;
  
  // Corner zones (smaller threshold for more precise corner detection)
  const inTopLeftCorner = x <= cornerThresholdPx && y <= cornerThresholdPx;
  const inTopRightCorner = x >= stageWidth - cornerThresholdPx && y <= cornerThresholdPx;
  
  if (inTopLeftCorner) return 'top-left';
  if (inTopRightCorner) return 'top-right';
  if (nearTop) return 'top';
  if (nearLeft) return 'left';
  if (nearRight) return 'right';
  
  return 'none';
}

/**
 * Detect an edge gesture: a 2-finger swipe that started from a screen edge.
 * Returns null if the gesture hasn't met the threshold, or an EdgeGestureResult
 * if it has committed to a direction.
 * 
 * On macOS, a 2-finger swipe from the top-right typically opens Notification Center.
 * On Windows, we map this to the Action Center (Win+A) since there's no direct
 * edge gesture equivalent.
 */
export function detectEdgeGesture(
  startX: number,
  startY: number,
  dx: number,
  dy: number,
  stageWidth: number,
  stageHeight: number,
  tuning: EdgeTuning,
): EdgeGestureResult | null {
  const zone = detectEdgeZone(startX, startY, stageWidth, stageHeight, tuning);
  
  if (zone === 'none') return null;
  
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const totalTravel = Math.max(ax, ay);
  
  if (totalTravel < tuning.edgeSwipeThresholdPx) return null;
  
  // Determine primary direction
  let direction: 'down' | 'right' | 'left' | 'up' | null = null;
  if (ax > ay) {
    direction = dx > 0 ? 'right' : 'left';
  } else {
    direction = dy > 0 ? 'down' : 'up';
  }
  
  return { zone, direction };
}

/**
 * Map an edge gesture to an action ID (KeySpec id from model.ts).
 * Returns null if the gesture doesn't map to any action, or if the action
 * is not supported on the current host OS.
 * 
 * Current mappings:
 * - 2-finger swipe down from top edge → Action Center (Windows only)
 * 
 * @param result The detected edge gesture
 * @param isMac Whether the host is macOS (vs Windows)
 */
export function edgeGestureToAction(result: EdgeGestureResult, isMac: boolean): string | null {
  if (!result) return null;
  
  const { zone, direction } = result;
  
  // 2-finger swipe from top edge inward → Action Center (Windows only).
  // macOS has no default Notification Center hotkey — users must configure
  // their own shortcut in System Settings → Keyboard if they want this.
  if ((zone === 'top-left' || zone === 'top-right' || zone === 'top') && direction === 'down') {
    return isMac ? null : 'NotifyCenter';
  }
  
  // Future: Add more edge gesture mappings here as needed
  // e.g., swipe from left edge for app switching, etc.
  
  return null;
}
