# Mark M: the two-link T from D, drawn with rounded-rectangle links like the ones in H's
# ring instead of fully rounded (paperclip) ends. python3 make-square-t.py
import os
NAVY, TEAL, WHITE = "#262a6e", "#14a99a", "#ffffff"
SW = 14
BAR = (28, 30, 144, 54, 17)    # x, y, w, h, corner radius: the top link
STEM = (73, 60, 54, 116, 17)   # the hanging link

def rect(r, color, w):
    x, y, ww, h, rx = r
    return f'<rect x="{x}" y="{y}" width="{ww}" height="{h}" rx="{rx}" fill="none" stroke="{color}" stroke-width="{w}"/>'

def square_t(fg, ac, bg, uid=None):
    bx, by, bw, bh, brx = BAR
    sx, sy, sw, sh, srx = STEM
    yb = by + bh          # the top link's lower side, where the links cross
    xl, xr = sx, sx + sw  # the hanging link's two sides
    gap = SW + 12         # width of the background cut around a crossing
    seg = lambda d, c, w: f'<path d="{d}" fill="none" stroke="{c}" stroke-width="{w}" stroke-linecap="butt"/>'
    s = rect(STEM, ac, SW) + rect(BAR, fg, SW)
    # Left crossing: the top link passes in front, cutting a gap in the hanging link.
    # The coloured redraw runs a little past the cut at both ends, so no hairline shows.
    s += seg(f'M{xl - 12} {yb} H{xl + 12}', bg, gap) + seg(f'M{xl - 17} {yb} H{xl + 17}', fg, SW)
    # Right crossing: the hanging link passes in front, cutting a gap in the top link.
    s += seg(f'M{xr} {sy + srx + 3} V{yb + 13}', bg, gap) + seg(f'M{xr} {sy + srx} V{yb + 18}', ac, SW)
    return s

def svg(title, body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><title>{title}</title>{body}</svg>\n'

here = os.path.dirname(os.path.abspath(__file__))
for suf, (fg, ac, bg) in {'': (NAVY, TEAL, WHITE), '-white': (WHITE, TEAL, NAVY)}.items():
    with open(os.path.join(here, f'm-square-link-t{suf}.svg'), 'w') as f:
        f.write(svg('Testimonia: square-link T', square_t(fg, ac, bg, 'w' if suf else 'n')))
