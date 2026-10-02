// Where the user last left the floating mascot button, per orientation.
//
// Same never-throw AsyncStorage pattern as home/hint-store.ts: a broken or
// malformed store just means the button is back in its top-right home,
// which is harmless. Values are validated on the way in — storage is not
// trusted — and clamped again by the button when they are applied, since
// the screen they were saved on may not be the screen they are restored on.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { MascotPlacement } from './mascot-button';

const PLACEMENT_KEY = 'belay.screen.mascotPlacement.v1';

export type MascotOrientation = 'portrait' | 'landscape';

export type MascotPlacements = Readonly<Partial<Record<MascotOrientation, MascotPlacement>>>;

const isPlacement = (value: unknown): value is MascotPlacement =>
  typeof value === 'object' && value !== null
  && ((value as MascotPlacement).side === 'left' || (value as MascotPlacement).side === 'right')
  && Number.isFinite((value as MascotPlacement).y);

const parse = (raw: string | null): MascotPlacements => {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  return {
    ...(isPlacement(record.portrait) ? { portrait: record.portrait } : {}),
    ...(isPlacement(record.landscape) ? { landscape: record.landscape } : {}),
  };
};

export async function loadMascotPlacements(): Promise<MascotPlacements> {
  try {
    return parse(await AsyncStorage.getItem(PLACEMENT_KEY));
  } catch {
    return {};
  }
}

/** Remembers one orientation's placement; returns the merged map. */
export async function persistMascotPlacement(
  current: MascotPlacements,
  orientation: MascotOrientation,
  placement: MascotPlacement,
): Promise<MascotPlacements> {
  const next = { ...current, [orientation]: placement };
  try {
    await AsyncStorage.setItem(PLACEMENT_KEY, JSON.stringify(next));
  } catch {
    // It still applies for this session; next launch starts top-right.
  }
  return next;
}
