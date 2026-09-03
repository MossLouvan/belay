# Trackpad-Style Gesture Controls

Belay now supports OS-native trackpad gestures when remotely controlling a Mac or Windows PC from your phone. Multi-finger swipes behave like a real trackpad, triggering the same system actions you'd expect on the host computer.

## Overview

The gesture system detects:
- **3-finger swipes** for desktop/space navigation and window management
- **2-finger edge swipes** for system panels like Notification Center
- Platform-aware gesture mapping that sends the correct shortcuts for macOS vs Windows

All gestures work in any pointer mode (Touch, Scroll, or Trackpad) and are active whenever the remote screen is visible.

## Supported Gestures

### Three-Finger Swipes

| Gesture | macOS Action | Windows Action |
|---------|--------------|----------------|
| 3-finger swipe left | Switch to next Space/desktop (⌃→) | Switch to next virtual desktop (Win+Ctrl+→) |
| 3-finger swipe right | Switch to previous Space/desktop (⌃←) | Switch to previous virtual desktop (Win+Ctrl+←) |
| 3-finger swipe up | Mission Control (⌃↑) | Task View (Win+Tab) |
| 3-finger swipe down | Show Desktop (F11) | Show Desktop (Win+D) |

**Behavior notes:**
- The content moves with your fingers: swiping left shows the desktop on the right
- Requires crossing a 48px threshold to commit
- Once committed, the gesture fires exactly once (no double-triggers)
- Diagonal swipes wait until one axis is decisively ahead before committing

### Two-Finger Edge Swipes

| Gesture | macOS Action | Windows Action |
|---------|--------------|----------------|
| 2-finger swipe down from top edge | Notification Center (⌃⌘↑)* | Action Center (Win+A) |

**Edge detection:**
- Gesture must start within 60px of the screen edge
- Corner detection uses an 80px threshold for more precise targeting
- Requires 40px of travel to commit

*Note: macOS Notification Center keyboard shortcuts vary by OS version and user configuration. The implemented shortcut (⌃⌘↑) works on macOS 11+ with default settings. Some Macs may require different shortcuts depending on system preferences.

## How It Works

### Client Side (React Native)
1. **Touch tracking** (`app/src/screen/viewport.ts`):
   - PanResponder tracks all touches by identity
   - Two-finger gestures check if they started near a screen edge
   - Three-finger gestures track centroid movement

2. **Gesture classification** (`app/src/screen/swipe.ts`, `app/src/screen/edge-gestures.ts`):
   - Centroid or edge position determines intent
   - Travel distance and axis dominance commit the gesture
   - Edge gestures are prioritized over zoom/scroll when detected

3. **Action mapping** (`app/src/screen/model.ts`):
   - Each gesture maps to a KeySpec (DeskNext, DeskPrev, Overview, ShowDesktop, NotifyCenter)
   - KeySpecs define both macOS and Windows shortcuts
   - OS detection happens via `ScreenInfo.platform`

### Server Side (Node.js)
1. **Key injection** (`server/src/keys.ts`):
   - Maps key names to platform-specific virtual key codes
   - macOS uses Carbon CGKeyCodes
   - Windows uses Win32 VK codes

2. **Native input** (platform-specific native modules):
   - macOS: CGEvent API for keyboard injection
   - Windows: SendInput API for keyboard injection
   - Both support modifier keys (Ctrl, Alt, Shift, Command)

### Security & Permissions

Gestures only work on paired, authenticated sessions. They respect the same security model as all other input:
- Bearer token required for `/input/key` route
- macOS requires Accessibility permission for keyboard injection
- Windows requires no special permissions (SendInput is available to normal processes)

## Discoverability

Users learn about gestures through:
1. **Help sheet** — The Screen tab's "Controls & permissions" sheet lists all gestures
2. **Accessibility labels** — VoiceOver announces "three fingers to switch desktops or access system controls"
3. **Key bar** — Desk keys on the last page offer touch equivalents for the swipe gestures

## Implementation Files

### Client (React Native / TypeScript)
- `app/src/screen/model.ts` — KeySpec definitions, gesture tuning constants
- `app/src/screen/swipe.ts` — 3-finger swipe detection
- `app/src/screen/edge-gestures.ts` — 2-finger edge gesture detection
- `app/src/screen/viewport.ts` — Touch tracking and gesture classification
- `app/src/screen/touches.ts` — Multi-touch bookkeeping
- `app/app/(tabs)/screen.tsx` — Screen surface and help documentation

### Server (Node.js / TypeScript)
- `server/src/keys.ts` — Platform-specific key code mappings

## Testing

### Manual Testing
1. Pair your phone with a Mac or Windows PC
2. Navigate to the Screen tab
3. Try each gesture:
   - 3-finger swipe left/right (should switch virtual desktops/spaces)
   - 3-finger swipe up (should open Mission Control / Task View)
   - 3-finger swipe down (should show desktop)
   - 2-finger swipe down from top edge (should open Notification Center / Action Center)

### Expected Behavior
- **Mac**: Spaces/Mission Control/Desktop shortcuts trigger as configured in System Settings
- **Windows**: Virtual desktop switching, Task View, and Action Center open as expected
- **Both**: Gestures should feel natural and responsive, matching trackpad behavior

### Known Limitations
1. **macOS Notification Center**: The keyboard shortcut for Notification Center varies by OS version and user settings. The default implementation may not work on all Macs.
2. **Windows Show Desktop**: Win+D toggles rather than momentarily revealing (App Exposé equivalent doesn't exist on Windows)
3. **React Native multi-touch**: Some phones may report limited touch point data; gesture detection gracefully degrades

## Future Enhancements

Potential additions (not yet implemented):
- 4-finger swipes for app switching
- Horizontal edge swipes for additional system actions
- Per-app gesture customization
- Haptic feedback intensity tuning
- Gesture sensitivity settings

## Troubleshooting

**Gestures not working on macOS:**
- Check that the terminal/app launching the server has Accessibility permission
- System Settings → Privacy & Security → Accessibility
- Quit and restart the launching app after granting permission

**Wrong shortcuts firing:**
- Verify the host is correctly detected as macOS or Windows
- Check `/screen/info` response includes `platform: 'darwin'` or `platform: 'win32'`

**Edge gestures not triggering:**
- Ensure the swipe starts within 60px of the screen edge
- Try starting closer to the corner (top-left or top-right)
- Check that 2 fingers are down simultaneously

**Three-finger swipes not working:**
- Confirm all 3 fingers land before starting the swipe
- Swipe at least 48px in one direction
- Avoid diagonal swipes (commit to horizontal or vertical first)
