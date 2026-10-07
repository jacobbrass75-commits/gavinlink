#!/usr/bin/env python3
"""Checks for the Cyborg UV print files. Prints numbers, exits nonzero on
any failure.

1. PDF page sizes match the declared artboards
2. torso fit: every inked row inside the face taper envelope
3. head fit: ink inside the front face print zone (8.4 x 5.6 mm)
4. feature survival: no inked component vanishes under a 0.04 mm erosion
   (UV inkjet at 1200 dpi resolves about 0.02 mm per dot)
5. white underbase sits inside the color layer (no white halo)
"""

import io
import os
import sys

import cairosvg
import numpy as np
import pypdfium2 as pdfium
from PIL import Image
from scipy import ndimage

OUT = os.path.dirname(os.path.abspath(__file__))
FAIL = []


def mask(svg, ppm):
    import re
    s = open(os.path.join(OUT, svg)).read()
    w, h = map(float, re.search(r'width="([\d.]+)mm" height="([\d.]+)mm"', s).groups())
    png = cairosvg.svg2png(url=os.path.join(OUT, svg),
                           output_width=round(w * ppm), output_height=round(h * ppm))
    return np.asarray(Image.open(io.BytesIO(png)).convert('RGBA'))[:, :, 3] > 127


def check(ok, msg):
    print(f'  {"ok  " if ok else "FAIL"} {msg}')
    if not ok:
        FAIL.append(msg)


def main():
    print('1. PDF page sizes')
    for f, (w, h) in (('cyborg_torso_uv.pdf', (15.4, 12.6)),
                      ('cyborg_head_uv.pdf', (9.0, 6.4))):
        p = pdfium.PdfDocument(os.path.join(OUT, f))[0]
        pw, ph = p.get_width() * 25.4 / 72, p.get_height() * 25.4 / 72
        check(abs(pw - w) < 0.01 and abs(ph - h) < 0.01,
              f'{f}: {pw:.3f} x {ph:.3f} mm (want {w} x {h})')

    ppm = 100
    print('2. torso fit against the face taper')
    m = mask('cyborg_torso_uv.svg', ppm)
    ys, xs = np.nonzero(m)
    x = (xs + 0.5) / ppm - 7.7
    y = (ys + 0.5) / ppm - 0.2
    work = 5.00 + 0.1888 * y - np.abs(x)
    true = 5.295 + 0.18875 * (y + 0.3) - np.abs(x)
    i = int(np.argmin(true))
    check(work.min() >= 0.25,
          f'min clearance to working envelope {work.min():.3f} mm (need 0.25)')
    print(f'       min clearance to true face edge {true.min():.3f} mm at '
          f'({x[i]:+.2f}, {y[i]:.2f})')

    print('3. head inside the front face print zone')
    m = mask('cyborg_head_uv.svg', ppm)
    ys, xs = np.nonzero(m)
    x = (xs + 0.5) / ppm - 4.5
    y = (ys + 0.5) / ppm - 0.4
    check(np.abs(x).max() <= 4.3 and y.min() >= 0 and y.max() <= 5.6,
          f'ink spans x +/-{np.abs(x).max():.2f} mm, y {y.min():.2f} to '
          f'{y.max():.2f} mm (zone +/-4.30 x 0 to 5.60)')

    print('4. feature survival, 0.04 mm erosion at 200 px/mm')
    for svg in ('cyborg_torso_uv.svg', 'cyborg_head_uv.svg'):
        m = mask(svg, 200)
        lab, n = ndimage.label(m)
        er = ndimage.binary_erosion(m, iterations=4)
        dead = sum(1 for k in range(1, n + 1) if not er[lab == k].any())
        check(dead == 0, f'{svg}: {n} components, {dead} lost')

    print('5. white underbase inside the color layer')
    for base in ('cyborg_torso_uv', 'cyborg_head_uv'):
        col = np.asarray(Image.open(os.path.join(OUT, base + '_1200dpi.png'))
                         .convert('RGBA'))[:, :, 3] > 127
        wht = np.asarray(Image.open(os.path.join(
            OUT, base + '_white_underbase_1200dpi.png')).convert('RGBA'))[:, :, 3] > 127
        spill = int((wht & ~col).sum())
        check(spill == 0 and col.shape == wht.shape,
              f'{base}: same size {col.shape == wht.shape}, white outside color '
              f'{spill} px')

    print()
    if FAIL:
        print(f'{len(FAIL)} FAILURE(S)')
        sys.exit(1)
    print('ALL CHECKS PASSED')


if __name__ == '__main__':
    main()
