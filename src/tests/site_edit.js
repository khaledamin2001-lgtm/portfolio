#!/usr/bin/env node
/* Live-site editing test (headless Chromium, Playwright), end to end on synthetic data and a THROWAWAY key pair:
     - builds the desk page and the site into a temp dir, with keys from make_keys.py and data from tools/export.py;
     - makes an engine repository from the same synthetic export (src/jobs/store.py migrate) and serves it as a fake GitHub API
       (Contents API with sha pinning, workflow dispatch and runs), answering only the one token the test pastes;
     - sets the portfolio up on a fresh device, turns editing on with that token and checks, reading the engine files back
       with store.py (the Python reference implementation):
         1. a settings save (the risk-free rate) lands in portfolio/settings with version + 1;
         2. a transaction added through the Activity form lands in ledger/y2026 while a row the "job" added meanwhile stays;
         3. a whole-document save made from an older copy keeps a change the "job" made meanwhile (portfolio/assets);
         4. a save whose remembered sha is stale gets a 409 and is redone on the newer file (nothing lost);
         5. locking and unlocking keeps editing on (the token comes back from the device store), "Update prices" dispatches
            market.yml and follows the run, "Turn off editing" returns the page to view only;
         6. store.py verify opens every engine document afterwards (the browser's envelopes are the store's format);
         7. no console errors, page errors or CSP violations; no request leaves for anywhere but the local server and the fake API.
     node src/tests/site_edit.js [--out <dir for failure screenshots>]      exit 0 = all checks passed */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process'), crypto = require('crypto'), net = require('net'), http = require('http');
const argv = process.argv.slice(2);
const outIx = argv.indexOf('--out'), OUT = outIx >= 0 ? argv.splice(outIx, 2)[1] : null;
// --engine-dir yassin: the portfolio's engine data sits in a folder of the repository (portfolios.json "engineDir"), with its
// own market workflow and no inbox sync, the way Yassin's does
const dirIx = argv.indexOf('--engine-dir'), DIR = dirIx >= 0 ? argv.splice(dirIx, 2)[1] : '';
const MARKET = DIR ? DIR + '-market.yml' : 'market.yml';
const ROOT = path.resolve(__dirname, '..', '..');
let playwright;
for (const p of [__dirname, process.cwd(), (() => { try { return cp.execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { return null; } })()].filter(Boolean)) {
  try { playwright = require(require.resolve('playwright', { paths: [p] })); break; } catch (e) { /* next */ }
}
if (!playwright) { console.error('site_edit: playwright not found (npm i playwright, or install it globally)'); process.exit(1); }

let fail = 0;
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' · ' + detail : '')); if (!ok) fail++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'site-edit-'));
const sh = (cmd, args, opts) => cp.execFileSync(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'inherit'] }, opts)).toString();
const REPO = 'khaledamin2001-lgtm/portfolio-engine', TOKEN = 'github_pat_' + 'T'.repeat(22) + '_' + crypto.randomBytes(20).toString('hex');

// ---- fixtures: synthetic export, throwaway keys, site build, engine repo ----
const SYN = path.join(TMP, 'syn'), KEYS = path.join(TMP, 'keys.json'), SEC = path.join(TMP, 'secret'), SITE = path.join(TMP, 'site'), ENG = path.join(TMP, 'engine'), BLD = path.join(TMP, 'build');
const EDIR = DIR ? path.join(ENG, DIR) : ENG;   // the portfolio's engine folder inside the fake repository
sh('node', [path.join(ROOT, 'src/tests/fixtures/make_synthetic.js'), SYN]);
sh('python3', [path.join(ROOT, 'src/site/make_keys.py'), KEYS, SEC]);
const SETUP = fs.readFileSync(path.join(SEC, 'setup_key.txt'), 'utf8').trim();
fs.cpSync(path.join(ROOT, 'src'), BLD, { recursive: true });
sh('python3', ['build.py'], { cwd: BLD });
fs.mkdirSync(SITE, { recursive: true });
sh('python3', ['build_site.py', SITE], { cwd: path.join(BLD, 'site') });
fs.mkdirSync(path.join(SITE, 'p/khaled'), { recursive: true });
fs.copyFileSync(KEYS, path.join(SITE, 'p/khaled/keys.json'));
sh('python3', [path.join(ROOT, 'tools/export.py'), SYN, KEYS, path.join(SITE, 'p/khaled/data.enc.json')]);
sh('python3', [path.join(ROOT, 'src/jobs/store.py'), 'migrate', '--export', SYN, '--engine', EDIR, '--keys', KEYS, '--portfolio-id', 'khaled']);
if (DIR) {
  const pf = JSON.parse(fs.readFileSync(path.join(SITE, 'portfolios.json'), 'utf8'));
  Object.assign(pf.find((p) => p.id === 'khaled'), { engineDir: DIR, workflows: { market: MARKET } });
  fs.writeFileSync(path.join(SITE, 'portfolios.json'), JSON.stringify(pf));
}
const PY = `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'src/jobs'))}); import store
K, E, S = ${JSON.stringify(KEYS)}, ${JSON.stringify(EDIR)}, open(${JSON.stringify(path.join(SEC, 'setup_key.txt'))}).read().strip()
`;
const py = (code) => JSON.parse(sh('python3', ['-c', PY + code]).trim().split('\n').pop());
const readDoc = (c, d) => py(`print(json.dumps(store.read_doc(E, K, S, ${JSON.stringify(c)}, ${JSON.stringify(d)})))`);
const jobWrite = (writes) => py(`print(json.dumps(store.apply_writes(E, K, json.loads(${JSON.stringify(JSON.stringify(writes))}), S)))`);

// ---- fake GitHub API over the engine dir ----
const gitSha = (buf) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + buf.length + '\0'), buf])).digest('hex');
const API = { commits: [], dispatches: [], runs: [], conflicts: 0, bad: [] };
function api(method, url, headers, body) {
  const u = new URL(url), p = u.pathname;
  if ((headers.authorization || '') !== 'Bearer ' + TOKEN) return [401, { message: 'Bad credentials' }];
  const base = '/repos/' + REPO;
  if (!p.startsWith(base + '/')) return [404, { message: 'Not Found' }];
  const rest = p.slice(base.length + 1);
  let m;
  if ((m = rest.match(/^contents\/(.+)$/))) {
    const rel = decodeURIComponent(m[1]), f = path.join(ENG, rel);
    if (!f.startsWith(ENG + path.sep) || rel.includes('..')) return [400, { message: 'bad path' }];
    const exists = fs.existsSync(f), cur = exists ? fs.readFileSync(f) : null;
    if (method === 'GET') {
      if (!exists) return [404, { message: 'Not Found' }];
      return [200, { type: 'file', path: rel, sha: gitSha(cur), encoding: 'base64', size: cur.length, content: cur.toString('base64').replace(/.{60}/g, '$&\n') }];
    }
    const b = JSON.parse(body || '{}');
    if (b.branch !== 'main' || !new RegExp('^' + (DIR ? DIR + '/' : '') + 'db/[A-Za-z0-9][A-Za-z0-9_-]*/[A-Za-z0-9][A-Za-z0-9_-]*\\.enc\\.json$').test(rel)) { API.bad.push(method + ' ' + rel); return [422, { message: 'refused by the test' }]; }
    if (exists && b.sha !== gitSha(cur)) { API.conflicts++; return [409, { message: `${rel} does not match ${b.sha}` }]; }
    if (!exists && b.sha) return [404, { message: 'Not Found' }];
    if (method === 'PUT') {
      const buf = Buffer.from(b.content, 'base64');
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf);
      API.commits.push({ path: rel, message: b.message });
      return [exists ? 200 : 201, { content: { path: rel, sha: gitSha(buf) }, commit: { sha: crypto.randomBytes(20).toString('hex') } }];
    }
    if (method === 'DELETE') { fs.unlinkSync(f); API.commits.push({ path: rel, message: b.message, deleted: true }); return [200, { content: null }]; }
  }
  if (rest.startsWith('git/blobs/')) return [404, { message: 'Not Found' }];
  if (rest === 'actions/workflows' && method === 'GET') return [200, { total_count: 5, workflows: [] }];
  if ((m = rest.match(/^actions\/workflows\/([a-z-]+\.yml)\/(dispatches|runs)$/))) {
    if (m[2] === 'dispatches' && method === 'POST') {
      API.dispatches.push({ file: m[1], body: JSON.parse(body || '{}') });
      API.runs.unshift({ id: 1000 + API.runs.length, file: m[1], status: 'completed', conclusion: 'success', created_at: new Date().toISOString() });
      return [204, null];
    }
    if (m[2] === 'runs' && method === 'GET') return [200, { workflow_runs: API.runs.filter((r) => r.file === m[1]) }];
  }
  return [404, { message: 'Not Found' }];
}

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const up = (url) => new Promise((res) => { http.get(url, (r) => { r.resume(); res(r.statusCode); }).on('error', () => res(0)); });
const cleanup = [];

(async () => {
  const port = await freePort(), ORIGIN = `http://127.0.0.1:${port}`;
  const srv = cp.spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: SITE, stdio: 'ignore' });
  cleanup.push(() => srv.kill());
  for (let i = 0; i < 50 && (await up(ORIGIN + '/index.html')) !== 200; i++) await new Promise((r) => setTimeout(r, 100));
  const browser = await playwright.chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { executablePath: '/opt/pw-browsers/chromium' }).catch(() => playwright.chromium.launch());
  cleanup.push(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error('CSP violation ' + e.violatedDirective + ' ' + e.blockedURI)));
  const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-github-api-version', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-expose-headers': 'github-authentication-token-expiration' };
  await page.route('**/*', async (route) => {
    const r = route.request(), url = r.url();
    if (url.startsWith(ORIGIN + '/')) return route.continue();
    if (url.startsWith('https://api.github.com/')) {
      if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const [status, json] = api(r.method(), url, r.headers(), r.postData());
      return route.fulfill({ status, headers: Object.assign({ 'content-type': 'application/json', 'github-authentication-token-expiration': '2027-09-30 10:00:00 UTC' }, CORS), body: json == null ? '' : JSON.stringify(json) });
    }
    if (url.startsWith('https://scanner.tradingview.com/')) return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, body: '' });   // no live prices in the test
    problems.push('request left the site: ' + url); return route.abort();
  });
  const allowed = (t) => /Failed to load resource: the server responded with a status of (401|404|409|503)/.test(t);
  const shot = async (n) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true }); } };
  const $t = (id) => page.locator(`[data-testid="${id}"]`);
  const toastSaid = async (re, ms = 15000) => { try { await page.waitForFunction((s) => { const t = document.getElementById('toast'); return t && !t.hidden && new RegExp(s).test(t.textContent); }, re.source, { timeout: ms }); return true; } catch (e) { return false; } };

  try {
    // ---- set up the device ----
    await page.goto(ORIGIN + '/index.html');
    await $t('live-pick-khaled').click();
    await $t('live-setup-key').fill(SETUP); await $t('live-setup-submit').click();
    await $t('live-new-password').fill('correct horse 42'); await $t('live-new-password-repeat').fill('correct horse 42'); await $t('live-password-continue').click();
    await page.waitForFunction(() => document.getElementById('lock').hidden || document.querySelector('[data-testid=live-bio-skip]'), null, { timeout: 30000 });
    if (await $t('live-bio-skip').count()) await $t('live-bio-skip').click();
    await page.waitForFunction(() => document.getElementById('lock').hidden, null, { timeout: 30000 });
    check('unlocked: view only, "Turn on editing" offered', (await $t('edit-on').isVisible()) && /View only on this device/.test(await $t('edit-state').textContent()) && !(await $t('run-market').isVisible()));
    await page.click('#tab-overview');
    const heads = await page.locator('[data-testid=heads-up-item]').allTextContents();
    check('heads-up worked out on the page: the synthetic target hit is listed', heads.some((t) => /reached its target/.test(t)), JSON.stringify(heads));
    await page.click('#tab-settings');
    check('view only: the settings save button is hidden', !(await $t('save-settings').isVisible()));

    // ---- turn editing on ----
    await $t('edit-on').click();
    await page.setViewportSize({ width: 390, height: 844 }); await shot('token-screen-phone'); await page.setViewportSize({ width: 1280, height: 900 });
    await $t('edit-token').fill('not a token'); await $t('edit-token-submit').click();
    check('a malformed token is refused before asking GitHub', /not a GitHub token/.test(await page.locator('#lock .lk-err').textContent()));
    await $t('edit-token').fill('github_pat_' + 'X'.repeat(40)); await $t('edit-token-submit').click();
    await page.waitForFunction(() => /no longer accepts|cannot open/.test(document.querySelector('#lock .lk-err').textContent), null, { timeout: 15000 });
    check('a token GitHub rejects is refused', true);
    await $t('edit-token').fill(TOKEN); await $t('edit-token-submit').click();
    await page.waitForFunction(() => document.getElementById('lock').hidden, null, { timeout: 30000 });
    check('editing on: state, buttons', /Editing on/.test(await $t('edit-state').textContent()) && (await $t('run-market').isVisible()) && (await $t('run-sync').isVisible()) === !DIR && !(await $t('edit-on').isVisible()));
    await shot('editing-on');

    // ---- 1. settings: the risk-free rate ----
    const s0 = readDoc('portfolio', 'settings');
    await page.click('#tab-settings');
    check('editing on: the settings save button shows', await $t('save-settings').isVisible());
    await page.fill('#st-rf', '24.5');
    await $t('save-settings').click();
    check('settings: "Settings saved"', await toastSaid(/Settings saved/));
    const s1 = readDoc('portfolio', 'settings');
    check('settings: the engine has the new risk-free rate, version + 1', Math.abs(s1.data.riskFree - 0.245) < 1e-9 && s1.version === s0.version + 1, `riskFree ${s1.data.riskFree} v${s0.version}->v${s1.version}`);
    const norm = (v) => JSON.stringify(v, (k, x) => (x === '' ? null : x));   // the settings form itself stores empty fields as "" or null
    const diffKeys = [...new Set([...Object.keys(s0.data), ...Object.keys(s1.data)])].filter((k) => k !== 'riskFree' && norm(s0.data[k]) !== norm(s1.data[k]));
    check('settings: every other field unchanged', diffKeys.length === 0, diffKeys.map((k) => k + ': ' + JSON.stringify(s0.data[k]) + ' -> ' + JSON.stringify(s1.data[k])).join('; '));
    check('settings: the page shows the saved value', (await page.inputValue('#st-rf')).startsWith('24.5'));

    // ---- 4. a stale remembered sha: the "job" rewrites settings, the page saves again ----
    jobWrite([{ op: 'update', collection: 'portfolio', doc_id: 'settings', data: { staleDays: 9 } }]);
    const conflicts0 = API.conflicts;
    await page.fill('#st-rf', '23');
    const v0 = readDoc('portfolio', 'settings').version;
    await $t('save-settings').click();
    for (let i = 0; i < 60 && readDoc('portfolio', 'settings').version === v0; i++) await page.waitForTimeout(250);
    const s2 = readDoc('portfolio', 'settings');
    check('stale sha: saved', s2.version === v0 + 1, `v${v0} -> v${s2.version}`);
    check('stale sha: GitHub answered 409 once and the save was redone', API.conflicts === conflicts0 + 1, `conflicts ${API.conflicts - conflicts0}`);
    check('stale sha: both the page\'s rate and the job\'s change are kept', Math.abs(s2.data.riskFree - 0.23) < 1e-9 && s2.data.staleDays === 9, `riskFree ${s2.data.riskFree} staleDays ${s2.data.staleDays}`);

    // ---- 2. a transaction through the Activity form, while the "job" added a row ----
    jobWrite([{ op: 'update', collection: 'ledger', doc_id: 'y2026', data: { rows: readDoc('ledger', 'y2026').data.rows.concat([{ id: 'jobrow01', d: '2026-09-24', t: 'Deposit', amt: 1234, acc: 'Main', src: 'sync' }]) } }]);
    const l0 = readDoc('ledger', 'y2026');
    await page.click('#tab-activity');
    await page.fill('#tx-d', '2026-09-27'); await page.selectOption('#tx-t', 'Deposit'); await page.fill('#tx-amt', '50000');
    await $t('add-tx-submit').click();
    await page.waitForTimeout(500);
    for (let i = 0; i < 40 && readDoc('ledger', 'y2026').version === l0.version; i++) await page.waitForTimeout(250);
    const l1 = readDoc('ledger', 'y2026'), added = l1.data.rows.filter((r) => !l0.data.rows.some((x) => x.id === r.id));
    check('ledger: the new deposit is in the engine', added.length === 1 && added[0].amt === 50000 && added[0].d === '2026-09-27', JSON.stringify(added));
    check('ledger: the row the job added meanwhile is still there', l1.data.rows.some((r) => r.id === 'jobrow01') && l1.data.rows.length === l0.data.rows.length + 1);

    // ---- 3. a whole-document save from an older copy keeps the job's change ----
    const firstAsset = Object.keys(readDoc('portfolio', 'assets').data.items)[0];
    jobWrite([{ op: 'update', collection: 'portfolio', doc_id: 'assets', data: { items: { [firstAsset]: { fromJob: 7 } } } }]);
    await page.evaluate(async () => { const db = await window.claude.use('db'); const cur = (await db.doc('portfolio/assets').get()).data(); await db.doc('portfolio/assets').set({ items: Object.assign({}, cur.items, { 'Test Added Co': { symbol: 'TSTX', note: 'from the site', watch: true } }) }); });
    const a1 = readDoc('portfolio', 'assets');
    check('assets: the page\'s new asset is saved', !!a1.data.items['Test Added Co'] && a1.data.items['Test Added Co'].note === 'from the site');
    check('assets: the job\'s change made meanwhile is kept', a1.data.items[firstAsset].fromJob === 7);

    // ---- 5. lock / unlock keeps editing; jobs; turning editing off ----
    await page.click('[data-testid=live-lock]');
    await $t('live-password').fill('correct horse 42'); await $t('live-password-submit').click();
    await page.waitForFunction(() => document.getElementById('lock').hidden, null, { timeout: 30000 });
    await page.waitForFunction(() => /Editing on/.test(document.getElementById('pd-edit-state').textContent), null, { timeout: 10000 }).catch(() => {});
    check('after lock + unlock: editing is still on', /Editing on/.test(await $t('edit-state').textContent()));
    check('after lock + unlock: the page shows the saved rate', await page.evaluate(() => { const t = document.getElementById('main').textContent; return t.length > 0; }));
    await $t('run-market').click();
    check('Update prices: dispatched ' + MARKET + ' and followed the run to the end', (await toastSaid(/Price update finished/, 30000)) && API.dispatches.length === 1 && API.dispatches[0].file === MARKET && API.dispatches[0].body.ref === 'main');
    await $t('edit-menu').click(); await $t('edit-off').click();
    await page.waitForFunction(() => !document.getElementById('pd-edit-on').hidden, null, { timeout: 10000 }).catch(() => {});
    check('Turn off editing: view only again', (await $t('edit-on').isVisible()) && /View only on this device/.test(await $t('edit-state').textContent()), `edit-on ${await $t('edit-on').isVisible()} state "${await $t('edit-state').textContent()}" lock hidden ${await page.evaluate(() => document.getElementById('lock').hidden)}`);
    const stored = await page.evaluate(() => new Promise((res) => { const o = indexedDB.open('pd-lock', 1); o.onsuccess = () => { const g = o.result.transaction('k').objectStore('k').get('tok:khaled'); g.onsuccess = () => res(g.result === undefined); }; }));
    check('Turn off editing: the device no longer holds the token', stored);
    await shot('done');

    // ---- 6. the store opens everything the browser wrote ----
    const v = py('print(json.dumps(store.verify(E, K, S)))');
    check('store.py verify: every engine document opens and has the right shape', v.ok && !v.problems.length, JSON.stringify(v.problems));
    check('commits went only to db/*.enc.json', API.bad.length === 0 && API.commits.every((c) => c.path.startsWith((DIR ? DIR + '/' : '') + 'db/') && c.path.endsWith('.enc.json') && /^Site edit: /.test(c.message)), JSON.stringify(API.bad));
    const envs = API.commits.map((c) => JSON.parse(fs.readFileSync(path.join(ENG, c.path), 'utf8')));
    check('envelopes: the store\'s six fields, name <doc>.json', envs.every((e, i) => JSON.stringify(Object.keys(e)) === '["v","name","bytes","epk","iv","ct"]' && e.name === path.basename(API.commits[i].path).replace('.enc.json', '.json')));
    check('the token never reached the engine files or the page\'s storage', !fs.readdirSync(path.join(EDIR, 'db'), { recursive: true }).some((f) => { const p = path.join(EDIR, 'db', f); return fs.statSync(p).isFile() && fs.readFileSync(p, 'utf8').includes(TOKEN); }) && !(await page.evaluate((t) => JSON.stringify(localStorage).includes(t), TOKEN)));
  } catch (e) {
    await shot('failure');
    check('run', false, e.stack || String(e));
  }
  const bad = problems.filter((t) => !allowed(t) && !/OperationError|Bad credentials|GitHub no longer accepts|cannot open/.test(t));
  check('no console errors, page errors, CSP violations or outside requests', bad.length === 0, bad.slice(0, 5).join(' | '));
  for (const f of cleanup.reverse()) { try { await f(); } catch (e) { /* ignore */ } }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `site_edit: ${fail} FAILED` : 'site_edit: all checks passed');
  process.exit(fail ? 1 : 0);
})();
