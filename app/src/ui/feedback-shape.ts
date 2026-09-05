// Pure state logic behind the feedback primitives (REVAMP-SPEC §3.5, §5.2,
// §5.8) — kept renderer-free so the rules are testable under node:test, the
// same way `track.ts` carries the track rule.
//
// Two rules live here:
//
// 1. The dot's ring/fill semantics. Status is SHAPE + colour, animated once
//    per change: a hollow ring means "transitioning", a filled disc means
//    "steady", and the only sanctioned motion is the single 120ms inner-disc
//    fade when a ring becomes a fill — the entire "we connected" moment.
//    Nothing pulses, ever (§3.5).
//
// 2. The Banner's full-bleed discipline. A Banner is a band of the page, not
//    a card on it (§5.8) — margin-to-margin no matter what a caller passes.
//    Callers historically inset it with `marginHorizontal`; those styles are
//    neutralised here until each tab drops them, so the primitive is already
//    correct today.

/** How full the dot's inner disc is for a given shape. 1 = filled (steady). */
export function dotFillTarget(ring: boolean): number {
  return ring ? 0 : 1;
}

export interface FillTransition {
  /** Where the inner-disc opacity lands. */
  readonly toValue: number;
  /** How long it takes to get there, ms. */
  readonly duration: number;
}

/**
 * The one dot animation (§3.5): on ring→fill the inner disc fades in over
 * `fast` (120ms). Every other change — fill→ring, or a same-shape re-render —
 * is instant: emptying back into a ring is a state regression ("we dropped"),
 * and celebrating it with motion would read as activity. Reduced motion makes
 * even the fill instant.
 */
export function dotFillTransition(
  prevRing: boolean,
  nextRing: boolean,
  motion: { readonly fast: number; readonly instant: number },
  reducedMotion = false
): FillTransition {
  const toValue = dotFillTarget(nextRing);
  const fills = prevRing && !nextRing;
  return {
    toValue,
    duration: fills && !reducedMotion ? motion.fast : motion.instant,
  };
}

// --- Banner full-bleed ------------------------------------------------------

/** Loose view of an RN style: a props bag, a falsy hole, or a nested array. */
export type LooseStyle =
  | Record<string, unknown>
  | null
  | undefined
  | false
  | number // a registered StyleSheet id — opaque, so it flattens to nothing
  | readonly LooseStyle[];

const HORIZONTAL_INSET_KEYS = [
  'marginHorizontal',
  'marginLeft',
  'marginRight',
  'marginStart',
  'marginEnd',
] as const;

/** Flattens a (possibly nested) RN style array into one plain object. */
const flattenStyle = (style: LooseStyle): Record<string, unknown> => {
  if (!style || typeof style === 'number') return {};
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, entry) => ({ ...acc, ...flattenStyle(entry as LooseStyle) }),
      {}
    );
  }
  return { ...(style as Record<string, unknown>) };
};

/**
 * Strips every horizontal inset from a caller-supplied style so a full-bleed
 * Banner (§5.8) cannot be re-inset into a card. The `margin` shorthand is
 * demoted to `marginVertical` (its vertical half survives; the horizontal
 * half dies). Everything else passes through untouched. Pure — returns a new
 * object, never mutates the input.
 */
export function stripHorizontalInsets(style: LooseStyle): Record<string, unknown> {
  const flat = flattenStyle(style);
  const { margin, ...rest } = flat;
  const kept = Object.fromEntries(
    Object.entries(rest).filter(([key]) => !(HORIZONTAL_INSET_KEYS as readonly string[]).includes(key))
  );
  if (margin !== undefined && kept.marginVertical === undefined) {
    return { ...kept, marginVertical: margin };
  }
  return kept;
}
