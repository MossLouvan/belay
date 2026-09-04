#!/usr/bin/env python3
"""Generate the Belay desktop wallpapers.

The art is the name: a rope in a slack catenary with a locking carabiner
clipped through it at the low point -- the line held. Colours are lifted
verbatim from app/src/theme.ts (the "Ledger" system): warm ink ground,
burnt-orange accent, hairline rules, no cards and no shadows. Type is Outfit
(fonts/Outfit.ttf, OFL), the brand face.

    python make_wallpaper.py            # every size, both themes
    python make_wallpaper.py 2560x1440  # just one

Everything is drawn on a 3x supersampled canvas and reduced with LANCZOS, so
hairlines stay hairlines at 4K without going dotty.
"""

import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SS = 3  # supersample factor
OUT = os.path.dirname(os.path.abspath(__file__))
OUTFIT = os.path.join(OUT, "fonts", "Outfit.ttf")

SIZES = [(3840, 2160), (3440, 1440), (2560, 1440), (1920, 1080)]

# --- palettes ---------------------------------------------------------------
# Every hex below is a token from app/src/theme.ts. `accent_lo` is the only
# derived value: the accent mixed toward the ground, for the rope's shaded
# underside (the palette has no dark-orange role).
DARK = dict(
    name="dark",
    bg_top="#1A1917",       # surface
    bg_bot="#0C0B0A",       # machine
    rule="#2E2C29",         # border
    rule_strong="#4A4741",  # borderStrong
    text="#ECEAE6",         # text
    text_dim="#A9A49C",     # textDim
    text_faint="#928D84",   # textFaint
    accent="#FF5C1A",       # accent
    accent_hi="#FF7A3D",    # onAccentSoft
    glow="#FF4D00",         # accentGraphic
    metal="#A9A49C",        # textDim
    metal_hi="#ECEAE6",     # text
    metal_lo="#4A4741",     # borderStrong
    grain=6, bloom=10, rope_glow=26,
)
LIGHT = dict(
    name="light",
    bg_top="#F2F1EE",       # surface
    bg_bot="#E1DED9",       # surfaceAlt
    rule="#C8C4BD",         # border
    rule_strong="#8F8A82",  # borderStrong
    text="#161513",         # text
    text_dim="#4F4B45",     # textDim
    text_faint="#615C55",   # textFaint
    accent="#DE4400",       # accentGraphic
    accent_hi="#FF7A3D",    # onAccentSoft -- the lit crown of the rope
    glow="#DE4400",         # accentGraphic
    metal="#615C55",        # textFaint
    metal_hi="#8F8A82",     # borderStrong
    metal_lo="#161513",     # text
    grain=4, bloom=6, rope_glow=14,
)


def rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def rgba(h, a):
    return rgb(h) + (a,)


def mix(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(rgb(a), rgb(b)))


def hexmix(a, b, t):
    return "#%02X%02X%02X" % mix(a, b, t)


# --- geometry ---------------------------------------------------------------
T_HANG = 0.52  # curve parameter the carabiner hangs from


def catenary(t, y0, y1, sag, k=1.85):
    """t in [0,1] -> y. Ends at y0/y1, dips `sag` below the chord at centre."""
    base = y0 + (y1 - y0) * t
    dip = sag * (1.0 - (math.cosh(k * (2 * t - 1)) - 1) / (math.cosh(k) - 1))
    return base + dip


def rope_points(W, H, rw, n=1400):
    """The line, skewed right so the sag -- and the carabiner on it -- sits
    right of centre, leaving the top-left quadrant clear for desktop icons.

    A shallow gaussian at T_HANG is the carabiner's weight: the rope is loaded
    there, so it draws down a touch rather than running through dead straight.
    """
    x0, x1 = -0.06 * W, 1.26 * W
    y0, y1 = 0.24 * H, 0.02 * H
    sag = 0.42 * H
    pts = []
    for i in range(n + 1):
        t = i / n
        load = rw * 1.5 * math.exp(-((t - T_HANG) / 0.085) ** 2)
        pts.append((x0 + (x1 - x0) * t, catenary(t, y0, y1, sag) + load))
    return pts


def rope_at(pts, t):
    return pts[min(len(pts) - 1, int(round(t * (len(pts) - 1))))]


# --- pieces -----------------------------------------------------------------
def background(W, H, P):
    """Vertical warm gradient + one wide, very soft accent bloom behind the sag."""
    grad = Image.new("RGB", (1, H))
    gd = ImageDraw.Draw(grad)
    for y in range(H):
        gd.point((0, y), fill=mix(P["bg_top"], P["bg_bot"], (y / H) ** 0.85))
    img = grad.resize((W, H), Image.BILINEAR).convert("RGBA")

    bloom = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bloom)
    cx, cy, r = 0.62 * W, 0.62 * H, 0.40 * H
    bd.ellipse((cx - r * 1.7, cy - r, cx + r * 1.7, cy + r),
               fill=rgba(P["glow"], P["bloom"]))
    bloom = bloom.filter(ImageFilter.GaussianBlur(0.30 * H))
    return Image.alpha_composite(img, bloom)


def rules(W, H, P, hair):
    """One hairline footer rule. That is the whole ledger texture now -- the
    baseline grid it used to carry banded the gradient and read as artefacts."""
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    d.line([(0.055 * W, 0.862 * H), (0.945 * W, 0.862 * H)],
           fill=rgba(P["rule_strong"], 90), width=hair)
    return lay


def rope(W, H, P, pts, rw):
    """Kernmantle: a restrained halo, sheath, core highlight, faint braid."""
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    accent_lo = hexmix(P["accent"], P["bg_bot"], 0.42)

    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).line(pts, fill=rgba(P["glow"], P["rope_glow"]),
                              width=int(rw * 3.2), joint="curve")
    lay = Image.alpha_composite(lay, glow.filter(ImageFilter.GaussianBlur(rw * 2.4)))

    d = ImageDraw.Draw(lay)
    d.line(pts, fill=rgba(accent_lo, 255), width=int(rw), joint="curve")
    d.line(pts, fill=rgba(P["accent"], 255), width=int(rw * 0.78), joint="curve")

    # core highlight, nudged toward the light
    hi = [(x, y - rw * 0.22) for x, y in pts]
    d.line(hi, fill=rgba(P["accent_hi"], 120), width=max(1, int(rw * 0.20)),
           joint="curve")

    # braid: short strokes across the sheath, cadence following the curve.
    # Deliberately near-invisible -- it should read as texture at arm's length,
    # never as hatching.
    braid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(braid)
    spacing = rw * 2.2
    acc = spacing
    for i in range(1, len(pts)):
        (ax, ay), (bx, by) = pts[i - 1], pts[i]
        acc += math.hypot(bx - ax, by - ay)
        if acc < spacing:
            continue
        acc = 0.0
        ang = math.atan2(by - ay, bx - ax) + math.radians(62)
        hx, hy = math.cos(ang) * rw * 0.46, math.sin(ang) * rw * 0.46
        bd.line([(bx - hx, by - hy), (bx + hx, by + hy)],
                fill=rgba(accent_lo, 70), width=max(1, int(rw * 0.11)))
    braid = braid.filter(ImageFilter.GaussianBlur(rw * 0.30))
    return Image.alpha_composite(lay, braid)


# --- carabiner --------------------------------------------------------------
CAR_H = 17.0     # body height, in rope widths
CAR_RTOP = 2.55  # rope-end (top) bend radius
CAR_RBOT = 4.10  # basket (bottom) bend radius
CAR_PAD = 2.6    # transparent margin, same units


def _offset_d(cx, y_top, y_bot, r_top, r_bot, n=96):
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
    """A locking screwgate drawn upright, plus the anchor the rope threads.

    Returns (image, anchor, split_x). `anchor` is the point inside the top bend
    where the rope bears; `split_x` is the axis dividing the near flank (drawn
    over the rope) from the far one (drawn under it).
    """
    t = max(2, int(rw * 0.44))          # stock thickness
    h = rw * CAR_H
    r_top, r_bot = rw * CAR_RTOP, rw * CAR_RBOT
    pad = rw * CAR_PAD
    img = Image.new("RGBA", (int(r_bot * 2 + pad * 2), int(h + pad * 2)),
                    (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, y_top, y_bot = r_bot + pad, pad, pad + h

    body, left = _offset_d(cx, y_top, y_bot, r_top, r_bot)
    d.line(body, fill=rgba(P["metal_lo"], 255), width=int(t * 1.3),
           joint="curve")
    d.line(body, fill=rgba(P["metal"], 255), width=t, joint="curve")
    # specular: only the left flank catches the light
    d.line(left, fill=rgba(P["metal_hi"], 150), width=max(1, int(t * 0.34)),
           joint="curve")

    # gate down the right flank, from the top cap to the basket
    gy0, gy1 = y_top + h * 0.17, y_top + h * 0.64
    gx0, gx1 = cx + r_top * 0.98, cx + r_bot * 0.86
    d.line([(gx0, gy0), (gx1, gy1)], fill=rgba(P["metal_lo"], 255),
           width=int(t * 1.1))
    d.line([(gx0, gy0), (gx1, gy1)], fill=rgba(P["metal"], 215),
           width=max(1, int(t * 0.5)))

    # screw-lock sleeve, straddling the middle of the gate
    def on_gate(u):
        return (gx0 + (gx1 - gx0) * u, gy0 + (gy1 - gy0) * u)

    sx0, sy0 = on_gate(0.36)
    sx1, sy1 = on_gate(0.68)
    ang = math.atan2(sy1 - sy0, sx1 - sx0)
    nx, ny = -math.sin(ang) * t * 1.05, math.cos(ang) * t * 1.05
    d.polygon([(sx0 - nx, sy0 - ny), (sx1 - nx, sy1 - ny),
               (sx1 + nx, sy1 + ny), (sx0 + nx, sy0 + ny)],
              fill=rgba(P["metal_lo"], 255), outline=rgba(P["metal"], 255),
              width=max(1, int(t * 0.34)))
    for i in range(5):  # knurling
        u = (i + 0.5) / 5
        kx, ky = sx0 + (sx1 - sx0) * u, sy0 + (sy1 - sy0) * u
        d.line([(kx - nx * 0.78, ky - ny * 0.78),
                (kx + nx * 0.78, ky + ny * 0.78)],
               fill=rgba(P["metal"], 150), width=max(1, int(t * 0.26)))

    # hinge and nose pins
    for u, rr in ((0.0, t * 0.34), (1.0, t * 0.30)):
        px, py = on_gate(u)
        d.ellipse((px - rr, py - rr, px + rr, py + rr),
                  fill=rgba(P["metal_hi"], 200))

    # The rope rides the inside of the top bend, one stock-thickness below the
    # crown; that point is what gets planted on the curve.
    return img, (cx, y_top + t * 0.5 + rw * 0.5), cx


def _rotate_tracked(img, angle, anchor):
    """Rotate about the image centre (expanding) and report where `anchor` went."""
    mark = Image.new("L", img.size, 0)
    ImageDraw.Draw(mark).ellipse(
        (anchor[0] - 2, anchor[1] - 2, anchor[0] + 2, anchor[1] + 2), fill=255)
    rot = img.rotate(angle, resample=Image.BICUBIC, expand=True)
    rm = mark.rotate(angle, resample=Image.BICUBIC, expand=True)
    px = rm.load()
    sx = sy = sw = 0.0
    for y in range(rm.height):
        for x in range(rm.width):
            v = px[x, y]
            if v:
                sx += x * v
                sy += y * v
                sw += v
    return rot, (sx / sw, sy / sw)


CAR_TILT = 6.0  # degrees; free-hanging, so it answers to gravity, not the tangent


def hang_carabiner(size, P, pts, rw):
    """Clip the carabiner through the rope at T_HANG.

    The rope threads the top bend, so the far flank passes behind the line and
    the near flank in front of it. Both come from the same render, drawn twice
    with the near half masked out of the second pass, so the crossing has no
    seam. Composited by the caller as: back layer, rope, front layer.
    """
    car, anchor, split_x = carabiner(P, rw)
    rot, (ax, ay) = _rotate_tracked(car, CAR_TILT, anchor)

    near = Image.new("L", car.size, 0)
    ImageDraw.Draw(near).rectangle((split_x, 0, car.width, car.height), fill=255)
    front = car.copy()
    front.putalpha(Image.composite(car.getchannel("A"),
                                   Image.new("L", car.size, 0), near))
    front = front.rotate(CAR_TILT, resample=Image.BICUBIC, expand=True)

    hx, hy = rope_at(pts, T_HANG)
    at = (int(round(hx - ax)), int(round(hy - ay)))

    back_l = Image.new("RGBA", size, (0, 0, 0, 0))
    back_l.alpha_composite(rot, at)
    front_l = Image.new("RGBA", size, (0, 0, 0, 0))
    front_l.alpha_composite(front, at)
    return back_l, front_l


# --- type -------------------------------------------------------------------
def outfit(size, weight):
    f = ImageFont.truetype(OUTFIT, size)
    f.set_variation_by_name(weight)
    return f


def wordmark(W, H, P, hair):
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    big = outfit(int(H * 0.056), "SemiBold")
    small = outfit(int(H * 0.0165), "Regular")
    tiny = outfit(int(H * 0.0140), "Medium")

    right = 0.945 * W
    base = 0.806 * H

    def tracked(text, font, x_left, y, fill, track):
        widths = [d.textlength(c, font=font) for c in text]
        total = sum(widths) + track * (len(text) - 1)
        x = x_left
        for c, cw in zip(text, widths):
            d.text((x, y), c, font=font, fill=fill, anchor="ls")
            x += cw + track
        return total

    def tracked_right(text, font, x_right, y, fill, track):
        widths = [d.textlength(c, font=font) for c in text]
        total = sum(widths) + track * (len(text) - 1)
        tracked(text, font, x_right - total, y, fill, track)
        return total

    total = tracked_right("BELAY", big, right, base, rgba(P["text"], 255),
                          int(H * 0.019))
    tracked_right("hold the line", small, right, base + H * 0.038,
                  rgba(P["text_dim"], 255), int(H * 0.0090))

    # accent keel under the wordmark
    d.line([(right - total, base + H * 0.015), (right, base + H * 0.015)],
           fill=rgba(P["accent"], 255), width=max(hair, int(H * 0.0032)))

    # host label riding the left end of the footer rule
    tracked("dev vm", tiny, 0.055 * W, 0.862 * H - H * 0.014,
            rgba(P["text_faint"], 255), int(H * 0.0075))
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
    img = Image.alpha_composite(img, rules(w, h, P, hair))

    pts = rope_points(w, h, rw)
    back, front = hang_carabiner((w, h), P, pts, rw)

    img = Image.alpha_composite(img, back)
    img = Image.alpha_composite(img, rope(w, h, P, pts, rw))
    img = Image.alpha_composite(img, front)

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
