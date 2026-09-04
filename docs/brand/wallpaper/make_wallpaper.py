#!/usr/bin/env python3
"""Generate the Belay desktop wallpapers.

The art is the name: a rope in a slack catenary with a locking carabiner
hanging at its low point -- the line held. Colours are lifted verbatim from
app/src/theme.ts (the "Ledger" system): warm ink ground, burnt-orange accent,
hairline rules, no cards and no shadows.

    python make_wallpaper.py            # every size, both themes
    python make_wallpaper.py 2560x1440  # just one

Everything is drawn on a 2x supersampled canvas and reduced with LANCZOS, so
hairlines stay hairlines at 4K without going dotty.
"""

import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SS = 2  # supersample factor
OUT = os.path.dirname(os.path.abspath(__file__))
FONTS = r"C:\Windows\Fonts"

SIZES = [(3840, 2160), (3440, 1440), (2560, 1440), (1920, 1080)]

# --- palettes (app/src/theme.ts) -------------------------------------------
DARK = dict(
    name="dark",
    bg_top="#16140F", bg_bot="#0C0B0A",
    rule="#2E2C29", rule_strong="#4A4741",
    text="#ECEAE6", text_dim="#A9A49C", text_faint="#928D84",
    accent="#FF5C1A", accent_hi="#FF9A5E", accent_lo="#B33A0D",
    metal="#A9A49C", metal_hi="#ECEAE6", metal_lo="#4A4741",
    glow="#FF4D00", grain=7, bloom=26,
)
LIGHT = dict(
    name="light",
    bg_top="#F2F1EE", bg_bot="#E1DED9",
    rule="#C8C4BD", rule_strong="#8F8A82",
    text="#161513", text_dim="#4F4B45", text_faint="#615C55",
    accent="#DE4400", accent_hi="#FF7A3D", accent_lo="#8A2B00",
    metal="#615C55", metal_hi="#8F8A82", metal_lo="#3A3630",
    glow="#DE4400", grain=5, bloom=14,
)


def rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def rgba(h, a):
    return rgb(h) + (a,)


def mix(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(rgb(a), rgb(b)))


# --- geometry ---------------------------------------------------------------
def catenary(t, y0, y1, sag, k=1.85):
    """t in [0,1] -> y. Ends at y0/y1, dips `sag` below the chord at centre."""
    base = y0 + (y1 - y0) * t
    dip = sag * (1.0 - (math.cosh(k * (2 * t - 1)) - 1) / (math.cosh(k) - 1))
    return base + dip


def rope_points(W, H, n=520):
    # Skewed right so the sag -- and the carabiner on it -- sits right of
    # centre, leaving the top-left quadrant clear for desktop icons.
    x0, x1 = -0.06 * W, 1.26 * W
    y0, y1 = 0.24 * H, 0.02 * H
    sag = 0.44 * H
    return [
        (x0 + (x1 - x0) * (i / n), catenary(i / n, y0, y1, sag))
        for i in range(n + 1)
    ]


# --- pieces -----------------------------------------------------------------
def background(W, H, P):
    """Vertical warm gradient + a wide, very soft accent bloom behind the sag."""
    grad = Image.new("RGB", (1, H))
    gd = ImageDraw.Draw(grad)
    for y in range(H):
        gd.point((0, y), fill=mix(P["bg_top"], P["bg_bot"], (y / H) ** 0.85))
    img = grad.resize((W, H), Image.BILINEAR).convert("RGBA")

    bloom = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bloom)
    cx, cy, r = 0.60 * W, 0.66 * H, 0.42 * H
    bd.ellipse((cx - r * 1.6, cy - r, cx + r * 1.6, cy + r),
               fill=rgba(P["glow"], P["bloom"]))
    bloom = bloom.filter(ImageFilter.GaussianBlur(0.22 * H))
    return Image.alpha_composite(img, bloom)


def ledger(W, H, P, hair):
    """The Ledger texture: a faint baseline grid, one strong footer rule."""
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    step = H / 26.0
    y = step
    while y < H:
        d.line([(0, y), (W, y)], fill=rgba(P["rule"], 42), width=hair)
        y += step
    d.line([(0.055 * W, 0.845 * H), (0.945 * W, 0.845 * H)],
           fill=rgba(P["rule_strong"], 120), width=hair)
    # tick marks on the footer rule, ledger-column style
    for i in range(1, 8):
        x = 0.055 * W + (0.89 * W) * i / 8.0
        d.line([(x, 0.845 * H - step * 0.28), (x, 0.845 * H)],
               fill=rgba(P["rule_strong"], 70), width=hair)
    return lay


def rope(W, H, P, pts, rw):
    """Kernmantle: glow, sheath, core highlight, braid ticks."""
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))

    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).line(pts, fill=rgba(P["glow"], 70),
                              width=int(rw * 2.6), joint="curve")
    lay = Image.alpha_composite(lay, glow.filter(ImageFilter.GaussianBlur(rw * 1.5)))

    d = ImageDraw.Draw(lay)
    d.line(pts, fill=rgba(P["accent_lo"], 255), width=int(rw), joint="curve")
    d.line(pts, fill=rgba(P["accent"], 255), width=int(rw * 0.80), joint="curve")

    # core highlight, nudged toward the light
    hi = [(x, y - rw * 0.20) for x, y in pts]
    d.line(hi, fill=rgba(P["accent_hi"], 170), width=max(1, int(rw * 0.22)),
           joint="curve")

    # braid: short strokes across the sheath, cadence following the curve
    braid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(braid)
    spacing = rw * 1.9
    acc = spacing
    for i in range(1, len(pts)):
        (ax, ay), (bx, by) = pts[i - 1], pts[i]
        acc += math.hypot(bx - ax, by - ay)
        if acc < spacing:
            continue
        acc = 0.0
        ang = math.atan2(by - ay, bx - ax) + math.radians(62)
        hx, hy = math.cos(ang) * rw * 0.52, math.sin(ang) * rw * 0.52
        bd.line([(bx - hx, by - hy), (bx + hx, by + hy)],
                fill=rgba(P["accent_lo"], 150), width=max(1, int(rw * 0.13)))
    braid = braid.filter(ImageFilter.GaussianBlur(rw * 0.06))
    return Image.alpha_composite(lay, braid)


CAR_BODY_H = 16.0   # carabiner body height, in rope widths
CAR_PAD = 2.4       # transparent margin around it, same units


def _offset_d(cx, y_top, y_bot, r_top, r_bot, n=64):
    """Outline of an offset-D carabiner: narrow rope end, wide basket.

    Returns the closed body path and, separately, the contiguous left flank
    (bottom-left arc up through the top-left arc) so the specular highlight can
    trace one unbroken side instead of two disjoint halves.
    """
    ct, cb = y_top + r_top, y_bot - r_bot
    top = [(cx + r_top * math.cos(math.pi + math.pi * i / n),
            ct + r_top * math.sin(math.pi + math.pi * i / n))
           for i in range(n + 1)]                     # left -> right
    bot = [(cx + r_bot * math.cos(math.pi * i / n),
            cb + r_bot * math.sin(math.pi * i / n))
           for i in range(n + 1)]                     # right -> left
    body = top + bot + [top[0]]
    left = bot[n // 2:] + top[:n // 2 + 1]
    return body, left


def carabiner(P, rw):
    """A locking screwgate, drawn upright then rotated by the caller."""
    t = max(2, int(rw * 0.42))          # stock thickness
    h = rw * CAR_BODY_H
    r_top, r_bot = rw * 2.30, rw * 3.75
    pad = rw * CAR_PAD
    img = Image.new("RGBA", (int(r_bot * 2 + pad * 2), int(h + pad * 2)),
                    (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, y_top, y_bot = r_bot + pad, pad, pad + h

    body, left = _offset_d(cx, y_top, y_bot, r_top, r_bot)
    d.line(body, fill=rgba(P["metal_lo"], 255), width=int(t * 1.25),
           joint="curve")
    d.line(body, fill=rgba(P["metal"], 255), width=t, joint="curve")
    # specular: only the left flank catches the light
    d.line(left, fill=rgba(P["metal_hi"], 140), width=max(1, int(t * 0.34)),
           joint="curve")

    # gate down the right flank, from the top cap to the basket
    gy0, gy1 = y_top + h * 0.16, y_top + h * 0.62
    gx0 = cx + r_top * 0.98
    gx1 = cx + r_bot * 0.86
    d.line([(gx0, gy0), (gx1, gy1)], fill=rgba(P["metal_lo"], 255),
           width=int(t * 1.1))
    d.line([(gx0, gy0), (gx1, gy1)], fill=rgba(P["metal"], 215),
           width=max(1, int(t * 0.5)))

    # screw-lock sleeve, straddling the middle of the gate
    def on_gate(u):
        return (gx0 + (gx1 - gx0) * u, gy0 + (gy1 - gy0) * u)

    sx0, sy0 = on_gate(0.34)
    sx1, sy1 = on_gate(0.66)
    ang = math.atan2(sy1 - sy0, sx1 - sx0)
    nx, ny = -math.sin(ang) * t * 1.05, math.cos(ang) * t * 1.05
    d.polygon([(sx0 - nx, sy0 - ny), (sx1 - nx, sy1 - ny),
               (sx1 + nx, sy1 + ny), (sx0 + nx, sy0 + ny)],
              fill=rgba(P["metal_lo"], 255), outline=rgba(P["metal"], 255),
              width=max(1, int(t * 0.34)))
    for i in range(5):  # knurling
        u = (i + 0.5) / 5
        kx, ky = sx0 + (sx1 - sx0) * u, sy0 + (sy1 - sy0) * u
        d.line([(kx - nx * 0.78, ky - ny * 0.78), (kx + nx * 0.78, ky + ny * 0.78)],
               fill=rgba(P["metal"], 150), width=max(1, int(t * 0.26)))

    # hinge and nose pins
    for u, rr in ((0.0, t * 0.34), (1.0, t * 0.30)):
        px, py = on_gate(u)
        d.ellipse((px - rr, py - rr, px + rr, py + rr),
                  fill=rgba(P["metal_hi"], 200))
    return img


def wordmark(W, H, P, hair):
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    mono = os.path.join(FONTS, "CascadiaMono.ttf")
    big = ImageFont.truetype(mono, int(H * 0.052))
    small = ImageFont.truetype(mono, int(H * 0.0155))
    tiny = ImageFont.truetype(mono, int(H * 0.0125))

    right = 0.945 * W
    base = 0.795 * H

    def tracked(text, font, x_right, y, fill, track):
        widths = [d.textlength(c, font=font) for c in text]
        total = sum(widths) + track * (len(text) - 1)
        x = x_right - total
        for c, cw in zip(text, widths):
            d.text((x, y), c, font=font, fill=fill, anchor="ls")
            x += cw + track
        return total

    total = tracked("BELAY", big, right, base, rgba(P["text"], 255),
                    int(H * 0.020))
    tracked("hold the line", small, right, base + H * 0.036,
            rgba(P["text_dim"], 255), int(H * 0.0085))

    # accent keel under the wordmark
    d.line([(right - total, base + H * 0.014), (right, base + H * 0.014)],
           fill=rgba(P["accent"], 255), width=max(hair, int(H * 0.0035)))

    # host label riding the left end of the footer rule
    d.text((0.055 * W, 0.845 * H - H * 0.016),
           "dev vm  ·  self-hosted  ·  no relay",
           font=tiny, fill=rgba(P["text_faint"], 255), anchor="ls")
    return lay


def grain(W, H, amt):
    n = Image.new("L", (W // 2, H // 2))
    rnd = random.Random(0xBE1A7)
    n.putdata([rnd.randint(0, 255) for _ in range(n.width * n.height)])
    n = n.resize((W, H), Image.BILINEAR)
    lay = Image.new("RGBA", (W, H), (255, 255, 255, 0))
    lay.putalpha(n.point(lambda v: int(abs(v - 128) / 128 * amt)))
    return lay


# --- compose ----------------------------------------------------------------
def render(W, H, P):
    w, h = W * SS, H * SS
    hair = max(1, round(h / 1080))
    rw = h * 0.0088

    img = background(w, h, P)
    img = Image.alpha_composite(img, ledger(w, h, P, hair))

    pts = rope_points(w, h)
    img = Image.alpha_composite(img, rope(w, h, P, pts, rw))

    # The carabiner hangs at the low point of the sag with the rope running
    # through its top cap. Free-hanging, so it answers to gravity, not to the
    # tangent -- just enough tilt to look hung rather than pasted on.
    lx, ly = max(pts, key=lambda p: p[1])
    car = carabiner(P, rw)
    rot = car.rotate(7.0, resample=Image.BICUBIC, expand=True)
    dx, dy = (rot.width - car.width) / 2, (rot.height - car.height) / 2
    img.alpha_composite(rot, (int(lx - car.width / 2 - dx),
                              int(ly - rw * (2.30 + CAR_PAD) - dy)))

    img = Image.alpha_composite(img, wordmark(w, h, P, hair))
    img = Image.alpha_composite(img, grain(w, h, P["grain"]))

    return img.resize((W, H), Image.LANCZOS).convert("RGB")


def main():
    args = sys.argv[1:]
    sizes = [tuple(int(v) for v in s.lower().split("x")) for s in args] or SIZES
    for P in (DARK, LIGHT):
        for W, H in sizes:
            path = os.path.join(OUT, "belay-%s-%dx%d.png" % (P["name"], W, H))
            render(W, H, P).save(path, optimize=True)
            print("%s  (%.0f KB)" % (path, os.path.getsize(path) / 1024))


if __name__ == "__main__":
    main()
