// The Belay beluga mascot — cohesive identity across stream HUD and tools drawer.
//
// IDLE (default, always):
//   - Continuously loop `beluga-swim-idle.mp4` (expo-av Video, muted, isLooping).
//   - Swimming-in-water look from Moss's Hailuo clip (~2.3s loop).
//   - Fallback: Reanimated bob on PNG if video fails to load.
//
// ON PRESS (click/tap):
//   - Pause/hide idle video, play `beluga-flip-splash.mp4` once (muted).
//   - On playback end: return to swim idle loop.
//   - No autoplay of flip animation.
//
// Assets: 512x512 silent MP4s from Hailuo, circular clipped to match avatar size.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import type { AVPlaybackStatus } from 'expo-av';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { useTheme } from '../theme';
import { haptic } from './haptics';

export interface BelugaAvatarProps {
  /** Avatar size in pixels (diameter of the circle). */
  size: number;
  /** Optional press handler. If omitted, the avatar is still animated but not pressable. */
  onPress?: () => void;
  /** Background color behind the circular crop. */
  backgroundColor?: string;
  /** Accessibility label. */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The Belay beluga mascot: always-animated circular avatar.
 * Used in the stream HUD (48px, top-right) and tools drawer header (40px).
 *
 * IDLE: Continuously loops beluga-swim-idle.mp4 (silent, ~2.3s).
 * PRESS: Plays beluga-flip-splash.mp4 once (silent, 4.0s), then returns to idle loop.
 *
 * Fallback: Reanimated bob on PNG if video fails to load.
 */
export function BelugaAvatar({
  size,
  onPress,
  backgroundColor,
  accessibilityLabel = 'Belay mascot',
  style,
  testID,
}: BelugaAvatarProps) {
  const theme = useTheme();
  const idleVideoRef = useRef<Video>(null);
  const flipVideoRef = useRef<Video>(null);
  const [isFlipping, setIsFlipping] = useState(false);
  const [videoError, setVideoError] = useState(false);
  
  // Fallback Reanimated bob if video fails
  const idleBob = useSharedValue(0);

  // Fallback idle animation: continuous subtle bob (2px up/down, 2s cycle)
  useEffect(() => {
    if (videoError) {
      idleBob.value = withRepeat(
        withSequence(
          withTiming(-2, { duration: 1000, easing: Easing.inOut(Easing.sin) }),
          withTiming(0, { duration: 1000, easing: Easing.inOut(Easing.sin) })
        ),
        -1, // infinite
        false // don't reverse
      );
    }

    return () => {
      cancelAnimation(idleBob);
    };
  }, [idleBob, videoError]);

  const fallbackAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: idleBob.value }],
  }));

  const playFlipAnimation = useCallback(async () => {
    if (isFlipping) return; // Prevent double-taps during flip
    
    haptic('light');
    onPress?.();
    setIsFlipping(true);
    
    try {
      // Pause idle video
      await idleVideoRef.current?.pauseAsync();
      
      // Play flip video from start
      await flipVideoRef.current?.setPositionAsync(0);
      await flipVideoRef.current?.playAsync();
    } catch (error) {
      console.warn('[BelugaAvatar] Flip video error:', error);
      setIsFlipping(false);
    }
  }, [isFlipping, onPress]);

  const handleFlipPlaybackEnd = useCallback(async (status: AVPlaybackStatus) => {
    if (status.isLoaded && status.didJustFinish) {
      setIsFlipping(false);
      
      try {
        // Return to idle loop
        await idleVideoRef.current?.playAsync();
      } catch (error) {
        console.warn('[BelugaAvatar] Idle video resume error:', error);
      }
    }
  }, []);

  const handleVideoError = useCallback(() => {
    console.warn('[BelugaAvatar] Video failed to load, using Reanimated fallback');
    setVideoError(true);
  }, []);

  // Video-based avatar
  const videoAvatar = (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: backgroundColor ?? theme.colors.surfaceAlt,
        overflow: 'hidden',
      }}
    >
      {/* Idle loop video (always playing unless flip is active) */}
      <Video
        ref={idleVideoRef}
        source={require('../../assets/beluga-swim-idle.mp4')}
        style={{ width: size, height: size, display: isFlipping ? 'none' : 'flex' }}
        resizeMode={ResizeMode.COVER}
        isLooping
        isMuted
        shouldPlay
        onError={handleVideoError}
      />
      
      {/* Flip video (plays once on tap, then hides) */}
      <Video
        ref={flipVideoRef}
        source={require('../../assets/beluga-flip-splash.mp4')}
        style={{ width: size, height: size, display: isFlipping ? 'flex' : 'none' }}
        resizeMode={ResizeMode.COVER}
        isMuted
        onPlaybackStatusUpdate={handleFlipPlaybackEnd}
        onError={handleVideoError}
      />
    </View>
  );

  // Fallback animated PNG avatar (if video fails)
  const fallbackAvatar = (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: backgroundColor ?? theme.colors.surfaceAlt,
          overflow: 'hidden',
        },
        fallbackAnimatedStyle,
      ]}
    >
      <Image
        source={require('../../assets/beluga-mascot.jpg')}
        style={{ width: size, height: size }}
        resizeMode="cover"
        accessibilityIgnoresInvertColors
      />
    </Animated.View>
  );

  const avatar = videoError ? fallbackAvatar : videoAvatar;

  if (!onPress) {
    // Always animated (idle loop), but not pressable
    return <View style={style} testID={testID}>{avatar}</View>;
  }

  // Always animated (idle loop) + pressable for flip animation
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Tap to play flip animation"
      hitSlop={theme.layout.hitSlop}
      onPress={playFlipAnimation}
      style={({ pressed }) => [
        {
          opacity: pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      {avatar}
    </Pressable>
  );
}
