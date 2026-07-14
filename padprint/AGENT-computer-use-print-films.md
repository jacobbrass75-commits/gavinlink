# Computer Use Runbook: Print Pad Print Films on the Epson SureColor P900

You are a computer use agent operating a Mac to print pad printing film positives. Your job is to open a film PDF and print it with the exact settings that produce a dense, correctly scaled, mirrored film. Getting any one setting wrong wastes a film sheet and, downstream, a plate. Work slowly, verify every setting on screen before clicking Print, and stop and report if any screen does not match what is described here.

## Absolute rules, never violate

1. Page scaling MUST be "Actual Size" / 100 percent. Never "Fit", "Shrink to fit", or "Scale to fit". A rescaled film silently breaks the 190 x 250 mm plate geometry.
2. Media Type MUST be a photo or fine art paper setting (high ink laydown), never Plain Paper. Plain paper prints a thin, gray black that will not block UV.
3. Print Quality MUST be the maximum setting, and High Speed / bidirectional MUST be off.
4. Mirror Image / Flip Horizontal MUST be ON for any film whose file name does NOT already contain the word "mirrored", and OFF for files that already contain "mirrored" (those are pre-flipped in the artwork). If unsure, STOP and ask the operator.
5. Use the real Epson driver, not AirPrint. If the print dialog shows no Media Type or Print Quality controls, the printer is set up as AirPrint. STOP and report; do not print.
6. Do not change any setting not listed in this runbook. Do not print more than one copy unless told to.

## Preconditions to check first

1. The Epson SureColor P900 driver is installed and the printer appears in System Settings > Printers & Scanners with the model listed as "EPSON SC-P900 Series" (not "AirPrint").
2. Film positive sheets (inkjet transparency) are loaded, coated side toward the print head. If the operator has not confirmed film is loaded, STOP and ask.
3. The film PDF to print is known. File names follow `<design>_film_190x250_cutline.pdf` or `..._mirrored.pdf`. If more than one candidate file exists, list them and ask which to print.

## Procedure

### Step 1: Open the file in Adobe Acrobat Reader

1. Locate the film PDF the operator named.
2. Open it in Adobe Acrobat Reader specifically. Do not use Preview, do not print from a web browser, because their scaling defaults are unreliable.
3. If Acrobat Reader is not installed, STOP and report; do not fall back to Preview.

### Step 2: Open the print dialog

1. Menu bar: File > Print (or Cmd+P).
2. Confirm the Printer dropdown shows the EPSON SC-P900 Series. If it shows an AirPrint entry or a different printer, select the Epson driver entry. If only an AirPrint entry exists, STOP and report.

### Step 3: Set Acrobat's own scaling

1. In Acrobat's print dialog, find "Page Sizing & Handling".
2. Select "Actual Size". Do NOT select "Fit" or "Custom Scale". If a "Scale" percentage is shown, it must read 100 percent.
3. Orientation: auto or portrait is fine; the page is 200 x 260 mm and must not be rotated in a way that crops. Confirm the preview shows the whole cut rectangle with margin around it, nothing clipped.

### Step 4: Open the Epson driver options

1. Click the "Printer..." button (or the dropdown that exposes printer-specific panels) to reach the Epson driver settings, sometimes shown as expandable panels titled "Printer Options", "Media & Quality", "Print Settings", or "Advanced".
2. If macOS warns that opening printer settings will use the print dialog, accept and continue.

### Step 5: Set media, quality, and speed

1. Media Type: choose a high ink laydown photo media, preference order: "Ultra Premium Photo Paper Luster", then "Premium Photo Paper Glossy", then "Watercolor Paper - Radiant White". Never "Plain Paper".
2. Color / Print Mode: Color (not grayscale). The files use rich black built from all channels; a Color pass lays down more total ink than a black-only pass.
3. Print Quality: the maximum available, labeled "Max Quality" or the highest "Quality" / level 5 on the quality slider. Move the slider fully to Quality, away from Speed.
4. High Speed: OFF (uncheck). Also called "High Speed printing" or bidirectional. Off gives sharper edges.
5. Finest Detail, if present: ON.

### Step 6: Set mirroring

1. Find "Mirror Image" (Epson driver) or "Flip Horizontally".
2. If the file name does NOT contain "mirrored": turn Mirror Image ON.
3. If the file name DOES contain "mirrored": leave Mirror Image OFF.
4. This is the one setting most likely to be wrong. Re-read the file name and set it deliberately.

### Step 7: Verify before printing

Read the full settings summary back on screen and confirm ALL of the following are true. If any is not, fix it or STOP and report:

```text
Printer:        EPSON SC-P900 Series  (not AirPrint)
Scaling:        Actual Size / 100 percent
Media Type:     a photo/fine art media (not Plain Paper)
Color:          Color
Quality:        maximum
High Speed:     off
Mirror Image:   on for non-mirrored files, off for *_mirrored files
Copies:         1
Preview:        whole page visible, cut rectangle not clipped
```

### Step 8: Print

1. Click Print.
2. Report to the operator that the job was sent, and state the exact Media Type, Quality, and Mirror setting you used, so it can be logged.

## After printing, tell the operator to verify by hand

You cannot verify the physical film, so instruct the operator to:

1. Let the film dry 10 to 15 minutes before touching it.
2. Measure the printed cut rectangle with a ruler: it must be 190 x 250 mm. If not, the scale was wrong; do not use the film.
3. Hold the black areas of the film over a bright light. If any light shows through the black, the film is too thin to expose a good plate; reprint after confirming Media Type and Quality, or print two identical films and stack them in register.

## Failure and stop conditions

Stop and report instead of guessing if:

- Only an AirPrint printer is available, or Media Type / Quality controls are missing.
- The scaling control does not offer "Actual Size".
- You cannot determine from the file name whether to mirror.
- Any dialog looks materially different from what is described here. Describe what you see and wait for the operator.

## Notes on scope

This runbook covers printing the film only. It does not cover plate exposure, ink, or the press; those are in `padprint/SOP-torso-print-start-to-finish.md`. Do not attempt hardware steps through computer use.
