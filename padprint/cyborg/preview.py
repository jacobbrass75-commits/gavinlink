#!/usr/bin/env python3
"""cyborg_preview.png: reference image left, printed head stacked on the
printed torso right, matched heights, for visual approval."""

import os
import sys

from PIL import Image

OUT = os.path.dirname(os.path.abspath(__file__))


def main(ref_path):
    head = Image.open(os.path.join(OUT, 'preview_head.png')).convert('RGB')
    torso = Image.open(os.path.join(OUT, 'preview_torso.png')).convert('RGB')
    fig_w = max(head.width, torso.width)
    fig = Image.new('RGB', (fig_w, head.height + torso.height), 'white')
    fig.paste(head, ((fig_w - head.width) // 2, 0))
    fig.paste(torso, ((fig_w - torso.width) // 2, head.height))

    ref = Image.open(ref_path).convert('RGB')
    ref = ref.resize((round(ref.width * fig.height / ref.height), fig.height))
    pad = 30
    sheet = Image.new('RGB', (ref.width + fig.width + 3 * pad, fig.height + 2 * pad),
                      'white')
    sheet.paste(ref, (pad, pad))
    sheet.paste(fig, (ref.width + 2 * pad, pad))
    sheet.save(os.path.join(OUT, 'cyborg_preview.png'))
    print('wrote cyborg_preview.png', sheet.size)


if __name__ == '__main__':
    main(sys.argv[1])
