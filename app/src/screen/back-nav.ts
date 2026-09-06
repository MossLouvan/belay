// Where "Back" goes from the live desktop — the decision, not the wiring.
//
// The desktop is the app's home, so it has no natural parent; what "back"
// means is "the surface I came from": the computers list (or the pairing
// flow when nothing is paired yet). Until this module the only way there by
// touch was the navigator's own swipe-back — on iOS 26 react-native-screens
// turns that into a FULL-WIDTH pan by default, so a trackpad drag on the
// black stage popped the route instead of moving the mouse. That gesture is
// now off on the desktop route (app/app/_layout.tsx) and this labelled
// control replaces it.
//
// Pure module: the node test runner imports it directly, so it must never
// pull in expo-router or a component.

/** The root routes a swipe-back used to reveal — the only ones worth popping to. */
export const BACK_TARGET_ROUTES: readonly string[] = Object.freeze(['devices', 'index']);

export type BackHref = '/devices' | '/';

export type BackPlan =
  | { readonly kind: 'pop' }
  | { readonly kind: 'replace'; readonly href: BackHref };

export interface BackContext {
  /** Whether the router reports history beneath this screen. */
  readonly canGoBack: boolean;
  /** Root-stack route name directly beneath the desktop, if any. */
  readonly previousRoute: string | null;
  /** How many computers are paired — none means the list would be empty. */
  readonly deviceCount: number;
}

interface RouteLike {
  readonly name: string;
}

/**
 * The root-stack route beneath the focused one, or null at the bottom of the
 * stack (or with no usable state). Tolerates a missing/garbage index the way
 * a half-mounted navigator reports it.
 */
export function previousRouteName(
  routes: readonly RouteLike[] | undefined,
  index: number | undefined,
): string | null {
  if (!routes || typeof index !== 'number' || !Number.isInteger(index)) return null;
  if (index <= 0 || index >= routes.length) return null;
  return routes[index - 1]?.name ?? null;
}

/** Where an explicit "start over" lands: the list when it has rows, else pairing. */
export function backFallbackHref(deviceCount: number): BackHref {
  return deviceCount > 0 ? '/devices' : '/';
}

/**
 * Pop only when the entry underneath is one of the surfaces a swipe used to
 * reveal. Anything else beneath us — most often a second copy of the desktop
 * left by `router.replace` from a pushed computers list — would make "Back"
 * land on the same picture again, so the route is replaced with the list
 * instead. With no history at all (the normal case: the desktop is the
 * bottom of the stack) the same replacement applies.
 */
export function planScreenBack(context: BackContext): BackPlan {
  const { canGoBack, previousRoute, deviceCount } = context;
  if (canGoBack && previousRoute !== null && BACK_TARGET_ROUTES.includes(previousRoute)) {
    return { kind: 'pop' };
  }
  return { kind: 'replace', href: backFallbackHref(deviceCount) };
}
