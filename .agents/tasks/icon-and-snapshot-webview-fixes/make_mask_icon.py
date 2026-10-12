#!/usr/bin/env python3
"""Derive a maskable monochrome activity-bar icon from the Menagerie master.

VS Code renders an activity-bar container icon as a monochrome alpha MASK: it
fills the non-transparent alpha region with the theme foreground color. The
master logo is light features on a dark navy background, so we threshold on
luminance: bright logo features -> opaque white, dark background/negative
space -> fully transparent. This preserves interior negative space (gaps
between the M strokes, animal heads, orbit lines) instead of a solid blob.
"""
import sys
from PIL import Image

MASTER = "menagerie.png"
OUT = "src/assets/icons/menagerie-activitybar.png"
SIZE = 128
# Luminance threshold (0-255). Pixels brighter than this become opaque.
THRESHOLD = int(sys.argv[1]) if len(sys.argv) > 1 else 70
if len(sys.argv) > 2:
    OUT = sys.argv[2]

src = Image.open(MASTER).convert("RGBA")
# Work at high resolution, then downsample for clean antialiased edges.
gray = src.convert("L")

# Build a binary alpha mask from luminance.
alpha = gray.point(lambda p: 255 if p > THRESHOLD else 0)

# Compose: white where opaque, transparent elsewhere.
white = Image.new("RGBA", src.size, (255, 255, 255, 255))
transparent = Image.new("RGBA", src.size, (255, 255, 255, 0))
masked = Image.composite(white, transparent, alpha)

# Downsample to SIZE with high-quality resampling (antialiases the mask edges).
masked = masked.resize((SIZE, SIZE), Image.LANCZOS)
masked.save(OUT)

# ---- Measurement / verification ----
px = masked.load()
total = SIZE * SIZE
opaque = 0          # alpha == 255 (fully opaque)
transparent_cnt = 0  # alpha == 0 (fully transparent)
partial = 0
# interior transparency check: count fully-transparent pixels NOT on the
# outer border (i.e. inside the logo bounding region).
interior_transparent = 0
# find bounding box of any non-transparent pixel
minx, miny, maxx, maxy = SIZE, SIZE, 0, 0
for y in range(SIZE):
    for x in range(SIZE):
        a = px[x, y][3]
        if a > 0:
            minx = min(minx, x); miny = min(miny, y)
            maxx = max(maxx, x); maxy = max(maxy, y)
for y in range(SIZE):
    for x in range(SIZE):
        a = px[x, y][3]
        if a == 255:
            opaque += 1
        elif a == 0:
            transparent_cnt += 1
            if minx <= x <= maxx and miny <= y <= maxy:
                interior_transparent += 1
        else:
            partial += 1

bbox_area = max(1, (maxx - minx + 1) * (maxy - miny + 1))
print(f"THRESHOLD={THRESHOLD}")
print(f"size={SIZE}x{SIZE} total={total}")
print(f"opaque(a==255)={opaque} ({100*opaque/total:.1f}%)")
print(f"transparent(a==0)={transparent_cnt} ({100*transparent_cnt/total:.1f}%)")
print(f"partial(0<a<255)={partial} ({100*partial/total:.1f}%)")
print(f"non-transparent ratio (opaque+partial)={100*(opaque+partial)/total:.1f}%")
print(f"logo bbox=({minx},{miny})-({maxx},{maxy}) area={bbox_area}")
print(f"interior-transparent pixels (inside bbox)={interior_transparent} "
      f"({100*interior_transparent/bbox_area:.1f}% of bbox)")
