#!/usr/bin/env python3
"""Stormtrooper torso pad print generator.

Parametric design in mm, y = 0 at top of print, y increases downward,
x = 0 at center. Emits color master, per-ink separations, station film,
PDFs, and preview renders. Verification lives in verify.py.
"""

import math
import os

BLACK, DGRAY, LGRAY = '#141414', '#7e8284', '#c4c8c7'

OUT = os.path.dirname(os.path.abspath(__file__))


def fhw(y):              # half width of the face at design depth y
    return 5.00 + 0.1888 * y


def L(x1, y1, x2, y2, w, c=BLACK, cap='round'):
    return (f'<line x1="{x1:.3f}" y1="{y1:.3f}" x2="{x2:.3f}" y2="{y2:.3f}" '
            f'stroke="{c}" stroke-width="{w}" stroke-linecap="{cap}" fill="none"/>')


def P(d, w, c=BLACK, fill='none', cap='round'):
    return (f'<path d="{d}" stroke="{c}" stroke-width="{w}" stroke-linecap="{cap}" '
            f'stroke-linejoin="round" fill="{fill}"/>')


def F(d, c):
    return f'<path d="{d}" fill="{c}" stroke="none"/>'


def seam_quad(x1, y1, x2, y2, w):   # thin clear knockout strip inside a filled shape
    dx, dy = x2 - x1, y2 - y1
    n = math.hypot(dx, dy)
    ux, uy = -dy / n * w / 2, dx / n * w / 2
    return (f'M {x1+ux:.3f},{y1+uy:.3f} L {x2+ux:.3f},{y2+uy:.3f} '
            f'L {x2-ux:.3f},{y2-uy:.3f} L {x1-ux:.3f},{y1-uy:.3f} Z')


def wrap(body, w=15.4, h=12.6, dx=7.7, dy=0.2):   # artboard with centered design
    return (f'<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}mm" height="{h}mm" '
            f'viewBox="0 0 {w} {h}">\n<g transform="translate({dx},{dy})">{body}</g>\n</svg>')


def build_design():
    """Return (lg, dg, bk) element lists for the stormtrooper torso.

    Anatomy, top to bottom: black neck seal, light gray collar rim shadow,
    chest armor plate (clavicle ridge, sternum seam, pectoral contours,
    side edges with shading), black undersuit gap band, abdominal plate
    with horizontal segment ridges and shaded outer edges.
    Fully symmetric about x = 0, so no mirrored film variant is needed.
    """
    lg, dg, bk = [], [], []

    # neck seal, black fill across the top
    bk.append(F('M -4.40,0 L 4.40,0 L 4.58,0.85 Q 0,1.95 -4.58,0.85 Z', BLACK))

    # collar rim shadow: lg band tucked 0.15 under the neck seal for trap
    lg.append(F('M -4.58,0.70 Q 0,1.80 4.58,0.70 L 4.66,1.30 Q 0,2.40 -4.66,1.30 Z', LGRAY))
    dg.append(P('M -4.66,1.30 Q 0,2.40 4.66,1.30', 0.18, DGRAY))

    # sternum seam
    bk.append(L(0, 2.30, 0, 6.35, 0.22))

    for s in (1, -1):
        # clavicle ridge, outer shoulder toward center
        bk.append(P(f'M {s*4.72:.3f},2.05 C {s*3.4:.3f},1.72 {s*1.8:.3f},1.88 '
                    f'{s*0.5:.3f},2.35', 0.24))
        # pectoral contour, lower edge kept 0.3+ clear of the undersuit band
        bk.append(P(f'M {s*1.0:.3f},2.78 C {s*3.2:.3f},2.62 {s*4.6:.3f},3.30 '
                    f'{s*4.7:.3f},4.40 C {s*4.75:.3f},5.15 {s*3.5:.3f},5.70 '
                    f'{s*1.6:.3f},5.70', 0.26))
        # chest plate side edge
        bk.append(P(f'M {s*4.72:.3f},2.05 C {s*5.15:.3f},2.90 {s*5.35:.3f},4.60 '
                    f'{s*5.30:.3f},5.95', 0.24))
        # under-pec shadow crescent, top edge tucked under the pec stroke
        lg.append(F(f'M {s*1.8:.3f},5.72 C {s*3.4:.3f},5.70 {s*4.5:.3f},5.25 '
                    f'{s*4.62:.3f},4.75 C {s*4.72:.3f},5.45 {s*3.6:.3f},6.00 '
                    f'{s*1.8:.3f},6.05 Z', LGRAY))
        # side edge shading sliver, outer edge shared with the bk side stroke
        lg.append(F(f'M {s*4.72:.3f},2.05 C {s*5.15:.3f},2.90 {s*5.35:.3f},4.60 '
                    f'{s*5.30:.3f},5.95 L {s*4.88:.3f},5.95 C {s*4.93:.3f},4.60 '
                    f'{s*4.78:.3f},3.00 {s*4.45:.3f},2.18 Z', LGRAY))
        # abdominal plate outer edge
        bk.append(P(f'M {s*5.42:.3f},6.60 C {s*5.9:.3f},7.40 {s*6.2:.3f},9.00 '
                    f'{s*6.25:.3f},10.35', 0.24))
        # abdominal plate edge shading, outer edge shared with the bk stroke
        lg.append(F(f'M {s*5.42:.3f},6.60 C {s*5.9:.3f},7.40 {s*6.2:.3f},9.00 '
                    f'{s*6.25:.3f},10.35 L {s*5.68:.3f},10.35 C {s*5.63:.3f},9.00 '
                    f'{s*5.38:.3f},7.55 {s*5.00:.3f},6.88 Z', LGRAY))

    # chest plate bottom edge and black undersuit gap band
    bk.append(P('M -5.30,5.95 Q 0,6.85 5.30,5.95', 0.26))
    bk.append(F('M -5.30,5.95 Q 0,6.85 5.30,5.95 L 5.42,6.60 Q 0,7.55 -5.42,6.60 Z',
                BLACK))

    # abdominal plate segment ridges
    dg.append(P('M -5.15,8.10 Q 0,8.75 5.15,8.10', 0.20, DGRAY))
    dg.append(P('M -5.35,9.30 Q 0,9.95 5.35,9.30', 0.20, DGRAY))

    return lg, dg, bk


def to_black(els):
    out = ''.join(els)
    out = out.replace(DGRAY, '#000000').replace(LGRAY, '#000000').replace(BLACK, '#000000')
    return out.replace('fill="#ffffff"', 'fill="none"')   # keep interiors open on film


def face_backdrop():
    """True torso face trapezoid for the color master. Design y=0 sits
    0.3 mm below the face top edge; face half width = 5.295 + 0.18875*t."""
    pts = []
    t_top, t_bot = 0.0, 12.82
    hw_top = 5.295 + 0.18875 * t_top
    hw_bot = 5.295 + 0.18875 * t_bot
    y_top, y_bot = -0.3, 12.52
    pts = f'{-hw_top:.3f},{y_top} {hw_top:.3f},{y_top} {hw_bot:.3f},{y_bot} {-hw_bot:.3f},{y_bot}'
    return f'<polygon points="{pts}" fill="#f0efec" stroke="#b9b7b2" stroke-width="0.06"/>'


def station_film(lg, dg, bk, mirrored=False):
    """200 x 260 mm page, 190 x 250 cut rect at (5,5). Stations at plate
    coords (50,50) (140,50) (50,200): lg, dg, bk. Fourth station empty."""
    layers = [to_black(lg), to_black(dg), to_black(bk)]
    stations = [(55.0, 55.0), (145.0, 55.0), (55.0, 205.0)]
    parts = ['<?xml version="1.0" encoding="UTF-8"?>\n'
             '<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="260mm" '
             'viewBox="0 0 200 260">',
             '<rect x="5" y="5" width="190" height="250" fill="none" '
             'stroke="#000000" stroke-width="0.2"/>']
    for (cx, cy), body in zip(stations, layers):
        inner = f'<g transform="translate(7.7,0.2)">{body}</g>'
        if mirrored:
            inner = f'<g transform="translate(15.4,0) scale(-1,1)">{inner}</g>'
        parts.append(f'<g transform="translate({cx-7.7:.3f},{cy-6.3:.3f})">{inner}</g>')
    parts.append('</svg>')
    return '\n'.join(parts)


def main():
    import cairosvg

    lg, dg, bk = build_design()

    files = {}
    # separations, shared artboard, recolored to pure black
    for i, (name, els) in enumerate([('lightgray', lg), ('darkgray', dg),
                                     ('black', bk)], start=1):
        files[f'stormtrooper_sep_{i}_{name}.svg'] = wrap(to_black(els))

    # color master with face backdrop, print order lg -> dg -> bk
    files['stormtrooper_torso_color_master.svg'] = wrap(
        face_backdrop() + ''.join(lg + dg + bk))

    # true size single artwork, all inks in color, no backdrop
    files['stormtrooper_torso_12.7mm.svg'] = wrap(''.join(lg + dg + bk))

    # station film
    files['stormtrooper_film_190x250_cutline.svg'] = station_film(lg, dg, bk)

    for fname, svg in files.items():
        path = os.path.join(OUT, fname)
        with open(path, 'w') as f:
            f.write(svg)
        if 'color_master' not in fname:
            cairosvg.svg2pdf(bytestring=svg.encode(), write_to=path[:-4] + '.pdf')

    # large render of the color master for visual review
    cairosvg.svg2png(
        bytestring=files['stormtrooper_torso_color_master.svg'].encode(),
        write_to=os.path.join(OUT, 'render_master.png'),
        output_width=924, output_height=756, background_color='white')
    print('wrote', ', '.join(sorted(files)))


if __name__ == '__main__':
    main()
