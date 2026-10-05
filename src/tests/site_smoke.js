#!/usr/bin/env node
/* Live-site smoke test (headless Chromium, Playwright). Serves the repository root with `python3 -m http.server`, opens
   index.html on a fresh device (empty storage) at a desktop and a phone size, and checks, without unlocking anything:
     1. the lock layer offers "Create your portfolio" / "Sign in" and, behind "Open a portfolio with a setup key", one
        live-pick-<id> button per entry of portfolios.json, the app behind
        it stays hidden (body.pd-locked);
     2. picking the first portfolio loads its keys.json and shows the setup-key screen (live-setup-key);
     3. a deliberately wrong setup key is refused with "not right" (PBKDF2 + AES-GCM ran on keys.json and failed as they
        must) - the lock's own console.error of that OperationError is the one console error allowed, and only in this step;
     4. no console errors, page errors, CSP violations (securitypolicyviolation events), failed or >= 400 same-origin
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
  for (let i = 0; i < 50 && !(await up(base + 'portfolios.json')); i++) await new Promise((r) => setTimeout(r, 100));
  const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'portfolios.json'))), portfolios = all.filter((p) => !p.moved), moved = all.filter((p) => p.moved);   // moved: lives in its owner's account
  const browser = await playwright.chromium.launch();
  try {
    for (const vp of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true }]) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, serviceWorkers: 'block' });
      const page = await ctx.newPage();
      const errors = [], external = [], bad = [];
      let phase = 'load';
      await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
      page.on('console', (m) => { if (m.type() === 'error') errors.push({ phase, text: m.text() }); });
      page.on('pageerror', (e) => errors.push({ phase, text: 'pageerror: ' + e.message }));
      page.on('requestfailed', (r) => { if (r.url().startsWith(base)) bad.push(`${r.url()} ${r.failure() && r.failure().errorText}`); });
      page.on('response', (r) => { if (r.url().startsWith(base) && r.status() >= 400) bad.push(`${r.url()} HTTP ${r.status()}`); });
      await page.route('**/*', (route) => { const u = route.request().url(); if (u.startsWith(base) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue(); external.push(u); return route.abort(); });
      const t0 = Date.now();
      await page.goto(base + 'index.html', { waitUntil: 'load' });
      const V = `[${vp.name}]`;
      // 1. picker
      // a fresh device sees "Create your portfolio" / "Sign in" first; the site's own portfolios sit behind "Open a portfolio with a setup key"
      await page.locator('[data-testid="live-signup"]').waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
      check(`${V} a fresh device is offered to create a portfolio or sign in`, (await page.locator('[data-testid="live-signup"]').isVisible()) && (await page.locator('[data-testid="live-signin"]').isVisible()));
      const locked = await page.evaluate(() => document.body.classList.contains('pd-locked') && !document.getElementById('lock').hidden);
      check(`${V} the app stays behind the lock (body.pd-locked, #lock shown)`, locked);
      const title = await page.title();
      check(`${V} page title`, title === 'Stock Market Portfolio Tracker', title);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${V} lock screen has no horizontal scroll`, overflow <= 1, `${overflow}px`);
      if (!portfolios.length) {   // every portfolio lives in its owner's account: no setup-key list at all
        check(`${V} no setup-key portfolios are offered (all moved into accounts: ${moved.map((p) => p.id).join(', ')})`, !(await page.locator('[data-testid="live-setup-key-list"]').count()));
      } else {
        await page.locator('[data-testid="live-setup-key-list"]').click().catch(() => {});
        const firstPick = page.locator(`[data-testid="live-pick-${portfolios[0].id}"]`);
        await firstPick.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        const picks = await Promise.all(portfolios.map((p) => page.locator(`[data-testid="live-pick-${p.id}"]`).isVisible()));
        check(`${V} lock screen shows the portfolio picker (${portfolios.map((p) => p.id).join(', ')})`, picks.every(Boolean), `visible: ${picks.join(',')} after ${Date.now() - t0} ms`);
        check(`${V} a portfolio that moved into its owner's account is not offered with a setup key (${moved.map((p) => p.id).join(', ') || 'none'})`, (await Promise.all(moved.map((p) => page.locator(`[data-testid="live-pick-${p.id}"]`).count()))).every((n) => n === 0));
        // 2. setup-key screen
        phase = 'pick';
        if (picks[0]) await firstPick.click();
        const keyInput = page.locator('[data-testid="live-setup-key"]');
        const keyShown = await keyInput.waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false);
        check(`${V} picking ${portfolios[0].id} loads keys.json and asks for the setup key`, keyShown);
        // 3. a wrong setup key is refused
        if (keyShown) {
          phase = 'wrong-key';
          await keyInput.fill('CIXX-TEST-WRNG-KEYX-ABCD');
          await page.locator('[data-testid="live-setup-submit"]').click();
          const msg = await page.locator('#lock .lk-err').filter({ hasText: /not right/ }).first().textContent({ timeout: 20000 }).catch(() => '');
          check(`${V} a wrong setup key is refused`, /not right/.test(msg || ''), (msg || '(no message)').trim());
        }
      }
      // 4. errors, CSP, requests
      const csp = await page.evaluate(() => window.__csp);
      const unexpected = errors.filter((e) => !(e.phase === 'wrong-key' && /OperationError/.test(e.text)));
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
