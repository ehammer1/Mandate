# Marks H, I, J: a ring of real chain links, and a T built from chain links.
# python3 make-chain.py
import math
NAVY = "#262a6e"; TEAL = "#14a99a"; WHITE = "#ffffff"

def svg(title, body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><title>{title}</title>{body}</svg>\n'

def oval(cx, cy, rx, ry, rot, color, sw, halo=None):
    """A face-on chain link: an oval outline."""
    t = f'transform="rotate({rot:.2f} {cx:.2f} {cy:.2f})"'
    s = ''
    if halo:
        s += f'<ellipse cx="{cx:.2f}" cy="{cy:.2f}" rx="{rx}" ry="{ry}" {t} fill="none" stroke="{halo}" stroke-width="{sw + 8}"/>'
    return s + f'<ellipse cx="{cx:.2f}" cy="{cy:.2f}" rx="{rx}" ry="{ry}" {t} fill="none" stroke="{color}" stroke-width="{sw}"/>'

def edge(x0, y0, x1, y1, color, w, halo=None):
    """An edge-on chain link: a short rounded bar threaded through its neighbours."""
    d = f'M{x0:.2f} {y0:.2f} L{x1:.2f} {y1:.2f}'
    s = ''
    if halo:
        s += f'<path d="{d}" stroke="{halo}" stroke-width="{w + 8}" stroke-linecap="round" fill="none"/>'
    return s + f'<path d="{d}" stroke="{color}" stroke-width="{w}" stroke-linecap="round" fill="none"/>'

def chain_ring(fg, accent, bg, R=80, n=18):
    """n links around a circle, alternating face-on and edge-on, all the same length, so it
    reads as one continuous chain; one face link in teal (the newest record)."""
    faces, edges = '', ''
    step = 360 / n
    for k in range(n):
        a = math.radians(k * step - 90)
        cx, cy = 100 + R * math.cos(a), 100 + R * math.sin(a)
        tang = math.degrees(a) + 90
        if k % 2 == 0:
            faces += oval(cx, cy, 17, 10, tang, accent if k == n - 2 else fg, 6)
        else:
            h = 13
            dx, dy = -math.sin(a) * h, math.cos(a) * h
            edges += edge(cx - dx, cy - dy, cx + dx, cy + dy, fg, 9, halo=bg)
    return faces + edges

def chain_t(fg, accent, bg):
    """A T of chain links: a round junction ring, an arm of links each side, a stem below."""
    s = ''
    # face-on links: left and right ends of the bar, and two down the stem
    s += oval(42, 52, 24, 14, 0, fg, 10)
    s += oval(158, 52, 24, 14, 0, fg, 10)
    s += oval(100, 118, 14, 24, 0, fg, 10)
    s += oval(100, 170, 14, 20, 0, accent, 10)
    # the junction ring
    s += f'<circle cx="100" cy="52" r="20" fill="none" stroke="{accent}" stroke-width="10"/>'
    # edge-on links threaded between them (drawn over, with a background halo)
    s += edge(56, 52, 84, 52, fg, 12, halo=bg)
    s += edge(116, 52, 144, 52, fg, 12, halo=bg)
    s += edge(100, 68, 100, 98, fg, 12, halo=bg)
    s += edge(100, 136, 100, 156, accent, 12, halo=bg)
    return s

def solid_t(fg):
    return f'<g fill="none" stroke="{fg}" stroke-width="16" stroke-linecap="round"><path d="M66 70 H134"/><path d="M100 70 V138"/></g>'

def scaled(body, k):
    return f'<g transform="translate(100 100) scale({k}) translate(-100 -100)">{body}</g>'

for suf, (fg, ac, bg) in {'': (NAVY, TEAL, WHITE), '-white': (WHITE, TEAL, NAVY)}.items():
    open(f'h-chain-ring{suf}.svg', 'w').write(svg('Testimonia: chain ring', chain_ring(fg, ac, bg) + solid_t(fg)))
    open(f'i-chain-ring-t{suf}.svg', 'w').write(svg('Testimonia: chain ring and chain T', chain_ring(fg, ac, bg) + scaled(chain_t(fg, ac, bg), 0.66)))
    open(f'j-chain-t{suf}.svg', 'w').write(svg('Testimonia: chain T', chain_t(fg, ac, bg)))
