#!/usr/bin/env python3
"""Cyborg minifig print generator, full color for a UV flatbed printer.

Two pieces of art, each on its own true-size artboard:
  torso: front face of a WHITE torso, same 15.4 x 12.6 artboard and taper
         envelope as the pad print jobs (y = 0 at print top, x = 0 center)
  head:  front face of a LIGHT BLUISH GRAY head. The gray head color is the
         metal half, so only the skin patch, eyes, mouth and metal panel
         lines are printed.

UV direct printing goes straight onto the part, so nothing is mirrored.
Outputs SVG + PDF (vector, true size), 1200 dpi PNG color layers, and
1200 dpi white underbase masks for printers with a white channel.
"""

import io
import os

OUT = os.path.dirname(os.path.abspath(__file__))
DPI = 1200
PPM = DPI / 25.4          # pixels per mm at 1200 dpi

# palette
SILVER, STEEL = '#c3c9d2', '#8a94a3'
BLUE, BLUE_LT, BLUE_DK = '#3a68b0', '#6d95d0', '#2c5294'
NAVY, RED, RED_LT = '#1c2740', '#e3262b', '#ff9a8a'
SKIN, SKIN_DK, BROW = '#6b3e26', '#4e2b19', '#1e130d'
MOUTH, LIP, TEETH = '#3a1410', '#8e2a20', '#f4efe6'
SEAM = '#2a2f38'

TORSO_PART = '#f4f4f2'    # white torso, for previews only
HEAD_PART = '#a0a5a9'     # light bluish gray head, for previews only


def fhw(y):               # torso face half width at design depth y
    return 5.00 + 0.1888 * y


def L(x1, y1, x2, y2, w, c=NAVY):
    return (f'<line x1="{x1:.3f}" y1="{y1:.3f}" x2="{x2:.3f}" y2="{y2:.3f}" '
            f'stroke="{c}" stroke-width="{w}" stroke-linecap="round"/>')


def P(d, w, c=NAVY, fill='none'):
    return (f'<path d="{d}" stroke="{c}" stroke-width="{w}" stroke-linecap="round" '
            f'stroke-linejoin="round" fill="{fill}"/>')


def F(d, c):
    return f'<path d="{d}" fill="{c}" stroke="none"/>'


def C(cx, cy, r, fill, stroke=None, w=0):
    s = f' stroke="{stroke}" stroke-width="{w}"' if stroke else ''
    return f'<circle cx="{cx:.3f}" cy="{cy:.3f}" r="{r}" fill="{fill}"{s}/>'


def E(cx, cy, rx, ry, fill):
    return f'<ellipse cx="{cx:.3f}" cy="{cy:.3f}" rx="{rx}" ry="{ry}" fill="{fill}"/>'


def wrap(body, w, h, dx, dy, backdrop=''):
    return (f'<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}mm" height="{h}mm" '
            f'viewBox="0 0 {w} {h}">\n{backdrop}'
            f'<g transform="translate({dx},{dy})">{body}</g>\n</svg>')


TORSO_BOARD = dict(w=15.4, h=12.6, dx=7.7, dy=0.2)
HEAD_BOARD = dict(w=9.0, h=6.4, dx=4.5, dy=0.4)


def torso():
    els = []
    # side armor shading, silver strips inside the outer edges
    for s in (1, -1):
        els.append(F(f'M {s*4.40:.2f},0.70 C {s*5.00:.2f},2.00 {s*5.45:.2f},4.20 '
                     f'{s*5.60:.2f},6.40 L {s*5.75:.2f},9.40 L {s*4.55:.2f},9.40 '
                     f'L {s*4.30:.2f},6.30 C {s*4.25:.2f},4.20 {s*3.95:.2f},2.20 '
                     f'{s*3.55:.2f},1.20 Z', SILVER))
        els.append(P(f'M {s*4.55:.2f},2.60 C {s*4.85:.2f},3.60 {s*5.00:.2f},4.80 '
                     f'{s*5.05:.2f},6.00', 0.14, STEEL))
        els.append(C(s * 4.95, 7.90, 0.17, STEEL))

    # blue chest plate
    # vest-like plate: square shoulders, gentle taper toward the waist
    plate = ('M -3.30,1.55 Q 0,1.95 3.30,1.55 C 3.60,2.60 3.75,3.80 3.75,5.20 '
             'C 3.75,6.80 3.62,8.10 3.45,9.30 Q 0,9.85 -3.45,9.30 '
             'C -3.62,8.10 -3.75,6.80 -3.75,5.20 C -3.75,3.80 -3.60,2.60 -3.30,1.55 Z')
    els.append(F(plate, BLUE))
    # lighter upper band and the bright highlight seam seen on the reference
    els.append(F('M -3.30,1.55 Q 0,1.95 3.30,1.55 C 3.42,1.95 3.52,2.40 3.58,2.85 '
                 'Q 0,3.35 -3.58,2.85 C -3.52,2.40 -3.42,1.95 -3.30,1.55 Z', BLUE_LT))
    els.append(P('M -3.58,2.85 Q 0,3.35 3.58,2.85', 0.18))
    els.append(P('M -2.60,3.30 Q 0,3.72 2.60,3.30', 0.14, '#dfe8f5'))
    # ab plate segment lines
    els.append(P('M -3.50,5.80 Q 0,6.30 3.50,5.80', 0.15, BLUE_DK))
    els.append(P('M -3.40,7.60 Q 0,8.10 3.40,7.60', 0.15, BLUE_DK))
    # rivets on the upper band
    for s in (1, -1):
        els.append(C(s * 2.45, 2.30, 0.17, NAVY))
    els.append(P(plate, 0.20))

    # neck collar
    els.append(P('M -3.25,0.00 L 3.25,0.00 L 3.60,0.95 Q 0,1.75 -3.60,0.95 Z',
                 0.16, NAVY, STEEL))
    els.append(P('M -2.40,0.55 Q 0,1.05 2.40,0.55', 0.14, SILVER))

    # belt with red power light
    els.append(P('M -6.00,9.55 Q 0,10.15 6.00,9.55 L 6.20,10.45 Q 0,11.05 -6.20,10.45 Z',
                 0.16, NAVY, STEEL))
    els.append(P('M -1.05,9.55 L 1.05,9.55 Q 1.25,9.55 1.25,9.75 L 1.25,10.75 '
                 'Q 1.25,10.95 1.05,10.95 L -1.05,10.95 Q -1.25,10.95 -1.25,10.75 '
                 'L -1.25,9.75 Q -1.25,9.55 -1.05,9.55 Z', 0.14, NAVY, SILVER))
    els.append(C(0, 10.25, 0.34, RED, NAVY, 0.10))
    els.append(C(-0.10, 10.15, 0.11, RED_LT))
    return els


def head():
    els = []
    # skin patch: whole viewer-left face, seam runs down beside the nose,
    # swings under the cyber eye, and drops to the jaw
    # skin wraps off the left edge (it continues around the head cylinder),
    # with a rounded hairline so the patch does not read as a box
    skin = ('M -4.30,1.20 C -3.60,0.40 -1.60,0.10 0.25,0.45 '
            'C 0.60,1.30 0.40,2.30 0.70,3.05 C 1.20,3.55 1.90,3.60 2.70,3.75 '
            'C 3.05,4.30 3.15,4.85 3.10,5.35 L -4.30,5.35 Z')
    els.append(F(skin, SKIN))
    # metal seam line along the cyborg edge only
    els.append(P('M 0.25,0.45 C 0.60,1.30 0.40,2.30 0.70,3.05 '
                 'C 1.20,3.55 1.90,3.60 2.70,3.75 C 3.05,4.30 3.15,4.85 3.10,5.35',
                 0.16, SEAM))
    # metal panel lines and rivets on the gray half
    els.append(P('M 1.70,0.20 C 2.60,0.50 3.30,1.10 3.75,2.10', 0.13, SEAM))
    els.append(C(2.95, 0.95, 0.15, SEAM))
    els.append(C(3.55, 3.05, 0.15, SEAM))

    # cyber eye: dark ring, red lens, highlight
    els.append(C(1.90, 2.00, 0.80, SEAM))
    els.append(C(1.90, 2.00, 0.58, RED))
    els.append(C(1.72, 1.82, 0.18, RED_LT))

    # human eye and angry brow
    els.append(E(-1.70, 2.05, 0.55, 0.38, TEETH))
    els.append(C(-1.55, 2.08, 0.22, BROW))
    els.append(P('M -2.65,1.20 Q -1.80,1.10 -0.85,1.45', 0.30, BROW))
    # cheek and nose shading
    els.append(P('M -2.30,3.00 Q -1.70,3.25 -1.10,3.05', 0.13, SKIN_DK))
    els.append(P('M -0.35,2.55 Q -0.55,3.20 -0.05,3.35', 0.14, SKIN_DK))

    # grimace: thick maroon lips with downturned corners, clenched teeth
    lips = ('M -1.55,4.55 C -1.10,3.85 1.40,3.85 1.85,4.55 '
            'C 1.40,5.10 -1.10,5.10 -1.55,4.55 Z')
    els.append(F(lips, LIP))
    els.append(F('M -1.05,4.40 Q 0.15,4.15 1.35,4.40 Q 1.35,4.72 0.15,4.78 '
                 'Q -1.05,4.72 -1.05,4.40 Z', MOUTH))
    els.append(F('M -0.95,4.42 Q 0.15,4.22 1.25,4.42 L 1.22,4.58 Q 0.15,4.45 '
                 '-0.92,4.58 Z', TEETH))
    els.append(L(0.15, 4.30, 0.15, 4.52, 0.06, MOUTH))
    els.append(P(lips, 0.12, MOUTH))
    return els


def main():
    import cairosvg

    t, h = ''.join(torso()), ''.join(head())
    files = {
        'cyborg_torso_uv.svg': wrap(t, **TORSO_BOARD),
        'cyborg_head_uv.svg': wrap(h, **HEAD_BOARD),
    }
    for name, svg in files.items():
        path = os.path.join(OUT, name)
        with open(path, 'w') as f:
            f.write(svg)
        cairosvg.svg2pdf(bytestring=svg.encode(), write_to=path[:-4] + '.pdf')
        b = TORSO_BOARD if 'torso' in name else HEAD_BOARD
        cairosvg.svg2png(bytestring=svg.encode(),
                         write_to=path[:-4] + '_1200dpi.png',
                         output_width=round(b['w'] * PPM),
                         output_height=round(b['h'] * PPM))
        write_white_mask(path[:-4] + '_1200dpi.png',
                         path[:-4] + '_white_underbase_1200dpi.png')

    # previews on the real part colors
    torso_bd = (f'<polygon points="-5.30,-0.3 5.30,-0.3 7.71,12.52 -7.71,12.52" '
                f'fill="{TORSO_PART}" stroke="#b9b7b2" stroke-width="0.06"/>')
    head_bd = (f'<rect x="-4.5" y="-0.4" width="9" height="6.4" rx="1.2" '
               f'fill="{HEAD_PART}"/>')
    for name, body, board, bd in (('preview_torso.png', t, TORSO_BOARD, torso_bd),
                                  ('preview_head.png', h, HEAD_BOARD, head_bd)):
        svg = wrap(bd + body, **board)
        cairosvg.svg2png(bytestring=svg.encode(), write_to=os.path.join(OUT, name),
                         output_width=round(board['w'] * 60),
                         output_height=round(board['h'] * 60),
                         background_color='white')
    print('wrote', ', '.join(sorted(files)), '+ pdf, png, white masks, previews')


def write_white_mask(color_png, mask_png):
    """White underbase = every inked pixel, choked 1 px (0.02 mm) so no
    white halo shows past the color edge. Black on transparent, the usual
    spot channel convention; the RIP maps it to the white ink channel."""
    import numpy as np
    from PIL import Image
    from scipy import ndimage
    a = np.asarray(Image.open(color_png).convert('RGBA'))[:, :, 3] > 127
    a = ndimage.binary_erosion(a, iterations=1)
    out = np.zeros(a.shape + (4,), np.uint8)
    out[a] = (0, 0, 0, 255)
    Image.fromarray(out, 'RGBA').save(mask_png, dpi=(DPI, DPI))


if __name__ == '__main__':
    main()
