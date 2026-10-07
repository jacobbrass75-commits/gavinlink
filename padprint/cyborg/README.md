# Cyborg Minifig, UV Print

Full-color head and torso print for a UV flatbed printer, made from a reference still.

## Parts to print on

- Torso: WHITE torso. The white part shows through as the white armor.
- Head: LIGHT BLUISH GRAY head. The gray part is the metal half of the face, so only the skin patch, eyes, mouth and metal panel lines are printed. The gray back and top of the head are correct for the character.
- Suggested arms: light bluish gray or blue. Legs: blue.

## Files

```text
cyborg_torso_uv.pdf / .svg                 vector, true size, 15.4 x 12.6 mm artboard
cyborg_torso_uv_1200dpi.png                color layer, transparent background
cyborg_torso_uv_white_underbase_1200dpi.png   white channel mask
cyborg_head_uv.pdf / .svg                  vector, true size, 9.0 x 6.4 mm artboard
cyborg_head_uv_1200dpi.png                 color layer, transparent background
cyborg_head_uv_white_underbase_1200dpi.png    white channel mask
cyborg_preview.png                         reference vs print, for approval
```

## UV printer notes

- Do NOT mirror. UV printing goes straight onto the part. (Mirroring is only for pad print films.)
- Import at 100 percent / actual size. The PDFs and SVGs carry true mm sizes; the PNGs are 1200 dpi.
- White underbase: on the white torso, skip it. On the gray head, use it so the brown skin, red eye and teeth print at full brightness. The mask is black on transparent and is choked 0.02 mm inside the color so no white halo shows.
- Head is a cylinder: center the face on the front of the head in a jig. The art is inside a 8.6 x 5.6 mm zone so it stays on the front curve, but test on a spare head first since curvature can soften the outer edges.
- Torso art follows the same taper envelope as the pad print jobs, so it fits the trapezoid face.

## Verification

`python3 verify.py`, all checks pass:

```text
PDF sizes exact: torso 15.400 x 12.600, head 9.000 x 6.400 mm
torso clearance: 0.434 mm to working envelope, 0.786 mm to true face edge
head ink inside front zone: x +/-4.29 mm, y 0.15 to 5.42 mm
feature survival at 0.04 mm erosion: all components survive
white underbase spill outside color: 0 px
```

Regenerate: `python3 generate.py`, then `python3 preview.py <reference.png>`, then `python3 verify.py`.
