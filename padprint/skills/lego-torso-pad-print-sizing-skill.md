# Skill: LEGO Minifig Torso Pad Print Sizing and Fit

You are a coding agent producing production pad printing films for custom LEGO minifigure torsos. This skill covers how to size a design to the torso, match it to the taper of the part, lay it out on film, and verify it before delivery. Follow every rule and run every check. The user's standing instruction is "make no mistakes" and the checks below are how that is enforced. Never use em dashes in any file content or file name.

## 1. Production context

- Machine: TTN Universal Series pad printer
- Plates: red photopolymer cliche, 190 x 250 mm, UV exposed through a film positive
- Film: printed transparency at 100 percent scale, dense black where ink goes, clear elsewhere
- Film logic: black on film = etched area on cliche = ink on part
- Parts: white ABS torsos. White is the part color. Never create a white ink layer.

Final film rules, non-negotiable: black vector art only, transparent or empty background, no guides, labels, crosshairs, or crop marks inside the 190 x 250 plate area. The only allowed extra element is the cut rectangle in section 6.

## 2. Torso geometry, the source of all sizing

The printable front face of the torso is a trapezoid, from the official LEGO technical drawing:

```text
top width:      10.59 mm
bottom width:   15.43 mm
height:         12.82 mm
side angle:     80.14 degrees
face width at depth t below the top edge: w(t) = 10.59 + 0.3775 * t
```

Design space is millimeters. y = 0 at the top of the print, y increases downward, x = 0 at center. The print starts 0.3 mm below the face top edge. Two envelopes exist:

```python
def fhw(y):                       # conservative working envelope, use this
    return 5.00 + 0.1888 * y

def true_half_width(y):           # exact face edge, use for reporting only
    return 5.295 + 0.18875 * (y + 0.3)
```

The working envelope already bakes in margin relative to the true face. All sizing decisions use `fhw`.

## 3. Fit rule, the core of this skill

At every height y of the design, all ink must satisfy:

```text
|x| <= fhw(y) - 0.25        hard requirement
|x| <= fhw(y) - 0.35        preferred target
```

Practical consequences:

- The trapezoid is narrowest at the top, so wide elements near the top of the design are almost always the binding constraint. Check the top corners first.
- The envelope grows by about 0.19 mm of half width per mm of depth. A design can and should get wider toward the bottom to look natural on the tapered part.
- When adapting flat rectangular art, either scale it to fit the top width or reshape its upper region to follow the taper. Do not let a rectangular design clip the top corners.
- Always compute clearance numerically for the finished art, per pixel row of a rasterized composite, not just for a few hand-picked points. Report the minimum clearance and where it occurs.
- Always tell the user to print a paper proof at 100 percent, cut it out, and lay it on a real torso before committing a plate.

## 4. Sizing conventions, pick one per job

- Full-face designs (armor style): content roughly 12.6 to 13.4 mm wide x 10.5 mm tall, drawn inside the taper so width varies with y. Used when the print covers the whole torso front.
- Centered emblem designs: fixed rectangular bounding box, 13.0 mm wide, height from the source aspect ratio. If a corner of the emblem has under 0.25 mm clearance to the envelope, regenerate at 12.5 to 12.7 mm instead of forcing it.
- Name the true-size artwork file with the measured content width, for example `<design>_torso_12.7mm.svg`.

## 5. Artboard and placement

Every artwork and every separation lives on the identical artboard so registration is inherent:

```python
def wrap(body, w=15.4, h=12.6, dx=7.7, dy=0.2):
    return (f'<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}mm" height="{h}mm" '
            f'viewBox="0 0 {w} {h}">\n<g transform="translate({dx},{dy})">{body}</g>\n</svg>')
```

Build mirrored halves explicitly with a sign loop `for s in (1, -1):` multiplying every x coordinate, never with transform groups, so separations stay flat. A design that is fully symmetric about x = 0 needs no mirrored film variant and is immune to plate orientation mistakes; prefer symmetry when the subject allows it.

## 6. Film layout for the 190 x 250 plate

Page is 200 x 260 mm so the cut line prints fully on A4 and Letter at 100 percent.

```text
cut rectangle: x=5 y=5, 190 x 250 mm, stroke 0.2 mm black, fill none
               the user cuts along the CENTER of the line
stations from the plate corner: (50,50) (140,50) (50,200) (140,200)
absolute page coordinates:      (55,55) (145,55) (55,205) (145,205)
station spacing: 90.00 mm horizontal, 150.00 mm vertical
```

Each separation artboard is placed with `translate(cx - 7.7, cy - 6.3)` so its center lands exactly on the station. Multi-color registration then equals exact station spacing when the user shifts plate or fixture between passes. Three color convention: light gray at (50,50), dark gray at (140,50), black at (50,200), fourth station empty. Single color: four copies. Emit both SVG and PDF for every film; the PDF is what gets printed.

The cut rectangle doubles as the scale check: it must measure 190 x 250 mm on the paper proof, and correction scale = desired / measured.

## 7. Color separations and trapping

- One ink per plate. Keep one python list per ink while building (`lg`, `dg`, `bk`), append every element to exactly one list. Print order on the part: light gray, dark gray, black last.
- Trapping: draw black outlines as strokes centered on the edges of gray fills. The black overlaps each gray edge by half a line width and hides misregistration. Never butt-register two colors edge to edge without black covering the joint. When two gray tones meet, overlap one at least 0.15 mm under the other.
- Separations are the same elements recolored to pure black; keep interiors that were white as open (fill none) on film.

## 8. Production floors

```text
minimum stroke width:      0.15 mm hard floor, prefer 0.16 to 0.28
minimum gap / knockout:    0.20 mm
minimum dot diameter:      0.30 mm
bold structural lines:     0.24 to 0.28
thin seam lines:           0.15 to 0.18
```

Two floors interact in ways that bite: a gap that measures 0.20 mm between element edges is AT the floor, not above it, and stroke caps and fill tapers eat into nominal gaps. Design distinct same-ink elements with 0.30 mm or more between their painted edges, remembering that a stroke extends half its width past its path.

## 9. Required verification before delivery

Run all of these, print the numbers, deliver only if all pass. Morphological checks are authoritative; do not trust skeleton-percentile width measurements, corner spurs read as false sub 0.1 features.

1. PDF page sizes match declared mm sizes exactly (points x 25.4 / 72).
2. All separation artboards byte-identical in width, height, and viewBox.
3. Station placement: rasterize the film at 40 px/mm, take the ink bbox center in a window around each station, compare against the standalone separation's ink bbox center offset from its artboard center. Must match within 0.05 mm. Per-layer ink bboxes legitimately differ; the artboard placement is what must match.
4. Feature survival: rasterize each separation at 100 px/mm, label connected components, erode with a disk of radius 6 px (0.12 mm diameter). Every component must retain pixels. A dead component is a feature below the printable floor.
5. Gap survival: binary closing with a disk of radius 10 px (the 0.20 mm floor). Newly filled regions larger than 0.02 sq mm (200 px) mark gaps that will bridge on the plate. Report their mm locations and fix the geometry; do not ship a film with flagged bridges.
6. Fit check: composite all separations, and for every pixel row compute clearance = envelope half width minus max |x| of ink. Report the minimum against both `fhw` and the true face edge. Fail below 0.10 mm to the true edge.
7. Digital composite of the separations must reproduce the color art: XOR the ink masks, erode by 1 px; the residue must be zero up to anti-alias noise (under 0.01 sq mm).

## 10. Deliverables and naming

```text
<design>_torso_<width>mm.svg/.pdf          single artwork, true size
<design>_film_190x250_cutline.svg/.pdf     plate film with cut rect
<design>_film_190x250_cutline_mirrored.*   mirrored variant when needed
<design>_sep_<n>_<color>.svg/.pdf          one per ink, shared artboard
<design>_torso_color_master.svg            colored approval master
<design>_torso_preview.png                 approval comparison sheet
```

Also commit the generator and verifier scripts next to the outputs so every film is reproducible with one command.

## 11. Known pitfalls from prior jobs

- Shadow fills that share an edge with an outline stroke tend to drift within 0.15 to 0.20 mm of a neighboring same-ink element; the gap closing test catches this. Fix by reshaping, not by hoping the plate is kind.
- A contour line running parallel to a filled band at 0.20 mm reads fine on screen and bridges on the plate. Keep parallel same-ink features 0.30 mm apart edge to edge.
- Photo references lie: bands are thicker than they look, separate marks are often one continuous stroke, straight lines are often shallow arcs. Expect 2 to 4 visual iteration passes against the reference.
- Emblem corners near the shoulder bevels are the classic tight spot on emblem designs; the neck area top corners are the classic tight spot on full-face designs.
- UV exposure baseline is 60 seconds and not yet calibrated per unit; shorter etches deeper. The mirror orientation test has not been run; supply mirrored variants for asymmetric designs or design symmetric.
- Printer scale is not ruler-verified; the cut rectangle is the scale check.
