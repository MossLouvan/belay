// The Belay beluga mascot — cohesive identity across stream HUD and tools drawer.
//
// IDLE (default, always):
//   - Continuously loop `beluga-swim-idle.mp4` (expo-video, muted, looping).
//   - Swimming-in-water look from Moss's Hailuo clip (~2.3s loop).
//   - Fallback: Reanimated bob on PNG if video fails to load.
//
// ON PRESS (click/tap):
//   - Pause/hide idle video, play `beluga-flip-splash.mp4` once (muted).
//   - On playback end: return to swim idle loop.
//   - No autoplay of flip animation.
//
// Assets: 512x512 silent MP4s from Hailuo, circular clipped to match avatar size.
//
// Player note: this used expo-av's <Video>, which does not compile on this Expo
// release (it imports headers ExpoModulesCore no longer ships). expo-video is
// the supported successor: players are objects from useVideoPlayer, driven
// imperatively (play/pause/replay, no promises) and rendered through VideoView.

import React, { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import type { VideoPlayer, VideoPlayerStatus } from 'expo-video';
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
  const [isFlipping, setIsFlipping] = useState(false);
  const [videoError, setVideoError] = useState(false);

  // The idle loop: muted, looping, and playing from the first frame.
  const idlePlayer = useVideoPlayer(require('../../assets/beluga-swim-idle.mp4'), (player) => {
    player.loop = true;
    player.muted = true;
    player.play();
  });

  // The flip: muted, single-shot. Armed here, fired on press.
  const flipPlayer = useVideoPlayer(require('../../assets/beluga-flip-splash.mp4'), (player) => {
    player.loop = false;
    player.muted = true;
  });

  // Fallback Reanimated bob if video fails
  const idleBob = useSharedValue(0);

  // A load failure on either player drops us to the PNG fallback for good.
  useEffect(() => {
    const onStatus = ({ status, error }: { status: VideoPlayerStatus; error?: unknown }) => {
      if (status === 'error') {
        console.warn('[BelugaAvatar] Video failed to load, using Reanimated fallback', error);
        setVideoError(true);
      }
    };
    const subs = [idlePlayer, flipPlayer].map((p: VideoPlayer) =>
      p.addListener('statusChange', onStatus),
    );
    return () => {
      for (const s of subs) s.remove();
    };
  }, [idlePlayer, flipPlayer]);

  // When the flip reaches its end, hide it and resume the idle loop.
  useEffect(() => {
    const sub = flipPlayer.addListener('playToEnd', () => {
      setIsFlipping(false);
      idlePlayer.play();
    });
    return () => sub.remove();
  }, [flipPlayer, idlePlayer]);

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

  const playFlipAnimation = useCallback(() => {
    if (isFlipping) return; // Prevent double-taps during flip

    haptic('light');
    onPress?.();
    setIsFlipping(true);

    try {
      idlePlayer.pause();
      // `replay` seeks the flip to its first frame and plays it in one call.
      flipPlayer.replay();
    } catch (error) {
      console.warn('[BelugaAvatar] Flip video error:', error);
      setIsFlipping(false);
      idlePlayer.play();
    }
  }, [isFlipping, onPress, idlePlayer, flipPlayer]);

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
      <VideoView
        player={idlePlayer}
        style={{ width: size, height: size, display: isFlipping ? 'none' : 'flex' }}
        contentFit="cover"
        nativeControls={false}
        pointerEvents="none"
      />

      {/* Flip video (plays once on tap, then hides) */}
      <VideoView
        player={flipPlayer}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: size,
          height: size,
          display: isFlipping ? 'flex' : 'none',
        }}
        contentFit="cover"
        nativeControls={false}
        pointerEvents="none"
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
