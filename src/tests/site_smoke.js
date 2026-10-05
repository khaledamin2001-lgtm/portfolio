#!/usr/bin/env node
/* Live-site smoke test (headless Chromium, Playwright). Serves the repository root with `python3 -m http.server`, opens
   index.html on a fresh device (empty storage) at a desktop and a phone size, and checks, without unlocking anything:
     1. the lock layer offers "Create your portfolio" / "Sign in" and nothing else (every portfolio lives in an account:
        no setup-key list), the app behind it stays hidden (body.pd-locked), the title, no sideways scroll;
     2. (phone) a device that still holds an old setup-key portfolio's leftovers (pd.current = khaled, pd.dev.khaled) gets the
        same first screen, and the leftovers are removed;
     3. no console errors, page errors, CSP violations (securitypolicyviolation events), failed or >= 400 same-origin
        requests, and no request leaves the local server (anything else is blocked and reported).
     node src/tests/site_smoke.js [repo dir] [--out <dir for failure screenshots>]
   Playwright is taken from ./node_modules, the working directory's node_modules or the global npm root; the browser
   from PLAYWRIGHT_BROWSERS_PATH (CI: `npx playwright install --with-deps chromium`). Exit 0 = all checks passed. */
'use strict';
const path = require('path'), fs = require('fs'), cp = require('child_process'), http = require('http'), net = require('net');
const argv = process.argv.slice(2);
const outIx = argv.indexOf('--out'), OUT = outIx >= 0 ? argv.splice(outIx, 2)[1] : null;
const ROOT = path.resolve(argv[0] || path.join(__dirname, '..', '..'));
let playwright;
for (const p of [__dirname, process.cwd(), (() => { try { return cp.execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { return null; } })()].filter(Boolean)) {
  try { playwright = require(require.resolve('playwright', { paths: [p] })); break; } catch (e) { /* next */ }
}
if (!playwright) { console.error('site_smoke: playwright not found (npm i playwright, or install it globally)'); process.exit(1); }

let fail = 0;
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' · ' + detail : '')); if (!ok) fail++; };
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const up = (url) => new Promise((res) => { http.get(url, (r) => { r.resume(); res(r.statusCode); }).on('error', () => res(0)); });

(async () => {
  const port = await freePort(), base = `http://127.0.0.1:${port}/`;
  const server = cp.spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
  const stop = () => { try { server.kill(); } catch (e) { /* gone */ } };
  process.on('exit', stop);
  for (let i = 0; i < 50 && !(await up(base + 'index.html')); i++) await new Promise((r) => setTimeout(r, 100));
  const browser = await playwright.chromium.launch();
  try {
    for (const vp of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true, legacy: true }]) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, serviceWorkers: 'block' });
      const page = await ctx.newPage();
      const errors = [], external = [], bad = [];
      let phase = 'load';
      await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
      if (vp.legacy) await page.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('pd.current', '"khaled"'); localStorage.setItem('pd.dev.khaled', '{"v":3,"tries":0}'); } });
      page.on('console', (m) => { if (m.type() === 'error') errors.push({ phase, text: m.text() }); });
      page.on('pageerror', (e) => errors.push({ phase, text: 'pageerror: ' + e.message }));
      page.on('requestfailed', (r) => { if (r.url().startsWith(base)) bad.push(`${r.url()} ${r.failure() && r.failure().errorText}`); });
      page.on('response', (r) => { if (r.url().startsWith(base) && r.status() >= 400) bad.push(`${r.url()} HTTP ${r.status()}`); });
      await page.route('**/*', (route) => { const u = route.request().url(); if (u.startsWith(base) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue(); external.push(u); return route.abort(); });
      await page.goto(base + 'index.html', { waitUntil: 'load' });
      const V = `[${vp.name}]`;
      // 1. the first screen
      await page.locator('[data-testid="live-signup"]').waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
      check(`${V} a fresh device is offered to create a portfolio or sign in`, (await page.locator('[data-testid="live-signup"]').isVisible()) && (await page.locator('[data-testid="live-signin"]').isVisible()));
      check(`${V} no setup-key portfolios are offered (every portfolio lives in an account)`, !(await page.locator('[data-testid="live-setup-key-list"]').count()) && !(await page.locator('[data-testid^="live-pick-"]').count()));
      const locked = await page.evaluate(() => document.body.classList.contains('pd-locked') && !document.getElementById('lock').hidden);
      check(`${V} the app stays behind the lock (body.pd-locked, #lock shown)`, locked);
      const title = await page.title();
      check(`${V} page title`, title === 'Stock Market Portfolio Tracker', title);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${V} lock screen has no horizontal scroll`, overflow <= 1, `${overflow}px`);
      // 2. an old setup-key portfolio's leftovers
      if (vp.legacy) check(`${V} an old setup-key portfolio's leftovers on the device are removed`, await page.evaluate(() => localStorage.getItem('pd.dev.khaled') === null));
      // 3. errors, CSP, requests
      const csp = await page.evaluate(() => window.__csp);
      const unexpected = errors;
      check(`${V} no console or page errors`, unexpected.length === 0, unexpected.map((e) => `[${e.phase}] ${e.text}`).join(' | ').slice(0, 600));
      check(`${V} no Content-Security-Policy violations`, csp.length === 0 && !errors.some((e) => /Content Security Policy/i.test(e.text)), csp.join(' | ').slice(0, 600));
      check(`${V} every same-origin request succeeded`, bad.length === 0, bad.join(' | ').slice(0, 600));
      check(`${V} no request left the site before unlocking`, external.length === 0, external.join(' | ').slice(0, 600));
      if (fail && OUT) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, `site-${vp.name}.png`), fullPage: true }); }
      await ctx.close();
    }
  } finally { await browser.close(); stop(); }
  console.log(fail ? `FAIL ${fail}` : 'ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
