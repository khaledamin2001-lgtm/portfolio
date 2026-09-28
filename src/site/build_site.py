"""Build the live site's index.html from the desk page + lock layer. Usage: python3 build_site.py <site repo dir>"""
import re, json, sys, os, shutil
from PIL import Image, ImageDraw
REPO = sys.argv[1] if len(sys.argv) > 1 else 'repo'
PORTFOLIOS = [{"id": "khaled", "name": "Khaled's Portfolio"}, {"id": "yassin", "name": "Yassin's Portfolio"}]
page = open('../portfolio-desk.html').read()
page = re.sub(r'<title>.*?</title>\s*', '', page, count=1)
assert page.count('readOnly:false,') == 1, 'page layout changed: readOnly flag not found'
page = page.replace('readOnly:false,', 'readOnly:true,')
hook = "async function refreshNow(btn){"
assert page.count(hook) == 1, 'page layout changed: refreshNow not found'
page = page.replace(hook, hook + " if(window.pdRefreshPrices) return window.pdRefreshPrices(btn, toast);")
hook = "function toast(msg, kind){"   # lock.js shows its notices (live prices unavailable) through the page's own toast
assert page.count(hook) == 1, 'page layout changed: toast() not found'
page = page.replace(hook, "window.pdToast = (m, k) => toast(m, k);\n" + hook)
# Self-hosted fonts: the Claude page links Google Fonts; the site serves the same WOFF2 files itself (site/fonts/, listed in
# fonts.json with each face's weight and unicode-range) from its own fonts/ folder, so no request leaves for Google.
FONTS = json.load(open('fonts/fonts.json'))
os.makedirs(os.path.join(REPO, 'fonts'), exist_ok=True)
for f in sorted({x['file'] for x in FONTS}): shutil.copyfile(os.path.join('fonts', f), os.path.join(REPO, 'fonts', f))
face = ''.join("@font-face{font-family:'%s';font-style:normal;font-weight:%s;font-display:swap;src:url(fonts/%s) format('woff2');unicode-range:%s}\n" % (x['family'], x['weight'], x['file'], x['range']) for x in FONTS)
gf = re.findall(r'<link rel="(?:preconnect|stylesheet)" href="https://fonts\.(?:googleapis|gstatic)\.com[^>]*>\n?', page)
assert len(gf) == 3, 'page layout changed: expected the 3 Google Fonts <link> tags, found %d' % len(gf)
for x in gf: page = page.replace(x, '', 1)
assert 'fonts.googleapis.com' not in page and 'fonts.gstatic.com' not in page, 'a Google Fonts reference is left in the page'
# Content-Security-Policy: the page loads only itself (fonts included) and the TradingView scanner (pdf.js is never loaded on the
# site: it is only fetched by the Claude page's statement reader). Inline scripts/styles are the whole app, hence 'unsafe-inline'.
CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
       "font-src 'self'; connect-src 'self' https://scanner.tradingview.com; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'")
css, js = open('lock.css').read(), open('lock.js').read()
head = '''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="''' + CSP + '''">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#0B6E5F"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Portfolio Tracker"><meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="manifest.webmanifest"><link rel="apple-touch-icon" href="icon-180.png"><link rel="icon" href="icon-192.png">
<title>Stock Market Portfolio Tracker</title>
<style>''' + face + ''':root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#F3F6F4}img{max-width:100%}[hidden]{display:none!important}
''' + css + '''
[data-testid=scan-gmail],[data-testid=factsheet-email],[data-testid=post-statement],[data-testid=csv-import],[data-testid=csv-import-input],[data-testid=save-marks],[data-testid=save-assets],[data-testid=save-settings]{display:none!important}
</style></head><body class="pd-locked">
<div id="lock" role="dialog" aria-modal="true" aria-label="Unlock portfolio"></div>
<script>''' + js + '</script>\n'
bar = '''<div id="pd-bar" data-testid="live-bar"><span><strong id="pd-who"></strong> · <span id="pd-updated">Loading…</span></span><span><span id="pd-prices" data-testid="live-prices-status">Prices from the last daily update</span> · edits and statement imports happen on the Claude page</span><span class="pd-actions"><button type="button" id="pd-switch" hidden onclick="pdSwitch()" data-testid="live-switch-bar">Switch portfolio</button><button type="button" onclick="pdLock()" data-testid="live-lock">Lock</button></span></div>
</body></html>'''
open(os.path.join(REPO, 'index.html'), 'w').write(head + page + bar)
json.dump(PORTFOLIOS, open(os.path.join(REPO, 'portfolios.json'), 'w'))
json.dump({"name": "Stock Market Portfolio Tracker", "short_name": "Portfolio Tracker", "start_url": "./", "scope": "./", "display": "standalone", "background_color": "#F3F6F4", "theme_color": "#0B6E5F",
           "icons": [{"src": "icon-192.png", "sizes": "192x192", "type": "image/png"}, {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"}]}, open(os.path.join(REPO, 'manifest.webmanifest'), 'w'), indent=1)
for n in (180, 192, 512):
    S = 4 * n; im = Image.new('RGB', (S, S), '#0B6E5F'); d = ImageDraw.Draw(im); s = S / 36; w = int(2.8 * s * 0.55)
    pts = [(9, 25), (15, 18.5), (20, 22), (27.5, 13)]
    d.line([(x * s, y * s) for x, y in pts], fill='white', width=w, joint='curve')
    d.line([(22.5 * s, 13 * s), (27.5 * s, 13 * s), (27.5 * s, 18 * s)], fill='white', width=w, joint='curve')
    for x, y in pts + [(22.5, 13), (27.5, 18)]: r = w / 2; d.ellipse([x * s - r, y * s - r, x * s + r, y * s + r], fill='white')
    im.resize((n, n), Image.LANCZOS).save(os.path.join(REPO, f'icon-{n}.png'))
print(len(head + page + bar), REPO)
