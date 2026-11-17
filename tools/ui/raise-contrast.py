#!/usr/bin/env python3
"""Darkens text colors so the interface reads crisp instead of dimmed.

Only `color:` declarations change (not backgrounds or borders). Light-theme text gets one of four
steps: primary near-black, then two secondary greys, then a faint step for placeholders. Very light
text (for example white on a dark button) is left alone. The dark theme gets the mirror image.

Usage: python3 tools/ui/raise-contrast.py apps/desktop/src/ui/*.css   (runs once per file)
"""
import colorsys
import re
import sys

PAIR = re.compile(r"(?<![-\w])color:light-dark\(#([0-9a-fA-F]{6,8}),\s*#([0-9a-fA-F]{6,8})\)")
MARK = "/* contrast raised */"


def rgb(h):
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)), h[6:8]


def hexa(r, g, b, alpha=""):
    return "#%02x%02x%02x" % tuple(round(max(0, min(1, v)) * 255) for v in (r, g, b)) + alpha


def step(l):
    if l < 0.30:
        return 0.10
    if l < 0.50:
        return 0.20
    if l < 0.68:
        return 0.33
    return 0.46


def convert(m):
    (r, g, b), alpha = rgb(m.group(1))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    if l > 0.85:
        return m.group(0)
    new = step(l)
    light = hexa(*colorsys.hls_to_rgb(h, new, s), alpha)
    (dr, dg, db), dalpha = rgb(m.group(2))
    dh, dl, ds = colorsys.rgb_to_hls(dr, dg, db)
    dark = hexa(*colorsys.hls_to_rgb(dh, max(dl, 0.96 - new * 0.95), ds), dalpha)
    return f"color:light-dark({light}, {dark})"


for path in sys.argv[1:]:
    text = open(path, encoding="utf-8").read()
    if MARK in text:
        print(f"skip {path}: already raised")
        continue
    out, n = PAIR.subn(convert, text)
    open(path, "w", encoding="utf-8").write(f"{MARK}\n{out}")
    print(f"{path}: {n} text colors")
