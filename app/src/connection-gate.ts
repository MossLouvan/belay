// When a screen may ask the host for something (#85). On a reload or deep
// link the saved connection is still racing when the screen mounts, so a
// request fired on mount fails with "not connected" and nothing re-runs it.
// Screens fire once this says true, and again whenever the phase settles.

import type { ConnectPhase } from './connection';

/** True once the store has loaded and no connect attempt is in flight. */
export const hostSettled = (ready: boolean, phase: ConnectPhase): boolean =>
  ready && phase !== 'connecting';
