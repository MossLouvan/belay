# Belay wallpaper

A rope in a slack catenary with a locking screwgate hanging at the low point —
the line held. Nothing in here is a stock asset; `make_wallpaper.py` draws every
pixel with Pillow, so the art re-renders at any resolution.

Colours come straight from `app/src/theme.ts`, so the desktop matches the app:

| Role | Dark ("ink") | Light ("paper") |
|---|---|---|
| Ground | `#16140F` → `#0C0B0A` | `#F2F1EE` → `#E1DED9` |
| Rope | `#FF5C1A` | `#DE4400` |
| Hardware | `#A9A49C` | `#615C55` |
| Wordmark | `#ECEAE6` | `#161513` |

The Ledger language carries over too: a faint baseline grid, one hairline footer
rule with column ticks, type instead of cards, and no shadows.

## Files

`belay-<theme>-<w>x<h>.png` — `dark` and `light`, at 3840x2160, 3440x1440,
2560x1440 and 1920x1080.

## Regenerating

```bash
python make_wallpaper.py            # every size, both themes (~1 min)
python make_wallpaper.py 2560x1440  # just one
```

Needs Pillow and `CascadiaMono.ttf` (ships with Windows; on macOS/Linux point
`FONTS` at a directory that has it, or swap in any mono face).

Everything is drawn 2x oversized and reduced with LANCZOS so the hairlines stay
hairlines at 4K. Composition is anchored to the frame height, so it survives odd
aspect ratios — the sag sits right of centre on purpose, leaving the top-left
quadrant clear for desktop icons.

## Setting it on the dev VM

- **Windows** — right-click the PNG → *Set as desktop background*, or
  `Settings → Personalization → Background → Picture`, fit **Fill**.
- **GNOME** — `gsettings set org.gnome.desktop.background picture-uri-dark
  "file:///path/belay-dark-3840x2160.png"` (and `picture-uri` for light).
- **macOS** — `System Settings → Wallpaper → Add Photo`.

Pick the size at or above the VM's resolution; downscaling is kind to this art,
upscaling is not.
