# Beluga Mascot Assets

## Current Assets
- **beluga-mascot.jpg** — Static beluga mascot image (white beluga with blue rope collar and silver carabiner on black background)
  - Used in: Stream HUD avatar (48px circular), Tools drawer header (40px circular)
  - Component: `BelugaAvatar` in `src/ui/beluga-avatar.tsx`

## Pending Assets
- **beluga-flip-splash.mp4** (or .webm/.mov) — TODO: Add animated flip + water-splash video clip
  - Purpose: Play on tap/press of the beluga avatar for personality + delight
  - Behavior: Loop once or play-once then settle back to still frame
  - Duration: ~600-1000ms recommended
  - Format: Silent MP4 (or platform-optimized video format)
  - Integration: Once added, update `BelugaAvatar` component to use Video playback instead of Reanimated flip animation

## Integration Notes
The `BelugaAvatar` component currently uses a Reanimated 3D flip as a placeholder animation. Once the video asset is supplied:
1. Place the video file in `app/assets/beluga-flip-splash.mp4`
2. Update `src/ui/beluga-avatar.tsx` to replace the Reanimated animation with video playback
3. Use expo-av Video component (add dependency if needed) or react-native-video
4. Wire video to play on press, loop once, then return to still state
