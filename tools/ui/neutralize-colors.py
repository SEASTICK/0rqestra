#!/usr/bin/env python3
"""One-off conversion of the interface palette (kept for review and re-runs on new CSS).

Turns the green-tinted palette into neutral greys and gives every color a dark-theme
counterpart with CSS light-dark(), so the theme follows color-scheme on <html>.

  - neutral and green colors: a pure grey of the same lightness (saturated greens, the old
    accent, are made darker so primary buttons read like Claude's and Codex's near-black ones);
    dark theme: surfaces stay dark and slightly lighter when "raised", lines and text invert.
  - shadows and overlays (translucent, dark): neutral black with the same opacity.
  - other hues (role colors, warnings, errors): kept in light; pastels become deep tints and
    dark tones become lighter in dark.

Usage: python3 tools/ui/neutralize-colors.py apps/desktop/src/ui/*.css
"""
import colorsys
import re
import sys

HEX = re.compile(r"#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b")


def parse(h):
    if len(h) in (3, 4):
        h = "".join(c * 2 for c in h)
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
    return r, g, b, a


def hexa(r, g, b, a=1.0):
    out = "#%02x%02x%02x" % tuple(round(max(0, min(1, v)) * 255) for v in (r, g, b))
    return out if a >= 0.999 else out + "%02x" % round(a * 255)


def grey(l, a=1.0):
    return hexa(l, l, l, a)


def dark_lightness(l):
    if l >= 0.94:  # surfaces: page, cards, sidebar (lighter in light stays lighter in dark)
        return 0.13 + (l - 0.94) / 0.06 * 0.06
    if l >= 0.80:  # lines and subtle fills
        return 0.30 - (l - 0.80) / 0.14 * 0.08
    return 0.30 + (0.80 - l) / 0.80 * 0.62  # text and icons


def convert(match):
    r, g, b, a = parse(match.group(1))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    hue = h * 360
    if a < 1 and l < 0.35:
        return grey(0, a)
    if s < 0.12 or 70 <= hue <= 175:
        if 70 <= hue <= 175 and s >= 0.25 and l < 0.6:
            l = max(0.08, l - 0.15)
        return f"light-dark({grey(l, a)}, {grey(dark_lightness(l), a)})"
    if l > 0.8:
        dr, dg, db = colorsys.hls_to_rgb(h, 0.2, s * 0.45)
    elif l < 0.45:
        dr, dg, db = colorsys.hls_to_rgb(h, 0.7, s)
    else:
        return match.group(0)
    return f"light-dark({match.group(0)}, {hexa(dr, dg, db, a)})"


NAMED = re.compile(r"(?<=[:\s,(])(white|black)(?=[;}\s,)!])")


for path in sys.argv[1:]:
    text = open(path, encoding="utf-8").read()
    if "light-dark(" in text:
        print(f"skip {path}: already converted")
        continue
    text = NAMED.sub(lambda m: "#ffffff" if m.group(1) == "white" else "#000000", text)
    out, n = HEX.subn(convert, text)
    open(path, "w", encoding="utf-8").write(out)
    print(f"{path}: {n} colors")
