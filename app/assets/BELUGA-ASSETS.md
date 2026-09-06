# Beluga Mascot Assets

## Current Assets
- **beluga-mascot.jpg** — Static beluga mascot image (white beluga with blue rope collar and silver carabiner on black background)
  - Used as fallback/poster frame
  - Component: `BelugaAvatar` in `src/ui/beluga-avatar.tsx`

## Required Video Assets (TODO: Supply)

### 1. beluga-idle.mp4 (or .webm)
**Purpose**: Continuous idle animation — always playing when beluga is visible
- **Behavior**: Seamless loop (soft bob/float/breathing, tiny flipper/tail motion)
- **Duration**: 2-4 seconds (loop length)
- **Content**: NO flip, NO splash in idle — gentle, calm personality
- **Format**: Silent MP4 or WebM
- **Integration path**: `require('../../assets/beluga-idle.mp4')`

### 2. beluga-flip-splash.mp4 (or .webm)
**Purpose**: Play-once flip + water splash on press/tap
- **Behavior**: Plays once when tapped, then returns to idle loop
- **Duration**: ~600-1000ms
- **Content**: Full flip + splash animation
- **Format**: Silent MP4 or WebM
- **Integration path**: `require('../../assets/beluga-flip-splash.mp4')`

## Current Implementation (Placeholder)
The `BelugaAvatar` component uses Reanimated animations as placeholders:
- **Idle**: Subtle Y-axis bob (2px up/down, 2s cycle) — continuous
- **Flip**: 360° Y-axis rotation on press (600ms) — play-once

## Integration Plan (Once Videos Supplied)
1. Place video files in `app/assets/`:
   - `beluga-idle.mp4`
   - `beluga-flip-splash.mp4`
2. Update `src/ui/beluga-avatar.tsx`:
   - Replace Reanimated idle bob with looping `beluga-idle.mp4`
   - Replace Reanimated flip with play-once `beluga-flip-splash.mp4`
   - Use Video component or swap sources (idle ↔ flip)
3. Behavior:
   - Default: `beluga-idle.mp4` loops seamlessly
   - On press: Play `beluga-flip-splash.mp4` once, then resume idle loop
   - No autoplay of flip animation

## Usage
- **Stream HUD**: 48px circular avatar (top-right) — always animated, pressable
- **Tools Drawer**: 40px circular avatar (header) — always animated, pressable
- **Cohesion**: Same `BelugaAvatar` component, same animations, different sizes
