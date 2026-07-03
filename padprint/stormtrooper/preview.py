#!/usr/bin/env python3
"""Compose stormtrooper_torso_preview.png: color master, the three ink
separations, and the station film overview on one approval sheet."""

import io
import os

import cairosvg
from PIL import Image, ImageDraw

OUT = os.path.dirname(os.path.abspath(__file__))


def render(name, width):
    png = cairosvg.svg2png(url=os.path.join(OUT, name), output_width=width,
                           background_color='white')
    return Image.open(io.BytesIO(png)).convert('RGB')


def main():
    master = render('stormtrooper_torso_color_master.svg', 700)
    seps = [render(f, 340) for f in (
        'stormtrooper_sep_1_lightgray.svg', 'stormtrooper_sep_2_darkgray.svg',
        'stormtrooper_sep_3_black.svg')]
    film = render('stormtrooper_film_190x250_cutline.svg', 440)

    pad = 24
    col2_w = max(3 * seps[0].width + 4 * pad, film.width + 2 * pad)
    W = master.width + col2_w + 3 * pad
    H = max(master.height + 2 * pad,
            seps[0].height + film.height + 3 * pad + 40)
    sheet = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(sheet)

    sheet.paste(master, (pad, pad))
    d.text((pad, master.height + pad + 6),
           'color master, print order light gray > dark gray > black',
           fill='black')

    x0 = master.width + 2 * pad
    labels = ['sep 1 light gray', 'sep 2 dark gray', 'sep 3 black']
    for i, (im, lab) in enumerate(zip(seps, labels)):
        x = x0 + pad + i * (im.width + pad)
        sheet.paste(im, (x, pad))
        d.rectangle([x, pad, x + im.width, pad + im.height], outline='#999999')
        d.text((x, pad + im.height + 6), lab, fill='black')

    fy = pad + seps[0].height + 40 + pad
    fx = x0 + pad
    sheet.paste(film, (fx, fy))
    d.rectangle([fx, fy, fx + film.width, fy + film.height], outline='#999999')
    d.text((fx, fy + film.height + 6),
           'film 200x260 page, 190x250 cut line, stations lg dg bk',
           fill='black')

    sheet.save(os.path.join(OUT, 'stormtrooper_torso_preview.png'))
    print('wrote stormtrooper_torso_preview.png', sheet.size)


if __name__ == '__main__':
    main()
