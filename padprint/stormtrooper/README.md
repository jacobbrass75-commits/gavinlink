# Stormtrooper Torso Pad Print

Custom LEGO minifigure torso design: Imperial Stormtrooper, original trilogy armor. Full-face layout on the standard 15.4 x 12.6 mm artboard, content 12.7 mm wide x 10.5 mm tall, drawn inside the torso taper envelope.

The part color does the work: white ABS is the armor white, so the design needs only the three standard inks. The design is fully symmetric about the vertical center line, so film orientation cannot ruin a plate and no mirrored film variant is needed.

## Inks and print order

1. light gray `#c4c8c7`: collar rim shadow, under-pec shadow crescents, chest side shading, ab plate edge shading
2. dark gray `#7e8284`: collar rim line, ab plate segment ridges
3. black `#141414`: neck seal fill, clavicle ridges, sternum seam, pectoral contours, chest side edges, chest plate bottom edge, undersuit gap band fill, ab plate outer edges

Black strokes are centered on the edges of the gray fills they border, so trapping is inherent.

## Files

```text
stormtrooper_torso_12.7mm.svg/.pdf          true size artwork, all inks in color
stormtrooper_torso_color_master.svg         approval master over the face trapezoid
stormtrooper_sep_1_lightgray.svg/.pdf       ink separations, shared artboard,
stormtrooper_sep_2_darkgray.svg/.pdf        recolored to pure black for film
stormtrooper_sep_3_black.svg/.pdf
stormtrooper_film_190x250_cutline.svg/.pdf  200x260 page, 190x250 cut rect,
                                            stations lg (50,50) dg (140,50)
                                            bk (50,200), fourth empty
stormtrooper_torso_preview.png              approval sheet
```

Print the film PDF at 100 percent scale. The cut rectangle must measure 190 x 250 mm on paper; if it does not, apply correction scale = desired / measured.

## Regenerate and verify

```bash
python3 generate.py
python3 verify.py
python3 preview.py
```

`verify.py` runs the seven required checks: PDF page sizes, identical artboards, station placement within 0.05 mm, erosion survival of every component, gap closing at the 0.20 mm floor, fit against the face trapezoid, and separation composite vs the color art. All pass as committed:

```text
station placement error: 0.000 mm on all three stations
erosion survival: 14 of 14 components across the three separations
gap floor: no regions close under a 0.20 mm disk
min clearance to true face edge: 0.747 mm (0.396 mm to the conservative
  handoff envelope), widest ink half width 6.365 mm
composite vs color art: 0.0000 sq mm residue after 1 px erosion
```

## Line width floors used

Bold structural black 0.24 to 0.26, sternum 0.22, dark gray details 0.18 to 0.20, all above the 0.15 mm hard floor. Smallest gray fill thickness is about 0.35 mm, above the 0.30 mm dot floor.

## Before committing a plate

- Print a paper proof at 100 percent, cut the torso art out, and lay it on a real torso. Binding point is the neck seal top corners at x = +/-4.40 mm on the top edge (0.60 mm envelope clearance).
- First UV exposure: start from the 60 second baseline, calibrate with test plates.
- Orientation: this design is symmetric, so the unresolved mirror question from the R test does not affect it.
