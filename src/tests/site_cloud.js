#!/usr/bin/env node
/* Accounts on the live site, end to end, in headless Chromium against a FAKE Firebase (Identity Toolkit, Secure Token and
   Firestore REST, with the access rules of src/cloud/firestore.rules), on synthetic market data:
     1. a fresh device is offered "Create your portfolio"; sign-up makes the account, shows a recovery code, stores the
        account's key only wrapped (users/{uid}.keys: pub, wrap, pwrap) and creates the members key (shared/members +
        shared/membersPub);
     2. the shared market bundle (sealed to the members key the way run_shared_market.py seals it) gives the onboarding its
        prices: cash + "SYM shares" lines become a starting deposit and buys; then the optional "Thndr emails" steps (2-Step
        Verification, app password, connect) save the Gmail login as the account's own encrypted document, the Thndr name
        on the settings, and the mail package (gmail on); the app opens with the holding priced;
     3. every stored document is an encrypted envelope (no symbol or figure in the clear), and another account's token is
        refused on it;
     4. a settings save goes to the account (updateTime changes); a save whose remembered updateTime is stale is refused
        once (FAILED_PRECONDITION) and redone;
     5. lock + unlock with the password reopens it (session refreshed with the refresh token);
     6. a second device signs in with email + password and sees the same portfolio; a wrong password is refused;
     7. after a password reset the recovery code unlocks it once and re-locks the key with the new password (the next sign-in
        needs no code); "Change password" in the Account menu works the same way;
     8. friends: a request by email (an unknown email is refused), the other side accepts, each sees the other's portfolio
        read-only (a copy sealed to their key, also one made by the email job's Python code) and "Back to mine"; the rules
        refuse a forged acceptance and a copy to a non-friend; removing deletes both sides;
     9. admin: the owner's email must be verified first; the admin list shows every account (names, no figures); a reset
        deletes everything but the sign-in, the next sign-in starts again; "Delete my account" removes the sign-in too;
    10. no console errors, page errors or CSP violations; nothing leaves for anywhere but the local server and the fakes.
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
{ const ix = path.join(SITE, 'index.html'), h = fs.readFileSync(ix, 'utf8'), m = h.match(/const OWNER_HASH = '([0-9a-f]{64})'/);
  if (!m) throw new Error('site_cloud: OWNER_HASH not found in the built page');
  fs.writeFileSync(ix, h.replace(m[0], `const OWNER_HASH = '${crypto.createHash('sha256').update('owner@example.com').digest('hex')}'`)); }
const rd = (f) => { const x = JSON.parse(fs.readFileSync(path.join(SYN, f), 'utf8')); return x && x.data && typeof x.data === 'object' ? x.data : x; };
const MARKET = { 'market/latest': rd('market/latest.json'), 'bench/egx30': rd('bench/egx30.json'), 'market/macro': { benchClose: {}, cpiMoM: {} } };
for (const f of fs.readdirSync(path.join(SYN, 'history'))) MARKET['history/' + f.replace('.json', '')] = rd('history/' + f);
const QUOTES = MARKET['market/latest'].quotes;
const SYM = Object.keys(QUOTES).find((s) => QUOTES[s] && QUOTES[s].price > 0);
// the owner's main portfolio (setup-key kind) under the throwaway key: the synthetic portfolio with the market data
{ const mainDocs = Object.assign({}, MARKET, { 'portfolio/settings': rd('portfolio/settings.json'), 'portfolio/assets': rd('portfolio/assets.json'), 'portfolio/marks': rd('portfolio/marks.json') });
  for (const f of fs.readdirSync(path.join(SYN, 'ledger'))) mainDocs['ledger/' + f.replace('.json', '')] = rd('ledger/' + f);
  fs.writeFileSync(path.join(TMP, 'main-docs.json'), JSON.stringify(mainDocs));
  const pub = JSON.parse(fs.readFileSync(path.join(SITE, 'p/khaled/keys.json'), 'utf8')).pub;
  fs.writeFileSync(path.join(SITE, 'p/khaled/data.enc.json'), sh('python3', ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'src/jobs'))}); import run_shared_market as r
print(r.seal_bundle(json.load(open(${JSON.stringify(path.join(TMP, 'main-docs.json'))})), ${JSON.stringify(pub)}, "2026-09-29T13:00:00+00:00"))`]).trim()); }
function writeBundle(pub) {   // sealed exactly like run_shared_market.py (the Python code itself)
  const docs = path.join(TMP, 'market-docs.json'); fs.writeFileSync(docs, JSON.stringify(MARKET));
  const env = sh('python3', ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'src/jobs'))}); import run_shared_market as r
print(r.seal_bundle(json.load(open(${JSON.stringify(docs)})), ${JSON.stringify(pub)}, "2026-09-29T13:00:00+00:00"))`]).trim();
  fs.mkdirSync(path.join(SITE, 'm'), { recursive: true }); fs.writeFileSync(path.join(SITE, 'm', 'market.enc.json'), env);
}

// ---- fake Firebase ----
const FB = { users: {}, byEmail: {}, tokens: {}, claims: {}, refresh: {}, docs: {}, t: 0, conflicts: 0, denied: 0, calls: [] };
const OWNER_EMAIL = 'owner@example.com';   // stands in for the real owner: the test site is built with its hash
const PID = 'portfolio-desk-4d14a', FSB = `/v1/projects/${PID}/databases/(default)/documents/`;
const stamp = () => new Date(Date.UTC(2026, 8, 30, 0, 0, 0) + ++FB.t * 1000).toISOString().replace('Z', '123456Z');
// ID tokens are JWT-shaped like Google's (the site reads email_verified from them for the admin screen)
const tokenFor = (uid) => { const u = FB.users[uid] || {}, c = { email: u.email, verified: !!u.verified };
  const t = 'h.' + Buffer.from(JSON.stringify({ user_id: uid, email: c.email, email_verified: c.verified })).toString('base64url') + '.' + crypto.randomBytes(8).toString('hex');
  FB.tokens[t] = uid; FB.claims[t] = c; return t; };
const refreshFor = (uid) => { const t = 'rf-' + crypto.randomBytes(8).toString('hex'); FB.refresh[t] = uid; return t; };
const authOut = (u) => ({ localId: u.uid, email: u.email, idToken: tokenFor(u.uid), refreshToken: refreshFor(u.uid), expiresIn: '3600' });
const err = (status, message) => [status, { error: { code: status, message, status: message } }];
function identity(ep, b) {
  if (ep === 'signUp') { if (FB.byEmail[b.email]) return err(400, 'EMAIL_EXISTS'); const u = { uid: 'U' + crypto.randomBytes(6).toString('hex'), email: b.email, pw: b.password }; FB.users[u.uid] = u; FB.byEmail[b.email] = u; return [200, authOut(u)]; }
  if (ep === 'signInWithPassword') { const u = FB.byEmail[b.email]; if (!u || u.pw !== b.password) return err(400, 'INVALID_LOGIN_CREDENTIALS'); return [200, authOut(u)]; }
  if (ep === 'sendOobCode' && b.requestType === 'VERIFY_EMAIL') { const uid = FB.tokens[b.idToken]; if (!uid) return err(400, 'INVALID_ID_TOKEN'); FB.users[uid].verifySent = (FB.users[uid].verifySent || 0) + 1; return [200, { email: FB.users[uid].email }]; }   // the test "clicks" the link: FB.users[uid].verified = true   // the link is clicked at once
  if (ep === 'sendOobCode') { FB.resetAsked = b.email; return [200, { email: b.email }]; }
  if (ep === 'delete') { const uid = FB.tokens[b.idToken]; if (!uid || !FB.users[uid]) return err(400, 'INVALID_ID_TOKEN'); delete FB.byEmail[FB.users[uid].email]; delete FB.users[uid]; return [200, {}]; }
  if (ep === 'update') { const uid = FB.tokens[b.idToken]; if (!uid) return err(400, 'INVALID_ID_TOKEN'); if (b.password) FB.users[uid].pw = b.password; return [200, authOut(FB.users[uid])]; }
  return err(400, 'UNKNOWN');
}
// the rules of src/cloud/firestore.rules (a: {uid, email, verified} of the token, or null; cur/next: the document's fields
// before and after a write)
const sv = (f, k) => (f && f[k] && f[k].stringValue) || null;
function allowed(a, method, p, cur, next) {
  const uid = a && a.uid, admin = !!(a && a.email === OWNER_EMAIL && a.verified), me = (x) => !!uid && uid === x;
  let m;
  if (p === 'users') return admin && method === 'GET';
  if ((m = p.match(/^users\/([^/]+)$/))) return me(m[1]) || (admin && (method === 'DELETE' || method === 'GET'));
  if ((m = p.match(/^users\/([^/]+)\/docs(?:\/[^/]+)?$/))) return me(m[1]) || (admin && (method === 'GET' || method === 'DELETE'));
  if (p === 'shared/membersPub') return method === 'GET' || (!!uid && method === 'PATCH' && !cur);
  if (p === 'shared/members') return !!uid && (method === 'GET' || (method === 'PATCH' && !cur));
  if ((m = p.match(/^mail\/([^/]+)$/))) return method === 'GET' || me(m[1]) || (admin && method === 'DELETE');
  if (p === 'status' || p === 'deleted') return admin && method === 'GET';
  if ((m = p.match(/^deleted\/([^/]+)$/))) return method === 'PATCH' ? admin && !cur : me(m[1]) || admin;
  if ((m = p.match(/^status\/([^/]+)$/))) return me(m[1]) || (admin && (method === 'GET' || method === 'DELETE'));
  if (p === 'directory') return false;
  if ((m = p.match(/^directory\/([^/]+)$/))) {
    if (method === 'GET') return !!uid;
    if (method === 'DELETE') return (!!a && a.email === m[1]) || admin;
    return !!a && a.verified && a.email === m[1] && sv(next, 'uid') === uid;
  }
  // @usernames (FB.oldRules: the rules from before them, which have no handles and no email on accepting)
  if (p === 'handles') return false;
  if ((m = p.match(/^handles\/([^/]+)$/))) {
    if (FB.oldRules) return false;
    if (method === 'GET') return !!uid;
    if (method === 'DELETE') return (!!cur && sv(cur, 'uid') === uid) || admin;
    const dirPub = a && sv((FB.docs['directory/' + a.email] || {}).fields, 'pub');
    if (!cur) return !!a && a.verified && /^[a-z][a-z0-9_]{2,19}$/.test(m[1]) && sv(next, 'uid') === uid && sv(next, 'pub') === dirPub;
    return !!a && a.verified && sv(cur, 'uid') === uid && sv(next, 'uid') === uid && sv(next, 'pub') === dirPub;
  }
  if ((m = p.match(/^links\/([^/]+)\/with$/))) return method === 'GET' && (me(m[1]) || admin);
  if ((m = p.match(/^links\/([^/]+)\/with\/([^/]+)$/))) {
    const [, u, o] = m;
    if (method === 'GET') return me(u) || admin;
    if (method === 'DELETE') return me(u) || me(o) || admin;
    if (!cur) return (me(u) && a.verified && sv(next, 'status') === 'sent') || (me(o) && a.verified && sv(next, 'status') === 'received'
      && sv(next, 'email') === a.email && sv(next, 'pub') === sv((FB.docs['directory/' + a.email] || {}).fields, 'pub'));
    const changed = Object.keys(Object.assign({}, cur, next)).filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(next[k]));
    const sameEmail = (sv(next, 'email') || '') === (sv(cur, 'email') || '');
    return changed.every((k) => k === 'status' || k === 'at' || (k === 'email' && !FB.oldRules)) && sv(next, 'status') === 'friends'
      && ((me(o) && sv(cur, 'status') === 'sent' && (sameEmail || (a.verified && sv(next, 'email') === a.email))) || (me(u) && sv(cur, 'status') === 'received' && sameEmail));
  }
  if ((m = p.match(/^shares\/([^/]+)\/to\/([^/]+)$/))) {
    const [, o, v] = m;
    if (method === 'GET') return me(o) || me(v) || admin;
    if (method === 'DELETE') return me(o) || me(v) || admin;
    return me(o) && sv((FB.docs[`links/${o}/with/${v}`] || {}).fields, 'status') === 'friends';
  }
  return false;
}
function firestore(method, url, headers, body) {
  const u = new URL(url), p = decodeURIComponent(u.pathname.slice(u.pathname.indexOf(FSB) + FSB.length)), q = u.searchParams;
  const tok = (headers.authorization || '').replace(/^Bearer /, ''), uid = FB.tokens[tok] || null;
  if (headers.authorization && !uid) return err(401, 'UNAUTHENTICATED');
  const cur0 = FB.docs[p], b0 = method === 'PATCH' ? JSON.parse(body || '{}') : null, mask0 = q.getAll('updateMask.fieldPaths');
  const next0 = b0 ? (mask0.length && cur0 ? Object.assign({}, cur0.fields, Object.fromEntries(mask0.map((k) => [k, b0.fields[k]]))) : b0.fields) : null;
  if (!allowed(uid ? Object.assign({ uid }, FB.claims[tok]) : null, method, p, cur0 && cur0.fields, next0)) { FB.denied++; return err(403, 'PERMISSION_DENIED'); }
  const full = (k) => `projects/${PID}/databases/(default)/documents/${k}`;
  const out = (k) => Object.assign({ name: full(k) }, FB.docs[k]);
  if (method === 'GET' && p.split('/').length % 2 === 1) return [200, { documents: Object.keys(FB.docs).filter((k) => k.startsWith(p + '/') && k.split('/').length === p.split('/').length + 1).sort().map(out) }];
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
    const ctx = await browser.newContext({ viewport: process.env.PHONE ? { width: 390, height: 844 } : { width: 1280, height: 900 }, serviceWorkers: 'block' });   // PHONE=1: screenshots at phone size
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
    const shot = async (n) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: !!process.env.PHONE }); } };
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
    check('sign-up sent the "confirm your email" link by itself', (FB.users[Object.keys(FB.users)[0]].verifySent || 0) >= 1);
    check('the choice screen leads with "Build it from my Thndr emails"; typing holdings is tucked away', await $t('onboard-history').isVisible() && !(await $t('onboard-cash').isVisible()));
    await $t('onboard-manual').click(); await $t('onboard-cash').fill('1000'); await $t('onboard-holdings').fill(`${SYM} 10`);
    await A.shot('onboard');
    await $t('onboard-submit').click();
    // ---- 2b. the optional Gmail steps, explained one at a time ----
    await $t('gmail-start').waitFor({ timeout: 60000 });
    check('after onboarding, a short yes/no question about adding trades automatically', /Add your trades automatically/.test(await page.locator('#lock').textContent()) && await $t('gmail-skip').isVisible());
    await A.shot('gmail-intro');
    await $t('gmail-start').click();
    await $t('gmail-connect').waitFor();
    check('one screen: numbered steps with a direct button to each Google page', (await $t('gmail-2sv-link').getAttribute('href')).startsWith('https://myaccount.google.com/signinoptions/twosv') && (await $t('gmail-apppw-link').getAttribute('href')).startsWith('https://myaccount.google.com/apppasswords') && (await $t('gmail-2sv-link').getAttribute('target')) === '_blank' && /EGX Tracker/.test(await page.locator('#lock').textContent()));
    check('it asks only for the Gmail and the app password (no Thndr name: the first statement sets the account)', !(await $t('gmail-holder').count()) && await $t('gmail-app-password').isVisible());
    await $t('gmail-address').fill('friend.test@example.com');
    check("the Google buttons open the Google account typed in step 1", (await $t('gmail-apppw-link').getAttribute('href')) === 'https://myaccount.google.com/apppasswords?authuser=friend.test%40example.com');
    await $t('gmail-app-password').fill('abc');
    await $t('gmail-connect').click();
    check('an app password that is not 16 letters is refused with a hint', /16 letters/.test(await A.lockErr()));
    await $t('gmail-app-password').fill('abcd efgh ijkl mnop'); await A.shot('gmail-step3');
    await $t('gmail-connect').click();
    await $t('gmail-done').waitFor({ timeout: 30000 }).catch(() => {});
    check('connected: what happens next is explained (first check within about 10 minutes, then three times a day)', /about 10 minutes/.test(await page.locator('#lock').textContent()) && /three times a day/.test(await page.locator('#lock').textContent()));
    await A.shot('gmail-done');
    await $t('gmail-done').click();
    await A.lockHidden(60000).catch(() => {});
    if (!(await page.evaluate(() => document.getElementById('lock').hidden)) && (await $t('live-bio-skip').count())) await $t('live-bio-skip').click();
    await A.lockHidden();
    const docs = Object.keys(FB.docs).filter((k) => k.startsWith(`users/${uid}/docs/`)).map((k) => k.split('/').pop()).sort();
    check('onboarding created the portfolio documents and the Gmail login', JSON.stringify(docs) === JSON.stringify(['ledger__y' + new Date().getUTCFullYear(), 'portfolio__assets', 'portfolio__marks', 'portfolio__settings', 'sync__gmail'].sort()) || docs.length === 5, docs.join(','));
    check('Gmail on: the mail package exists', !!FB.docs['mail/' + uid]);
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
    check('every stored document is an encrypted envelope with nothing in the clear', blobs.length === 5 && blobs.every((b) => { const e = JSON.parse(b); return e.v === 1 && e.epk && e.iv && e.ct && !b.includes(SYM) && !b.includes('Omar') && !b.includes('abcdefgh'); }));
    await page.click('#tab-more'); await page.click('[data-testid=sec-inputs]'); await page.waitForTimeout(300);
    check('no Thndr name was asked: the settings hold none (the first statement sets the account)', (await page.inputValue('#st-holder')) === '');
    const other = identity('signUp', { email: 'other@example.com', password: 'x'.repeat(10), returnSecureToken: true })[1];
    const denied = firestore('GET', `https://firestore.googleapis.com${FSB}users/${uid}/docs/portfolio__settings`, { authorization: 'Bearer ' + other.idToken });
    check("another account's token is refused on this account's documents", denied[0] === 403);

    // ---- 4. saves, and a stale save is redone ----
    const s0 = FB.docs[`users/${uid}/docs/portfolio__settings`].updateTime;
    await page.click('#tab-more'); await page.click('[data-testid=sec-inputs]'); await page.fill('#st-rf', '21.5'); await $t('save-settings').click();
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
    // next month's statement: tracking started today, so this month's statement would count only from tomorrow
    const NM = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 7); })(), NY = NM.slice(0, 4);
    sh('python3', [path.join(ROOT, 'src/tests/fixtures/make_statement_pdf.py'), STMT, '--symbol', SYM, '--price', String(QUOTES[SYM].price), '--close', String(QUOTES[SYM].price), '--month', NM]);
    let asked = '';
    page.on('dialog', (d) => { asked = d.message(); d.accept(); });
    const L0 = (FB.docs[`users/${uid}/docs/ledger__y${NY}`] || {}).updateTime;
    await page.click('#tab-more'); await page.click('[data-testid=sec-statements]');
    check('the statement upload is offered', await $t('statement-upload-label').isVisible());
    await $t('statement-upload').setInputFiles([path.join(STMT, 'account-statement.pdf'), path.join(STMT, 'position-snapshot.pdf')]);
    await $t('statement-review').waitFor({ timeout: 60000 }).catch(() => {});
    check('the PDFs are read on the device and the account is confirmed once', /Thndr account 1234567/.test(asked) && await $t('statement-review').isVisible(), asked.slice(0, 60));   // private-scan: synthetic
    await A.shot('statement-review');
    await $t('post-statement').click();
    for (let i = 0; i < 60 && !FB.docs[`users/${uid}/docs/imports__${NM}`]; i++) await page.waitForTimeout(250);
    check('posting the statement saves the ledger, the month-end marks and the import record to the account',
      (FB.docs[`users/${uid}/docs/ledger__y${NY}`] || {}).updateTime !== L0 && !!FB.docs[`users/${uid}/docs/imports__${NM}`]);
    await page.waitForTimeout(1500);
    await page.click('#tab-more'); await page.click('[data-testid=sec-ledger]'); await page.waitForTimeout(300);
    check('the statement rows are in the ledger on the page', /Deposit[\s\S]*10,000/.test(await page.locator('#main').textContent()));

    // ---- 4c. email updates: the package is sealed to the mail key and names this account ----
    const pkg0 = FB.docs['mail/' + uid].updateTime;
    await $t('account-menu').click();
    check('the Account menu shows Thndr emails connected and email updates on', /connected/.test(await $t('account-gmail').textContent()) && /on/.test(await $t('account-email').textContent()));
    await $t('account-email').click();
    await $t('mail-on').click();
    for (let i = 0; i < 40 && FB.docs['mail/' + uid].updateTime === pkg0; i++) await page.waitForTimeout(250);
    const pkgEnv = FB.docs['mail/' + uid] && FB.docs['mail/' + uid].fields.pkg.stringValue;
    const gmailEnv = FB.docs[`users/${uid}/docs/sync__gmail`].fields.blob.stringValue;
    const opened = pkgEnv ? JSON.parse(sh('python3', ['-c', `import sys, json, os; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'src/jobs'))}); import store, run_account_mail as r
k = store.unlock(${JSON.stringify(path.join(SITE, 'p/khaled/keys.json'))}, open(${JSON.stringify(path.join(TMP, 'mailsec', 'setup_key.txt'))}).read().strip())
i = json.loads(sys.stdin.read()); p = r.open_mail_pkg(k, i["pkg"]); priv, _ = r.account_key(p["pk8"])
g = json.loads(store.unseal(priv, i["gmail"]).decode())["data"]
print(json.dumps({"uid": p["uid"], "email": p["email"], "prefs": p["prefs"], "refresh": bool(p["refresh"]), "pk8": bool(p["pk8"]), "gmail": [g["address"], g["appPassword"]]}))`], { input: JSON.stringify({ pkg: pkgEnv, gmail: gmailEnv }), stdio: ['pipe', 'pipe', 'inherit'] })) : null;
    check('email updates: the package opens only with the mail key and names this account, its address and choices (the friends leaderboard and the report card on by default, the morning brief off)', !!opened && opened.uid === uid && opened.email === EMAIL && opened.prefs.alerts && opened.prefs.weekly && opened.prefs.reports && opened.prefs.leaderboard === true && opened.prefs.reportCard === true && opened.prefs.morning === false && opened.prefs.gmail && opened.refresh && opened.pk8 && !pkgEnv.includes(EMAIL), JSON.stringify(opened));
    check('the job can open the Gmail login with the account key from the package (spaces removed)', !!opened && JSON.stringify(opened.gmail) === JSON.stringify(['friend.test@example.com', 'abcdefghijklmnop']));
    await $t('account-menu').click(); await $t('account-gmail').click();
    await $t('gmail-status').waitFor();
    check('Thndr emails: the status says it is connected and not checked yet', /friend\.test@example\.com/.test(await page.locator('#lock').textContent()) && /Not checked yet/.test(await $t('gmail-status').textContent()));
    await A.shot('gmail-status');
    await $t('gmail-off').click();
    for (let i = 0; i < 40 && FB.docs[`users/${uid}/docs/sync__gmail`]; i++) await page.waitForTimeout(250);
    check('turning Thndr emails off deletes the Gmail login and keeps email updates', !FB.docs[`users/${uid}/docs/sync__gmail`] && !!FB.docs['mail/' + uid]);
    await page.waitForTimeout(500);
    if (!(await page.evaluate(() => document.getElementById('lock').hidden))) await $t('account-back').click();
    await page.click('#tab-more'); await page.click('[data-testid=sec-factsheet]'); await page.waitForTimeout(400);
    if (await page.locator('#fs-xlsx').count()) {
      await page.click('#fs-xlsx'); await page.waitForTimeout(300);
      check('Reports tab: an account is told its month-end Excel and PDF come by email', /emailed to you/.test(await page.locator('#toast').textContent()));
      // once the job has published the month's files (sealed to this account's key, run_account_mail.py publish_files)
      const M0 = await page.locator('#fs-xlsx').getAttribute('data-month');
      const folder = 'a/' + require('crypto').createHash('sha256').update('pd-account-files-v1:' + uid).digest('hex').slice(0, 24) + '/exports';
      cp.execFileSync('python3', ['-c', `
import sys, json, os; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'src', 'jobs'))}); import store
a = json.load(sys.stdin); k = {"pub": a["pub"]}; d = os.path.join(a["site"], a["folder"]); os.makedirs(d, exist_ok=True)
open(os.path.join(d, "Test-Wb.xlsx.enc.json"), "wb").write(store.seal(k, b"PK-test-workbook", "Test-Wb.xlsx"))
open(os.path.join(d, "index.enc.json"), "wb").write(store.seal(k, json.dumps([{"month": a["m"], "name": "Test-Wb.xlsx", "file": a["folder"] + "/Test-Wb.xlsx.enc.json"}]).encode(), "index.json"))`],
        { input: JSON.stringify({ pub: keys.pub, site: SITE, folder, m: M0 }) });
      await page.evaluate(() => { window.pdExportsReset(); return window.pdExports(); });
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }).catch(() => null), page.click('#fs-xlsx')]);
      check('Reports tab: the account downloads its own month-end workbook, opened with its key', !!dl && dl.suggestedFilename() === 'Test-Wb.xlsx', dl ? dl.suggestedFilename() : 'no download: ' + (await page.locator('#toast').textContent()) + ' ' + JSON.stringify(await page.evaluate(() => window.pdExports())));
    } else check('Reports tab: the Download Excel button is there', false);
    await $t('account-menu').click(); await $t('account-email').click(); await $t('mail-off').click();
    for (let i = 0; i < 40 && FB.docs['mail/' + uid]; i++) await page.waitForTimeout(250);
    check('switching email updates off deletes the package', !FB.docs['mail/' + uid]);

    // ---- 5. lock + unlock ----
    await page.click('[data-testid=live-lock]');
    await $t('live-password').fill(PW); await $t('live-password-submit').click();
    await A.lockHidden();
    await page.click('#tab-more'); await page.click('[data-testid=sec-inputs]');
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
    await B.page.click('#tab-more'); await B.page.click('[data-testid=sec-inputs]');
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
    await C.page.click('#tab-more'); await C.page.click('[data-testid=sec-inputs]');
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

    // ---- 8. friends ----
    const EMAIL_B = 'sara@example.com', PWB = 'yellow kite 58';
    const signUp = async (X, name, email, pw) => {
      await X.page.goto(ORIGIN + '/index.html'); await X.$t('live-signup').click();
      await X.$t('signup-name').fill(name); await X.$t('signup-email').fill(email); await X.$t('signup-password').fill(pw); await X.$t('signup-password-repeat').fill(pw);
      await X.$t('signup-submit').click(); await X.$t('recovery-code').waitFor({ timeout: 60000 });
      await X.$t('recovery-saved').check(); await X.$t('recovery-continue').click();
      await X.$t('onboard-skip').click(); await X.$t('gmail-skip').waitFor({ timeout: 60000 }); await X.$t('gmail-skip').click();
      await X.lockHidden(60000).catch(() => {}); if (await X.$t('live-bio-skip').count()) await X.$t('live-bio-skip').click(); await X.lockHidden();
    };
    const until = async (f, ms = 15000) => { for (let i = 0; i < ms / 100 && !f(); i++) await new Promise((r) => setTimeout(r, 100)); return f(); };
    // Friends need a verified email: the link went out at sign-up; the test "clicks" it, then taps "I tapped the link"
    const verifyEmail = async (X, email) => {
      FB.byEmail[email].verified = true;
      await X.$t('account-menu').click(); await X.$t('account-friends').click(); await X.$t('friends-verify-done').click();
      await X.$t('friend-email').waitFor({ timeout: 15000 }); await X.$t('friends-back').click(); await X.$t('account-back').click();
    };
    const F = await device('F');
    await signUp(F, 'Sara', EMAIL_B, PWB);
    const uidB = FB.byEmail[EMAIL_B].uid;
    await F.$t('account-menu').click(); await F.$t('account-friends').click(); await F.$t('friends-unverified').waitFor({ timeout: 15000 });
    check('until the email is verified, Friends asks to confirm it and the account is not findable', !(await F.$t('friend-email').count()) && !FB.docs['directory/' + EMAIL_B]);
    const tokU = identity('signInWithPassword', { email: EMAIL_B, password: PWB })[1].idToken;
    const squat = firestore('PATCH', `https://firestore.googleapis.com${FSB}directory/${EMAIL_B}`, { authorization: 'Bearer ' + tokU }, JSON.stringify({ fields: { uid: { stringValue: uidB }, pub: { stringValue: 'x' } } }));
    check('the rules refuse a directory entry for an unverified email', squat[0] === 403);
    await F.$t('friends-back').click(); await F.$t('account-back').click();
    await verifyEmail(E, EMAIL); await verifyEmail(F, EMAIL_B);
    check('each account is findable by its sign-in email once verified (directory, with its public key)', await until(() => FB.docs['directory/' + EMAIL] && FB.docs['directory/' + EMAIL_B]) && sv(FB.docs['directory/' + EMAIL_B].fields, 'uid') === uidB);
    const hOf = (h) => sv((FB.docs['handles/' + h] || {}).fields, 'uid');
    check('once the email is confirmed, each account gets an @username from its name (@omar, @sara), kept in its status line too',
      await until(() => hOf('omar') === uid && hOf('sara') === uidB) && sv(FB.docs['status/' + uidB].fields, 'handle') === 'sara', JSON.stringify(Object.keys(FB.docs).filter((k) => k.startsWith('handles/'))));
    const takeOver = firestore('PATCH', `https://firestore.googleapis.com${FSB}handles/omar`, { authorization: 'Bearer ' + identity('signInWithPassword', { email: EMAIL_B, password: PWB })[1].idToken }, JSON.stringify({ fields: { uid: { stringValue: uidB }, pub: { stringValue: sv(FB.docs['directory/' + EMAIL_B].fields, 'pub') } } }));
    check("the rules refuse taking over someone else's @username", takeOver[0] === 403 && hOf('omar') === uid);
    check('the admin status line is written at sign-up (no figures)', !!FB.docs['status/' + uidB] && sv(FB.docs['status/' + uidB].fields, 'createdAt') && !/10,000|holding/i.test(JSON.stringify(FB.docs['status/' + uidB])));
    await F.$t('account-menu').click(); await F.$t('account-friends').click();
    await F.$t('friend-email').fill('nobody@example.com'); await F.$t('friend-add').click();
    await F.page.waitForFunction(() => /Nobody has an account/.test((document.querySelector('#lock .lk-err') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => {});
    check('asking an email with no account is refused with the site link to send', /Nobody has an account with nobody@example.com/.test(await F.lockErr()));
    await F.$t('friend-email').fill(EMAIL.toUpperCase()); await F.$t('friend-add').click();
    await F.$t('friend-sent').waitFor({ timeout: 15000 }).catch(() => {});
    check('a friend request writes both sides (mine sent, theirs received)', sv((FB.docs[`links/${uidB}/with/${uid}`] || {}).fields, 'status') === 'sent' && sv((FB.docs[`links/${uid}/with/${uidB}`] || {}).fields, 'status') === 'received');
    await F.shot('friends-sent');
    const tokB = identity('signInWithPassword', { email: EMAIL_B, password: PWB })[1].idToken, FSU = `https://firestore.googleapis.com${FSB}`;
    const forged = firestore('PATCH', FSU + `links/${uid}/with/${uidB}?updateMask.fieldPaths=status&updateMask.fieldPaths=at`, { authorization: 'Bearer ' + tokB }, JSON.stringify({ fields: { status: { stringValue: 'friends' }, at: { stringValue: 'x' } } }));
    const early = firestore('PATCH', FSU + `shares/${uidB}/to/${uid}`, { authorization: 'Bearer ' + tokB }, JSON.stringify({ fields: { pkg: { stringValue: '{}' } } }));
    check('the rules refuse accepting on the other side and a copy for someone who is not a friend yet', forged[0] === 403 && early[0] === 403);
    const pose = firestore('PATCH', FSU + `links/Uvictim/with/${uidB}?currentDocument.exists=false`, { authorization: 'Bearer ' + tokB }, JSON.stringify({ fields: { status: { stringValue: 'received' }, name: { stringValue: 'Mom' }, email: { stringValue: 'mom@example.com' }, pub: { stringValue: sv(FB.docs['directory/' + EMAIL_B].fields, 'pub') } } }));
    check('the rules refuse a friend request that poses as someone else (another email on the request)', pose[0] === 403);
    await E.$t('account-menu').click();
    await E.page.waitForFunction(() => /1 new/.test(document.querySelector('[data-testid=account-friends]').textContent), null, { timeout: 15000 }).catch(() => {});
    check('the Account menu shows the new request', /Friends · 1 new/.test(await E.$t('account-friends').textContent()));
    await E.page.waitForTimeout(300);
    check('an ordinary account never sees the Admin button', !(await E.$t('account-admin').isVisible()));
    await E.$t('account-friends').click(); await E.$t('friend-accept').waitFor();
    await E.shot('friends-request');
    FB.oldRules = true;   // accepting still works under the rules from before @usernames
    await E.$t('friend-accept').click(); await E.$t('friend-friends').waitFor({ timeout: 20000 }).catch(() => {});
    FB.oldRules = false;
    check('accepting makes both sides friends and shares a copy at once', sv(FB.docs[`links/${uid}/with/${uidB}`].fields, 'status') === 'friends' && sv(FB.docs[`links/${uidB}/with/${uid}`].fields, 'status') === 'friends' && await until(() => FB.docs[`shares/${uid}/to/${uidB}`]));
    check('the copy is sealed (nothing in the clear)', !/Omar|holding|COMI/.test(sv(FB.docs[`shares/${uid}/to/${uidB}`].fields, 'pkg')));
    await E.$t('friends-back').click(); await E.$t('account-back').click();
    await F.$t('friends-back').click(); await F.$t('account-friends').click(); await F.$t('friend-view').waitFor();
    check("opening Friends shares the viewer's own copy back", await until(() => FB.docs[`shares/${uidB}/to/${uid}`]));
    // a friend's profile: percentages only (returns, holdings by weight, trades), never an amount
    const noAmounts = (t) => !/EGP|\b\d{1,3}(,\d{3})+\b|\b\d{4,}\b(?!-)/.test(t.replace(/\b20\d\d\b/g, ''));
    await F.$t('friend-view').click(); await F.$t('profile-sheet').waitFor({ timeout: 30000 });
    await F.page.waitForTimeout(400);
    const sheet1 = await F.$t('profile-sheet').textContent();
    check("tapping View opens their profile page: their return next to yours and the index's, holdings by weight, latest trades",
      /Omar/.test(await F.$t('profile-name').textContent()) && /%/.test(await F.$t('profile-picked').textContent()) && await F.$t('profile-holdings').isVisible() && await F.$t('profile-trades').isVisible() && /Them.*You.*Index/.test(sheet1), sheet1.slice(0, 200));
    check('the profile shows percentages only: no EGP amount anywhere on it', noAmounts(sheet1), sheet1.slice(0, 300));
    await F.page.waitForTimeout(600); await F.shot('friend-profile');
    await F.$t('profile-close').click(); await F.page.waitForTimeout(300);
    check('closing the profile leaves you on your own portfolio', !(await F.$t('profile-sheet').count()) && /Sara/.test(await F.page.locator('#pf-name-text').textContent()));
    // a copy from before profiles (the documents themselves, v1) still opens: the profile is made on this side
    const snapDocs = Object.assign({}, MARKET, { 'portfolio/settings': Object.assign({}, rd('portfolio/settings.json'), { name: 'Main Portfolio' }), 'portfolio/assets': rd('portfolio/assets.json'), 'portfolio/marks': rd('portfolio/marks.json') });
    for (const f of fs.readdirSync(path.join(SYN, 'ledger'))) snapDocs['ledger/' + f.replace('.json', '')] = rd('ledger/' + f);
    const seal = (obj) => { fs.writeFileSync(path.join(TMP, 'snap.json'), JSON.stringify(obj)); return sh('python3', ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'src/jobs'))}); import run_account_mail as r
print(r.seal_json(json.load(open(${JSON.stringify(path.join(TMP, 'snap.json'))})), ${JSON.stringify(sv(FB.docs['directory/' + EMAIL_B].fields, 'pub'))}, r.SHARE_LABEL))`]).trim(); };
    const synProf = JSON.parse(sh('node', [path.join(ROOT, 'src/tools/profile.js'), '--data', SYN, '--name', 'Main Portfolio'])).profile;
    const topSym = synProf.holdings[0].s;
    FB.docs[`shares/${uid}/to/${uidB}`].fields.pkg = { stringValue: seal({ v: 1, at: '2026-09-30T15:30:00Z', name: 'Main Portfolio', full: true, docs: snapDocs }) };
    await F.$t('account-menu').click(); await F.$t('account-friends').click(); await F.$t('friend-view').click(); await F.$t('profile-sheet').waitFor({ timeout: 30000 });
    const sheet2 = await F.$t('profile-holdings').textContent();
    check("an older copy (the documents themselves) still opens as a profile, made on this side", new RegExp(topSym).test(sheet2) && noAmounts(await F.$t('profile-sheet').textContent()), sheet2.slice(0, 120));
    await F.$t('profile-close').click();
    // the profile the email job makes (tools/profile.js, sealed by Python) opens the same way
    FB.docs[`shares/${uid}/to/${uidB}`].fields.pkg = { stringValue: seal({ v: 2, at: '2026-09-30T15:30:00Z', name: 'Main Portfolio', profile: synProf }) };
    await F.$t('account-menu').click(); await F.$t('account-friends').click(); await F.$t('friend-view').click(); await F.$t('profile-sheet').waitFor({ timeout: 30000 });
    check("a profile made by the email job's code opens on the page", new RegExp(topSym).test(await F.$t('profile-holdings').textContent()));
    await F.$t('profile-close').click(); await F.page.waitForTimeout(300);
    // a broken or hostile copy: markup in any field never runs, wrong types never break the page
    const evil = '<img src=x onerror="window.__pwned=1">';
    await F.page.evaluate(() => { window.__pwned = 0; });
    FB.docs[`shares/${uid}/to/${uidB}`].fields.pkg = { stringValue: seal({ v: 2, at: evil, name: evil, profile: Object.assign({}, synProf, { name: evil, handle: evil,
      stats: { closed: evil, avgHold: evil, winRate: evil }, months: 'not a list', trades: [{ d: 5 }, null, { d: '2026-09-01', side: evil, kind: evil, s: evil, n: evil, ret: evil }],
      holdings: [{ s: evil, n: evil, sec: evil, w: evil }], sectors: [{ sec: evil, w: 0.5 }] }) }) };
    await F.$t('account-menu').click(); await F.$t('account-friends').click(); await F.$t('friend-view').click(); await F.$t('profile-sheet').waitFor({ timeout: 30000 });
    await F.page.waitForTimeout(800);
    check('a hostile copy: nothing in it runs and no markup gets in, the sheet still opens', await F.page.evaluate(() => window.__pwned) === 0
      && (await F.page.locator('#pd-sheet img').count()) === 0 && await F.$t('profile-sheet').isVisible());
    await F.$t('profile-close').click(); await F.page.waitForTimeout(300);
    await E.$t('account-menu').click(); await E.$t('account-friends').click(); await E.$t('friend-remove').waitFor();
    E.page.once('dialog', (d) => d.accept());
    await E.$t('friend-remove').click();
    check('removing a friend deletes both sides and both copies', await until(() => !FB.docs[`links/${uid}/with/${uidB}`] && !FB.docs[`links/${uidB}/with/${uid}`] && !FB.docs[`shares/${uid}/to/${uidB}`] && !FB.docs[`shares/${uidB}/to/${uid}`]));
    await E.$t('friends-back').click(); await E.$t('account-back').click();
    // ---- 8b. friends by @username: no email needed ----
    await F.$t('account-menu').click(); await F.$t('account-friends').click(); await F.$t('my-handle').waitFor({ timeout: 15000 });
    check('Friends shows your own @username, to copy or change', (await F.$t('my-handle').textContent()) === '@sara' && await F.$t('my-handle-copy').isVisible());
    await F.$t('friend-email').fill('@nobody_here'); await F.$t('friend-add').click();
    await F.page.waitForFunction(() => /Nobody has the username/.test((document.querySelector('#lock .lk-err') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => {});
    check('an unknown @username is refused, saying so', /Nobody has the username @nobody_here/.test(await F.lockErr()));
    await F.$t('friend-email').fill('@Omar'); await F.$t('friend-add').click();
    await F.$t('friend-sent').waitFor({ timeout: 15000 }).catch(() => {});
    const sideF = (FB.docs[`links/${uidB}/with/${uid}`] || {}).fields, sideE = (FB.docs[`links/${uid}/with/${uidB}`] || {}).fields;
    check("a request to @omar: the asker's side names the username and no email; the other side shows @sara",
      sv(sideF, 'status') === 'sent' && sv(sideF, 'handle') === 'omar' && !sv(sideF, 'email') && sv(sideE, 'status') === 'received' && sv(sideE, 'handle') === 'sara');
    check('the waiting request shows @omar, not an email', /@omar/.test(await F.$t('friend-sent').textContent()));
    await F.shot('friends-handle');
    await F.$t('friends-back').click(); await F.$t('account-back').click();
    await E.$t('account-menu').click(); await E.$t('account-friends').click(); await E.$t('friend-accept').waitFor({ timeout: 15000 });
    check('the request shows who asked by @username', /@sara/.test(await E.$t('friend-received').textContent()));
    await E.$t('friend-accept').click(); await E.$t('friend-friends').waitFor({ timeout: 20000 }).catch(() => {});
    check("accepting adds the accepter's own email to the asker's side, so a later username change cannot break it",
      sv(FB.docs[`links/${uidB}/with/${uid}`].fields, 'status') === 'friends' && sv(FB.docs[`links/${uidB}/with/${uid}`].fields, 'email') === EMAIL && await until(() => FB.docs[`shares/${uid}/to/${uidB}`]));
    // Omar changes his username: the old one is freed, the friendship keeps working
    await E.$t('my-handle-change').click(); await E.$t('my-handle-input').fill('omar_k'); await E.$t('my-handle-save').click();
    await E.page.waitForFunction(() => (document.querySelector('[data-testid=my-handle]') || {}).textContent === '@omar_k', null, { timeout: 15000 }).catch(() => {});
    check('changing your username takes the new one and frees the old one', hOf('omar_k') === uid && !FB.docs['handles/omar'] && sv(FB.docs['status/' + uid].fields, 'handle') === 'omar_k');
    await E.$t('friends-back').click(); await E.$t('account-back').click();
    await F.$t('account-menu').click(); await F.$t('account-friends').click(); await F.$t('my-handle-change').click(); await F.$t('my-handle-input').fill('omar_k'); await F.$t('my-handle-save').click();
    await F.page.waitForFunction(() => /is taken/.test((document.querySelector('#lock .lk-err') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => {});
    check("a username someone else holds is refused (\"@omar_k is taken\")", /@omar_k is taken/.test(await F.lockErr()) && hOf('omar_k') === uid && hOf('sara') === uidB);
    delete FB.docs[`shares/${uidB}/to/${uid}`];
    await F.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pd.share.')).forEach((k) => localStorage.removeItem(k)));   // forget "sent recently"
    await F.$t('friends-back').click(); await F.$t('account-friends').click(); await F.$t('friend-view').waitFor({ timeout: 15000 });
    check("after the username change Sara still shares with Omar (checked by his email now)", await until(() => FB.docs[`shares/${uidB}/to/${uid}`]));
    await F.$t('friend-remove').waitFor(); F.page.once('dialog', (d) => d.accept()); await F.$t('friend-remove').click();
    await until(() => !FB.docs[`links/${uid}/with/${uidB}`]);
    await F.$t('friends-back').click(); await F.$t('account-back').click();
    // Sara asks again, so the reset below has a friend link to clean up
    await F.$t('account-menu').click(); await F.$t('account-friends').click(); await F.$t('friend-email').fill(EMAIL); await F.$t('friend-add').click();
    await until(() => FB.docs[`links/${uid}/with/${uidB}`]);

    // ---- 9. admin ----
    const G = await device('G');
    await signUp(G, 'Khaled', OWNER_EMAIL, 'owner pass 777');
    const tokG0 = identity('signInWithPassword', { email: OWNER_EMAIL, password: 'owner pass 777' })[1].idToken;
    await G.$t('owner-main-hint').waitFor({ timeout: 15000 }).catch(() => {});
    check("the owner's own sign-in account (no trades) says it is not the portfolio and offers the main one",
      await G.$t('owner-main-hint').isVisible() && /Open .*Portfolio/.test(await G.$t('owner-open-main').textContent()));
    await G.shot('owner-hint');
    // from the account, "Open <main>" asks for the setup key ONCE, keeps it in the account and opens the main portfolio here
    const H1 = await device('H1');
    await H1.page.goto(ORIGIN + '/index.html'); await H1.$t('live-signin').waitFor({ timeout: 30000 }); await H1.$t('live-signin').click();
    await H1.$t('signin-email').fill(OWNER_EMAIL); await H1.$t('signin-password').fill('owner pass 777'); await H1.$t('signin-submit').click();
    await H1.lockHidden(60000).catch(() => {}); if (await H1.$t('live-bio-skip').count()) await H1.$t('live-bio-skip').click(); await H1.lockHidden().catch(() => {});
    await H1.$t('owner-open-main').waitFor({ timeout: 20000 }); await H1.$t('owner-open-main').click();
    await H1.$t('mainkey-setup-key').waitFor({ timeout: 15000 });
    await H1.$t('mainkey-setup-key').fill('WRONG-WRONG-WRONG-WRONG'); await H1.$t('mainkey-submit').click();
    await H1.page.waitForFunction(() => /not right/.test((document.querySelector('#lock .lk-err') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => {});
    check('from the account: a wrong setup key is refused', /not right/.test(await H1.lockErr()));
    await H1.$t('mainkey-setup-key').fill(fs.readFileSync(path.join(TMP, 'mailsec', 'setup_key.txt'), 'utf8').trim()); await H1.$t('mainkey-submit').click();
    await H1.$t('live-new-password').waitFor({ timeout: 20000 });
    await H1.$t('live-new-password').fill('owner pass 777'); await H1.$t('live-new-password-repeat').fill('owner pass 777'); await H1.$t('live-password-continue').click();
    await H1.lockHidden(60000).catch(() => {}); if (await H1.$t('live-bio-skip').count()) await H1.$t('live-bio-skip').click(); await H1.lockHidden().catch(() => {});
    await H1.page.waitForTimeout(800);
    check('from the account: the setup key once opens the main portfolio here, and the account now holds its key (sealed)',
      /Demo Portfolio/.test(await H1.page.locator('#pf-name-text').textContent()) && !!FB.docs['users/' + FB.byEmail[OWNER_EMAIL].uid].fields.mainKey
      && (await H1.page.evaluate(() => JSON.parse(localStorage.getItem('pd.accounts') || '[]').length)) === 0);
    check('before verifying the email, the owner cannot list accounts', firestore('GET', FSU + 'status', { authorization: 'Bearer ' + tokG0 })[0] === 403);
    check('an ordinary account can never list accounts', firestore('GET', FSU + 'status', { authorization: 'Bearer ' + tokB })[0] === 403);
    await G.$t('account-menu').click();
    await G.page.waitForTimeout(300);
    check("the owner's account menu hides Thndr emails and Email updates (the main portfolio does those)", !(await G.$t('account-gmail').isVisible()) && !(await G.$t('account-email').isVisible()) && await G.$t('account-owner-note').isVisible());
    await G.$t('account-admin').click();
    await G.$t('admin-verify-send').waitFor();
    check('the admin screen asks the owner to verify the email first', await G.$t('admin-verify-done').isVisible());
    const omarStatus = FB.docs['status/' + uid]; delete FB.docs['status/' + uid];   // an account that has not opened the site since the admin page started
    await G.$t('admin-verify-send').click(); await G.page.waitForTimeout(300); FB.byEmail[OWNER_EMAIL].verified = true; await G.$t('admin-verify-done').click();
    await G.$t('admin-row').first().waitFor({ timeout: 20000 }).catch(() => {});
    const adminText = await G.page.locator('#lock').textContent();
    check('the admin list shows everyone who signed up (also one who has not opened the site since), with names and emails, no figures', (await G.$t('admin-row').count()) === 3 && /Sara/.test(adminText) && /Omar/.test(adminText) && /sara@example\.com/.test(adminText) && /3 people have signed up/.test(adminText) && !/10,000/.test(adminText), `${await G.$t('admin-row').count()} rows`);
    FB.docs['status/' + uid] = omarStatus;
    await G.shot('admin');
    await G.page.locator('[data-testid=admin-row]', { hasText: 'Sara' }).locator('[data-testid=admin-reset]').click();
    await G.$t('admin-reset-confirm').fill('reset'); await G.$t('admin-reset-go').click();
    const gone = await until(() => !FB.docs[`users/${uidB}`] && !FB.docs['handles/sara'] && !Object.keys(FB.docs).some((k) => k.includes(uidB) || k === 'directory/' + EMAIL_B), 20000);
    check('a reset deletes everything of the account (documents, friends, copies, directory, @username, status) but not its sign-in', gone && !!FB.users[uidB], Object.keys(FB.docs).filter((k) => k.includes(uidB)).join(','));
    await F.page.reload(); await F.$t('live-password').waitFor({ timeout: 30000 });
    await F.$t('live-password').fill(PWB); await F.$t('live-password-submit').click();
    await F.page.waitForFunction(() => /reset by the site owner/.test((document.querySelector('#lock .lk-err') || {}).textContent || ''), null, { timeout: 30000 }).catch(() => {});
    check('a device still signed in to a reset account is sent to sign in again, not into an empty portfolio', /reset by the site owner/.test(await F.lockErr()) && !FB.docs['status/' + uidB]);
    const H = await device('H');
    await H.page.goto(ORIGIN + '/index.html'); await H.$t('live-signin').click();
    await H.$t('signin-email').fill(EMAIL_B); await H.$t('signin-password').fill(PWB); await H.$t('signin-submit').click();
    await H.$t('restart-name').waitFor({ timeout: 60000 }).catch(() => {});
    check('after a reset, signing in offers to start again', await H.$t('restart-name').isVisible());
    await H.$t('restart-name').fill('Sara'); await H.$t('restart-go').click(); await H.$t('recovery-code').waitFor({ timeout: 60000 });
    await H.$t('recovery-saved').check(); await H.$t('recovery-continue').click(); await H.$t('onboard-skip').click();
    await H.$t('gmail-skip').waitFor({ timeout: 60000 }); await H.$t('gmail-skip').click();
    await H.lockHidden(60000).catch(() => {}); if (await H.$t('live-bio-skip').count()) await H.$t('live-bio-skip').click();
    check('starting again makes a fresh portfolio with the same sign-in', !!FB.docs[`users/${uidB}`] && /Sara/.test(await H.page.locator('#pf-name-text').textContent()));
    // the owner deletes the account: data at once, the sign-in the next time it is used
    await G.$t('admin-back').click(); await G.$t('account-admin').click(); await G.$t('admin-row').first().waitFor({ timeout: 20000 }).catch(() => {});
    await G.page.locator('[data-testid=admin-row]', { hasText: 'Sara' }).locator('[data-testid=admin-delete]').click();
    await G.$t('admin-reset-confirm').fill('delete'); await G.$t('admin-reset-go').click();
    await until(() => !FB.docs[`users/${uidB}`], 20000);
    await G.$t('admin-deleted').waitFor({ timeout: 20000 }).catch(() => {});
    check('"Delete account" on the admin page wipes everything and marks the sign-in for removal', !Object.keys(FB.docs).some((k) => k.includes(uidB) && k !== 'deleted/' + uidB) && !!FB.docs['deleted/' + uidB] && /sara@example\.com/.test(await G.$t('admin-deleted').textContent()));
    await G.shot('admin-deleted');
    await H.page.reload(); await H.$t('live-password').waitFor({ timeout: 30000 });
    await H.$t('live-password').fill(PWB); await H.$t('live-password-submit').click();
    await H.$t('gone-screen').waitFor({ timeout: 30000 }).catch(() => {});
    check('the deleted account\'s next use removes its own sign-in and says so', await H.$t('gone-screen').isVisible() && !FB.users[uidB] && !FB.docs['deleted/' + uidB]);
    // an account deletes itself
    const I = await device('I');
    await signUp(I, 'Tariq', 'tariq@example.com', 'green door 44');
    const uidT = FB.byEmail['tariq@example.com'].uid;
    await I.$t('account-menu').click(); await I.$t('account-delete').click();
    await I.$t('delete-confirm').fill('DELETE'); await I.$t('delete-go').click();
    await I.$t('live-signup').waitFor({ timeout: 30000 }).catch(() => {});
    check('"Delete my account" removes the sign-in and everything else', !FB.users[uidT] && !Object.keys(FB.docs).some((k) => k.includes(uidT)) && await I.$t('live-signup').isVisible());

    // ---- 10. one place: the owner's main portfolio carries the site account (no second portfolio) ----
    await G.page.goto(ORIGIN + '/index.html'); await G.$t('live-switch').waitFor({ timeout: 30000 }); await G.$t('live-switch').click();
    await G.$t('live-setup-key-list').click(); await G.$t('live-pick-khaled').click();
    await G.$t('live-setup-key').fill(fs.readFileSync(path.join(TMP, 'mailsec', 'setup_key.txt'), 'utf8').trim()); await G.$t('live-setup-submit').click();
    await G.$t('live-new-password').fill('main device 99'); await G.$t('live-new-password-repeat').fill('main device 99'); await G.$t('live-password-continue').click();
    await G.lockHidden(60000).catch(() => {}); if (await G.$t('live-bio-skip').count()) await G.$t('live-bio-skip').click(); await G.lockHidden();
    await G.page.waitForTimeout(600);
    check('the main portfolio opens with its setup key', /Demo Portfolio/.test(await G.page.locator('#pf-name-text').textContent()));
    await G.$t('account-menu').click(); await G.$t('link-email').waitFor();
    await G.$t('link-email').fill(OWNER_EMAIL); await G.$t('link-password').fill('owner pass 777'); await G.$t('link-go').click();
    await G.$t('link-signout').waitFor({ timeout: 30000 }).catch(() => {});
    check('signing in from the main portfolio links the site account and removes its separate entry here',
      await G.$t('account-friends').isVisible() && await G.$t('account-admin').isVisible() && (await G.page.evaluate(() => JSON.parse(localStorage.getItem('pd.accounts') || '[]').length)) === 0);
    await G.shot('linked-account');
    check('linking also keeps the main portfolio\'s key in the account, sealed (one login from now on)',
      !!(FB.docs['users/' + FB.byEmail[OWNER_EMAIL].uid] && FB.docs['users/' + FB.byEmail[OWNER_EMAIL].uid].fields.mainKey) && !/"pk8"/.test(JSON.stringify(FB.docs['users/' + FB.byEmail[OWNER_EMAIL].uid].fields.mainKey)));
    // ---- 10b. one login: on a brand-new device, the account's email and password open the MAIN portfolio ----
    const H2 = await device('H2');
    await H2.page.goto(ORIGIN + '/index.html'); await H2.$t('live-signin').waitFor({ timeout: 30000 }); await H2.$t('live-signin').click();
    await H2.$t('signin-email').fill(OWNER_EMAIL); await H2.$t('signin-password').fill('owner pass 777'); await H2.$t('signin-submit').click();
    await H2.lockHidden(60000).catch(() => {}); if (await H2.$t('live-bio-skip').count()) await H2.$t('live-bio-skip').click(); await H2.lockHidden().catch(() => {});
    await H2.page.waitForTimeout(800);
    check('one login: email and password on a new device open the main portfolio directly (no setup key, no empty account)',
      /Demo Portfolio/.test(await H2.page.locator('#pf-name-text').textContent()) && (await H2.page.evaluate(() => JSON.parse(localStorage.getItem('pd.accounts') || '[]').length)) === 0
      && !(await H2.$t('owner-main-hint').count()));
    await H2.$t('account-menu').click(); await H2.$t('account-friends').waitFor({ timeout: 15000 });
    check('... with the account inside it (Friends and Admin under Account)', await H2.$t('account-friends').isVisible() && await H2.$t('link-signout').isVisible());
    await H2.$t('account-back').click();
    await H2.page.reload(); await H2.$t('live-password').waitFor({ timeout: 30000 }).catch(() => {});
    check('... and the next time this device opens it with the same password', await H2.$t('live-password').isVisible());
    await H2.$t('live-password').fill('owner pass 777'); await H2.$t('live-password-submit').click(); await H2.lockHidden(30000).catch(() => {});
    check('... which unlocks it', /Demo Portfolio/.test(await H2.page.locator('#pf-name-text').textContent()) && await H2.page.evaluate(() => document.getElementById('lock').hidden));
    await G.$t('account-friends').click(); await G.$t('friend-email').fill(EMAIL); await G.$t('friend-add').click();
    await G.$t('friend-sent').waitFor({ timeout: 15000 }).catch(() => {});
    await E.$t('account-menu').click(); await E.$t('account-friends').click(); await E.$t('friend-accept').waitFor({ timeout: 15000 }); await E.$t('friend-accept').click();
    await E.$t('friend-friends').waitFor({ timeout: 20000 }).catch(() => {});
    await G.$t('friends-back').click(); await G.$t('account-friends').click(); await G.$t('friend-view').waitFor({ timeout: 15000 });
    await G.$t('friend-view').click(); await G.$t('profile-sheet').waitFor({ timeout: 30000 });
    check("from the main portfolio, a friend's profile opens", /Omar/.test(await G.$t('profile-name').textContent()));
    await G.$t('profile-close').click(); await G.page.waitForTimeout(300);
    // the top-left menu is the friends hub: you and your friends ranked by the return over the page's period, tap to view
    await G.page.click('#pf-name'); await G.$t('hub-me').waitFor({ timeout: 10000 });
    await G.page.waitForFunction(() => { const f = document.querySelector('[data-testid=hub-friend]'); return f && /Month/.test(f.textContent); }, null, { timeout: 30000 }).catch(() => {});
    const hubText = await G.page.locator('#pf-menu').textContent();
    check('the hub lists you and your friend, ranked over the picked period (All time), with this month and this year', /Demo Portfolio/.test(hubText) && /Omar/.test(hubText) && /Friends · All time/.test(hubText) && /%/.test(await G.$t('hub-friend').textContent()) && /Month .*This year/.test(await G.$t('hub-me').textContent()), hubText.slice(0, 200));
    await G.shot('hub');
    await G.$t('hub-friend').click(); await G.$t('profile-sheet').waitFor({ timeout: 15000 }).catch(() => {});
    check("tapping a friend in the hub opens their profile", /Omar/.test(await G.$t('profile-name').textContent()));
    await G.$t('profile-close').click();
    await G.page.click('#pf-name'); await G.$t('hub-me').click(); await G.$t('profile-sheet').waitFor({ timeout: 15000 }).catch(() => {});
    check('tapping yourself in the hub shows your own profile, as friends see it', /what your friends see/.test(await G.$t('profile-sheet').textContent()) && noAmounts(await G.$t('profile-sheet').textContent()));
    await G.page.waitForTimeout(600); await G.shot('my-profile');
    await G.$t('profile-close').click();
    // the same ranking on the Overview tab
    await G.page.click('#tab-overview'); await G.$t('friends-panel').waitFor({ timeout: 10000 });
    await G.page.waitForFunction(() => { const f = document.querySelector('[data-testid=panel-friend]'); return f && /Month/.test(f.textContent); }, null, { timeout: 30000 }).catch(() => {});
    check('the Overview tab shows the friends ranking with returns', /Omar/.test(await G.$t('panel-friend').textContent()) && /%/.test(await G.$t('panel-friend').textContent()) && /All time/.test(await G.$t('panel-me').textContent()));
    await G.shot('overview-friends');
    // the cards follow the period picked at the top: This year's figure (shown underneath) becomes the big number
    const ytdBelow = ((await G.$t('panel-me').textContent()).match(/This year ([+−]?[\d.]+%|—)/) || [])[1];
    await G.page.click('#period [data-pt="YTD"]'); await G.$t('friends-panel').waitFor({ timeout: 10000 });
    await G.page.waitForFunction(() => /Friends · This year/.test((document.getElementById('pd-friends') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => {});
    const picked = await G.page.locator('[data-testid=panel-me] [data-testid=panel-picked]').textContent();
    check('picking This year at the top switches the friends cards to this year (the big number is the year-to-date return)',
      /Friends · This year/.test(await G.$t('friends-panel').textContent()) && ytdBelow && picked.trim() === ytdBelow && /All time/.test(await G.$t('panel-me').textContent()), `${ytdBelow} vs ${picked}`);
    // This quarter and Calendar year head the page with their whole span, like "Oct 2026 – Dec 2026"
    await G.page.click('#period [data-pt="Quarter"]'); await G.page.waitForTimeout(500);
    const qLabel = (await G.$t('period-label').textContent()).trim();
    await G.page.click('#period [data-pt="Year"]'); await G.page.waitForTimeout(500);
    const yLabel = (await G.$t('period-label').textContent()).trim();
    const [qa, qb] = qLabel.split(' – '), MONS = ['Jan', 'Apr', 'Jul', 'Oct'];
    check('This quarter shows the whole quarter at the top (e.g. Oct 2026 – Dec 2026), Calendar year the whole year',
      /^[A-Z][a-z]{2} \d{4} – (Mar|Jun|Sep|Dec) \d{4}$/.test(qLabel) && MONS[['Mar', 'Jun', 'Sep', 'Dec'].indexOf(qb.slice(0, 3))] === qa.slice(0, 3) && /^[A-Z][a-z]{2} \d{4} – Dec \d{4}$/.test(yLabel), `${qLabel} | ${yLabel}`);
    await G.page.click('#period [data-pt="Since Inception"]'); await G.page.waitForTimeout(500);
    await G.page.waitForFunction(() => document.querySelector('[data-testid=friends-feed]'), null, { timeout: 15000 }).catch(() => {});
    const feed = (await G.$t('friends-feed').count()) ? await G.$t('friends-feed').textContent() : '';
    check("the Overview lists the friends' latest trades (who, what, when; a sale's result in %)", /Friends' activity/.test(feed) && /@omar_k (bought|sold)/.test(feed) && noAmounts(feed), feed.slice(0, 200));
    await G.$t('feed-item').first().click(); await G.$t('profile-sheet').waitFor({ timeout: 15000 }).catch(() => {});
    check("tapping a trade in the feed opens that friend's profile", /Omar/.test(await G.$t('profile-name').textContent()));
    await G.$t('profile-close').click();
    await G.$t('panel-friend').click(); await G.$t('profile-sheet').waitFor({ timeout: 15000 }).catch(() => {});
    check('tapping a friend card on the Overview opens their profile', /Omar/.test(await G.$t('profile-name').textContent()));
    await G.$t('profile-close').click(); await G.page.waitForTimeout(300);
    check('your own page stays open underneath', /Demo Portfolio/.test(await G.page.locator('#pf-name-text').textContent()));
    // another portfolio on this device can be removed from the list by the user
    await G.page.evaluate(() => localStorage.setItem('pd.dev.yassin', JSON.stringify({ v: 3, ct: 'x' })));
    await G.page.click('#pf-name'); await G.$t('forget-yassin').waitFor({ timeout: 10000 });
    G.page.once('dialog', (d) => d.accept());
    await G.$t('forget-yassin').click(); await G.page.waitForTimeout(500);
    check('"Remove" takes a portfolio off this device\'s list (after a confirmation)', !(await G.$t('switch-yassin').count()) && (await G.page.evaluate(() => localStorage.getItem('pd.dev.yassin'))) === null);
    await G.page.keyboard.press('Escape');
    await G.page.reload(); await G.$t('live-password').waitFor({ timeout: 30000 }); await G.$t('live-password').fill('main device 99'); await G.$t('live-password-submit').click();
    await G.lockHidden(60000).catch(() => {}); await G.page.waitForTimeout(600);
    await G.$t('account-menu').click(); await G.$t('account-admin').waitFor({ timeout: 15000 }).catch(() => {});
    check('after unlocking the main portfolio again, Friends and Admin are right there (the link is remembered)', await G.$t('account-friends').isVisible() && await G.$t('account-admin').isVisible());
    await G.$t('account-admin').click(); await G.$t('admin-row').first().waitFor({ timeout: 20000 }).catch(() => {});
    check('Admin opens from the main portfolio', (await G.$t('admin-row').count()) >= 2);

    // ---- 11. "Build it from my Thndr emails": no typing at sign-up; the job builds it (test_account_mail.py) ----
    const K = await device('K');
    await K.page.goto(ORIGIN + '/index.html'); await K.$t('live-signup').click();
    await K.$t('signup-name').fill('Nour'); await K.$t('signup-email').fill('nour@example.com'); await K.$t('signup-password').fill('violet pier 31'); await K.$t('signup-password-repeat').fill('violet pier 31');
    await K.$t('signup-submit').click(); await K.$t('recovery-code').waitFor({ timeout: 60000 }); await K.$t('recovery-saved').check(); await K.$t('recovery-continue').click();
    await K.$t('onboard-history').waitFor(); await K.shot('onboard-history');
    await K.$t('onboard-history').click(); await K.$t('gmail-connect').waitFor({ timeout: 60000 });
    check('"Build it from my Thndr emails" goes straight to connecting Gmail, and says what will happen', /builds your portfolio from them/.test(await K.page.locator('#lock').textContent()));
    await K.$t('gmail-address').fill('nour.test@example.com'); await K.$t('gmail-app-password').fill('abcd efgh ijkl mnop');
    await K.$t('gmail-connect').click(); await K.$t('gmail-done').waitFor({ timeout: 30000 }).catch(() => {});
    check('connected: it says the portfolio is being built now, in about 10 minutes, with an email when ready', /about 10 minutes/.test(await K.page.locator('#lock').textContent()) && /email you when it is ready/.test(await K.page.locator('#lock').textContent()));
    await K.$t('gmail-done').click(); await K.lockHidden(60000).catch(() => {}); if (await K.$t('live-bio-skip').count()) await K.$t('live-bio-skip').click();
    await K.page.click('#tab-overview'); await K.$t('history-pending').waitFor({ timeout: 15000 }).catch(() => {});
    check('until it is built, the Overview says so (and shows the friends section, without the period pickers)', await K.$t('history-pending').isVisible() && await K.$t('friends-panel').isVisible() && (await K.page.innerHTML('#period')).trim() === '');
    await K.shot('history-pending');
    const nuid = FB.byEmail['nour@example.com'].uid, npk = FB.docs['mail/' + nuid] && FB.docs['mail/' + nuid].fields.pkg.stringValue;
    const nset = npk ? JSON.parse(sh('python3', ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'src/jobs'))}); import store, run_account_mail as r
k = store.unlock(${JSON.stringify(path.join(SITE, 'p/khaled/keys.json'))}, open(${JSON.stringify(path.join(TMP, 'mailsec', 'setup_key.txt'))}).read().strip())
i = json.loads(sys.stdin.read()); p = r.open_mail_pkg(k, i["pkg"]); priv, _ = r.account_key(p["pk8"])
print(json.dumps(json.loads(store.unseal(priv, i["settings"]).decode())["data"]))`], { input: JSON.stringify({ pkg: npk, settings: FB.docs[`users/${nuid}/docs/portfolio__settings`].fields.blob.stringValue }), stdio: ['pipe', 'pipe', 'inherit'] })) : {};
    check('the settings ask the job for a history import (no start date yet, no Thndr name to type)', (nset.historyImport || {}).status === 'pending' && !nset.trackFrom && !(nset.account || {}).holder, JSON.stringify({ h: nset.historyImport, t: nset.trackFrom, a: nset.account }));
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
