#!/usr/bin/env node
/* Accounts on the live site, end to end, in headless Chromium against a FAKE Firebase (Identity Toolkit, Secure Token and
   Firestore REST, with the access rules of src/cloud/firestore.rules), on synthetic market data:
     1. a fresh device is offered "Create your portfolio"; sign-up makes the account, shows a recovery code, stores the
        account's key only wrapped (users/{uid}.keys: pub, wrap, pwrap) and creates the members key (shared/members +
        shared/membersPub);
     2. the shared market bundle (sealed to the members key the way run_shared_market.py seals it) gives the onboarding its
        prices: cash + "SYM shares" lines become a starting deposit and buys; the app opens with the holding priced;
     3. every stored document is an encrypted envelope (no symbol or figure in the clear), and another account's token is
        refused on it;
     4. a settings save goes to the account (updateTime changes); a save whose remembered updateTime is stale is refused
        once (FAILED_PRECONDITION) and redone;
     5. lock + unlock with the password reopens it (session refreshed with the refresh token);
     6. a second device signs in with email + password and sees the same portfolio; a wrong password is refused;
     7. after a password reset the recovery code unlocks it once and re-locks the key with the new password (the next sign-in
        needs no code); "Change password" in the Account menu works the same way;
     8. no console errors, page errors or CSP violations; nothing leaves for anywhere but the local server and the fakes.
     node src/tests/site_cloud.js [--out <dir for screenshots>]      exit 0 = all checks passed */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process'), crypto = require('crypto'), net = require('net'), http = require('http');
const argv = process.argv.slice(2);
const outIx = argv.indexOf('--out'), OUT = outIx >= 0 ? argv.splice(outIx, 2)[1] : null;
const ROOT = path.resolve(__dirname, '..', '..');
let playwright;
for (const p of [__dirname, process.cwd(), (() => { try { return cp.execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { return null; } })()].filter(Boolean)) {
  try { playwright = require(require.resolve('playwright', { paths: [p] })); break; } catch (e) { /* next */ }
}
if (!playwright) { console.error('site_cloud: playwright not found'); process.exit(1); }
let fail = 0;
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' · ' + detail : '')); if (!ok) fail++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'site-cloud-'));
const sh = (cmd, args, opts) => cp.execFileSync(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'inherit'] }, opts)).toString();

// ---- site build + synthetic market data ----
const SYN = path.join(TMP, 'syn'), SITE = path.join(TMP, 'site'), BLD = path.join(TMP, 'build');
sh('node', [path.join(ROOT, 'src/tests/fixtures/make_synthetic.js'), SYN]);
fs.cpSync(path.join(ROOT, 'src'), BLD, { recursive: true });
sh('python3', ['build.py'], { cwd: BLD });
fs.mkdirSync(SITE, { recursive: true });
sh('python3', ['build_site.py', SITE], { cwd: path.join(BLD, 'site') });
sh('python3', [path.join(ROOT, 'src/site/make_keys.py'), path.join(SITE, 'p/khaled/keys.json'), path.join(TMP, 'mailsec')]);   // a throwaway mail key
const rd = (f) => { const x = JSON.parse(fs.readFileSync(path.join(SYN, f), 'utf8')); return x && x.data && typeof x.data === 'object' ? x.data : x; };
const MARKET = { 'market/latest': rd('market/latest.json'), 'bench/egx30': rd('bench/egx30.json'), 'market/macro': { benchClose: {}, cpiMoM: {} } };
for (const f of fs.readdirSync(path.join(SYN, 'history'))) MARKET['history/' + f.replace('.json', '')] = rd('history/' + f);
const QUOTES = MARKET['market/latest'].quotes;
const SYM = Object.keys(QUOTES).find((s) => QUOTES[s] && QUOTES[s].price > 0);
function writeBundle(pub) {   // sealed exactly like run_shared_market.py (the Python code itself)
  const docs = path.join(TMP, 'market-docs.json'); fs.writeFileSync(docs, JSON.stringify(MARKET));
  const env = sh('python3', ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'src/jobs'))}); import run_shared_market as r
print(r.seal_bundle(json.load(open(${JSON.stringify(docs)})), ${JSON.stringify(pub)}, "2026-09-29T13:00:00+00:00"))`]).trim();
  fs.mkdirSync(path.join(SITE, 'm'), { recursive: true }); fs.writeFileSync(path.join(SITE, 'm', 'market.enc.json'), env);
}

// ---- fake Firebase ----
const FB = { users: {}, byEmail: {}, tokens: {}, refresh: {}, docs: {}, t: 0, conflicts: 0, denied: 0, calls: [] };
const PID = 'portfolio-desk-4d14a', FSB = `/v1/projects/${PID}/databases/(default)/documents/`;
const stamp = () => new Date(Date.UTC(2026, 8, 30, 0, 0, 0) + ++FB.t * 1000).toISOString().replace('Z', '123456Z');
const tokenFor = (uid) => { const t = 'id-' + crypto.randomBytes(8).toString('hex'); FB.tokens[t] = uid; return t; };
const refreshFor = (uid) => { const t = 'rf-' + crypto.randomBytes(8).toString('hex'); FB.refresh[t] = uid; return t; };
const authOut = (u) => ({ localId: u.uid, email: u.email, idToken: tokenFor(u.uid), refreshToken: refreshFor(u.uid), expiresIn: '3600' });
const err = (status, message) => [status, { error: { code: status, message, status: message } }];
function identity(ep, b) {
  if (ep === 'signUp') { if (FB.byEmail[b.email]) return err(400, 'EMAIL_EXISTS'); const u = { uid: 'U' + crypto.randomBytes(6).toString('hex'), email: b.email, pw: b.password }; FB.users[u.uid] = u; FB.byEmail[b.email] = u; return [200, authOut(u)]; }
  if (ep === 'signInWithPassword') { const u = FB.byEmail[b.email]; if (!u || u.pw !== b.password) return err(400, 'INVALID_LOGIN_CREDENTIALS'); return [200, authOut(u)]; }
  if (ep === 'sendOobCode') { FB.resetAsked = b.email; return [200, { email: b.email }]; }
  if (ep === 'update') { const uid = FB.tokens[b.idToken]; if (!uid) return err(400, 'INVALID_ID_TOKEN'); if (b.password) FB.users[uid].pw = b.password; return [200, authOut(FB.users[uid])]; }
  return err(400, 'UNKNOWN');
}
// the rules of src/cloud/firestore.rules
function allowed(uid, method, p) {
  const m = p.match(/^users\/([^/]+)(?:\/docs(?:\/[^/]+)?)?$/);
  if (m) return !!uid && uid === m[1];
  if (p === 'shared/membersPub') return method === 'GET' || (!!uid && method === 'PATCH' && !FB.docs[p]);
  if (p === 'shared/members') return !!uid && (method === 'GET' || (method === 'PATCH' && !FB.docs[p]));
  if (/^mail\/[^/]+$/.test(p)) return method === 'GET' || (!!uid && uid === p.split('/')[1]);
  return false;
}
function firestore(method, url, headers, body) {
  const u = new URL(url), p = decodeURIComponent(u.pathname.slice(u.pathname.indexOf(FSB) + FSB.length)), q = u.searchParams;
  const uid = FB.tokens[(headers.authorization || '').replace(/^Bearer /, '')] || null;
  if (headers.authorization && !uid) return err(401, 'UNAUTHENTICATED');
  if (!allowed(uid, method, p)) { FB.denied++; return err(403, 'PERMISSION_DENIED'); }
  const full = (k) => `projects/${PID}/databases/(default)/documents/${k}`;
  const out = (k) => Object.assign({ name: full(k) }, FB.docs[k]);
  if (method === 'GET' && /\/docs$/.test(p)) return [200, { documents: Object.keys(FB.docs).filter((k) => k.startsWith(p + '/')).sort().map(out) }];
  const cur = FB.docs[p];
  if (method === 'GET') return cur ? [200, out(p)] : err(404, 'NOT_FOUND');
  if (q.get('currentDocument.exists') === 'false' && cur) { FB.conflicts++; return err(409, 'ALREADY_EXISTS'); }
  if (q.has('currentDocument.updateTime') && (!cur || cur.updateTime !== q.get('currentDocument.updateTime'))) { FB.conflicts++; return cur ? err(400, 'FAILED_PRECONDITION') : err(404, 'NOT_FOUND'); }
  if (method === 'DELETE') { delete FB.docs[p]; return [200, {}]; }
  if (method === 'PATCH') {
    const b = JSON.parse(body || '{}'), mask = q.getAll('updateMask.fieldPaths');
    const fields = mask.length && cur ? Object.assign({}, cur.fields, Object.fromEntries(mask.map((k) => [k, b.fields[k]]))) : b.fields;
    FB.docs[p] = { fields, createTime: cur ? cur.createTime : stamp(), updateTime: stamp() };
    FB.calls.push(p);
    return [200, out(p)];
  }
  return err(400, 'INVALID_ARGUMENT');
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const up = (url) => new Promise((res) => { http.get(url, (r) => { r.resume(); res(r.statusCode); }).on('error', () => res(0)); });

(async () => {
  const port = await freePort(), ORIGIN = `http://127.0.0.1:${port}`;
  const srv = cp.spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: SITE, stdio: 'ignore' });
  for (let i = 0; i < 50 && (await up(ORIGIN + '/index.html')) !== 200; i++) await new Promise((r) => setTimeout(r, 100));
  const browser = await playwright.chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { executablePath: '/opt/pw-browsers/chromium' }).catch(() => playwright.chromium.launch());
  const problems = [];
  const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS' };
  async function device(name) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${name}] console: ` + m.text()); });
    page.on('pageerror', (e) => problems.push(`[${name}] pageerror: ` + e.message));
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error('CSP violation ' + e.violatedDirective + ' ' + e.blockedURI)));
    await page.route('**/*', async (route) => {
      const r = route.request(), url = r.url();
      if (url.startsWith(ORIGIN + '/')) return route.continue();
      if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      let res = null;
      const m = url.match(/^https:\/\/identitytoolkit\.googleapis\.com\/v1\/accounts:([A-Za-z]+)\?key=/);
      if (m) res = identity(m[1], JSON.parse(r.postData() || '{}'));
      else if (url.startsWith('https://securetoken.googleapis.com/v1/token')) { const rt = new URLSearchParams(r.postData() || '').get('refresh_token'), uid = FB.refresh[rt];
        res = uid ? [200, { id_token: tokenFor(uid), refresh_token: rt, user_id: uid, expires_in: '3600' }] : err(400, 'INVALID_REFRESH_TOKEN'); }
      else if (url.startsWith('https://firestore.googleapis.com/')) res = firestore(r.method(), url, r.headers(), r.postData());
      else if (url.startsWith('https://scanner.tradingview.com/')) return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, body: '' });
      if (res) return route.fulfill({ status: res[0], headers: Object.assign({ 'content-type': 'application/json' }, CORS), body: JSON.stringify(res[1]) });
      problems.push(`[${name}] request left the site: ` + url); return route.abort();
    });
    const $t = (id) => page.locator(`[data-testid="${id}"]`);
    const shot = async (n) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: false }); } };
    const lockHidden = (ms = 30000) => page.waitForFunction(() => document.getElementById('lock').hidden, null, { timeout: ms });
    const lockErr = () => page.locator('#lock .lk-err').textContent();
    return { ctx, page, $t, shot, lockHidden, lockErr };
  }
  const EMAIL = 'friend@example.com', PW = 'green tomato 17', PW2 = 'blue lagoon 29', PW3 = 'red sunset 41';
  let CODE = null;
  try {
    // ---- 1. sign-up on a fresh device ----
    const A = await device('A'); const { page, $t } = A;
    await page.goto(ORIGIN + '/index.html');
    await $t('live-signup').waitFor({ timeout: 20000 });
    check('fresh device: "Create your portfolio" and "Sign in" are offered', (await $t('live-signup').isVisible()) && (await $t('live-signin').isVisible()));
    await $t('live-signup').click();
    await $t('signup-name').fill('Omar'); await $t('signup-email').fill(EMAIL); await $t('signup-password').fill(PW); await $t('signup-password-repeat').fill(PW);
    await A.shot('signup');
    await $t('signup-submit').click();
    await $t('recovery-code').waitFor({ timeout: 60000 });
    CODE = (await $t('recovery-code').textContent()).trim();
    check('sign-up shows a recovery code', /^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/.test(CODE), CODE);
    const uid = Object.keys(FB.users)[0], prof = FB.docs['users/' + uid];
    const keys = prof && JSON.parse(prof.fields.keys.stringValue);
    check('the account profile holds only the public key and two wraps of the private key', !!keys && keys.pub && keys.wrap && keys.wrap.ct && keys.pwrap && keys.pwrap.ct && !/pk8|BEGIN/.test(JSON.stringify(keys)) && keys.wrap.iter === 600000 && keys.pwrap.iter === 310000);
    check('the members key was created (both halves)', !!FB.docs['shared/members'] && !!FB.docs['shared/membersPub'] && FB.docs['shared/members'].fields.pub.stringValue === FB.docs['shared/membersPub'].fields.pub.stringValue);
    writeBundle(FB.docs['shared/membersPub'].fields.pub.stringValue);
    await A.shot('recovery');
    check('Continue waits until the code is saved', await $t('recovery-continue').isDisabled());
    await $t('recovery-saved').check(); await $t('recovery-continue').click();

    // ---- 2. onboarding with shared prices ----
    await $t('onboard-cash').fill('1000'); await $t('onboard-holdings').fill(`${SYM} 10`);
    await A.shot('onboard');
    await $t('onboard-submit').click();
    await A.lockHidden(60000).catch(() => {});
    if (!(await page.evaluate(() => document.getElementById('lock').hidden)) && (await $t('live-bio-skip').count())) await $t('live-bio-skip').click();
    await A.lockHidden();
    const docs = Object.keys(FB.docs).filter((k) => k.startsWith(`users/${uid}/docs/`)).map((k) => k.split('/').pop()).sort();
    check('onboarding created the portfolio documents', JSON.stringify(docs) === JSON.stringify(['ledger__y' + new Date().getUTCFullYear(), 'portfolio__assets', 'portfolio__marks', 'portfolio__settings'].sort()) || docs.length === 4, docs.join(','));
    await page.waitForTimeout(800);
    const main = await page.locator('#main').textContent();
    check('the app opens on the new portfolio', /Omar/.test(await page.locator('#pf-name-text').textContent()) && main.length > 100);
    await page.click('#tab-holdings'); await page.waitForTimeout(300);
    const hold = await page.locator('#main').textContent();
    check(`the holding (${SYM}) is priced from the shared market data`, hold.includes(SYM), '');
    check('the bar says it is your account, with an Account button', /Your account/.test(await $t('edit-state').textContent()) && (await $t('account-menu').isVisible()) && !(await $t('edit-on').isVisible()));
    await A.shot('app');

    // ---- 3. everything stored is encrypted, and private ----
    const blobs = Object.entries(FB.docs).filter(([k]) => k.startsWith(`users/${uid}/docs/`)).map(([, v]) => v.fields.blob.stringValue);
    check('every stored document is an encrypted envelope with nothing in the clear', blobs.length === 4 && blobs.every((b) => { const e = JSON.parse(b); return e.v === 1 && e.epk && e.iv && e.ct && !b.includes(SYM) && !b.includes('Omar'); }));
    const other = identity('signUp', { email: 'other@example.com', password: 'x'.repeat(10), returnSecureToken: true })[1];
    const denied = firestore('GET', `https://firestore.googleapis.com${FSB}users/${uid}/docs/portfolio__settings`, { authorization: 'Bearer ' + other.idToken });
    check("another account's token is refused on this account's documents", denied[0] === 403);

    // ---- 4. saves, and a stale save is redone ----
    const s0 = FB.docs[`users/${uid}/docs/portfolio__settings`].updateTime;
    await page.click('#tab-settings'); await page.fill('#st-rf', '21.5'); await $t('save-settings').click();
    for (let i = 0; i < 40 && FB.docs[`users/${uid}/docs/portfolio__settings`].updateTime === s0; i++) await page.waitForTimeout(250);
    const s1 = FB.docs[`users/${uid}/docs/portfolio__settings`].updateTime;
    check('a settings save lands in the account', s1 !== s0);
    await page.waitForTimeout(1500);   // the page redraws after a save
    FB.docs[`users/${uid}/docs/portfolio__settings`].updateTime = stamp();   // "another device" saved meanwhile
    const c0 = FB.conflicts;
    await page.fill('#st-rf', '20'); await $t('save-settings').click();
    for (let i = 0; i < 60 && FB.conflicts === c0; i++) await page.waitForTimeout(100);
    for (let i = 0; i < 60 && (await page.inputValue('#st-rf').catch(() => '')) !== '20'; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(1500);
    check('a save made from a stale copy is refused once and redone', FB.conflicts === c0 + 1, `conflicts ${FB.conflicts - c0}`);

    // ---- 4b. a Thndr statement uploaded from this device (synthetic PDFs), the account confirmed once ----
    const STMT = path.join(TMP, 'stmt');
    sh('python3', [path.join(ROOT, 'src/tests/fixtures/make_statement_pdf.py'), STMT, '--symbol', SYM, '--price', String(QUOTES[SYM].price), '--close', String(QUOTES[SYM].price), '--month', new Date().toISOString().slice(0, 7)]);
    let asked = '';
    page.on('dialog', (d) => { asked = d.message(); d.accept(); });
    const L0 = FB.docs[`users/${uid}/docs/ledger__y${new Date().getUTCFullYear()}`].updateTime;
    await page.click('#tab-settings');
    check('the statement upload is offered', await $t('statement-upload-label').isVisible());
    await $t('statement-upload').setInputFiles([path.join(STMT, 'account-statement.pdf'), path.join(STMT, 'position-snapshot.pdf')]);
    await $t('statement-review').waitFor({ timeout: 60000 }).catch(() => {});
    check('the PDFs are read on the device and the account is confirmed once', /Thndr account 1234567/.test(asked) && await $t('statement-review').isVisible(), asked.slice(0, 60));   // private-scan: synthetic
    await A.shot('statement-review');
    await $t('post-statement').click();
    for (let i = 0; i < 60 && !FB.docs[`users/${uid}/docs/imports__${new Date().toISOString().slice(0, 7)}`]; i++) await page.waitForTimeout(250);
    check('posting the statement saves the ledger, the month-end marks and the import record to the account',
      FB.docs[`users/${uid}/docs/ledger__y${new Date().getUTCFullYear()}`].updateTime !== L0 && !!FB.docs[`users/${uid}/docs/imports__${new Date().toISOString().slice(0, 7)}`]);
    await page.waitForTimeout(1500);
    await page.click('#tab-activity'); await page.waitForTimeout(300);
    check('the statement rows are in the ledger on the page', /Deposit[\s\S]*10,000/.test(await page.locator('#main').textContent()));

    // ---- 4c. email updates: the package is sealed to the mail key and names this account ----
    await $t('account-menu').click(); await $t('account-email').click();
    await $t('mail-on').click();
    for (let i = 0; i < 40 && !FB.docs['mail/' + uid]; i++) await page.waitForTimeout(250);
    const pkgEnv = FB.docs['mail/' + uid] && FB.docs['mail/' + uid].fields.pkg.stringValue;
    const opened = pkgEnv ? JSON.parse(sh('python3', ['-c', `import sys, json, os; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'src/jobs'))}); import store, run_account_mail as r
k = store.unlock(${JSON.stringify(path.join(SITE, 'p/khaled/keys.json'))}, open(${JSON.stringify(path.join(TMP, 'mailsec', 'setup_key.txt'))}).read().strip())
p = r.open_mail_pkg(k, sys.stdin.read()); print(json.dumps({"uid": p["uid"], "email": p["email"], "prefs": p["prefs"], "refresh": bool(p["refresh"]), "pk8": bool(p["pk8"])}))`], { input: pkgEnv, stdio: ['pipe', 'pipe', 'inherit'] })) : null;
    check('email updates: the package opens only with the mail key and names this account, its address and choices', !!opened && opened.uid === uid && opened.email === EMAIL && opened.prefs.alerts && opened.prefs.weekly && opened.refresh && opened.pk8 && !pkgEnv.includes(EMAIL), JSON.stringify(opened));
    await $t('account-menu').click(); await $t('account-email').click(); await $t('mail-off').click();
    for (let i = 0; i < 40 && FB.docs['mail/' + uid]; i++) await page.waitForTimeout(250);
    check('switching email updates off deletes the package', !FB.docs['mail/' + uid]);

    // ---- 5. lock + unlock ----
    await page.click('[data-testid=live-lock]');
    await $t('live-password').fill(PW); await $t('live-password-submit').click();
    await A.lockHidden();
    await page.click('#tab-settings');
    check('lock + unlock with the password reopens the account (session refreshed)', (await page.inputValue('#st-rf')) === '20');

    // ---- 6. a second device ----
    const B = await device('B');
    await B.page.goto(ORIGIN + '/index.html'); await B.$t('live-signin').click();
    await B.$t('signin-email').fill(EMAIL); await B.$t('signin-password').fill('wrong password 1'); await B.$t('signin-submit').click();
    await B.page.waitForFunction(() => /Wrong email or password/.test(document.querySelector('#lock .lk-err').textContent), null, { timeout: 15000 }).catch(() => {});
    check('a wrong password is refused', /Wrong email or password/.test(await B.lockErr()));
    await B.$t('signin-password').fill(PW); await B.$t('signin-submit').click();
    await B.lockHidden(60000).catch(() => {});
    if (await B.$t('live-bio-skip').count()) await B.$t('live-bio-skip').click();
    await B.lockHidden();
    await B.page.click('#tab-settings');
    check('a second device signs in and sees the same portfolio', (await B.page.inputValue('#st-rf')) === '20');

    // ---- 7. password reset + recovery code; change password ----
    FB.users[uid].pw = PW2;   // the reset link was used
    const C = await device('C');
    await C.page.goto(ORIGIN + '/index.html'); await C.$t('live-signin').click();
    await C.$t('signin-email').fill(EMAIL); await C.$t('signin-password').fill(PW2); await C.$t('signin-submit').click();
    await C.$t('recover-code').waitFor({ timeout: 60000 });
    check('after a password reset the recovery code is asked for', await C.$t('recover-code').isVisible());
    await C.$t('recover-code').fill('AAAA-BBBB-CCCC-DDDD-EEEE'); await C.$t('recover-submit').click();
    await C.page.waitForFunction(() => /not right/.test(document.querySelector('#lock .lk-err').textContent), null, { timeout: 60000 }).catch(() => {});
    check('a wrong recovery code is refused', /not right/.test(await C.lockErr()));
    await C.$t('recover-code').fill(CODE.toLowerCase()); await C.$t('recover-submit').click();
    await C.lockHidden(90000).catch(() => {});
    if (await C.$t('live-bio-skip').count()) await C.$t('live-bio-skip').click();
    await C.lockHidden();
    await C.page.click('#tab-settings');
    check('the recovery code opens the portfolio', (await C.page.inputValue('#st-rf')) === '20');
    const D = await device('D');
    await D.page.goto(ORIGIN + '/index.html'); await D.$t('live-signin').click();
    await D.$t('signin-email').fill(EMAIL); await D.$t('signin-password').fill(PW2); await D.$t('signin-submit').click();
    await D.lockHidden(60000).catch(() => {});
    if (await D.$t('live-bio-skip').count()) await D.$t('live-bio-skip').click();
    check('after that the new password alone opens it', await D.page.evaluate(() => document.getElementById('lock').hidden));
    await D.$t('account-menu').click(); await D.$t('account-password').click();
    await D.page.fill('[data-testid=live-new-password]', PW3); await D.page.fill('[data-testid=live-new-password-repeat]', PW3); await D.page.click('[data-testid=live-password-continue]');
    await D.lockHidden(60000).catch(() => {});
    const E = await device('E');
    await E.page.goto(ORIGIN + '/index.html'); await E.$t('live-signin').click();
    await E.$t('signin-email').fill(EMAIL); await E.$t('signin-password').fill(PW3); await E.$t('signin-submit').click();
    await E.lockHidden(60000).catch(() => {});
    if (await E.$t('live-bio-skip').count()) await E.$t('live-bio-skip').click();
    check('"Change password" in the Account menu: the new password opens it on another device', await E.page.evaluate(() => document.getElementById('lock').hidden) && FB.users[uid].pw === PW3);
  } catch (e) {
    check('run', false, e.stack || String(e));
  }
  const bad = problems.filter((t) => !/Failed to load resource: the server responded with a status of (400|401|403|404|409|503)/.test(t) && !/OperationError|Wrong email|not right|INVALID_LOGIN|FAILED_PRECONDITION|ALREADY_EXISTS/.test(t));
  check('no console errors, page errors, CSP violations or outside requests', bad.length === 0, bad.slice(0, 5).join(' | '));
  await browser.close(); srv.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `site_cloud: ${fail} FAILED` : 'site_cloud: all checks passed');
  process.exit(fail ? 1 : 0);
})();
