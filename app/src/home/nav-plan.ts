// What a bottom-bar tap does, as data, so the rule is testable without a
// router. Inside a tool panel, moving to another tool REPLACES it: pushing
// would stack a second panel — and a second copy of the bar — over the first,
// so the app would grow one tablist per tap and the way back to the desktop
// would need as many taps.

export type NavTab = 'screen' | 'agent' | 'terminal' | 'files' | 'system';

export type TabPressPlan =
  | { readonly kind: 'stay' }
  | { readonly kind: 'back' }
  | { readonly kind: 'navigate' | 'replace'; readonly href: `/${NavTab}` };

/**
 * `selected` is the tab the current screen IS, or undefined on a screen that
 * is none of them (the Computers list, #73): there nothing is lit and every
 * tab — Screen included — simply navigates.
 */
export function planTabPress(selected: NavTab | undefined, tab: NavTab): TabPressPlan {
  if (tab === selected) return { kind: 'stay' };
  if (selected === undefined || selected === 'screen') return { kind: 'navigate', href: `/${tab}` };
  if (tab === 'screen') return { kind: 'back' };
  return { kind: 'replace', href: `/${tab}` };
}
