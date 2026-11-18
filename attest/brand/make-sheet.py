# Builds sheet.html from the mark SVGs in this folder: python3 make-sheet.py
names = [
    ('a-chain-seal', 'A. Chain seal', 'A ring of linked segments, one per second of video; the newest in teal. A broken ring can mean "altered".'),
    ('b-human-ai', 'B. Human and AI', 'A person and an AI side by side under one seal, on one shared line: both accountable.'),
    ('c-lens-check', 'C. Lens check', 'A camera aperture around a check mark. Strongest as the capture app icon.'),
    ('d-t-link', 'D. T-link', 'The T of Testimonia as two interlocking chain links.'),
    ('e-chain-t', 'E. Chain T', 'The T as a real chain: the bar is one link, the stem a chain hanging from it.'),
    ('f-key-t', 'F. Key T', 'An upside-down skeleton key: its bit is the bar of the T, its ring a chain link.'),
    ('g-sealed-key', 'G. Sealed key', 'The key inside the chain seal from A.'),
    ('h-chain-ring', 'H. Chain ring', 'A with its outer ring made of real chain links, alternating face-on and edge-on.'),
    ('i-chain-ring-t', 'I. Chain ring, chain T', 'The chain ring with a T built from chain links inside.'),
    ('j-chain-t', 'J. Chain T', 'The T built from oval chain links around a junction ring.'),
]
cards = ''
for f, t, d in names:
    img = lambda w, suffix='': f'<img src="{f}{suffix}.svg" width="{w}" height="{w}" alt="">'
    cards += f'''<section class="card"><h2>{t}</h2><p>{d}</p>
<div class="row">{img(150)}<div class="dark">{img(126, '-white')}</div>
<div class="sizes">{img(48)}{img(24)}{img(16)}</div></div>
<div class="lockup">{img(56)}<span>Testimonia</span></div></section>'''
open('sheet.html', 'w').write(f'''<!doctype html><html><head><meta charset="utf-8"><title>Testimonia marks</title><style>
body{{margin:0;padding:32px;background:#f5f6fa;font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#262a6e}}
h1{{margin:0 0 4px;font-size:22px}} .sub{{margin:0 0 24px;color:#5a5f8f;font-size:14px}}
.grid{{display:grid;grid-template-columns:1fr 1fr;gap:20px}}
.card{{background:#fff;border-radius:14px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}}
h2{{margin:0;font-size:16px}} .card p{{margin:4px 0 14px;font-size:13px;color:#5a5f8f;min-height:34px}}
.row{{display:flex;gap:16px;align-items:center}} .dark{{background:#262a6e;border-radius:12px;padding:12px;line-height:0}}
.sizes{{display:flex;flex-direction:column;gap:10px;align-items:center}}
.lockup{{display:flex;align-items:center;gap:12px;margin-top:16px;border-top:1px solid #eceef5;padding-top:14px}}
.lockup span{{font-size:30px;font-weight:650;letter-spacing:.5px}}
</style></head><body><h1>Testimonia: mark options</h1>
<p class="sub">Draft. Each shown large, on navy, at 48, 24 and 16 px, and with the name. Colours match Promissa (navy #262a6e, teal #14a99a).</p>
<div class="grid">{cards}</div></body></html>''')
