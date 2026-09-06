# Beluga Mascot Assets

## Delivered Assets ✅

### 1. beluga-swim-idle.mp4
**Status**: ✅ Committed, integrated
- **Source**: Hailuo AI via Moss (swim cycle from end of Hailuo clip)
- **Path**: `app/assets/beluga-swim-idle.mp4`
- **Size**: 512x512, ~135KB
- **Duration**: ~2.3s
- **Format**: Silent MP4
- **Usage**: IDLE loop — continuously plays while beluga is visible
- **Behavior**: expo-av Video, muted, isLooping, shouldPlay
- **Integration**: `require('../../assets/beluga-swim-idle.mp4')`

### 2. beluga-flip-splash.mp4
**Status**: ✅ Committed, integrated
- **Source**: Hailuo AI via Moss (flip + water splash animation)
- **Path**: `app/assets/beluga-flip-splash.mp4`
- **Size**: 512x512, ~337KB
- **Duration**: 4.0s
- **Format**: Silent MP4
- **Usage**: ON PRESS — plays once when tapped, then returns to idle
- **Behavior**: expo-av Video, muted, play-once, didJustFinish → resume idle
- **Integration**: `require('../../assets/beluga-flip-splash.mp4')`

### 3. beluga-mascot.jpg
**Status**: ✅ Committed (fallback only)
- **Path**: `app/assets/beluga-mascot.jpg`
- **Usage**: Fallback if video fails to load (Reanimated bob on PNG)

## Final Implementation ✅

The `BelugaAvatar` component (`src/ui/beluga-avatar.tsx`):

**IDLE (default, always)**:
- ✅ Primary: Continuously loop `beluga-swim-idle.mp4` (expo-av Video)
  - Swimming-in-water look, ~2.3s loop
  - Muted, isLooping, shouldPlay
  - Never frozen still
- ✅ Fallback: Reanimated subtle bob (2px Y-axis, 2s cycle) if video fails
  - Automatic error handling with `onError` handler

**ON PRESS (tap/click)**:
- ✅ Pause/hide idle video
- ✅ Play `beluga-flip-splash.mp4` once (muted, 4.0s)
- ✅ On playback end: return to idle loop (resume `beluga-swim-idle.mp4`)
- ✅ Haptic feedback on press
- ✅ No autoplay of flip animation
- ✅ Prevents double-taps during flip

**Technical Details**:
- Two Video refs: `idleVideoRef` (always looping) + `flipVideoRef` (play-once on tap)
- Display toggle: `isFlipping` state controls which video is visible
- Circular clip: `borderRadius` + `overflow: hidden` for circular masking
- ResizeMode: `COVER` for proper 512x512 → circular avatar scaling
- Error handling: Falls back to Reanimated bob if video fails to load

## Usage
- **Stream HUD**: 48px circular avatar (top-right, landscape mode) — swim idle loop, flip on tap
- **Tools Drawer**: 40px circular avatar (header) — swim idle loop, flip on tap
- **Cohesion**: Same `BelugaAvatar` component, same behavior, different sizes

## Cost Summary
- ✅ Swim idle video: Included in Hailuo source from Moss
- ✅ Flip splash video: 7.5 Higgsfield credits (delivered)
- ✅ Total cost: Within ~10 credit budget
- ✅ Reanimated fallback: $0 (free safety net)
