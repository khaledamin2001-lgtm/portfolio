#!/usr/bin/env node
/* Read-only export of ONE site account's portfolio for its owner's own assistant (e.g. KAIRO): signs in with the
   account's email and password exactly like the site, opens the account's key with the password, reads the account's
   documents and the shared market file, runs the site's own engine (engine.js + engine2.js, next to this file) and
   prints one JSON object: holdings, cash, value, returns, months and the full trade list.
     PD_EMAIL=you@example.com PD_PASSWORD='…' node read_account.js [--no-trades] [--today YYYY-MM-DD]
   Only reads: one sign-in call, then Firestore GETs of the account's own documents and the members key the site reads
   (shared/members). Nothing is written, created or changed, and the Thndr emails login (sync/gmail) is never opened.
   It sees only this one account: the Firestore rules give a sign-in its own documents and nothing else.
   The password comes from the environment, never the command line. Needs Node 18 or newer, and the three files
   read_account.js, engine.js and engine2.js from src/tools/ in one folder.
   Amounts are EGP. Prices are the shared market file's (the latest EGX close, published after each session); the site
   adds 15-minute delayed prices during the session on top. Exit 0 with {"ok": true, ...}, 1 with {"ok": false, "error"}.
   Tests: PD_AUTH_URL, PD_FS_URL and PD_SITE_URL point it at a fake Firebase and site (src/tests/test_read_account.js). */
'use strict';
const zlib = require('zlib');
const { webcrypto: crypto } = require('crypto');
const PE = require('./engine.js'); global.PE = PE;
const PA = require('./engine2.js');

const API_KEY = 'AIzaSyAYvh69A5VWAgmhKXt07RTgLpB_1hYBjA8', PROJECT = 'portfolio-desk-4d14a';
const AUTH = process.env.PD_AUTH_URL || 'https://identitytoolkit.googleapis.com/v1';
const FS = process.env.PD_FS_URL || `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const SITE = (process.env.PD_SITE_URL || 'https://khaledamin2001-lgtm.github.io/portfolio').replace(/\/+$/, '');
const FILE_LABEL = 'portfolio-file-v1', DATA_LABEL = 'portfolio-data-v1', KEY_AD = 'portfolio-key-v1';
const MARKET_COLLS = new Set(['market', 'history', 'bench']), PRIVATE_COLLS = new Set(['sync']);   // never opened
const enc = new TextEncoder(), dec = new TextDecoder();
const ub64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const flag = (k) => process.argv.includes('--' + k);
const r2 = (x) => (typeof x === 'number' && isFinite(x) ? Math.round(x * 100) / 100 : null);
const r4 = (x) => (typeof x === 'number' && isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);

async function getJSON(url, opt) {
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j.error && j.error.message) || `HTTP ${r.status}`), { status: r.status });
  return j;
}
async function signIn(email, password) {
  try {
    return await getJSON(`${AUTH}/accounts:signInWithPassword?key=${API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  } catch (e) {
    throw new Error(/INVALID_LOGIN_CREDENTIALS|EMAIL_NOT_FOUND|INVALID_PASSWORD/.test(e.message) ? 'Wrong email or password' : 'Sign-in failed: ' + e.message);
  }
}
const fsGet = (tok, path, query) => getJSON(`${FS}/${path}${query ? '?' + query : ''}`, { headers: { Authorization: 'Bearer ' + tok } });
const fStr = (doc, k) => (doc && doc.fields && doc.fields[k] && doc.fields[k].stringValue) || null;

// the site's unwrapKey: PBKDF2-SHA256 of the password (trimmed, as the site keeps it) -> AES-GCM over the PKCS8 key
async function unwrapKey(w, secret) {
  const k0 = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  const k = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: ub64(w.salt), iterations: w.iter }, k0, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(w.iv), additionalData: enc.encode(KEY_AD) }, k, ub64(w.ct)));
}
// the site's unseal: ECDH P-256 with the envelope's ephemeral key -> HKDF-SHA256 (salt = that key, info = label) -> AES-GCM
async function unseal(e, label, pk8) {
  const priv = await crypto.subtle.importKey('pkcs8', pk8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const epk = ub64(e.epk);
  const pub = await crypto.subtle.importKey('raw', epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: enc.encode(label) }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(e.iv), additionalData: enc.encode(label) }, key, ub64(e.ct)));
}
// month-end market fields the page fills into the marks from the shared market file (lock.js macroMarks)
function macroMarks(docs, today) {
  const mk = docs['portfolio/marks'], mac = docs['market/macro'];
  if (!mk || !mk.months || !mac) return;
  const cur = today.slice(0, 7), num = (x) => typeof x === 'number' && isFinite(x);
  for (const [M, v] of Object.entries(mk.months)) {
    if (!v || M >= cur) continue;
    if (!num(v.benchClose) && num((mac.benchClose || {})[M])) v.benchClose = mac.benchClose[M];
    if (!num(v.cpi) && num((mac.cpiMoM || {})[M])) { v.cpi = mac.cpiMoM[M]; v.cpiSource = mac.cpiSource || null; }
    if (!num(v.usdegp) && num((mac.fxEom || {})[M])) { v.usdegp = mac.fxEom[M]; v.usdegpSource = mac.fxSource || null; }
    if (!num(v.cashRate) && num((mac.cashRate || {})[M])) { v.cashRate = mac.cashRate[M]; v.cashRateSource = mac.cashRateSource || null; }
  }
}

async function readAccount(email, password) {
  const a = await signIn(email, password), tok = a.idToken, uid = a.localId;
  const user = await fsGet(tok, `users/${uid}`);
  const keys = JSON.parse(fStr(user, 'keys') || 'null');
  if (!keys || !keys.pwrap) throw new Error('This account has no portfolio key yet: open the site once and finish signing up');
  let pk8;
  try { pk8 = await unwrapKey(keys.pwrap, String(password).trim()); } catch (e) { throw new Error('The password signs in but does not open the portfolio key (was the password changed on another device? Sign in on the site once)'); }
  const list = [];
  let page = '';
  do {
    const j = await fsGet(tok, `users/${uid}/docs`, 'pageSize=300' + (page ? '&pageToken=' + encodeURIComponent(page) : ''));
    list.push(...(j.documents || []));
    page = j.nextPageToken || '';
  } while (page);
  let market = { exportedAt: null, docs: {} };
  const r = await fetch(`${SITE}/m/market.enc.json?t=${Date.now()}`);
  if (r.ok) {
    const members = ub64(fStr(await fsGet(tok, 'shared/members'), 'pk8'));
    market = JSON.parse(zlib.gunzipSync(Buffer.from(await unseal(await r.json(), DATA_LABEL, members))).toString('utf8'));
  }
  const docs = Object.assign({}, market.docs || {});
  let newest = 0;
  for (const x of list) {
    const id = String(x.name).split('/').pop(), i = id.indexOf('__');
    if (i < 1) continue;
    const c = id.slice(0, i), d = id.slice(i + 2);
    if (MARKET_COLLS.has(c) || PRIVATE_COLLS.has(c)) continue;
    const p = JSON.parse(dec.decode(await unseal(JSON.parse(fStr(x, 'blob')), FILE_LABEL, pk8)));
    docs[c + '/' + d] = p.data;
    newest = Math.max(newest, Date.parse(x.updateTime) || 0);
  }
  return { uid, docs, name: fStr(user, 'name'), marketAt: market.exportedAt || null, savedAt: newest ? new Date(newest).toISOString() : null };
}

function summarize(acct, opts) {
  const today = opts.today || PE.cairoToday();
  const docs = acct.docs;
  macroMarks(docs, today);
  const all = PA.portfolioRun(docs, { type: 'Since Inception' }, { today });
  if (!all) return { ok: true, portfolio: acct.name, empty: true, note: 'No portfolio in this account yet (not set up, or still being built from the Thndr emails)' };
  const ytd = PA.portfolioRun(docs, { type: 'YTD' }, { today });
  const R = all.R, S = R.stats, Y = ytd && ytd.R.stats, pos = R.pos;
  const cash = R.liveCash, securities = pos.mvTotal, value = cash + securities;
  const openCost = pos.open.reduce((a, p) => a + (p.openCost || 0), 0), unreal = pos.open.reduce((a, p) => a + (p.unreal || 0), 0);
  const ret = (s) => (s ? { from: s.range ? s.range.from : undefined, twr: r4(s.twr), annualized: r4(s.annualized), moneyWeighted: r4(s.xirr), benchmarkEGX30: r4(s.benchTwr), vsBenchmark: r4(s.alpha) } : null);
  const out = {
    ok: true,
    portfolio: acct.name || (R.settings && R.settings.name) || null,
    currency: 'EGP',
    asOf: today,
    pricesAsOf: (docs['market/latest'] && (docs['market/latest'].asOf || docs['market/latest'].updatedAt)) || acct.marketAt,
    portfolioSavedAt: acct.savedAt,
    summary: {
      totalValue: r2(value), cash: r2(cash), securities: r2(securities),
      costOfHoldings: r2(openCost), unrealizedPL: r2(unreal), unrealizedPct: openCost ? r4(unreal / openCost) : null,
      realizedPL: r2(pos.rows.reduce((a, p) => a + (p.realized || 0), 0)), dividends: r2(pos.rows.reduce((a, p) => a + (p.divs || 0), 0)),
      deposits: r2(S.deposits), withdrawals: r2(S.withdrawals), openPositions: pos.open.length,
    },
    returns: {
      sinceInception: Object.assign(ret(S), { from: R.settings.inception, to: R.range.to }),
      yearToDate: Y ? Object.assign(ret(Y), { from: ytd.R.range.from, to: ytd.R.range.to }) : null,
      maxDrawdown: r4(S.maxDD), volatility: r4(S.vol), sharpe: r4(S.sharpe), winRate: r4(S.winRate),
    },
    holdings: pos.open.slice().sort((a, b) => (b.mv || 0) - (a.mv || 0)).map((p) => ({
      name: p.name, symbol: p.symbol || null, sector: p.sector, shares: r4(p.open), avgCost: r4(p.avgCost), cost: r2(p.openCost),
      price: r4(p.price), priceDate: p.priceDate, value: r2(p.mv), unrealizedPL: r2(p.unreal), unrealizedPct: p.openCost ? r4(p.unreal / p.openCost) : null,
      weight: r4(p.weight), dividends: r2(p.divs), firstBuy: p.firstBuy, target: p.target || null, stop: p.stop || null,
    })),
    closedPositions: pos.rows.filter((p) => p.status === 'Closed').map((p) => ({ name: p.name, symbol: p.symbol || null, firstBuy: p.firstBuy, lastSell: p.lastSell, realizedPL: r2(p.realized), dividends: r2(p.divs), roi: r4(p.roi) })),
    sectors: Object.fromEntries(Object.entries(pos.open.reduce((m, p) => { m[p.sector] = (m[p.sector] || 0) + (p.weight || 0); return m; }, {})).map(([k, v]) => [k, r4(v)])),
    months: R.months.filter((m) => m.has).map((m) => ({ month: m.month, return: r4(m.ret), benchmarkEGX30: r4(m.bench), value: r2(m.value), live: !!m.live })),
  };
  if (!opts.noTrades) out.transactions = PE.sortLedger(R.ledger).map((t) => ({ date: t.d, type: t.t, asset: t.a || null, shares: t.q ?? null, price: t.p ?? null, amount: r2(t.amt), account: t.acc || null, note: t.note || null }));
  return out;
}

if (require.main === module) {
  (async () => {
    const email = (process.env.PD_EMAIL || '').trim(), password = process.env.PD_PASSWORD || '';
    if (!email || !password) throw new Error('Set PD_EMAIL and PD_PASSWORD (the site sign-in) in the environment');
    const acct = await readAccount(email, password);
    console.log(JSON.stringify(summarize(acct, { today: arg('today') || undefined, noTrades: flag('no-trades') })));
  })().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); process.exit(1); });
}
module.exports = { readAccount, summarize };
