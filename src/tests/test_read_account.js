#!/usr/bin/env node
/* src/tools/read_account.js (the read-only export for an account owner's assistant) against a fake Firebase and site, on
   the synthetic export and throwaway keys: an account is made the way the site makes one (key pair, "pwrap" under the
   password, every document sealed to the account key, the market data sealed to the members key), then the script signs
   in, opens everything and prints holdings, value and returns equal to the engine's own run on the same documents. It
   only ever GETs from Firestore, pages through the document list, never opens sync/* (the Gmail login), and a wrong
   password or an account without a key fails cleanly.
     node src/tests/test_read_account.js <synthetic export dir>   (exit 0 = all pass) */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), zlib = require('zlib'), { execFile } = require('child_process');
const { webcrypto: crypto } = require('crypto');
const TOOLS = path.join(__dirname, '..', 'tools');
const PE = require(path.join(TOOLS, 'engine.js')); global.PE = PE;
const PA = require(path.join(TOOLS, 'engine2.js'));
const DIR = process.argv[2];
if (!DIR || !fs.existsSync(path.join(DIR, 'portfolio', 'settings.json'))) { console.error('usage: test_read_account.js <synthetic export dir>'); process.exit(1); }
let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ' · ' + detail : ''}`); if (!ok) fails++; };
const enc = new TextEncoder(), b64 = (u) => Buffer.from(u).toString('base64');
const EMAIL = 'demo.reader@example.com', PASSWORD = 'correct horse battery', TODAY = '2026-09-24', GMAIL_SECRET = 'zzsecretapppwzz';

async function seal(bytes, label, pubB64) {
  const pub = await crypto.subtle.importKey('raw', Buffer.from(pubB64, 'base64'), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256);
  const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: enc.encode(label) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(label) }, key, bytes);
  return { epk: b64(epk), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}
async function wrapKey(pk8, secret, iter) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const k0 = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  const k = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, k0, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('portfolio-key-v1') }, k, pk8);
  return { kdf: 'PBKDF2-SHA256', iter, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}
async function keyPair() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { pk8: new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey)), pub: b64(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))) };
}
// the export folder as the site's {"coll/doc": data}
function exportDocs(dir) {
  const docs = {};
  for (const c of fs.readdirSync(dir)) {
    const cd = path.join(dir, c);
    if (!fs.statSync(cd).isDirectory()) continue;
    for (const f of fs.readdirSync(cd).filter((x) => x.endsWith('.json'))) { const x = JSON.parse(fs.readFileSync(path.join(cd, f), 'utf8')); docs[c + '/' + f.slice(0, -5)] = x && x.data !== undefined && x.id !== undefined ? x.data : x; }
  }
  return docs;
}
const run = (env, args) => new Promise((res) => execFile('node', [path.join(TOOLS, 'read_account.js'), ...(args || [])], { env: Object.assign({}, process.env, env) }, (err, out) => {
  let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch (e) { /* checked by the caller */ }
  res({ code: err ? err.code : 0, out, j });
}));

(async () => {
  const docs = exportDocs(DIR);
  docs['sync/gmail'] = { address: 'demo@gmail.example', appPassword: GMAIL_SECRET };
  const UID = 'Ureader1', OTHER = 'Uother2', acct = await keyPair(), members = await keyPair();
  const FB = { docs: {}, methods: [], pages: 0, otherRead: 0 };
  FB.docs[`users/${UID}`] = { fields: { keys: { stringValue: JSON.stringify({ v: 3, pub: acct.pub, pwrap: await wrapKey(acct.pk8, PASSWORD, 1000), wrap: await wrapKey(acct.pk8, 'RECOVERYCODE', 1000) }) }, name: { stringValue: "Demo Reader's Portfolio" } } };
  FB.docs[`users/${OTHER}`] = { fields: { name: { stringValue: 'Someone else' } } };
  const market = { exportedAt: '2026-09-24T14:00:00Z', docs: {} };
  let n = 0;
  for (const [k, data] of Object.entries(docs)) {
    const [c, d] = k.split('/');
    if (['market', 'history', 'bench'].includes(c)) { market.docs[k] = data; continue; }
    const blob = await seal(enc.encode(JSON.stringify({ version: 1, updatedAt: '2026-09-24T10:00:00Z', data })), 'portfolio-file-v1', acct.pub);
    FB.docs[`users/${UID}/docs/${c}__${d}`] = { fields: { blob: { stringValue: JSON.stringify(blob) } }, updateTime: `2026-09-24T10:00:${String(n++).padStart(2, '0')}Z` };
  }
  FB.docs['shared/members'] = { fields: { pk8: { stringValue: b64(members.pk8) }, pub: { stringValue: members.pub } } };
  const marketFile = JSON.stringify(Object.assign({ v: 1 }, await seal(zlib.gzipSync(JSON.stringify(market)), 'portfolio-data-v1', members.pub)));

  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x'), send = (st, j) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(typeof j === 'string' ? j : JSON.stringify(j)); };
      if (u.pathname === '/auth/accounts:signInWithPassword') {
        const b = JSON.parse(body || '{}');
        return b.email === EMAIL && b.password === PASSWORD ? send(200, { idToken: 'tok-' + UID, localId: UID, email: EMAIL, refreshToken: 'r', expiresIn: '3600' })
          : b.email === 'nokey@example.com' && b.password === PASSWORD ? send(200, { idToken: 'tok-' + OTHER, localId: OTHER, email: b.email, refreshToken: 'r', expiresIn: '3600' })
            : send(400, { error: { message: 'INVALID_LOGIN_CREDENTIALS' } });
      }
      if (u.pathname === '/site/m/market.enc.json') return send(200, marketFile);
      if (!u.pathname.startsWith('/fs/')) return send(404, {});
      FB.methods.push(req.method);
      const p = decodeURIComponent(u.pathname.slice(4)), uid = (req.headers.authorization || '').replace('Bearer tok-', '');
      // the rules: a sign-in reads only its own users/{uid}/... (and shared/members)
      if (!(p === 'shared/members' || p === `users/${uid}` || p.startsWith(`users/${uid}/`))) { FB.otherRead++; return send(403, { error: { status: 'PERMISSION_DENIED' } }); }
      if (req.method !== 'GET') return send(403, { error: { status: 'PERMISSION_DENIED' } });
      if (p.endsWith('/docs')) {   // a list, 3 per page so the paging is exercised
        const all = Object.keys(FB.docs).filter((k) => k.startsWith(p + '/')).sort(), at = +(u.searchParams.get('pageToken') || 0);
        FB.pages++;
        const out = { documents: all.slice(at, at + 3).map((k) => Object.assign({ name: `projects/x/databases/(default)/documents/${k}` }, FB.docs[k])) };
        if (at + 3 < all.length) out.nextPageToken = String(at + 3);
        return send(200, out);
      }
      return FB.docs[p] ? send(200, Object.assign({ name: p }, FB.docs[p])) : send(404, { error: { status: 'NOT_FOUND' } });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const env = { PD_AUTH_URL: base + '/auth', PD_FS_URL: base + '/fs', PD_SITE_URL: base + '/site', PD_EMAIL: EMAIL, PD_PASSWORD: PASSWORD };
  try {
    const a = await run(env, ['--today', TODAY]), j = a.j || {};
    check('signs in, opens the key with the password and prints ok', a.code === 0 && j.ok === true, a.out.slice(0, 300));
    // the engine's own run on the very same documents (what the site shows)
    const ref = PA.portfolioRun(JSON.parse(JSON.stringify(docs)), { type: 'Since Inception' }, { today: TODAY }).R;
    const refVal = ref.liveCash + ref.pos.mvTotal, near = (x, y) => typeof x === 'number' && Math.abs(x - y) < 0.011;
    check('total value, cash and securities equal the engine\'s run on the same documents', !!j.summary && near(j.summary.totalValue, refVal) && near(j.summary.cash, ref.liveCash) && near(j.summary.securities, ref.pos.mvTotal), JSON.stringify(j.summary));
    check('every open holding is listed with shares, cost, price and value', Array.isArray(j.holdings) && j.holdings.length === ref.pos.open.length && j.holdings.every((h) => h.shares > 0 && h.cost > 0 && h.price > 0 && h.value > 0 && h.priceDate), JSON.stringify((j.holdings || [])[0]));
    check('returns since inception equal the engine\'s TWR', !!j.returns && j.returns.sinceInception.twr === Math.round(ref.stats.twr * 1e4) / 1e4, JSON.stringify(j.returns && j.returns.sinceInception));
    check('months and the full trade list are there', (j.months || []).length >= 3 && (j.transactions || []).length === ref.ledger.length);
    check('the portfolio name comes from the account', j.portfolio === "Demo Reader's Portfolio");
    check('read-only: only GETs reach Firestore, and nothing outside the account is asked for', FB.methods.length > 0 && FB.methods.every((m) => m === 'GET') && FB.otherRead === 0, FB.methods.join(','));
    check('the document list is paged through to the end', FB.pages >= Math.ceil(Object.keys(FB.docs).filter((k) => k.startsWith(`users/${UID}/docs/`)).length / 3));
    check('the Thndr emails login (sync/gmail) is never opened or printed', !a.out.includes(GMAIL_SECRET) && !a.out.includes('demo@gmail.example'));
    const nt = await run(env, ['--today', TODAY, '--no-trades']);
    check('--no-trades leaves the trade list out', nt.j && nt.j.ok && !('transactions' in nt.j));
    const bad = await run(Object.assign({}, env, { PD_PASSWORD: 'wrong password' }));
    check('a wrong password fails cleanly', bad.code === 1 && bad.j && bad.j.ok === false && /Wrong email or password/.test(bad.j.error), bad.out);
    const nokey = await run(Object.assign({}, env, { PD_EMAIL: 'nokey@example.com' }));
    check('an account without a portfolio key fails cleanly', nokey.code === 1 && nokey.j && nokey.j.ok === false && /no portfolio key/.test(nokey.j.error), nokey.out);
    const none = await run(Object.assign({}, env, { PD_EMAIL: '', PD_PASSWORD: '' }));
    check('without PD_EMAIL / PD_PASSWORD it says what to set', none.code === 1 && none.j && /PD_EMAIL/.test(none.j.error));
  } finally { srv.close(); }
  console.log(fails ? `read_account: ${fails} check(s) failed` : 'read_account: all checks passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
