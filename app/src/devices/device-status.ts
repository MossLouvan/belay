// The one word under a computer's name, and the colour of the dot beside it.
//
// Both concept mockups reduce a device row's state to exactly this: a small
// dot and a single word — "Available", "Offline", "Connected". The rules for
// which word and which tone are pure so the card stays a view, and so the
// "checking" case cannot silently start rendering as "Offline" again.

import type { Reachability } from './reachability';

export type StatusTone = 'good' | 'faint' | 'dim';

export interface DeviceStatus {
  readonly word: string;
  readonly tone: StatusTone;
  /** The computer can be connected to right now. Gates the Connect button. */
  readonly actionable: boolean;
}

const CONNECTED: DeviceStatus = Object.freeze({ word: 'Connected', tone: 'good', actionable: true });
const AVAILABLE: DeviceStatus = Object.freeze({ word: 'Available', tone: 'good', actionable: true });
const OFFLINE: DeviceStatus = Object.freeze({ word: 'Offline', tone: 'faint', actionable: false });
const CHECKING: DeviceStatus = Object.freeze({ word: 'Checking…', tone: 'dim', actionable: false });

/**
 * `connected` wins over any probe result: the live socket is the strongest
 * evidence the app has, and a reachability probe that has not come back yet
 * must never downgrade a machine the user is actively driving.
 */
export function deviceStatus(state: Reachability | undefined, connected: boolean): DeviceStatus {
  if (connected) return CONNECTED;
  if (state === 'online') return AVAILABLE;
  if (state === 'offline') return OFFLINE;
  return CHECKING;
}

/** The Connect/Open label. Never "Connect" for a machine already connected. */
export function connectLabel(connected: boolean): string {
  return connected ? 'Open computer' : 'Connect';
}
