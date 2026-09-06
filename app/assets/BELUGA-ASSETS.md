# Beluga Mascot Assets

## Current Assets
- **beluga-mascot.jpg** — Beluga mascot image (white beluga with blue rope collar and silver carabiner on black background)
  - Used for: Idle animation base (Reanimated bob on PNG)
  - Component: `BelugaAvatar` in `src/ui/beluga-avatar.tsx`

## Credit-Constrained Approach

### Idle Animation: Reanimated (Keep)
**Current**: Always-on Reanimated subtle bob/float/breathe on PNG
- **Implementation**: 2px Y-axis bob, 2s cycle, smooth sine easing
- **Cost**: $0 (Reanimated is free, performant, native thread)
- **Status**: ✅ Final implementation (never frozen still)
- **Future**: *Optional* swap to `beluga-idle.mp4` if credits become available

### Flip Animation: Video (Priority)
**Required**: `beluga-flip-splash.mp4` (or .webm)
- **Purpose**: Play-once flip + water splash on press/tap
- **Behavior**: Plays once when tapped, then returns to Reanimated idle
- **Duration**: ~600-1000ms
- **Format**: Silent MP4 or WebM
- **Cost**: ~7.5 Higgsfield credits
- **Status**: TODO - generate and add to `app/assets/`
- **Integration path**: `require('../../assets/beluga-flip-splash.mp4')`
- **Placeholder**: 360° Y-axis rotation (600ms) — already wired, Pressable API ready

## Current Implementation
The `BelugaAvatar` component:
- ✅ **Idle**: Reanimated subtle Y-axis bob (2px, 2s cycle) — continuous, never still
- ⏳ **Flip**: Reanimated 360° rotation (600ms) — placeholder until video supplied
- ✅ **Pressable**: API ready for video drop-in

## Integration Plan (When Flip Video Supplied)
1. Generate `beluga-flip-splash.mp4` (7.5 credits)
2. Place video file in `app/assets/beluga-flip-splash.mp4`
3. Update `src/ui/beluga-avatar.tsx`:
   - Keep Reanimated idle bob (no change)
   - Replace Reanimated flip with play-once video
   - On press: Play video once → return to Reanimated idle
4. Behavior:
   - Default: Reanimated bob loops seamlessly
   - On press: Play `beluga-flip-splash.mp4` once, then resume bob
   - No autoplay of flip

## Usage
- **Stream HUD**: 48px circular avatar (top-right) — always animated, pressable
- **Tools Drawer**: 40px circular avatar (header) — always animated, pressable
- **Cohesion**: Same `BelugaAvatar` component, same animations, different sizes

## Credit Budget
- ✅ Idle animation: $0 (Reanimated on PNG)
- ⏳ Flip animation: 7.5 credits (priority)
- Total needed: 7.5 credits (within ~10 credit budget)
