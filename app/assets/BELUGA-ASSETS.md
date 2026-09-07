# Beluga Mascot Assets

## On disk

### beluga-cutout.png
- **Path**: `app/assets/beluga-cutout.png`
- **Size**: 642x537, transparent RGBA cutout (rope collar + carabiner intact)
- **Usage**: the one and only mascot image. `BelugaAvatar`
  (`src/ui/beluga-avatar.tsx`) draws it directly on whatever surface hosts
  it — no circle, no water, no video — and animates it with Reanimated
  (`src/ui/beluga-motion.ts` holds the pure motion model).
- **Integration**: `require('../../assets/beluga-cutout.png')`

## Retired

The video era (`beluga-swim-idle.mp4`, `beluga-flip-splash.mp4`, and the
`beluga-mascot.jpg` fallback, all Hailuo/Higgsfield renders) was replaced by
the cutout: every tap adds angular velocity to a Reanimated flip, the idle is
a bob + sway, and reduced motion drops the travel entirely. The clips, the
fallback photo and the `expo-video` dependency were deleted together; the
history holds them if a video path is ever wanted again.

## Usage
- **Screen header** (portrait): 36px, on the hero ground — tap is the
  orientation latch plus the flip.
- **Stream HUD** (landscape): 48px on the HUD scrim, same tap.
- **Tools drawer**: header avatar, same component.
