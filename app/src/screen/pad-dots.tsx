// Fieldwork's trackpad texture: a faint dot grid, drawn once the pad has
// measured itself. Decorative only — it carries no meaning, never reacts to
// touch, and is hidden from accessibility.

import React, { useState } from 'react';
import { View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { useTheme } from '../theme';
import { PAD_DOT_SIZE, padDots } from './pad-texture';

export function PadTexture() {
  const theme = useTheme();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((previous) => (previous.w === width && previous.h === height ? previous : { w: width, h: height }));
  };
  const dots = padDots(size.w, size.h);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      onLayout={onLayout}
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
    >
      {dots.map((dot) => (
        <View
          key={`${dot.x}:${dot.y}`}
          style={{
            position: 'absolute',
            left: dot.x,
            top: dot.y,
            width: PAD_DOT_SIZE,
            height: PAD_DOT_SIZE,
            borderRadius: PAD_DOT_SIZE / 2,
            backgroundColor: theme.colors.borderStrong,
          }}
        />
      ))}
    </View>
  );
}
