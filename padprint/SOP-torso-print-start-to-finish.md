# Pad Print SOP: Custom Minifig Torso, Start to Finish

Standard operating procedure for producing a high quality multi-color torso print on the TTN Universal pad printer with Automark water wash photopolymer plates. Work top to bottom, check every box. One variable at a time when anything goes wrong. Keep a written log of every run: date, exposure times, washout time, ink batch, film used, result.

## Stage 1: Design and files

1. Design or commission the artwork with the coding agent using the sizing skill (`padprint/skills/lego-torso-pad-print-sizing-skill.md`). Requirements the files must already meet before you touch hardware:
   - All ink inside the taper envelope, 0.25 mm minimum clearance, 0.35 preferred
   - Strokes 0.15 mm or wider, gaps 0.20 mm or wider, dots 0.30 mm or wider
   - One separation per ink on identical 15.4 x 12.6 artboards
   - Black outlines centered on gray fill edges for trapping
   - Station film: 200 x 260 page, 190 x 250 cut rectangle, stations at 90.00 mm horizontal and 150.00 mm vertical spacing
   - All seven verification checks passing, numbers printed
2. Confirm the design is either symmetric, or you have the MIRRORED film as the production file. Ink side of the film must contact the polymer, so production films are mirrored.
3. Print a paper proof of the torso art at 100 percent, cut it out, lay it on a real torso. Check the tight spots called out in the verification report. If anything clips, regenerate smaller. Do not skip this; plates are consumables, torsos are cheap, time is not.

## Stage 2: Film

1. Print the film PDF at 100 percent scale, no fit-to-page, from a computer with the full Epson P900 driver, not from the phone. Quality at maximum (beyond good/better/best presets), film/transparency media setting.
2. Blacks must be rich black, all four channels at 100 percent. Plain single channel black passes UV and ruins etch depth.
3. Print MIRRORED so the ink side faces the polymer at exposure.
4. Measure the cut rectangle with a ruler: it must be 190 x 250 mm. If not, correction scale = desired / measured, reprint, remeasure.
5. Density check: hold the film over a bright light or light table. If ANY light shows through the black areas, do not expose with it. Fix the driver settings or stack two identical films in perfect register.
6. Cut along the center of the cut line. Handle by edges, keep dust free.

## Stage 3: Plate exposure (Automark water wash process)

Numbers below are for the Automark unit with 15 W bulbs, vendor guidance 35 to 45 seconds per step. Your calibrated numbers come from the step test in Stage 8; start at 35 s.

1. Glass spotless: no dust, spots, or streaks, both sides.
2. Peel the plate's protective layer. Dust the polymer lightly with baby powder using a new 2 to 3 inch flat paint brush, brush around, then brush off the excess leaving a thin haze. This prevents air pockets and gives full contact (this unit has no vacuum).
3. Artwork exposure: film INK SIDE DOWN on the polymer, aligned square to the plate edges. Set the pressure clips for this plate size; placing a used same-size cliche under the new one focuses the pressure. Expose 35 s.
4. Raster exposure: swap to the 250L 90 percent raster film, printed side down, same time, 35 s. Keep the raster film pristine in a manila folder between white paper; scratched or low opacity raster overexposes the floor.
5. Water washout: 2 minutes, lukewarm to warm tap water (about 25 to 30 C), very soft cliche brush, only the weight of the brush. Longer washout etches deeper, shorter shallower; adjust in 30 s steps only during calibration.
6. Dry with compressed air, about 50 psi, rubber tip: slow front pass focusing on the image (you will see it reveal), back pass, final front pass for edge water. Remove all water.
7. Bake 170 to 180 F for 15 minutes. Cool fully.
8. Final UV cure: 15 minutes above the glass. Do not skip; this is what makes the plate survive production instead of dozens of prints.
9. Inspect with a 10x loupe: crisp edges, uniform matte texture in the etched areas from the raster, no scum in open areas, no washed-away fine lines.

## Stage 4: Ink

1. Use ink matched to ABS. Mix color to the LEGO palette against a real LEGO part in daylight, not against a screen.
2. Add hardener at the manufacturer ratio (Marabu H1 class). Pot life is about 8 hours; mix only what today needs.
3. Thin to spec viscosity. Re-check flow through the session; solvent flashes off and the ink thickens.
4. Light colors and white on dark parts: plan a double hit (two transfers, same plate, same position) or a white underbase.

## Stage 5: Machine setup and registration

1. Mount the plate against fixed stops so it can be removed and replaced identically.
2. Mount the part in a rigid nest that locates it against hard stops. A 3D printed nest keyed to the torso is the standard answer. Any part wiggle is print wiggle.
3. Choose the pad: standard cone for flat torso faces; pad must roll ink on and off, never stamp flat.
4. Color to color registration comes from the film math: station spacing is exactly 90.00 mm horizontal and 150.00 mm vertical, so moving plate or fixture exactly that distance between passes keeps register. Verify your repeatability once with the two-pass registration test in Stage 8 before trusting multi-color runs.

## Stage 6: Printing

1. Order: light gray, then dark gray, then black last. Underbase (if any) before everything. Black last hides misregistration at every trapped joint.
2. Consistent stroke: same pad speed and pressure every cycle. Let the machine's stops define positions, not your eye.
3. Flash dry between colors (warm airflow) so the next pad does not pick back the previous ink.
4. First article on every color: print one, inspect against the digital color master with the loupe, then run.
5. Do not print white ink on white torsos, ever.

## Stage 7: QC and finish

1. Compare finished part to the color master render side by side.
2. Check: registration at trapped joints, ink opacity, edge crispness, no pinholes (dirty plate or dry ink), no ghosting (pickback), full cure.
3. Log the run. Good settings only exist if they are written down.

## Stage 8: Calibration tests (run once, rerun when anything changes)

1. Scale test: film cut rectangle measures 190 x 250 on paper and film.
2. Exposure step test: one plate, cover strips progressively, expose segments at 25/30/35/40/45 s with a test film carrying 0.15 mm lines, 0.20 mm gaps, 0.30 mm dots, and a halftone patch. Pick the time where fine detail survives at the depth you want. Remember: longer exposure = shallower etch, shorter = deeper.
3. Registration test: expose a crosshair/vernier plate, print the same film twice in the same nominal setup, read the offset with a loupe. Repeat 10 times. Target under 0.08 mm before attempting 4+ colors.
4. Orientation sanity check: print a plate from a film with a letter R and confirm it reads correctly on the part when the film was exposed ink side down, mirrored.

## Troubleshooting quick table

```text
etch too shallow          exposure too long, film black not dense, washout
                          too short or cold, poor film contact
etch too deep, scooping   exposure too short, washout too long, missing or
                          weak raster exposure
blurry, soft edges        air gap at exposure (powder step, pressure clips),
                          film printed ink side up, glass dirty
fine lines missing        overexposure of thin negatives is not the issue,
                          they wash away: art below floor or washout too hard
ink not sticking to ABS   missing or under-dosed hardener, part oils, wipe
                          with IPA before printing
pinholes in print         dust on plate or part, ink too thick
ghost of previous color   insufficient flash dry between passes
colors misregistered      fixture or plate not on hard stops, station move
                          not exactly 90.00 / 150.00
plate wears out fast      final 15 minute UV cure or bake skipped
```
