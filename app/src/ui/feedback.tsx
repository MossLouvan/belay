// Status, progress and empty/loading/error affordances.
//
// Status has its own muted colours and is not the accent (docs/DESIGN.md
// §3.3): errors are `bad`, never orange — if everything urgent were orange,
// nothing would be. Soft status tints are the only fills allowed behind text.

import React, { useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import { Animated, Easing, Platform, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { easing, useTheme } from '../theme';
import type { Palette } from '../theme';
import { Button } from './button';
import { dotFillTransition, stripHorizontalInsets } from './feedback-shape';
import type { LooseStyle } from './feedback-shape';
import { Column } from './layout';
import { useReducedMotion } from './motion';
import { Label, Txt } from './text';
import { TrackLabel } from './track-label';

export type Status = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

const statusColor = (status: Status, c: Palette): string => {
  const map: Record<Status, string> = {
    neutral: c.textFaint,
    good: c.good,
    warn: c.warn,
    bad: c.bad,
    accent: c.accent,
  };
  return map[status];
};

const statusFill = (status: Status, c: Palette): string => {
  const map: Record<Status, string> = {
    neutral: c.surfaceAlt,
    good: c.goodSoft,
    warn: c.warnSoft,
    bad: c.badSoft,
    accent: c.accentSoft,
  };
  return map[status];
};

/**
 * Text colour for content rendered ON `statusFill(status)`.
 *
 * Deliberately NOT `statusColor`: the `*Soft` fills are translucent, so the
 * colour actually behind the glyphs is the fill composited over whatever
 * surface the component sits on. The solid status colours are only verified
 * against the opaque surfaces and drop below WCAG AA 4.5:1 once that
 * compositing is accounted for (worst case: fill over `surfaceAlt`). The
 * `on*Soft` roles are verified against that case.
 *
 * `neutral` uses the opaque `surfaceAlt` fill, so no compositing happens and
 * `textFaint` — already verified against `surfaceAlt` — is correct.
 */
const statusOnFill = (status: Status, c: Palette): string => {
  const map: Record<Status, string> = {
    neutral: c.textFaint,
    good: c.onGoodSoft,
    warn: c.onWarnSoft,
    bad: c.onBadSoft,
    accent: c.onAccentSoft,
  };
  return map[status];
};

/**
 * Status mark — a filled disc or a hollow ring (REVAMP-SPEC §3.5, §5.2).
 *
 * State is SHAPE + colour, never motion: `ring` renders a hollow 2pt ring in
 * the status colour meaning "transitioning" (connecting/reconnecting); without
 * it the mark is a filled disc meaning "steady" (live/offline/fault). The one
 * sanctioned animation is the ring→fill moment: the inner disc fades in over
 * `motion.fast` (120ms) and the colour crossfades over the same beat — that
 * single fill IS the "we connected" motion. Nothing here ever pulses.
 *
 * Legacy signature took a required `color`; both that and the newer `status`
 * shorthand work. Decorative by default — pass `label` when the dot is the
 * only carrier of the state. An `accent` dot draws in `accentGraphic`: a dot
 * is a ≥3pt non-text mark, exactly what that role exists for.
 */
export function Dot({
  color,
  status = 'neutral',
  size = 9,
  ring = false,
  label,
}: {
  color?: string;
  status?: Status;
  size?: number;
  /** Hollow ring = transitioning; filled disc = steady (§5.2). */
  ring?: boolean;
  label?: string;
  /** @deprecated Pulsing is banned (§3.5). Accepted for old callers, ignored. */
  pulse?: boolean;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const paint = color ?? (status === 'accent' ? theme.colors.accentGraphic : statusColor(status, theme.colors));

  // The inner disc's opacity: 0 while a ring, 1 while steady. Seeded to the
  // first shape so a dot mounts already-correct, with no entrance animation.
  const fill = useRef(new Animated.Value(ring ? 0 : 1)).current;
  const prevRing = useRef(ring);

  // Colour crossfade (§3.5): 0→1 sweeps from the previous colour to the new
  // one. Both refs are Animated plumbing, not React state — the values the
  // renderer reads are new objects/interpolations every change.
  const colorT = useRef(new Animated.Value(1)).current;
  const colors = useRef({ from: paint, to: paint });
  const paintRef = useRef(paint);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const t = dotFillTransition(prevRing.current, ring, theme.motion, reduced);
    prevRing.current = ring;
    if (t.duration === 0) {
      fill.setValue(t.toValue);
      return;
    }
    // Colour animation shares this node's driver, so both stay on the JS side.
    Animated.timing(fill, {
      toValue: t.toValue,
      duration: t.duration,
      easing: easing.standard,
      useNativeDriver: false,
    }).start();
  }, [ring, reduced, fill, theme.motion]);

  // Colour change → rebase the crossfade in a PRE-PAINT layout effect (never
  // during render, which triggers React's "update while rendering" warning).
  // The forced re-render lets `ink` swap to the interpolation before paint, so
  // the frame starts from the old colour with no flash.
  useLayoutEffect(() => {
    if (paintRef.current === paint) return;
    colors.current = { from: paintRef.current, to: paint };
    paintRef.current = paint;
    colorT.setValue(0);
    rerender();
    if (reduced) {
      colorT.setValue(1);
      return;
    }
    Animated.timing(colorT, {
      toValue: 1,
      duration: theme.motion.fast,
      easing: easing.standard,
      useNativeDriver: false,
    }).start();
  }, [paint, reduced, colorT, theme.motion.fast]);

  const ink =
    colors.current.from === colors.current.to
      ? colors.current.to
      : colorT.interpolate({ inputRange: [0, 1], outputRange: [colors.current.from, colors.current.to] });

  return (
    <View
      accessibilityRole={label ? 'image' : undefined}
      accessibilityLabel={label}
      accessibilityElementsHidden={!label}
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      {/* The rim: a 2pt stroke that is the whole mark while transitioning and
          a seamless edge of the disc once filled — same colour, no seam. */}
      <Animated.View
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          borderRadius: size / 2,
          borderWidth: theme.layout.ruleEmphasis,
          borderColor: ink,
        }}
      />
      {/* The disc: hidden while a ring; fades in once, over motion.fast, when
          the state goes steady — the entire connect celebration (§3.5). */}
      <Animated.View
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          borderRadius: size / 2,
          backgroundColor: ink,
          opacity: fill,
        }}
      />
    </View>
  );
}

/**
 * Horizontal progress/usage bar. Legacy signature — `{ percent, tint }` —
 * preserved and the colour thresholds are unchanged; the bar itself became the
 * 2pt square-cornered track of the meter pattern (docs/DESIGN.md §7).
 */
export function Meter({
  percent,
  tint,
  height,
  label,
}: {
  percent: number;
  tint?: string;
  height?: number;
  label?: string;
}) {
  const theme = useTheme();
  const safe = Number.isFinite(percent) ? percent : 0;
  const p = Math.max(0, Math.min(100, safe));
  const color = tint ?? (p > 85 ? theme.colors.bad : p > 65 ? theme.colors.warn : theme.colors.good);

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(p) }}
      style={{ height: height ?? theme.layout.ruleEmphasis, backgroundColor: theme.colors.surfaceAlt }}
    >
      <View style={{ width: `${p}%`, height: '100%', backgroundColor: color }} />
    </View>
  );
}

/**
 * Compact status chip: a mono micro-label on a soft status band. Square
 * corners — the pill shape is banned — and 2pt radius only so the tint does
 * not render as a raw rectangle against the paper.
 */
export function Badge({
  label,
  status = 'neutral',
  dot,
  style,
  testID,
}: {
  label: string;
  status?: Status;
  dot?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space.xxs,
          alignSelf: 'flex-start',
          backgroundColor: statusFill(status, theme.colors),
          borderRadius: theme.radius.xs,
          paddingHorizontal: theme.space.xs,
          paddingVertical: theme.space.xxs,
        },
        style,
      ]}
    >
      {dot ? <Dot status={status} size={6} /> : null}
      <Txt variant="label" color={statusOnFill(status, theme.colors)} testID={testID}>
        {label}
      </Txt>
    </View>
  );
}

/**
 * Advisory band (REVAMP-SPEC §5.8). Full-bleed — margin-to-margin, radius 0,
 * a hairline above AND below — a band OF the page, never a card floating on
 * it. The 2pt status-coloured left rule is the anchor mark (§3.4): the one
 * vertical emphasis rule sanctioned outside ledger cells. Announced to screen
 * readers, so it is suitable for surfacing degraded-but-working states.
 *
 * Banners are for advisories; faults belong on the machine glass (§5.5).
 * Caller-supplied horizontal margins are stripped (see `feedback-shape.ts`)
 * so legacy `marginHorizontal` styles cannot re-inset the band into a card.
 */
export function Banner({
  message,
  title,
  status = 'bad',
  action,
  style,
  testID,
}: {
  message: string;
  title?: string;
  status?: Status;
  action?: { label: string; onPress: () => void };
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const theme = useTheme();
  // The anchor rule keeps the solid status colour; the title sits on the soft
  // fill, so it uses the composited-safe on-fill role.
  const rule = statusColor(status, theme.colors);
  const onFill = statusOnFill(status, theme.colors);

  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[
        {
          backgroundColor: statusFill(status, theme.colors),
          // A band, not a box (§5.8): square corners, page-edge to page-edge,
          // held by hairlines above and below like any other ledger rule.
          borderRadius: 0,
          borderTopWidth: theme.layout.hairline,
          borderBottomWidth: theme.layout.hairline,
          borderTopColor: theme.colors.border,
          borderBottomColor: theme.colors.border,
          // The anchor rule on the page's left edge.
          borderLeftWidth: theme.layout.ruleEmphasis,
          borderLeftColor: rule,
          // Content stays on the 20pt page grid; the anchor rule eats into
          // the left gutter so text aligns with everything else on the page.
          paddingLeft: theme.layout.margin - theme.layout.ruleEmphasis,
          paddingRight: theme.layout.margin,
          paddingVertical: theme.space.sm,
          gap: theme.space.xs,
        },
        // Full-bleed is non-negotiable: horizontal insets from callers are
        // dropped (legacy `marginHorizontal` — per-tab cleanup pending).
        stripHorizontalInsets(style as LooseStyle) as ViewStyle,
      ]}
    >
      {title ? (
        <Txt variant="label" color={onFill}>
          {title}
        </Txt>
      ) : null}
      {/* `dim`, not `faint`: textDim clears 4.5:1 on every composited soft
          fill, textFaint does not. */}
      <Txt variant="body" tone="dim">
        {message}
      </Txt>
      {/* The action is a tracked text button, not a soft Button — fills
          within fills die (§5.8). Inks: on-fill label, solid status track. */}
      {action ? (
        <TrackLabel
          label={action.label}
          onPress={action.onPress}
          labelColor={onFill}
          trackColor={rule}
          style={{ alignSelf: 'flex-start' }}
        />
      ) : null}
    </View>
  );
}

export { Banner as Toast };

/**
 * Placeholder for an empty list or a screen with nothing to show yet. Built to
 * the fixed empty-state anatomy (docs/DESIGN.md §11.4): STATE NAME as a dim
 * micro-label, what is true in body prose, then the way forward. Flush-left —
 * centred text is banned outside machine panels, and the app's historical
 * failure mode was empty states that described instead of guided.
 */
export function EmptyState({
  title,
  message,
  icon,
  action,
  style,
  testID,
}: {
  title: string;
  message?: string;
  icon?: React.ReactNode;
  action?: { label: string; onPress: () => void };
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Column
      gap="sm"
      testID={testID}
      style={[{ paddingVertical: theme.space.xl, alignItems: 'flex-start' }, style]}
    >
      {icon ? <View accessibilityElementsHidden>{icon}</View> : null}
      <Label style={{ marginBottom: 0 }}>{title}</Label>
      {message ? <Txt variant="body" tone="dim">{message}</Txt> : null}
      {action ? <Button label={action.label} onPress={action.onPress} variant="secondary" size="sm" /> : null}
    </Column>
  );
}

/** Shimmering placeholder block shown while data loads. */
export function Skeleton({
  width = '100%',
  height = 14,
  radius,
  style,
}: {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    if (reduced) {
      pulse.setValue(0.7);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(pulse, { toValue: 0.5, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, pulse]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width,
          height,
          borderRadius: radius ?? theme.radius.xs,
          backgroundColor: theme.colors.skeleton,
          opacity: pulse,
        },
        style,
      ]}
    />
  );
}
