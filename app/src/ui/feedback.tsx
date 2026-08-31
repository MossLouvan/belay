// Status, progress and empty/loading/error affordances.
//
// Status has its own muted colours and is not the accent (docs/DESIGN.md
// §3.3): errors are `bad`, never orange — if everything urgent were orange,
// nothing would be. Soft status tints are the only fills allowed behind text.

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import type { Palette } from '../theme';
import { Button } from './button';
import { Column } from './layout';
import { usePulse, useReducedMotion } from './motion';
import { Label, Txt } from './text';

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
 * Status dot. Legacy signature took a required `color`; both that and the new
 * `status` shorthand work. Decorative by default — pass `label` when the dot is
 * the only carrier of the state. An `accent` dot draws in `accentGraphic`: a
 * dot is a ≥3pt non-text mark, exactly what that role exists for.
 */
export function Dot({
  color,
  status = 'neutral',
  size = 9,
  pulse,
  label,
}: {
  color?: string;
  status?: Status;
  size?: number;
  pulse?: boolean;
  label?: string;
}) {
  const theme = useTheme();
  const fill = color ?? (status === 'accent' ? theme.colors.accentGraphic : statusColor(status, theme.colors));
  const opacity = usePulse(Boolean(pulse), theme.motion.pulse);

  return (
    <View
      accessibilityRole={label ? 'image' : undefined}
      accessibilityLabel={label}
      accessibilityElementsHidden={!label}
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      <Animated.View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: fill,
          opacity,
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

/** @deprecated Pills are banned; this now renders the square Badge. */
export { Badge as Pill };

/**
 * Inline banner for errors and notices. Announced to screen readers, so it is
 * suitable for surfacing connection failures. The leading 2pt rule is the
 * emphasis weight in the status colour — a rule, not a border box.
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
  // The rule sits on the host surface, not on the fill, so it keeps the solid
  // status colour. The title sits on the fill, so it uses the on-fill role.
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
          borderRadius: theme.radius.xs,
          borderLeftWidth: theme.layout.ruleEmphasis,
          borderLeftColor: rule,
          padding: theme.space.sm,
          gap: theme.space.xs,
        },
        style,
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
      {action ? <Button label={action.label} onPress={action.onPress} variant="subtle" size="sm" /> : null}
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
