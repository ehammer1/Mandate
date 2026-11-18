# Mark K: a T of two oval chain links in H's style, one across the top and one hanging
# down, interlocked. Mark L: K inside H's chain ring. python3 make-link-t.py
import importlib.util, math, os
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('chain', os.path.join(here, 'make-chain.py'))
chain = importlib.util.module_from_spec(spec); spec.loader.exec_module(chain)
NAVY, TEAL, WHITE = chain.NAVY, chain.TEAL, chain.WHITE

# Two identical links (H's oval proportions), one turned 90 degrees, hooked together.
BAR = (100, 52, 58, 33)    # cx, cy, rx, ry: the top link
STEM = (100, 118, 33, 58)  # the hanging link
SW = 14

def crossings():
    """Where the two ovals' centre lines cross (numerically), right-hand side first."""
    (bx, by, brx, bry), (sx, sy, srx, sry) = BAR, STEM
    pts = []
    for i in range(3600):
        t = 2 * math.pi * i / 3600
        x, y = sx + srx * math.cos(t), sy + sry * math.sin(t)
        v = ((x - bx) / brx) ** 2 + ((y - by) / bry) ** 2
        t2 = 2 * math.pi * (i + 1) / 3600
        x2, y2 = sx + srx * math.cos(t2), sy + sry * math.sin(t2)
        v2 = ((x2 - bx) / brx) ** 2 + ((y2 - by) / bry) ** 2
        if (v - 1) * (v2 - 1) < 0:
            pts.append((x, y))
    return sorted(pts, key=lambda p: -p[0])

def link_t(fg, ac, bg, uid):
    (bx, by, brx, bry), (sx, sy, srx, sry) = BAR, STEM
    e = lambda cx, cy, rx, ry, c, w: f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="none" stroke="{c}" stroke-width="{w}"/>'
    pts = crossings()
    right, left = max(pts, key=lambda p: p[0]), min(pts, key=lambda p: p[0])
    r = SW + 6
    clip = lambda name, p: f'<clipPath id="{name}{uid}"><circle cx="{p[0]:.2f}" cy="{p[1]:.2f}" r="{r}"/></clipPath>'
    s = clip('l', left) + clip('r', right)
    s += e(sx, sy, srx, sry, ac, SW) + e(bx, by, brx, bry, fg, SW)
    # left crossing: the top link passes in front; right crossing: the hanging link does.
    # Gaps are cut only at the crossings, so nothing shows on any background.
    s += f'<g clip-path="url(#l{uid})">{e(bx, by, brx, bry, bg, SW + 10)}{e(bx, by, brx, bry, fg, SW)}</g>'
    s += f'<g clip-path="url(#r{uid})">{e(sx, sy, srx, sry, bg, SW + 10)}{e(sx, sy, srx, sry, ac, SW)}</g>'
    return s

def svg(title, body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><title>{title}</title>{body}</svg>\n'

for suf, (fg, ac, bg) in {'': (NAVY, TEAL, WHITE), '-white': (WHITE, TEAL, NAVY)}.items():
    u = 'w' if suf else 'n'
    open(f'k-link-t{suf}.svg', 'w').write(svg('Testimonia: link T', link_t(fg, ac, bg, 'k' + u)))
    inner = f'<g transform="translate(100 102) scale(0.6) translate(-100 -108)">{link_t(fg, ac, bg, "l" + u)}</g>'
    open(f'l-chain-ring-link-t{suf}.svg', 'w').write(svg('Testimonia: chain ring with link T', chain.chain_ring(fg, ac, bg) + inner))
