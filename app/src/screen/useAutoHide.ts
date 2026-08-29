// Auto-hide state for stage overlays: visible after any poke, hidden once the
// delay elapses untouched. The timing decisions are pure (autohide.ts); this
// hook owns the timer and the React state.
//
// Deliberately NOT wired to stage touches — those are remote input, and remote
// input must never double as "reveal the controls".

import { useCallback, useEffect, useRef, useState } from 'react';
import { AUTO_HIDE_MS, hideDelayRemaining } from './autohide';

export interface AutoHide {
  /** Whether the overlay should currently be shown. Always true when disabled. */
  readonly visible: boolean;
  /** Note an interaction: show the overlay and restart the countdown. */
  readonly poke: () => void;
  /** Hide immediately (e.g. the user explicitly dismissed the controls). */
  readonly hide: () => void;
}

export function useAutoHide(enabled: boolean, delayMs: number = AUTO_HIDE_MS): AutoHide {
  const [visible, setVisible] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const clear = useCallback(() => {
    if (timer.current === undefined) return;
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const arm = useCallback(() => {
    clear();
    const at = Date.now();
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setVisible(false);
    }, hideDelayRemaining(Date.now(), at, delayMs));
  }, [clear, delayMs]);

  const poke = useCallback(() => {
    setVisible(true);
    if (enabledRef.current) arm();
  }, [arm]);

  const hide = useCallback(() => {
    clear();
    setVisible(false);
  }, [clear]);

  // Enabling starts a fresh countdown; disabling pins the overlay visible.
  useEffect(() => {
    if (!enabled) {
      clear();
      setVisible(true);
      return;
    }
    setVisible(true);
    arm();
    return clear;
  }, [enabled, arm, clear]);

  return { visible, poke, hide };
}
