// Bottom sheet built on RN's Modal so it works identically in Expo Go and on
// web without pulling in a gesture/reanimated-based sheet library.

import React, { useEffect, useRef } from 'react';
import { Animated, Modal, Platform, Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { IconButton } from './button';
import { Row } from './layout';
import { Txt } from './text';
import { useReducedMotion } from './motion';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  /** Hides the top-right close control (for a required decision). */
  hideClose?: boolean;
  /** Tapping the scrim closes the sheet. Defaults to true. */
  dismissOnBackdropPress?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Sheet({
  visible,
  onClose,
  title,
  children,
  hideClose = false,
  dismissOnBackdropPress = true,
  style,
  testID,
}: SheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const slide = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    const target = visible ? 1 : 0;
    if (reduced) {
      slide.setValue(target);
      return;
    }
    const animation = Animated.timing(slide, {
      toValue: target,
      duration: visible ? theme.motion.slow : theme.motion.fast,
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start();
    return () => animation.stop();
  }, [visible, reduced, slide, theme.motion.slow, theme.motion.fast]);

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [48, 0] });

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} testID={testID}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          disabled={!dismissOnBackdropPress}
          onPress={dismissOnBackdropPress ? onClose : undefined}
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlay }]}
        />
        <Animated.View
          accessibilityViewIsModal
          style={[
            {
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: theme.radius.xl,
              borderTopRightRadius: theme.radius.xl,
              borderTopWidth: theme.layout.hairline,
              borderColor: theme.colors.border,
              paddingHorizontal: theme.space.md,
              paddingTop: theme.space.sm,
              paddingBottom: insets.bottom + theme.space.md,
              opacity: slide,
              transform: [{ translateY }],
            },
            theme.elevation.lg,
            style,
          ]}
        >
          <View
            accessibilityElementsHidden
            style={{
              alignSelf: 'center',
              width: 40,
              height: 4,
              borderRadius: theme.radius.pill,
              backgroundColor: theme.colors.borderStrong,
              marginBottom: theme.space.sm,
            }}
          />
          {title || !hideClose ? (
            <Row justify="space-between" style={{ marginBottom: theme.space.sm }}>
              <Txt variant="heading" heading>
                {title ?? ''}
              </Txt>
              {hideClose ? null : (
                <IconButton accessibilityLabel="Close" variant="plain" onPress={onClose}>
                  <CloseGlyph color={theme.colors.textDim} />
                </IconButton>
              )}
            </Row>
          ) : null}
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

/** Small X drawn with two rotated bars, so there is no icon-font dependency. */
function CloseGlyph({ color }: { color: string }) {
  const bar: ViewStyle = { position: 'absolute', width: 16, height: 2, borderRadius: 1, backgroundColor: color };
  return (
    <View style={{ width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
      <View style={[bar, { transform: [{ rotate: '45deg' }] }]} />
      <View style={[bar, { transform: [{ rotate: '-45deg' }] }]} />
    </View>
  );
}
