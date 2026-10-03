# Beluga Assets

## On disk

### beluga-mark.svg
- The flat one-colour silhouette: app icon, tray, and every small spot in the
  app via `BelugaAvatar` (`src/ui/beluga-avatar.tsx`), which recolours it with
  the theme.

### beluga-cartoon.svg
- The cartoon illustration (cream body, slate outline, blue rope collar and
  carabiner). The app draws it through `BelugaIllustration`
  (`src/ui/beluga-illustration.tsx`, an inlined copy) in hero spots: the
  welcome screen, the empty computer list, the lock screen.

## Retired

The 3D render cutout (and before it the Hailuo/Higgsfield swim videos) was
dropped from the app: it belongs on the website only. The app must not
reference it (`src/design/no-off-system.test.mjs` fails if it does).
