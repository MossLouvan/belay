// A value that stands down by itself: set it, and after `durationMs` it is
// null again. The desktop route has three of these — the one-shot input-error
// toast, the deadspace pad's cursor linger, and the "frames sent" receipt —
// each of which used to carry its own state, ref, timer and unmount cleanup.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Transient<T> {
  readonly value: T | null;
  /** Show `next`, restarting the countdown. Stable across renders. */
  readonly show: (next: T) => void;
  /** Stand down now, dropping any pending countdown. Stable across renders. */
  readonly clear: () => void;
}

export function useTransient<T>(durationMs: number): Transient<T> {
  const [value, setValue] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    setValue(null);
  }, []);

  const show = useCallback(
    (next: T) => {
      setValue(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setValue(null), durationMs);
    },
    [durationMs]
  );

  // Timer cleared on unmount.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  return { value, show, clear };
}
