// Keystrokes to the host: the key bar's presses and auto-repeats, the sticky
// modifier latch they consume, and the three-finger desktop-switch chord.
// The latch rules are pure (mods.ts); this hook owns the state, the refs the
// press-time reads go through, and the api calls.

import { useCallback, useRef, useState } from 'react';
import { api } from '../api';
import { failureLine } from '../errors';
import { haptic } from '../ui';
import { keyFor, KEYS, modsFor } from './model';
import type { KeySpec } from './model';

/**
 * What to call a key in an error a person reads. `id` is a testID suffix —
 * "cmd-shift-4" — and it used to be what the failure toast printed; `action`
 * is the sentence the key already carries for screen readers, and `label` is
 * what is printed on the cap.
 */
const keyName = (spec: KeySpec): string => spec.action ?? spec.label ?? spec.id;
import { activeMods, IDLE_MODS, modNamesForHost, releaseLatched, tapMod } from './mods';
import type { ModsState, StickyMod } from './mods';
import { SWIPE_ACTION_ID } from './swipe';
import type { SwipeDirection } from './swipe';

export interface KeySenderInputs {
  readonly isMac: boolean;
  /** One-shot failures go to the tab's shared toast. */
  readonly reportError: (message: string) => void;
}

export interface KeySender {
  readonly mods: ModsState;
  /** A key bar press: haptic, the latch spent, the chord sent. */
  readonly sendKey: (spec: KeySpec) => Promise<unknown>;
  /** One auto-repeat of a held key: the same chord again, no haptic. */
  readonly repeatKey: (spec: KeySpec) => Promise<unknown>;
  readonly tapModifier: (mod: StickyMod) => void;
  /** A pointer action on the stage spends one-shot latched modifiers. */
  readonly spendLatch: () => void;
  /** A committed three-finger swipe becomes the host's desktop-switch chord. */
  readonly onSwipe: (direction: SwipeDirection) => void;
  /** The modifiers active right now, in the host's own names. Read at call time. */
  readonly activeModsForHost: () => string[];
}

export function useKeySender({ isMac, reportError }: KeySenderInputs): KeySender {
  const [mods, setMods] = useState<ModsState>(IDLE_MODS);
  // The latch state, mirrored into a ref so `sendKey` reads the value at press
  // time without rebuilding its callback on every latch change.
  const modsRef = useRef(mods);
  modsRef.current = mods;

  // Modifiers resolved by the press that started a hold. Repeats reuse them so
  // a held Ctrl+Backspace keeps deleting WORDS, even though the latch was
  // released the moment the first key went out.
  const heldModsRef = useRef<readonly string[]>([]);

  // A pointer action on the stage spends one-shot latched modifiers, the same
  // way letting go of Ctrl does when you reach for the mouse. (The host's
  // /input/click does not take modifiers, so the latch cannot ride along on a
  // click — it applies to the next KEY; the tap just abandons it.)
  const spendLatch = useCallback(() => setMods(releaseLatched), []);

  // A committed three-finger swipe becomes the host OS's own desktop-switch
  // chord. Latched modifiers are deliberately NOT mixed in: like pans and
  // zooms, the swipe is navigation, not a keystroke the user is composing.
  const onSwipe = useCallback(
    (direction: SwipeDirection) => {
      const spec = KEYS.find((key) => key.id === SWIPE_ACTION_ID[direction]);
      if (!spec) return;
      api
        .key(keyFor(spec, isMac), modsFor(spec, isMac))
        .catch((e: unknown) => reportError(failureLine('Could not switch desktop', e)));
    },
    [isMac, reportError]
  );

  const sendKey = useCallback(
    (spec: KeySpec) => {
      haptic('light');
      const base = modsFor(spec, isMac);
      const latched = modNamesForHost(activeMods(modsRef.current), isMac).filter((m) => !base.includes(m));
      const chord = [...latched, ...base];
      heldModsRef.current = chord;
      setMods(releaseLatched);
      // Returned so the key bar's auto-repeat can pace itself on the round
      // trip instead of queueing sends a slow link cannot keep up with.
      return api
        .key(keyFor(spec, isMac), chord)
        .catch((e: unknown) => reportError(failureLine(`${keyName(spec)} did not reach the computer`, e)));
    },
    [isMac, reportError]
  );

  /**
   * One auto-repeat of a key being held down. No haptic (eighteen a second is
   * a buzz, not feedback) and no latch bookkeeping — just the same chord the
   * press sent, again.
   */
  const repeatKey = useCallback(
    (spec: KeySpec) =>
      api
        .key(keyFor(spec, isMac), [...heldModsRef.current])
        .catch((e: unknown) => reportError(failureLine(`${keyName(spec)} did not reach the computer`, e))),
    [isMac, reportError]
  );

  const tapModifier = useCallback((mod: StickyMod) => {
    haptic('selection');
    setMods((state) => tapMod(state, mod, Date.now()));
  }, []);

  const activeModsForHost = useCallback(
    () => modNamesForHost(activeMods(modsRef.current), isMac),
    [isMac]
  );

  return { mods, sendKey, repeatKey, tapModifier, spendLatch, onSwipe, activeModsForHost };
}
