#!/usr/bin/env python3
"""
Generate the disk-image background for the macOS installer.

Kept as a script rather than a checked-in binary so the artwork can be changed
by editing values instead of reopening a design tool, and so the @1x and @2x
copies can never drift apart — Finder picks whichever matches the display, and
two hand-exported files eventually disagree.

The background carries only the wordmark, the instruction and the arrow. The
two icons are placed by electron-builder at the coordinates in package.json's
`dmg.contents`; drawing them here as well would double them on screen.

    python3 scripts/make-dmg-background.py
"""

from PIL import Image, ImageDraw, ImageFont
import pathlib

W, H = 620, 400                     # must match build.dmg.window in package.json
ICON_Y = 208                        # centre line of both icons
APP_X, APPS_X = 165, 455            # centres, matching dmg.contents

BG = (13, 14, 17)
ACCENT = (43, 212, 115)
TEXT = (236, 237, 240)
DIM = (150, 152, 160)

ROOT = pathlib.Path(__file__).resolve().parent.parent


def font(size, weight=0):
    """
    A real system face.

    HelveticaNeue before SFNS deliberately: SFNS is a variable font, and PIL
    renders it with collapsed side bearings — words in the smaller sizes run
    into each other. Helvetica has static instances and correct metrics.
    `weight` picks the face inside the .ttc collection: 0 regular, 1 bold.
    """
    candidates = [
        ("/System/Library/Fonts/HelveticaNeue.ttc", weight),
        ("/System/Library/Fonts/Helvetica.ttc", weight),
        ("/System/Library/Fonts/Supplemental/Arial.ttf", 0),
    ]
    for path, index in candidates:
        try:
            return ImageFont.truetype(path, size, index=index)
        except Exception:
            continue
    return ImageFont.load_default()


def centred(draw, text, y, f, fill, width=None, tracking=0):
    """Centre a line, optionally letter-spaced."""
    span = width if width is not None else W
    if tracking:
        total = sum(draw.textlength(c, font=f) + tracking for c in text) - tracking
        x = (span - total) / 2
        for c in text:
            draw.text((x, y), c, font=f, fill=fill)
            x += draw.textlength(c, font=f) + tracking
        return
    left, _, right, _ = draw.textbbox((0, 0), text, font=f)
    draw.text(((span - (right - left)) / 2 - left, y), text, font=f, fill=fill)


def radial_glow(img, cx, cy, radius, colour, peak):
    """A soft pool of light, drawn as concentric alpha rings."""
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    steps = 90
    for i in range(steps, 0, -1):
        t = i / steps
        r = radius * t
        alpha = int(peak * (1 - t) ** 2.2)
        if alpha <= 0:
            continue
        gd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(*colour, alpha))
    return Image.alpha_composite(img, glow)


def arrow(draw, x0, x1, y, scale=1):
    """A thin line into a solid head — the direction of the drag."""
    head = 11 * scale
    shaft_end = x1 - head
    draw.line([(x0, y), (shaft_end, y)], fill=(76, 80, 88), width=max(1, int(2 * scale)))
    draw.polygon(
        [(x1, y), (shaft_end, y - 5.5 * scale), (shaft_end, y + 5.5 * scale)],
        fill=(138, 143, 152),
    )


def build(scale):
    global W, H
    w, h = W * scale, H * scale

    img = Image.new("RGBA", (w, h), (*BG, 255))

    # Three pools of light. A broad cool one from above the wordmark, then a
    # tight accent under the app icon and a fainter neutral one under the
    # Applications alias — a single off-centre blob read as a stain rather than
    # as lighting, because nothing balanced it.
    tmp_w, tmp_h = W, H
    globals()["W"], globals()["H"] = w, h
    img = radial_glow(img, w * 0.5, -h * 0.16, h * 1.25, (58, 68, 88), 30)
    img = radial_glow(img, APP_X * scale, ICON_Y * scale, 118 * scale, ACCENT, 46)
    img = radial_glow(img, APPS_X * scale, ICON_Y * scale, 104 * scale, (150, 165, 190), 16)
    globals()["W"], globals()["H"] = tmp_w, tmp_h

    draw = ImageDraw.Draw(img)

    centred(draw, "Mind Browser", 46 * scale, font(24 * scale, weight=1), TEXT, width=w)
    centred(draw, "Drag it onto Applications", 82 * scale,
            font(13 * scale), DIM, width=w)
    centred(draw, "FIRST LAUNCH  ·  RIGHT-CLICK THE APP AND CHOOSE OPEN",
            348 * scale, font(9 * scale), (96, 100, 108), width=w,
            tracking=0.9 * scale)

    arrow(draw, (APP_X + 74) * scale, (APPS_X - 74) * scale, ICON_Y * scale, scale)

    # A hairline at the very bottom keeps the window from looking unfinished
    # against a light desktop.
    draw.line([(0, h - 1), (w, h - 1)], fill=(34, 36, 40), width=1)

    return img.convert("RGB")


def main():
    out = ROOT / "build"
    out.mkdir(exist_ok=True)

    one = build(1)
    one.save(out / "dmg-background.png")

    two = build(2)
    two.save(out / "dmg-background@2x.png")

    print(f"wrote {out/'dmg-background.png'} ({one.size[0]}x{one.size[1]})")
    print(f"wrote {out/'dmg-background@2x.png'} ({two.size[0]}x{two.size[1]})")


if __name__ == "__main__":
    main()
