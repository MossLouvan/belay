// Status, progress and empty/loading/error affordances.

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, StyleProp, View, ViewStyle } from 'react-native';
import { Palette, useTheme } from '../theme';
import { Button } from './button';
import { Column, Row } from './layout';
import { useReducedMotion } from './motion';
import { Caption, Txt } from './text';

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
 * compositing is accounted for (worst case: a badge on a raised Card, i.e.
 * fill over `surfaceAlt`). The `on*Soft` roles are verified against that case.
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
 * the only carrier of the state.
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
  const reduced = useReducedMotion();
  const glow = useRef(new Animated.Value(0)).current;
  const fill = color ?? statusColor(status, theme.colors);
  const animate = Boolean(pulse) && !reduced;

  useEffect(() => {
    if (!animate) {
      glow.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glow, { toValue: 1, duration: 900, easing: Easing.out(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(glow, { toValue: 0, duration: 900, easing: Easing.in(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [animate, glow]);

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
          opacity: animate ? glow.interpolate({ inputRange: [0, 1], outputRange: [1, 0.35] }) : 1,
        }}
      />
    </View>
  );
}

/**
 * Horizontal progress/usage bar. Legacy signature — `{ percent, tint }` —
 * preserved; the thresholds that pick a colour are unchanged.
 */
export function Meter({
  percent,
  tint,
  height = 8,
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
      style={{ height, backgroundColor: theme.colors.surfaceAlt, borderRadius: theme.radius.pill, overflow: 'hidden' }}
    >
      <View style={{ width: `${p}%`, height: '100%', backgroundColor: color, borderRadius: theme.radius.pill }} />
    </View>
  );
}

/** Compact status chip. */
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
    <Row
      gap="xs"
      style={[
        {
          alignSelf: 'flex-start',
          backgroundColor: statusFill(status, theme.colors),
          borderRadius: theme.radius.pill,
          paddingHorizontal: theme.space.sm,
          paddingVertical: theme.space.xxs + 2,
        },
        style,
      ]}
    >
      {dot ? <Dot status={status} size={6} /> : null}
      <Txt variant="caption" color={statusOnFill(status, theme.colors)} testID={testID} style={{ fontWeight: '700' }}>
        {label}
      </Txt>
    </Row>
  );
}

export { Badge as Pill };

/**
 * Inline banner for errors and notices. Announced to screen readers, so it is
 * suitable for surfacing connection failures.
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
          borderRadius: theme.radius.md,
          borderLeftWidth: 3,
          borderLeftColor: rule,
          padding: theme.space.sm + 2,
          gap: theme.space.xs,
        },
        style,
      ]}
    >
      {title ? (
        <Txt variant="bodyStrong" color={onFill}>
          {title}
        </Txt>
      ) : null}
      {/* `dim`, not `faint`: textDim clears 4.5:1 on every composited soft
          fill, textFaint does not. */}
      <Txt variant="caption" tone="dim">
        {message}
      </Txt>
      {action ? <Button label={action.label} onPress={action.onPress} variant="subtle" size="sm" /> : null}
    </View>
  );
}

export { Banner as Toast };

/** Placeholder for an empty list or a screen with nothing to show yet. */
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
      align="center"
      gap="sm"
      testID={testID}
      style={[{ paddingVertical: theme.space.xl, paddingHorizontal: theme.space.lg }, style]}
    >
      {icon ? <View accessibilityElementsHidden>{icon}</View> : null}
      <Txt variant="subheading" align="center">
        {title}
      </Txt>
      {message ? <Caption style={{ textAlign: 'center' }}>{message}</Caption> : null}
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
          borderRadius: radius ?? theme.radius.sm,
          backgroundColor: theme.colors.skeleton,
          opacity: pulse,
        },
        style,
      ]}
    />
  );
}
