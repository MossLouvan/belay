// Auto-recheck when the user comes back from the Tailscale app.
//
// The code screen offers "Open Tailscale"; once it is on, the address that
// failed a moment ago should just work, so the return to the foreground
// re-runs the check instead of asking for another tap. The decision itself
// is pure (pair-flow.ts shouldRecheckOnReturn); this hook owns the AppState
// subscription and the "we opened Tailscale" flag.

import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { AppState } from 'react-native';
import type { AppStateStatus } from 'react-native';
import { shouldRecheckOnReturn } from './pair-flow';
import type { Stage } from './pair-flow';

export interface TailscaleReturnInputs {
  readonly stage: Stage;
  /** True while a `/health` check is in flight — blocks a second, overlapping one. */
  readonly checking: RefObject<boolean>;
  /** False once the screen is gone, so a late return cannot set state. */
  readonly live: RefObject<boolean>;
  /** The full check to re-run. Read at return time, so the latest one always wins. */
  readonly onReturn: () => void;
}

export interface TailscaleReturn {
  /** Note that Tailscale was just opened, so the next foreground re-checks. */
  readonly armReturn: () => void;
}

export function useTailscaleReturn({ stage, checking, live, onReturn }: TailscaleReturnInputs): TailscaleReturn {
  /** Tracks previous AppState to detect foreground transitions. */
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  /** True when we opened Tailscale, so we know to auto-recheck on return. */
  const awaitingTailscale = useRef(false);
  // Latest onReturn, so the AppState effect can call it without depending on
  // a callback declared further down the component.
  const onReturnRef = useRef(onReturn);
  onReturnRef.current = onReturn;

  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;

      // Only act when transitioning to active (foreground) from background,
      // and only if we're waiting for Tailscale and on the code stage.
      const recheck = shouldRecheckOnReturn({
        previous: prev,
        next: nextState,
        awaitingTailscale: awaitingTailscale.current,
        stage,
        checking: checking.current,
        live: live.current,
      });
      if (!recheck) return;
      awaitingTailscale.current = false;
      // Re-run the full check to see if Tailscale is now reachable.
      void onReturnRef.current();
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [stage, checking, live]);

  const armReturn = useCallback(() => {
    awaitingTailscale.current = true;
  }, []);

  return { armReturn };
}
