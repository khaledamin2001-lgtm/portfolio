"""Build the live site's index.html from the desk page + lock layer. Usage: python3 build_site.py <site repo dir>"""
import re, json, sys, os, shutil, hashlib
REPO = sys.argv[1] if len(sys.argv) > 1 else 'repo'
# "engine": the portfolio's private data repository; the site can edit a portfolio that has one (lock.js "editing from the site")
# "engineDir": the folder of that repository holding this portfolio's data; "workflows": its own jobs (a kind left out has no button)
PORTFOLIOS = [{"id": "khaled", "name": "Khaled's Portfolio", "engine": "khaledamin2001-lgtm/portfolio-engine"},
              {"id": "yassin", "name": "Yassin's Portfolio", "engine": "khaledamin2001-lgtm/portfolio-engine", "engineDir": "yassin",
               "workflows": {"market": "yassin-market.yml"}}]
page = open('../portfolio-desk.html').read()
page = re.sub(r'<title>.*?</title>\s*', '', page, count=1)
m = re.search(r'<meta name="pd-build" content="([^"]+)">', page)   # written by ../build.py: '<12 hex> <UTC date time>'
assert m, 'page layout changed: pd-build meta not found'
BUILD = m.group(1)
assert page.count('readOnly:false,') == 1, 'page layout changed: readOnly flag not found'
# view-only unless this device has editing turned on for the open portfolio (lock.js pdCanEdit); the page re-renders on change
page = page.replace('readOnly:false,', 'get readOnly(){ return !(window.pdCanEdit && window.pdCanEdit()); }, set readOnly(v){},')
# the Claude page's wording for a view-only reader, as it applies on the site
for a, b in [("toast('The watchlist is edited on the Claude page.','error')", "toast('Turn on editing at the bottom of the page to change the watchlist.','error')"),
             ("toast('Retrying is only possible on the Claude page.','error')", "toast('Turn on editing at the bottom of the page to retry held emails.','error')"),
             ("as recorded on the Claude page.", "as recorded.")]:
    assert page.count(a) == 1, 'page layout changed: ' + a
    page = page.replace(a, b)
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
# Content-Security-Policy: the page loads only itself (fonts included) and talks only to the TradingView scanner and, when editing
# is on, the GitHub API (pdf.js is never loaded on the site: it is only fetched by the Claude page's statement reader). Inline
# scripts/styles are the whole app, hence 'unsafe-inline'.
CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
       "font-src 'self'; connect-src 'self' https://scanner.tradingview.com https://api.github.com; img-src 'self' data: blob:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'")
css, js = open('lock.css').read(), open('store.js').read() + '\n' + open('lock.js').read()
head = '''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="''' + CSP + '''">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#F3F6F4" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0D1311" media="(prefers-color-scheme: dark)">
<meta name="application-name" content="Portfolio Desk"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Portfolio"><meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="manifest.webmanifest"><link rel="apple-touch-icon" sizes="180x180" href="icon-180.png"><link rel="icon" type="image/png" sizes="192x192" href="icon-192.png">
<title>Stock Market Portfolio Tracker</title>
<style>''' + face + ''':root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#F3F6F4}img{max-width:100%}[hidden]{display:none!important}
''' + css + '''
[data-testid=scan-gmail],[data-testid=factsheet-email],[data-testid=post-statement]{display:none!important}
body:not(.pd-edit) :is([data-testid=csv-import],[data-testid=csv-import-input],[data-testid=save-marks],[data-testid=save-assets],[data-testid=save-settings]){display:none!important}
</style></head><body class="pd-locked">
<div id="lock" role="dialog" aria-modal="true" aria-label="Unlock portfolio"></div>
<div id="pd-offline" data-testid="offline-banner" role="status" hidden></div>
<script>''' + js + '</script>\n'
bar = '''<div id="pd-bar" data-testid="live-bar"><span><strong id="pd-who"></strong> · <span id="pd-updated">Loading…</span></span><span><span id="pd-prices" data-testid="live-prices-status">Prices from the last daily update</span> · <span id="pd-edit-state" data-testid="edit-state">View only</span></span><span class="pd-actions"><button type="button" id="pd-edit-on" hidden onclick="pdEditOn()" data-testid="edit-on">Turn on editing</button><button type="button" id="pd-run-market" hidden onclick="pdRunJob('market', this)" data-testid="run-market">Update prices</button><button type="button" id="pd-run-sync" hidden onclick="pdRunJob('sync', this)" data-testid="run-sync">Check inbox</button><button type="button" id="pd-edit-menu" hidden onclick="pdEditMenu()" data-testid="edit-menu">Editing</button><button type="button" id="pd-install" hidden onclick="pdInstall()" data-testid="install-app">Install app</button><button type="button" id="pd-switch" hidden onclick="pdSwitch()" data-testid="live-switch-bar">Switch portfolio</button><button type="button" onclick="pdLock()" data-testid="live-lock">Lock</button></span></div>
</body></html>'''
open(os.path.join(REPO, 'index.html'), 'w').write(head + page + bar)
json.dump(PORTFOLIOS, open(os.path.join(REPO, 'portfolios.json'), 'w'))
# ---- installable app (PWA): manifest, icons (drawn by pwa/make_icons.py), service worker (pwa/sw.js, stamped per build) ----
ICONS = ['icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png']
for f in ICONS: shutil.copyfile(os.path.join('pwa', f), os.path.join(REPO, f))
MANIFEST = {"id": "./", "name": "Portfolio Desk", "short_name": "Portfolio", "description": "Encrypted stock portfolio tracker", "lang": "en",
            "start_url": "./", "scope": "./", "display": "standalone", "background_color": "#F3F6F4", "theme_color": "#F3F6F4",
            "icons": [{"src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
                      {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
                      {"src": "icon-maskable-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable"},
                      {"src": "icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}]}
json.dump(MANIFEST, open(os.path.join(REPO, 'manifest.webmanifest'), 'w'), indent=1)
STATIC = ['manifest.webmanifest'] + ICONS + ['fonts/' + f for f in sorted({x['file'] for x in FONTS})]
sw = open('pwa/sw.js').read()
h = hashlib.sha256((head + page + bar + sw + json.dumps(MANIFEST)).encode())
for f in STATIC: h.update(open(os.path.join(REPO, f), 'rb').read())
for k, v in (('__PD_BUILD__', BUILD), ('__PD_SITE__', h.hexdigest()[:10]), ('__PD_STATIC__', json.dumps(STATIC))):
    assert sw.count(k) == 1 and "'" not in v, k
    sw = sw.replace(k, v)
open(os.path.join(REPO, 'sw.js'), 'w').write(sw)
print(len(head + page + bar), REPO, 'sw', BUILD, h.hexdigest()[:10])
