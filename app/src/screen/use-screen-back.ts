// The desktop's Back control, wired: reads the root stack and the paired
// computers, asks src/screen/back-nav.ts where to go, and goes there.
//
// Kept apart from the pure decision so the node test runner never has to
// import expo-router; kept apart from the route file so screen.tsx stays a
// layout, not a navigation policy.

import { useCallback } from 'react';
import { router, useRootNavigationState } from 'expo-router';
import { useConnection } from '../connection';
import { planScreenBack, previousRouteName } from './back-nav';

/** Returns the handler for the desktop's Back control. */
export function useScreenBack(): () => void {
  const rootState = useRootNavigationState();
  const { devices } = useConnection();
  const previousRoute = previousRouteName(rootState?.routes, rootState?.index);
  const deviceCount = devices.length;

  return useCallback(() => {
    const plan = planScreenBack({ canGoBack: router.canGoBack(), previousRoute, deviceCount });
    if (plan.kind === 'pop') router.back();
    else router.replace(plan.href);
  }, [previousRoute, deviceCount]);
}
