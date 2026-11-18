# Draws marks E, F, G (chain-link T and skeleton-key T). python3 make-keys.py
import math
NAVY = "#262a6e"; TEAL = "#14a99a"; WHITE = "#ffffff"

def svg(title, body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><title>{title}</title>{body}</svg>\n'

def stadium(x, y, w, h, color, sw, halo=None):
    r = min(w, h) / 2
    out = ''
    if halo:
        out += f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="none" stroke="{halo}" stroke-width="{sw + 10}"/>'
    return out + f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="none" stroke="{color}" stroke-width="{sw}"/>'

def seg(path, color, sw, halo=None, cap="butt"):
    out = ''
    if halo:
        out += f'<path d="{path}" fill="none" stroke="{halo}" stroke-width="{sw + 10}" stroke-linecap="{cap}"/>'
    return out + f'<path d="{path}" fill="none" stroke="{color}" stroke-width="{sw}" stroke-linecap="{cap}"/>'

def chain_t(fg, accent, bg):
    # Classic chain drawing: links alternate face-on (an outline) and edge-on (a solid bar
    # through the next link's hole). Bar of the T = one face-on link.
    s = ''
    s += stadium(78, 100, 44, 82, fg, 12)                          # bottom link, face-on
    s += seg('M100 52 V136', accent, 16, cap='round')               # middle link, edge-on
    s += stadium(24, 22, 152, 50, fg, 12)                           # the bar, face-on
    s += seg('M100 64 V82', accent, 16, halo=bg)                    # edge link passes in front of the bar
    s += seg('M84 100 H116', fg, 12, halo=bg)                       # bottom link's top passes in front of it
    s += stadium(78, 100, 44, 82, fg, 12)                           # redraw ring outline cleanly over the halo
    s += seg('M100 64 V82', accent, 16)
    return s

def key_t(fg, accent, bg, scale=1.0, cx=100, cy=100):
    # Upside-down skeleton key. Its bit is the T's bar: plain rounded on the left, the
    # stepped bit with wards on the right. The round bow at the bottom is a chain link.
    s = ''
    s += f'<path d="M100 50 V128" fill="none" stroke="{fg}" stroke-width="16" stroke-linecap="butt"/>'
    s += f'<path d="M86 104 H114 M86 116 H114" fill="none" stroke="{fg}" stroke-width="7" stroke-linecap="round"/>'
    s += (f'<path d="M48 30 H160 Q168 30 168 38 V76 H152 V60 H140 V76 H124 V60 H48 A15 15 0 0 1 48 30 Z" fill="{fg}"/>')
    s += f'<circle cx="100" cy="152" r="27" fill="none" stroke="{accent}" stroke-width="13"/>'
    if scale != 1.0:
        s = f'<g transform="translate({cx} {cy}) scale({scale}) translate(-100 -100)">{s}</g>'
    return s

def chain_ring(fg, accent):
    out = []
    for i in range(12):
        a0, a1 = i * 30 + 5, i * 30 + 25
        p = lambda a: (100 + 84 * math.cos(math.radians(a - 90)), 100 + 84 * math.sin(math.radians(a - 90)))
        (x0, y0), (x1, y1) = p(a0), p(a1)
        out.append(f'<path d="M{x0:.2f} {y0:.2f} A84 84 0 0 1 {x1:.2f} {y1:.2f}" stroke="{accent if i == 11 else fg}"/>')
    return f'<g fill="none" stroke-width="11" stroke-linecap="round">{"".join(out)}</g>'

variants = {'': (NAVY, TEAL, WHITE), '-white': (WHITE, TEAL, NAVY)}
for suf, (fg, ac, bg) in variants.items():
    open(f'e-chain-t{suf}.svg', 'w').write(svg('Testimonia: chain T', chain_t(fg, ac, bg)))
    open(f'f-key-t{suf}.svg', 'w').write(svg('Testimonia: key T', key_t(fg, ac, bg)))
    open(f'g-sealed-key{suf}.svg', 'w').write(svg('Testimonia: sealed key', chain_ring(fg, ac) + key_t(fg, ac, bg, scale=0.66)))
