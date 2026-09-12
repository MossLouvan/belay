// Keeping the pictures on the Computers list honest, without photographing
// anybody's desktop more often than a glance needs.
//
// The refresh policy, stated plainly, because "how often does this app take a
// picture of my screen" deserves a straight answer:
//
//   * Only while the Computers list is actually on screen and the app is in
//     the foreground. Leave the tab and nothing is fetched; pocket the phone
//     and nothing is fetched. There is no background poll and no timer that
//     survives this screen.
//   * Only for a computer that JUST answered a reachability probe, reusing the
//     address that probe proved. An offline or unknown machine is never asked.
//   * Only when the card's picture is missing or older than a minute. A
//     machine you were looking at three seconds ago is not re-photographed.
//   * At most one request per computer per attempt window, even if the screen
//     re-renders, so a render loop can never become a capture loop. The host
//     enforces its own coalescing and request budget on top of this — see
//     server/src/thumbnail.ts — so neither side is trusting the other to
//     behave.
//
// The net effect for the founder's two machines: opening the Computers tab
// costs at most two small captures, and coming back to it a few seconds later
// costs none.

import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { fetchHostStill } from './preview-fetch';
import { stillsToFetch } from './preview-plan';
import { previewFor, rememberHostStill, retainPairedPreviews } from './preview-store';
import type { SavedDevice } from '../devices/model';
import type { Reachability } from '../devices/reachability';

export interface PreviewRefreshInputs {
  readonly devices: readonly SavedDevice[];
  readonly byId: Readonly<Record<string, Reachability>>;
  readonly urlById: Readonly<Record<string, string>>;
  /** False while the list is not the visible screen. Nothing is fetched then. */
  readonly enabled?: boolean;
}

/**
 * Fetch a current still for every reachable computer that needs one, and keep
 * the cache in step with the paired set.
 *
 * Returns nothing: the pictures land in the preview store, which the cards
 * read through `useDevicePreview`.
 */
export function useDevicePreviews({ devices, byId, urlById, enabled = true }: PreviewRefreshInputs): void {
  /** Last attempt per host id. A ref, so re-renders cannot reset the pacing. */
  const attempted = useRef<Record<string, number>>({});

  // A computer that is no longer paired must not keep a picture of its desktop
  // in this phone's memory.
  const pairedKey = devices.map((d) => d.id).join('|');
  useEffect(() => {
    retainPairedPreviews(devices.map((d) => d.id));
  }, [pairedKey]);

  // Keyed on which computers answered and where — not on object identity — so
  // an unrelated store write does not restart every fetch.
  const readyKey = devices
    .filter((d) => byId[d.id] === 'online')
    .map((d) => `${d.id}@${urlById[d.id] ?? ''}`)
    .join('|');

  useEffect(() => {
    if (!enabled || readyKey.length === 0) return;
    if (AppState.currentState !== 'active') return;

    const controller = new AbortController();
    const now = Date.now();
    const targets = stillsToFetch({
      devices,
      byId,
      urlById,
      attemptedAt: attempted.current,
      previewAt: (hostId) => previewFor(hostId)?.capturedAt ?? null,
      now,
    });
    for (const { device, url } of targets) {
      attempted.current = { ...attempted.current, [device.id]: now };
      void fetchHostStill({ url, token: device.token }, controller.signal).then((still) => {
        if (!still || controller.signal.aborted) return;
        rememberHostStill(device.id, still.data, still.capturedAt);
      });
    }
    // Leaving the screen cancels anything still in flight: a picture that
    // arrives for a list nobody is looking at is a capture that should not
    // have been taken.
    return () => controller.abort();
  }, [readyKey, enabled]);
}
