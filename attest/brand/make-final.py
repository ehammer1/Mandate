# Builds the final Testimonia brand set in final/: python3 make-final.py
# Needs fontTools (pip install fonttools) and the Inter Display SemiBold font (SIL Open Font
# License), which is turned into outlines so the wordmark looks the same everywhere.
import importlib.util
import math
import os

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('chain', os.path.join(here, 'make-chain.py'))
chain = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chain)  # also regenerates h-* and j-* next to it

NAVY, TEAL, WHITE = chain.NAVY, chain.TEAL, chain.WHITE
FONT = os.environ.get('TESTIMONIA_FONT', '/usr/share/fonts/opentype/inter/InterDisplay-SemiBold.otf')
OUT = os.path.join(here, 'final')
os.makedirs(OUT, exist_ok=True)


def mark_h(fg, ac, bg):
    return chain.chain_ring(fg, ac, bg) + chain.solid_t(fg)


def mark_j(fg, ac, bg):
    return chain.chain_t(fg, ac, bg)


def wordmark_path(text, size, tracking=0.01):
    """The text as one SVG path, baseline at y=0, plus its width."""
    font = TTFont(FONT)
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    upm = font['head'].unitsPerEm
    k = size / upm
    pen = SVGPathPen(glyphs)
    x = 0.0
    for ch in text:
        name = cmap[ord(ch)]
        glyphs[name].draw(TransformPen(pen, (k, 0, 0, -k, x, 0)))
        x += glyphs[name].width * k + tracking * size
    return pen.getCommands(), x - tracking * size


def write(name, w, h, body, title):
    with open(os.path.join(OUT, name), 'w') as f:
        f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} {h:.0f}"><title>{title}</title>{body}</svg>\n')


WORD, WORD_W = wordmark_path('Testimonia', 100)
CAP = 72  # Inter's cap height at size 100, near enough for layout

for suffix, (fg, ac, bg) in {'': (NAVY, TEAL, WHITE), '-white': (WHITE, TEAL, NAVY)}.items():
    # Marks
    write(f'testimonia-mark{suffix}.svg', 200, 200, mark_h(fg, ac, bg), 'Testimonia')
    write(f'testimonia-chain-t{suffix}.svg', 200, 200, mark_j(fg, ac, bg), 'Testimonia')
    # Wordmark alone
    write(f'testimonia-wordmark{suffix}.svg', WORD_W + 4, 104,
          f'<path transform="translate(2 78)" d="{WORD}" fill="{fg}"/>', 'Testimonia')
    # Horizontal lockup: mark at cap-height scale, name to its right
    m = 1.0  # mark is 200 tall
    gap = 40
    tx = 200 + gap
    ty = 100 + CAP / 2  # optically centre the caps on the mark
    write(f'testimonia-lockup{suffix}.svg', tx + WORD_W + 4, 200,
          f'<g>{mark_h(fg, ac, bg)}</g><path transform="translate({tx} {ty})" d="{WORD}" fill="{fg}"/>',
          'Testimonia')
    # Stacked lockup: mark above, name centred below
    k = 0.72  # name scaled to sit under the mark without overpowering it
    sw = max(WORD_W * k, 200) + 8
    write(f'testimonia-lockup-stacked{suffix}.svg', sw, 290,
          f'<g transform="translate({(sw - 200) / 2} 0)">{mark_h(fg, ac, bg)}</g>'
          f'<path transform="translate({(sw - WORD_W * k) / 2} 272) scale({k})" d="{WORD}" fill="{fg}"/>', 'Testimonia')

# App icon: white H on navy, rounded square (the stores apply their own masks too).
write('testimonia-app-icon.svg', 200, 200,
      f'<rect width="200" height="200" rx="44" fill="{NAVY}"/>'
      f'<g transform="translate(100 100) scale(0.78) translate(-100 -100)">{mark_h(WHITE, TEAL, NAVY)}</g>',
      'Testimonia')

# Favicon: at 16-32 px the chain links blur, so use a simplified ring of 8 heavy segments
# around the T, which keeps H's silhouette.
segs = []
for i in range(8):
    a0, a1 = i * 45 + 8, i * 45 + 37
    p = lambda a: (100 + 78 * math.cos(math.radians(a - 90)), 100 + 78 * math.sin(math.radians(a - 90)))
    (x0, y0), (x1, y1) = p(a0), p(a1)
    segs.append(f'<path d="M{x0:.2f} {y0:.2f} A78 78 0 0 1 {x1:.2f} {y1:.2f}" stroke="{TEAL if i == 7 else WHITE}"/>')
write('testimonia-favicon.svg', 200, 200,
      f'<rect width="200" height="200" rx="40" fill="{NAVY}"/>'
      f'<g fill="none" stroke-width="22" stroke-linecap="round">{"".join(segs)}</g>'
      f'<g fill="none" stroke="{WHITE}" stroke-width="26" stroke-linecap="round"><path d="M64 70 H136"/><path d="M100 70 V140"/></g>',
      'Testimonia')
print('wrote', len(os.listdir(OUT)), 'files to final/')
