"""Draw the Portfolio Desk app icons (run once; build_site.py copies the PNGs). Usage: python3 make_icons.py
The mark: a deep-green field (the lock screen's accent, #0B6E5F, with a soft top-left light), three ascending ledger bars in
translucent white and a white trend line rising over them to an amber "latest" point, echoing the lock screen's trend mark.
  icon-192.png / icon-512.png                   purpose "any": rounded square, transparent corners, larger mark
  icon-maskable-192.png / icon-maskable-512.png purpose "maskable": full bleed, mark inside the 80% safe circle
  icon-180.png                                  apple-touch-icon: full bleed and opaque (iOS rounds the corners itself)
Drawn at 4x and downsampled for clean anti-aliased edges."""
import os
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
TOP, BOTTOM = (16, 128, 110), (8, 84, 72)       # field gradient around #0B6E5F
BAR = (255, 255, 255, 64)                        # translucent mint-white ledger bars
LINE = (255, 255, 255, 255)
TIP = (246, 196, 92, 255)                        # warm amber dot at the latest point


def field(S):
    """Vertical gradient with a gentle radial light in the upper left."""
    g = Image.new('RGB', (1, S))
    for y in range(S):
        t = y / (S - 1)
        g.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    im = g.resize((S, S))
    glow = Image.new('L', (S, S), 0)
    ImageDraw.Draw(glow).ellipse([-S * 0.35, -S * 0.45, S * 0.75, S * 0.55], fill=70)
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.12))
    im.paste(Image.new('RGB', (S, S), (60, 170, 150)), (0, 0), glow)
    return im.convert('RGBA')


def mark(S, scale):
    """The bars + trend line on a transparent layer; `scale` = width of the mark's box as a share of S, centred."""
    L = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(L)
    box = S * scale; ox = (S - box) / 2; oy = (S - box) / 2 + box * 0.03   # the dot sits high: nudge down to balance
    P = lambda x, y: (ox + x * box, oy + y * box)          # mark coordinates in 0..1
    w = max(2, round(box * 0.08))
    # three ascending ledger bars on a common baseline
    for x0, top in ((0.02, 0.66), (0.37, 0.50), (0.72, 0.30)):
        d.rounded_rectangle([P(x0, top), P(x0 + 0.24, 1.0)], radius=box * 0.05, fill=BAR)
    # the trend line: steady, a small dip, then a rise that runs past the last bar to the latest point
    pts = [P(0.0, 0.52), P(0.36, 0.30), P(0.58, 0.42), P(0.94, 0.04)]
    d.line(pts, fill=LINE, width=w, joint='curve')
    x, y = pts[0]; d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=LINE)
    # the latest point: an amber disc ringed in white
    x, y = pts[-1]; R = w * 1.45; r = w * 0.95
    d.ellipse([x - R, y - R, x + R, y + R], fill=LINE)
    d.ellipse([x - r, y - r, x + r, y + r], fill=TIP)
    return L


def render(n, kind):
    S = n * 4
    if kind == 'any':   # rounded square with transparent corners
        im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        m = Image.new('L', (S, S), 0); ImageDraw.Draw(m).rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.225, fill=255)
        im.paste(field(S), (0, 0), m)
        im.alpha_composite(mark(S, 0.58))
    else:               # full bleed; maskable keeps the mark well inside the 80% safe circle
        im = field(S)
        im.alpha_composite(mark(S, 0.50 if kind == 'maskable' else 0.58))
    out = im.resize((n, n), Image.LANCZOS)
    return out.convert('RGB') if kind == 'apple' else out


if __name__ == '__main__':
    for n in (192, 512):
        render(n, 'any').save(os.path.join(HERE, f'icon-{n}.png'), optimize=True)
        render(n, 'maskable').save(os.path.join(HERE, f'icon-maskable-{n}.png'), optimize=True)
    render(180, 'apple').save(os.path.join(HERE, 'icon-180.png'), optimize=True)
    print('icons written to', HERE)
