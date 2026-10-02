## Why
The owner wants to close the laptop lid and keep using the computer from the phone, anywhere. Today a closed lid sleeps the machine (host and network stop), and the built-in screen turns off, so there is nothing to capture. Belay already ships the pieces for a screen without a panel: a macOS CGVirtualDisplay helper and a Windows indirect display driver (docs/VIRTUAL-DISPLAY.md), but both are gated behind BELAY_VIRTUAL_DISPLAY=1.

## What Changes
- Virtual display becomes a normal part of the app: the env gate is removed (on by default), and the phone shows it with no experimental flag. If the Windows driver isn't installed or the host isn't elevated, it degrades to the existing clean error.
- New "Keep running with the lid closed" switch in the System tab (Mac and Windows hosts).
- While the switch is on and a phone is streaming, the host keeps the laptop awake with the lid shut. When the lid is closed it streams a virtual display at the phone's resolution.
- Battery guard: on battery, it stops at 20% and warns the phone. It never stops for battery while on AC.
- It releases (normal sleep restored) when the switch turns off, after 30 min with no stream, or at the battery cutoff. It is also restored on host start, so a crash can't leave the Mac never-sleeping.

## Impact
server/src (new lid module + routes + state), server/native/mac (lid state, virtual display already exists), server/native (Windows powercfg + existing driver), app System tab + Screen quality sheet, docs/VIRTUAL-DISPLAY.md. Windows driver signing stays a founder item (needs company + EV cert); unsigned driver works only with test-signing.
