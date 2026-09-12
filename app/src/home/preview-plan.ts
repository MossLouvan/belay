// Which computers are worth spending a capture on, right now.
//
// The policy in use-device-previews.ts, as a pure function: no React, no
// network, no clock. It lives apart so "does opening this tab photograph
// anybody's desktop?" is answerable by a unit test rather than by reading an
// effect.

import { needsHostStill } from './preview-cache.ts';
import type { SavedDevice } from '../devices/model';
import type { Reachability } from '../devices/reachability';

/** How long a computer is left alone after an attempt, successful or not. */
export const ATTEMPT_COOLDOWN_MS = 30_000;

/**
 * Which computers are worth asking for a still right now.
 *
 * Pure, and separated from the effect so the policy above is testable without
 * a network, a clock or React. `attemptedAt` is the caller's record of the
 * last attempt per host id.
 */
export function stillsToFetch(
  input: {
    readonly devices: readonly SavedDevice[];
    readonly byId: Readonly<Record<string, Reachability>>;
    readonly urlById: Readonly<Record<string, string>>;
    readonly attemptedAt: Readonly<Record<string, number>>;
    readonly previewAt: (hostId: string) => number | null;
    readonly now: number;
    readonly cooldownMs?: number;
  },
): readonly { readonly device: SavedDevice; readonly url: string }[] {
  const cooldownMs = input.cooldownMs ?? ATTEMPT_COOLDOWN_MS;
  const out: { device: SavedDevice; url: string }[] = [];
  for (const device of input.devices) {
    if (input.byId[device.id] !== 'online') continue;
    const url = input.urlById[device.id];
    if (!url || !device.token) continue;
    const last = input.attemptedAt[device.id] ?? 0;
    if (last > 0 && input.now - last < cooldownMs) continue;
    if (!needsHostStill(input.previewAt(device.id), input.now)) continue;
    out.push({ device, url });
  }
  return out;
}

