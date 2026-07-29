// Small set of styled primitives shared by every screen. Kept in one file so
// the visual language stays consistent and easy to tune.

import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleProp,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import { colors, radius, space } from './theme';

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[
        {
          backgroundColor: colors.surface,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: colors.border,
          padding: space.md,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  testID,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const bg =
    variant === 'primary' ? colors.accent
    : variant === 'danger' ? colors.bad
    : variant === 'secondary' ? colors.surfaceAlt
    : 'transparent';
  const fg = variant === 'primary' || variant === 'danger' ? colors.black : colors.text;
  const border = variant === 'ghost' || variant === 'secondary' ? colors.borderStrong : 'transparent';
  const isOff = disabled || loading;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={isOff ? undefined : onPress}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderColor: border,
          borderWidth: 1,
          borderRadius: radius.md,
          paddingVertical: 13,
          paddingHorizontal: space.md,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: isOff ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={{ color: fg, fontWeight: '700', fontSize: 15 }}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Heading({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[{ color: colors.text, fontSize: 26, fontWeight: '800', letterSpacing: 0.2 }, style]}>{children}</Text>;
}

export function Sub({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[{ color: colors.textDim, fontSize: 14, lineHeight: 20 }, style]}>{children}</Text>;
}

export function Label({ children }: { children: React.ReactNode }) {
  return (
    <Text style={{ color: colors.textFaint, fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginBottom: space.xs }}>
      {children}
    </Text>
  );
}

export function Meter({ percent, tint }: { percent: number; tint?: string }) {
  const p = Math.max(0, Math.min(100, percent));
  const color = tint || (p > 85 ? colors.bad : p > 65 ? colors.warn : colors.good);
  return (
    <View style={{ height: 8, backgroundColor: colors.surfaceAlt, borderRadius: radius.pill, overflow: 'hidden' }}>
      <View style={{ width: `${p}%`, height: '100%', backgroundColor: color, borderRadius: radius.pill }} />
    </View>
  );
}

export function Row({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center' }, style]}>{children}</View>;
}

export function Dot({ color }: { color: string }) {
  return <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }} />;
}
