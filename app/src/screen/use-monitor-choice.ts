// Which monitor the stream shows AND every input call targets — one value,
// by construction, because the host maps normalized coordinates onto the
// captured monitor's rectangle. `selectedScreen` remembers the user's tap;
// `screenIndex` re-validates it against the live monitor list every poll
// (undefined until the host reports a list, so old hosts get no index at
// all and keep their primary-monitor behavior).

import { useCallback, useMemo, useState } from 'react';
import type { ScreenInfo } from '../api';
import { nextScreenIndex, resolveScreenIndex, screensOf } from './monitors';
import type { MonitorChoice } from './monitors';

export interface MonitorChoiceState {
  readonly screens: readonly MonitorChoice[];
  /** The resolved monitor index currently streamed. */
  readonly screenIndex: number | undefined;
  readonly selectScreen: (index: number) => void;
  /** The dock's monitor key: the next one in the list, wrapping. */
  readonly cycleMonitor: () => void;
}

export function useMonitorChoice(info: ScreenInfo | null): MonitorChoiceState {
  const screens = useMemo(() => screensOf(info), [info]);
  const [selectedScreen, setSelectedScreen] = useState<number | undefined>(undefined);
  const screenIndex = useMemo(() => resolveScreenIndex(selectedScreen, screens), [selectedScreen, screens]);

  const cycleMonitor = useCallback(() => {
    const next = nextScreenIndex(screenIndex, screens);
    if (next !== undefined) setSelectedScreen(next);
  }, [screenIndex, screens]);

  const selectScreen = useCallback((index: number) => setSelectedScreen(index), []);

  return { screens, screenIndex, selectScreen, cycleMonitor };
}
