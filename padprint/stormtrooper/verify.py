#!/usr/bin/env python3
"""Section 9 verification suite for the stormtrooper pad print films.

Runs all seven required checks and prints the numbers. Exits nonzero if
any check fails.
"""

import os
import re
import sys

import cairosvg
import numpy as np
import pypdfium2 as pdfium
from PIL import Image
from scipy import ndimage
from skimage.morphology import binary_erosion, binary_closing, disk

OUT = os.path.dirname(os.path.abspath(__file__))
SEPS = ['stormtrooper_sep_1_lightgray.svg', 'stormtrooper_sep_2_darkgray.svg',
        'stormtrooper_sep_3_black.svg']
FILM = 'stormtrooper_film_190x250_cutline.svg'
FAILURES = []


def fail(msg):
    FAILURES.append(msg)
    print(f'  FAIL: {msg}')


def render_mask(svg_path, px_per_mm, thr=128):
    """Rasterize an SVG on white and return a boolean ink mask."""
    m = re.search(r'width="([\d.]+)mm" height="([\d.]+)mm"',
                  open(svg_path).read())
    w_mm, h_mm = float(m.group(1)), float(m.group(2))
    png = cairosvg.svg2png(url=svg_path, output_width=round(w_mm * px_per_mm),
                           output_height=round(h_mm * px_per_mm),
                           background_color='white')
    import io
    img = np.asarray(Image.open(io.BytesIO(png)).convert('L'))
    return img < thr


def check1_pdf_sizes():
    print('check 1: PDF page sizes')
    expected = {f[:-4] + '.pdf': (15.4, 12.6) for f in SEPS}
    expected['stormtrooper_torso_12.7mm.pdf'] = (15.4, 12.6)
    expected[FILM[:-4] + '.pdf'] = (200.0, 260.0)
    for fname, (ew, eh) in expected.items():
        page = pdfium.PdfDocument(os.path.join(OUT, fname))[0]
        w = page.get_width() * 25.4 / 72
        h = page.get_height() * 25.4 / 72
        ok = abs(w - ew) < 0.01 and abs(h - eh) < 0.01
        print(f'  {fname}: {w:.3f} x {h:.3f} mm (want {ew} x {eh})'
              f' {"ok" if ok else "MISMATCH"}')
        if not ok:
            fail(f'{fname} page size {w:.3f}x{h:.3f}, want {ew}x{eh}')


def check2_artboards():
    print('check 2: separation artboards identical')
    heads = []
    for f in SEPS:
        m = re.search(r'<svg[^>]*>', open(os.path.join(OUT, f)).read())
        attrs = dict(re.findall(r'(width|height|viewBox)="([^"]+)"', m.group(0)))
        heads.append((attrs['width'], attrs['height'], attrs['viewBox']))
        print(f'  {f}: {heads[-1]}')
    if len(set(heads)) != 1:
        fail('separation artboards differ')
    else:
        print('  ok, all identical')


def check3_stations():
    print('check 3: station centers within 0.05 mm')
    ppm = 40
    film = render_mask(os.path.join(OUT, FILM), ppm)
    stations = [(55.0, 55.0), (145.0, 55.0), (55.0, 205.0)]
    for sep, (sx, sy) in zip(SEPS, stations):
        art = render_mask(os.path.join(OUT, sep), ppm)
        ys, xs = np.nonzero(art)
        # ink bbox center offset from the artboard center (7.7, 6.3)
        ox = (xs.min() + xs.max() + 1) / 2 / ppm - 7.7
        oy = (ys.min() + ys.max() + 1) / 2 / ppm - 6.3
        # same measurement in a window around the station on the film
        r = 12
        win = film[round((sy - r) * ppm):round((sy + r) * ppm),
                   round((sx - r) * ppm):round((sx + r) * ppm)]
        wy, wx = np.nonzero(win)
        fx = (wx.min() + wx.max() + 1) / 2 / ppm + (sx - r)
        fy = (wy.min() + wy.max() + 1) / 2 / ppm + (sy - r)
        dx, dy = fx - (sx + ox), fy - (sy + oy)
        ok = abs(dx) <= 0.05 and abs(dy) <= 0.05
        print(f'  {sep} at ({sx},{sy}): placement error '
              f'dx={dx:+.3f} dy={dy:+.3f} mm {"ok" if ok else "OFF"}')
        if not ok:
            fail(f'{sep} station placement off by ({dx:+.3f},{dy:+.3f})')


def check4_erosion():
    print('check 4: feature survival, disk r=6 px erosion at 100 px/mm '
          '(0.12 mm dia)')
    for sep in SEPS:
        mask = render_mask(os.path.join(OUT, sep), 100)
        labels, n = ndimage.label(mask)
        eroded = binary_erosion(mask, disk(6))
        dead = []
        for i in range(1, n + 1):
            if not eroded[labels == i].any():
                ys, xs = np.nonzero(labels == i)
                dead.append((xs.mean() / 100, ys.mean() / 100))
        print(f'  {sep}: {n} components, {n - len(dead)} survive')
        for cx, cy in dead:
            fail(f'{sep}: component near ({cx:.2f},{cy:.2f}) mm artboard '
                 f'coords dies under erosion')


def check5_gaps():
    print('check 5: gap survival, closing with disk r=10 px (0.20 mm floor)')
    for sep in SEPS:
        mask = render_mask(os.path.join(OUT, sep), 100)
        closed = binary_closing(mask, disk(10))
        filled = closed & ~mask
        labels, n = ndimage.label(filled)
        bad = 0
        for i in range(1, n + 1):
            area_px = int((labels == i).sum())
            if area_px > 200:                      # 0.02 sq mm at 100 px/mm
                ys, xs = np.nonzero(labels == i)
                bad += 1
                print(f'  {sep}: bridge risk {area_px/10000:.4f} sq mm near '
                      f'({xs.mean()/100:.2f},{ys.mean()/100:.2f}) mm')
        if bad == 0:
            print(f'  {sep}: no gaps below the 0.20 mm floor')
        else:
            fail(f'{sep}: {bad} region(s) may bridge on the plate')


def check6_fit():
    print('check 6: fit against the torso face trapezoid')
    ppm = 100
    union = None
    for sep in SEPS:
        m = render_mask(os.path.join(OUT, sep), ppm)
        union = m if union is None else (union | m)
    ys, xs = np.nonzero(union)
    x_mm = (xs + 0.5) / ppm - 7.7          # design x
    y_mm = (ys + 0.5) / ppm - 0.2          # design y
    hw_hand = 5.00 + 0.1888 * y_mm - np.abs(x_mm)     # handoff envelope
    hw_true = 5.295 + 0.18875 * (y_mm + 0.3) - np.abs(x_mm)  # section 2 face
    i = int(np.argmin(hw_true))
    print(f'  min clearance to true face edge: {hw_true.min():.3f} mm at '
          f'design ({x_mm[i]:+.2f},{y_mm[i]:.2f})')
    print(f'  min clearance to handoff envelope fhw(y): {hw_hand.min():.3f} mm')
    if hw_true.min() < 0.10:
        fail(f'clearance {hw_true.min():.3f} below 0.10 mm floor')
    print(f'  widest ink half-width: {np.abs(x_mm).max():.3f} mm, design '
          f'height {y_mm.max():.2f} mm')


def check7_composite():
    print('check 7: separations composite vs color art')
    ppm = 100
    color = render_mask(os.path.join(OUT, 'stormtrooper_torso_12.7mm.svg'),
                        ppm, thr=250)
    union = None
    for sep in SEPS:
        m = render_mask(os.path.join(OUT, sep), ppm, thr=250)
        union = m if union is None else (union | m)
    diff = color ^ union
    residue = binary_erosion(diff, disk(1))
    print(f'  raw xor {diff.sum()/ppm/ppm:.4f} sq mm, after 1 px erosion '
          f'{residue.sum()/ppm/ppm:.4f} sq mm')
    if residue.sum() / ppm / ppm > 0.01:
        fail('separations do not reproduce the color master')
    else:
        print('  ok, residue is anti-alias noise')


def main():
    for step in (check1_pdf_sizes, check2_artboards, check3_stations,
                 check4_erosion, check5_gaps, check6_fit, check7_composite):
        step()
        print()
    if FAILURES:
        print(f'{len(FAILURES)} FAILURE(S)')
        sys.exit(1)
    print('ALL CHECKS PASSED')


if __name__ == '__main__':
    main()
