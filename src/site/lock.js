/* Live-site lock, one page for several portfolios — device store v3.
   Each portfolio lives under p/<id>/: its figures are published encrypted (data.enc.json) to that portfolio's public key; the
   matching private key is published only wrapped by the portfolio's one-time setup key (keys.json — v3 files carry no
   password hash; the device password never leaves the device, and a v2 file's `pw` field is ignored).
   Once a device is set up it keeps the private key (PKCS8) in IndexedDB, 'dev:<id>', wrapped by AES-256-GCM under a key
   derived from the device password (PBKDF2-SHA256, 310,000 iterations, a random 16-byte salt per device) with additional
   data 'portfolio-device-v3'; and optionally a second wrapping, 'bio:<id>', under a key derived (HKDF-SHA256, info
   'portfolio-bio-v3') from the WebAuthn PRF output of the device's platform passkey, so Face ID / Touch ID / fingerprint
   really unlocks the key instead of just gating a screen (a device whose passkeys cannot do PRF gets no biometric option).
   localStorage holds only bookkeeping: pd.dev.<id> = { v: 3, tries, at }, pd.bio.v3 = { cred } — no key material, no hash.
   Ten wrong passwords remove the portfolio from the device; failing to download or decrypt the data never does. After a key
   rotation (rotate_keys.py) the device's key no longer matches keys.json's public key: the page says so and the user removes
   the old setup through the explicit "Forget" flow before entering the new setup key.
   Locking (the Lock button, or 5 minutes in the background) drops the key and the decrypted documents from memory and blanks
   the page; unlocking downloads the data again. Devices set up under v2 (private key wrapped by a non-extractable browser
   key, password checked against the published hash) are migrated on first use without the setup key: the key is read with
   the browser key and the user chooses a real password. */
(function(){
  'use strict';
  const MAX_TRIES = 10, RELOCK_MS = 5 * 60e3, REFRESH_MS = 30 * 60e3, PBKDF2_ITER = 310000;
  const CUR_LS = 'pd.current', BIO_LS = 'pd.bio.v3', OLD_BIO_LS = 'pd.bio.v1', LEGACY_LS = 'pd.device.v1';
  const DEV_AD = 'portfolio-device-v3', BIO_INFO = 'portfolio-bio-v3';
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (u) => btoa(String.fromCharCode(...new Uint8Array(u)));
  const ub64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
  const $l = (s) => document.querySelector('#lock ' + s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const UA = navigator.userAgent;
  const bio = (() => { if (/iPhone|iPad/.test(UA)) return 'Face ID'; if (/Macintosh/.test(UA)) return 'Touch ID'; if (/Android/.test(UA)) return 'fingerprint'; if (/Windows/.test(UA)) return 'Windows Hello'; return 'Face ID / fingerprint'; })();
  const ls = { get: (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }, del: (k) => { try { localStorage.removeItem(k); } catch (e) {} } };
  // iOS/iPadOS Safari as a browser tab (not an installed Home Screen app) evicts a site's storage after 7 days without a visit
  const iosSafariTab = () => { const ios = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
    return ios && /Safari/.test(UA) && !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\//.test(UA) && 'standalone' in navigator && navigator.standalone === false; };
  const safariTip = () => (iosSafariTab() ? '<p class="lk-tip" data-testid="live-safari-tip">Tip: add this site to your Home Screen (Share → Add to Home Screen) so Safari keeps it set up. Safari deletes a website\'s saved setup after 7 days without a visit; a Home Screen app keeps it.</p>' : '');

  /* ---------- portfolios ---------- */
  let PORTFOLIOS = [], CUR = null, OPENED = null;   // CUR: {id, name}; OPENED: id whose data is on the page
  const base = () => 'p/' + CUR.id + '/';
  const devLS = () => 'pd.dev.' + CUR.id;

  /* ---------- device storage (per portfolio; the passkey is shared by the device, its PRF salt is per portfolio) ---------- */
  const idb = (mode, fn) => new Promise((res, rej) => { const o = indexedDB.open('pd-lock', 1); o.onupgradeneeded = () => o.result.createObjectStore('k'); o.onerror = () => rej(o.error);
    o.onsuccess = () => { const t = o.result.transaction('k', mode); const r = fn(t.objectStore('k')); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }; });
  const idbGet = (k) => idb('readonly', (s) => s.get(k));
  const idbPut = (k, v) => idb('readwrite', (s) => s.put(v, k));
  const idbDel = async (k) => { try { await idb('readwrite', (s) => s.delete(k)); } catch (e) {} };
  const getDev = () => ls.get(devLS());
  const putDev = (d) => ls.set(devLS(), d);
  const isV3 = (d) => !!d && d.v === 3;
  const isOld = (d) => !!d && d.v !== 3 && !!d.ct;   // v2: {iv, ct, tries, at} in localStorage + a CryptoKey in IndexedDB
  const notSetUp = () => Object.assign(new Error('This device is not set up'), { code: 'not_set_up' });
  // the ONLY callers: MAX_TRIES wrong passwords, and the explicit "Forget this portfolio" flow
  async function forget() { ls.del(devLS()); await idbDel('dev:' + CUR.id); await idbDel('bio:' + CUR.id); }
  async function migrateLegacy() {   // devices set up before the site held more than one portfolio (single-portfolio v1 layout)
    const d = ls.get(LEGACY_LS); if (!d) return;
    try { const dk = await idbGet('device'); if (dk) { await idbPut('dev:khaled', dk); await idbDel('device'); } } catch (e) {}
    ls.set('pd.dev.khaled', { iv: d.iv, ct: d.ct, tries: d.tries || 0, at: d.at });   // old format; select() migrates it to v3
    if (!ls.get(CUR_LS)) ls.set(CUR_LS, 'khaled');
    ls.del(LEGACY_LS);
  }
  async function pwKey(password, salt, usages) {
    const k0 = await crypto.subtle.importKey('raw', enc.encode(password.trim()), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, k0, { name: 'AES-GCM', length: 256 }, false, usages);
  }
  async function storeV3(pk8, password) {   // (re)wrap the private key under the password; replaces any older store for this portfolio
    const salt = rnd(16), iv = rnd(12), at = new Date().toISOString();
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(DEV_AD) }, await pwKey(password, salt, ['encrypt']), pk8);
    await idbPut('dev:' + CUR.id, { v: 3, salt: b64(salt), iv: b64(iv), ct: b64(ct), at });
    putDev({ v: 3, tries: 0, at });
  }
  async function openV3(password) {   // -> PK8 bytes; a wrong password surfaces as an OperationError from AES-GCM
    const r = await idbGet('dev:' + CUR.id);
    if (!r || r.v !== 3 || !r.ct) throw notSetUp();
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(r.iv), additionalData: enc.encode(DEV_AD) }, await pwKey(password, ub64(r.salt), ['decrypt']), ub64(r.ct)));
  }
  async function openOld() {   // v2 store: no password involved — the browser key alone opens it
    const d = getDev(), dk = await idbGet('dev:' + CUR.id);
    if (!d || !d.ct || !dk || !(dk instanceof CryptoKey)) throw notSetUp();
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(d.iv) }, dk, ub64(d.ct)));
  }

  /* ---------- keys ---------- */
  let KEYS = null, PK8 = null, DATA_AT = null, lastFetch = 0;
  async function unwrapWithSetupKey(code) {
    const w = KEYS.wrap, clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const k0 = await crypto.subtle.importKey('raw', enc.encode(clean), 'PBKDF2', false, ['deriveKey']);
    const k = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: ub64(w.salt), iterations: w.iter }, k0, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(w.iv), additionalData: enc.encode('portfolio-key-v1') }, k, ub64(w.ct)));
  }
  // does the device's private key belong to the public key the site currently publishes? (false after a key rotation)
  async function keyMatches(pk8) {
    try {
      if (!KEYS || !KEYS.pub) return true;
      const k = await crypto.subtle.importKey('pkcs8', pk8, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const j = await crypto.subtle.exportKey('jwk', k), u = (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - s.length % 4) % 4));
      return btoa('\x04' + u(j.x) + u(j.y)) === KEYS.pub;
    } catch (e) { console.error(e); return true; }   // never block an unlock on this check itself failing
  }

  /* ---------- data ---------- */
  async function unseal(e, label) {
    const priv = await crypto.subtle.importKey('pkcs8', PK8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const epk = ub64(e.epk);
    const pub = await crypto.subtle.importKey('raw', epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
    const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: enc.encode(label) }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(e.iv), additionalData: enc.encode(label) }, key, ub64(e.ct));
  }
  async function fetchData() {
    const r = await fetch(base() + 'data.enc.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('Could not download the portfolio data (' + r.status + ')');
    const gz = await unseal(await r.json(), 'portfolio-data-v1');
    const plain = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    lastFetch = Date.now();
    return JSON.parse(plain);
  }
  // month-end Excel workbooks, published encrypted under p/<id>/exports/ (exports/index.json lists them)
  let EXPORTS = null;
  window.pdExports = async () => { if (EXPORTS) return EXPORTS; try { const r = await fetch(base() + 'exports/index.json?t=' + Date.now(), { cache: 'no-store' }); EXPORTS = r.ok ? await r.json() : []; } catch (e) { EXPORTS = []; } return EXPORTS; };
  window.pdDownloadExport = async (month) => {
    if (!PK8) throw new Error('The portfolio is locked. Unlock it first.');
    const list = await window.pdExports(); const x = list.find((e) => e.month === month); if (!x) throw new Error('No workbook published for ' + month);
    const r = await fetch(base() + x.file + '?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) throw new Error('Could not download the workbook (' + r.status + ')');
    const e = await r.json(); const bytes = await unseal(e, 'portfolio-file-v1');
    await downloads.save({ filename: e.name || x.name, data: new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }) });
  };

  /* ---------- read-only database for the page ---------- */
  let DOCS = {}, dbResolve; const listeners = new Set();
  const dbReady = new Promise((r) => (dbResolve = r));
  const snap = (id, d) => ({ id, exists: d != null, data: () => (d == null ? undefined : JSON.parse(JSON.stringify(d))), metadata: {} });
  const fire = (l) => { try {
    if (l.kind === 'doc') l.f(snap(l.path.split('/').pop(), DOCS[l.path]));
    else { const docs = Object.keys(DOCS).filter((p) => p.startsWith(l.path + '/') && p.split('/').length === l.path.split('/').length + 1).sort().map((p) => snap(p.split('/').pop(), DOCS[p])); l.f({ docs, size: docs.length, empty: !docs.length }); }
  } catch (e) { console.error(e); } };
  const readOnly = () => Promise.reject(Object.assign(new Error('This live site is read-only. Make changes on the Claude page; they show up here after the next daily update.'), { code: 'read_only' }));
  const sub = (kind, path) => ({ onSnapshot(f) { const l = { kind, path, f }; listeners.add(l); setTimeout(() => fire(l), 0); return () => listeners.delete(l); } });
  const db = Object.freeze({
    doc: (p) => ({ ...sub('doc', p), get: async () => snap(p.split('/').pop(), DOCS[p]), set: readOnly, update: readOnly, delete: readOnly }),
    collection: (p) => ({ ...sub('col', p), get: async () => { const docs = Object.keys(DOCS).filter((k) => k.startsWith(p + '/')).map((k) => snap(k.split('/').pop(), DOCS[k])); return { docs, size: docs.length, empty: !docs.length }; } }),
  });
  // Downloads work normally on a real website, so the page's export buttons save straight to the device.
  const downloads = Object.freeze({ save: async ({ filename, data }) => {
    const blob = data instanceof Blob ? data : new Blob([data], { type: /\.json$/.test(filename) ? 'application/json' : /\.html$/.test(filename) ? 'text/html' : 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } });
  window.claude = Object.freeze({ use: async (n) => (n === 'db' ? dbReady : n === 'downloads' ? downloads : null) });

  /* ---------- live prices straight from TradingView (15-min delayed; the scanner allows this site's origin) ---------- */
  let LIVE = null, liveAt = 0;
  const cairoDay = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date(ts * 1000));
  async function scan(market, body) {
    const r = await fetch('https://scanner.tradingview.com/' + market + '/scan', { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) throw new Error('TradingView answered ' + r.status);
    return Object.fromEntries((await r.json()).data.map((x) => [x.s, x.d]));
  }
  async function livePrices() {
    const items = (DOCS['portfolio/assets'] || {}).items || {};
    const syms = [...new Set(Object.values(items).map((a) => (a.symbol || '').toUpperCase()).filter((s) => s && s !== 'SAVINGS' && s !== 'THNDRGOLD'))].sort();
    const idx = ['EGX30CAPPED', 'EGX30', 'EGX70EWI', 'EGX100EWI'], today = cairoDay(Date.now() / 1000);
    const cols = ['close', 'change', 'time', 'close[1]|1M', 'description', 'dividends_yield_current', 'ex_dividend_date_upcoming', 'dividend_amount_upcoming', 'ex_dividend_date_recent', 'dividend_amount_recent'];
    // every stock listed on the EGX in one call, plus the indices, plus USD/EGP and gold
    const [all, eg, gl] = await Promise.all([
      scan('egypt', { columns: cols, range: [0, 800], symbols: { query: { types: ['stock', 'dr', 'fund'] } } }),
      scan('egypt', { symbols: { tickers: idx.map((s) => 'EGX:' + s) }, columns: cols }),
      scan('global', { symbols: { tickers: ['FX_IDC:USDEGP', 'OANDA:XAUUSD'] }, columns: ['close', 'change', 'close[1]|1M'] })]);
    const prev = DOCS['market/latest'] || {}, quotes = {}, index = {}, missing = [];
    const put = (s, d) => { quotes[s] = { price: d[0], chg: +(d[1] || 0).toFixed(4), date: d[2] ? cairoDay(d[2]) : today, prevMonthClose: d[3], name: d[4], dy: d[5] == null ? null : +d[5].toFixed(4),
      exDate: d[6] ? cairoDay(d[6]) : null, divUp: d[7] ?? null, exRecent: d[8] ? cairoDay(d[8]) : null, divRecent: d[9] ?? null }; };
    for (const [t, d] of Object.entries(all)) { if (d && d[0] != null) put(t.replace(/^EGX:/, ''), d); }
    for (const s of syms) { if (!quotes[s]) { if (prev.quotes && prev.quotes[s]) quotes[s] = prev.quotes[s]; else missing.push(s); } }
    for (const s of idx) { const d = eg['EGX:' + s]; if (d && d[0] != null) index[s] = { close: d[0], chg: +(d[1] || 0).toFixed(4), date: d[2] ? cairoDay(d[2]) : today, prevMonthClose: d[3] }; }
    if (!Object.keys(quotes).length || !index.EGX30CAPPED) throw new Error('TradingView returned no EGX prices');
    const fx = gl['FX_IDC:USDEGP'], xau = gl['OANDA:XAUUSD'];
    LIVE = { asOf: new Date().toISOString(), source: 'TradingView scanner (15-min delayed), fetched by this browser', quotes, index,
      fx: fx ? { USDEGP: { price: fx[0], chg: +(fx[1] || 0).toFixed(4), prevMonthClose: fx[2], date: today } } : prev.fx || {},
      gold: fx && xau ? { XAUUSD: xau[0], gram24kEgp: +(xau[0] * fx[0] / 31.1035).toFixed(2), date: today } : prev.gold || {}, missing };
    liveAt = Date.now();
    if (PK8) { DOCS['market/latest'] = LIVE; listeners.forEach(fire); }   // never repopulate a locked page
    return Object.keys(quotes).length;
  }
  window.pdRefreshPrices = async (btn, toast) => {
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
    try { await refresh(); const n = await livePrices(); const miss = (LIVE && LIVE.missing) || []; const items = Object.values((DOCS['portfolio/assets'] || {}).items || {}); const funds = items.filter((a) => !a.symbol || a.symbol === 'SAVINGS' || a.symbol === 'THNDRGOLD').length;
      toast && toast(`Refreshed every EGX-listed stock (${n}), EGX30 Capped, USD/EGP and gold as of ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Africa/Cairo' })} Cairo (15-minute delayed).${funds ? ` ${funds} fund${funds > 1 ? 's' : ''} priced from your last trade.` : ''}${miss.length ? ` No TradingView listing for ${miss.join(', ')}.` : ''}`); }
    catch (e) { console.error(e); toast && toast('Could not reach TradingView: ' + (e.message || e) + '. Showing the last saved prices.', 'error'); }
    finally { const b = document.getElementById('refresh-prices'); if (b) { b.disabled = false; b.textContent = 'Refresh now'; } }
  };
  function publish(bundle) {
    DOCS = bundle.docs || {}; DATA_AT = bundle.exportedAt; OPENED = CUR.id;
    if (LIVE && Date.parse(LIVE.asOf) > Date.parse((DOCS['market/latest'] || {}).asOf || 0)) DOCS['market/latest'] = LIVE;
    listeners.forEach(fire);
    document.title = CUR.name + ' · Stock Market Portfolio Tracker';
    whenReady(() => {   // the bottom bar is the last thing in the document; the data can be ready before it is parsed
      const t = document.getElementById('pd-updated');
      if (t && DATA_AT) t.textContent = 'Ledger data as of ' + new Date(DATA_AT).toLocaleString('en-US', { timeZone: 'Africa/Cairo', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) + ' Cairo';
      const w = document.getElementById('pd-who'); if (w) w.textContent = CUR.name;
    });
  }
  const whenReady = (fn) => { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true }); else fn(); };
  // Lock means locked: drop the key and every decrypted document, tell the page (its state is rebuilt from the snapshots it
  // receives, so it renders its empty state) and blank whatever it had drawn. LIVE (public market prices) is kept for reuse.
  function blank() {
    for (const id of ['main', 'tape', 'feed', 'period', 'pf-name-text', 'pf-menu', 'pd-updated', 'pd-who']) { const el = document.getElementById(id); if (el) el.textContent = ''; }
    const t = document.getElementById('toast'); if (t) { t.hidden = true; t.textContent = ''; }
  }
  function lock(auto) {
    PK8 = null; DOCS = {}; DATA_AT = null; lastFetch = 0; EXPORTS = null;
    document.title = 'Stock Market Portfolio Tracker';
    listeners.forEach(fire); blank();
    if (!CUR) return chooseScreen();
    const d = getDev();
    if (isV3(d)) unlockScreen(auto); else if (isOld(d)) migrateScreen(); else setupScreen();
  }

  /* ---------- WebAuthn with PRF: the passkey's PRF output is what wraps the private key ---------- */
  async function canBio() {
    try {
      if (!window.PublicKeyCredential || !(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())) return false;
      if (PublicKeyCredential.getClientCapabilities) { const c = await PublicKeyCredential.getClientCapabilities(); if (c && c['extension:prf'] === false) return false; }
      return true;   // browsers without getClientCapabilities: PRF support is only known once a credential is created
    } catch (e) { return false; }
  }
  const noPrf = () => Object.assign(new Error(`This device cannot unlock the portfolio securely with ${bio}; use the password.`), { code: 'no_prf' });
  const bioReady = async () => { const b = ls.get(BIO_LS); if (!b || !b.cred) return false; try { const r = await idbGet('bio:' + CUR.id); return !!(r && r.v === 3 && r.ct); } catch (e) { return false; } };
  async function prfSecret(credId, salt) {   // get() with prf eval -> the 32-byte PRF output for this salt
    const challenge = rnd(32);
    const a = await navigator.credentials.get({ publicKey: { challenge, allowCredentials: [{ type: 'public-key', id: credId, transports: ['internal', 'hybrid'] }], userVerification: 'required', timeout: 60000,
      extensions: { prf: { eval: { first: salt } } } } });
    const x = a.getClientExtensionResults(), out = x.prf && x.prf.results && x.prf.results.first;
    if (!out) throw noPrf();
    const cd = JSON.parse(dec.decode(a.response.clientDataJSON)), want = b64(challenge).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (cd.type !== 'webauthn.get' || cd.challenge !== want || cd.origin !== location.origin) throw new Error('verification failed');
    return new Uint8Array(out);
  }
  async function bioKey(secret, salt, usages) {
    const hk = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(BIO_INFO) }, hk, { name: 'AES-GCM', length: 256 }, false, usages);
  }
  async function enrollBio(pk8) {
    const bioSalt = rnd(32); let b = ls.get(BIO_LS), credId, secret;
    if (!b || !b.cred) {   // first portfolio on this device: create the passkey, requiring PRF
      const c = await navigator.credentials.create({ publicKey: {
        rp: { name: 'Stock Market Portfolio Tracker' }, user: { id: rnd(16), name: 'portfolio', displayName: 'Portfolio' }, challenge: rnd(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' }, timeout: 60000, attestation: 'none',
        extensions: { prf: { eval: { first: bioSalt } } } } });
      const x = c.getClientExtensionResults();
      if (!x.prf || !x.prf.enabled) throw noPrf();
      credId = new Uint8Array(c.rawId); ls.set(BIO_LS, { cred: b64(c.rawId), at: new Date().toISOString() });
      if (x.prf.results && x.prf.results.first) secret = new Uint8Array(x.prf.results.first);   // some authenticators answer at creation, iOS does not
    } else credId = ub64(b.cred);
    if (!secret) secret = await prfSecret(credId, bioSalt);
    const iv = rnd(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(BIO_INFO) }, await bioKey(secret, bioSalt, ['encrypt']), pk8);
    await idbPut('bio:' + CUR.id, { v: 3, bioSalt: b64(bioSalt), iv: b64(iv), ct: b64(ct), at: new Date().toISOString() });
  }
  async function bioOpen() {   // -> PK8 bytes, or throws (the caller falls back to the password)
    const b = ls.get(BIO_LS), r = await idbGet('bio:' + CUR.id);
    if (!b || !b.cred || !r || r.v !== 3) throw new Error('not enrolled');
    const salt = ub64(r.bioSalt), secret = await prfSecret(ub64(b.cred), salt);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(r.iv), additionalData: enc.encode(BIO_INFO) }, await bioKey(secret, salt, ['decrypt']), ub64(r.ct)));
  }

  /* ---------- screens ---------- */
  const MARK = '<div class="lk-mark" aria-hidden="true"><svg viewBox="0 0 36 36" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 27l8-9 6 5 11-13"/><path d="M23 10h7v7"/></svg></div>';
  const lockEl = () => document.getElementById('lock');
  function screen(html) { const l = lockEl(); l.hidden = false; document.body.classList.add('pd-locked'); l.innerHTML = '<div class="lk">' + MARK + html + '</div>'; }
  function open() { const l = lockEl(); l.hidden = true; l.innerHTML = ''; document.body.classList.remove('pd-locked'); }
  const err = (m) => { const e = $l('.lk-err'); if (e) e.textContent = m || ''; };
  const switchLink = () => (PORTFOLIOS.length > 1 ? '<button type="button" class="lk-link" id="lk-switch" data-testid="live-switch">Switch portfolio</button>' : '');
  const wireSwitch = () => { const b = $l('#lk-switch'); if (b) b.onclick = () => chooseScreen(); };

  function chooseScreen() {
    screen(`<h1>Stock Market Portfolio Tracker</h1><p>Choose whose portfolio to open.</p><div class="lk-list">${PORTFOLIOS.map((p) => { const set = !!ls.get('pd.dev.' + p.id);
      return `<button class="lk-btn ${set ? '' : 'ghost'}" data-pick="${esc(p.id)}" data-testid="live-pick-${esc(p.id)}">${esc(p.name)}<small>${set ? 'ready on this device' : 'needs its setup key'}</small></button>`; }).join('')}</div>
      <p class="lk-foot">Each portfolio has its own setup key; each device gets its own password. Ask the owner for their setup key to add a portfolio here.</p>`);
    document.querySelectorAll('#lock [data-pick]').forEach((b) => { b.onclick = () => select(PORTFOLIOS.find((p) => p.id === b.dataset.pick)); });
  }
  async function select(p) {
    if (OPENED && OPENED !== p.id) { ls.set(CUR_LS, p.id); location.reload(); return; }   // the page already shows another portfolio: start clean
    CUR = p; ls.set(CUR_LS, p.id); KEYS = null; PK8 = null; EXPORTS = null;
    try { KEYS = await (await fetch(base() + 'keys.json', { cache: 'no-store' })).json(); } catch (e) { return screen('<h1>Offline</h1><p>The portfolio could not load. Check your connection and reload.</p>'); }
    const d = getDev();
    if (isV3(d)) unlockScreen(true); else if (isOld(d)) migrateScreen(); else setupScreen();
  }
  function setupScreen(note) {
    screen(`<h1>Set up ${esc(CUR.name)}</h1><p>Enter this portfolio's setup key once on each new phone or computer. Then you choose a password for this device; ${esc(bio)} can be added after that.</p>
      <form id="lk-setup" autocomplete="off"><input id="lk-code" data-testid="live-setup-key" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" autocapitalize="characters" spellcheck="false" aria-label="Setup key">
      <button class="lk-btn" data-testid="live-setup-submit">Continue</button><div class="lk-err" role="alert">${esc(note || '')}</div></form>
      ${safariTip()}${switchLink()}<p class="lk-foot">The figures are encrypted. Without the setup key this page shows nothing.</p>`);
    $l('#lk-code').focus(); wireSwitch();
    $l('#lk-setup').onsubmit = async (ev) => { ev.preventDefault(); const b = $l('.lk-btn'); b.disabled = true; err('Checking…');
      try { const pk8 = await unwrapWithSetupKey($l('#lk-code').value);
        passwordScreen({ title: 'Choose a password for this device', intro: `It unlocks ${esc(CUR.name)} on this device only, and nothing here can recover it: if you forget it, you set the device up again with the setup key.`,
          done: async (pw) => { await storeV3(pk8, pw); await afterSetup(pk8); } }); }
      catch (e) { console.error(e); b.disabled = false; err(e && e.name === 'OperationError' ? 'That setup key is not right. Check it and try again.' : 'Could not set up: ' + (e.message || e)); } };
  }
  // password rules: at least 8 characters; not the portfolio name, its first word (with or without the possessive), the
  // portfolio id or "password" (compared trimmed and case-insensitively); both fields equal. The password is used as typed
  // (trimmed, never lowercased).
  function pwRules(pw, rep) {
    const p = pw.trim(), low = p.toLowerCase(), first = CUR.name.trim().split(/\s+/)[0] || '', bare = first.replace(/[^a-z0-9].*$/i, '');
    const banned = new Set([CUR.name, first, bare, CUR.id, 'password'].map((s) => s.trim().toLowerCase()).filter(Boolean));
    return [{ ok: p.length >= 8, text: 'At least 8 characters' },
      { ok: p.length > 0 && !banned.has(low), text: `Not the portfolio name, "${bare || first}" or "password"` },
      { ok: p.length > 0 && rep.trim() === p, text: 'Both fields match' }];
  }
  function passwordScreen({ title, intro, done, back }) {
    screen(`<h1>${title}</h1><p>${intro}</p>
      <form id="lk-choose" autocomplete="off"><input id="lk-new" type="password" data-testid="live-new-password" placeholder="Password" aria-label="Password" autocomplete="new-password">
      <input id="lk-rep" type="password" data-testid="live-new-password-repeat" placeholder="Repeat the password" aria-label="Repeat the password" autocomplete="new-password">
      <ul class="lk-rules" id="lk-rules" data-testid="live-password-rules"></ul>
      <button class="lk-btn" id="lk-choose-go" data-testid="live-password-continue" disabled>Continue</button><div class="lk-err" role="alert"></div></form>
      ${safariTip()}${back ? '<div class="lk-links"><button type="button" class="lk-link" id="lk-choose-back" data-testid="live-password-back">Back</button></div>' : ''}`);
    const nw = $l('#lk-new'), rp = $l('#lk-rep'), go = $l('#lk-choose-go'), ul = $l('#lk-rules');
    const check = () => { const rs = pwRules(nw.value, rp.value); ul.innerHTML = rs.map((r) => `<li class="${r.ok ? 'ok' : ''}">${esc(r.text)}</li>`).join(''); go.disabled = !rs.every((r) => r.ok); return !go.disabled; };
    nw.oninput = rp.oninput = check; check(); nw.focus();
    if (back) $l('#lk-choose-back').onclick = back;
    $l('#lk-choose').onsubmit = async (ev) => { ev.preventDefault(); if (!check()) return; go.disabled = true; err('Saving…');
      try { await done(nw.value); } catch (e) { console.error(e); err('Could not save the password: ' + (e.message || e)); check(); } };
  }
  async function afterSetup(pk8) {   // the device store is written: open the data, then offer biometrics
    if (!(await keyMatches(pk8))) return rotatedScreen();   // a migrated v2 device may hold a key the site has since rotated
    PK8 = pk8;
    try { await start(); } catch (e) { console.error(e); return dataErrorScreen(e); }
    await offerBio(pk8);
  }
  async function migrateScreen() {   // v2 device store -> v3: the browser key opens the old store, then the user chooses a real password
    let pk8;
    try { pk8 = await openOld(); }
    catch (e) {   // only a store that is really gone sends the user back to the setup key; anything else keeps it for a retry
      console.error(e);
      if (e && e.code === 'not_set_up') { ls.del(devLS()); await idbDel('dev:' + CUR.id); return setupScreen('This portfolio needs to be set up again on this device.'); }
      return screen(`<h1>${esc(CUR.name)}</h1><p>This device's saved setup could not be opened just now. Nothing was removed.</p><button class="lk-btn" id="lk-mig-retry" data-testid="live-migrate-retry">Try again</button>`), ($l('#lk-mig-retry').onclick = () => migrateScreen());
    }
    passwordScreen({ title: 'Choose a password for this device', intro: `${esc(CUR.name)} is already set up here. The site now protects it with a password that only this device knows, so pick one now; the old password no longer applies. ${esc(bio)} can be turned on again afterwards.`,
      done: async (pw) => { await storeV3(pk8, pw); ls.del(OLD_BIO_LS); await idbDel('bio:' + CUR.id); await afterSetup(pk8); } });
  }
  async function offerBio(pk8) {
    if (await bioReady() || !(await canBio())) return open();
    screen(`<h1>Use ${esc(bio)}?</h1><p>Unlock with ${esc(bio)} on this device. The password still works as a backup.</p>
      <button class="lk-btn" id="lk-bio-on" data-testid="live-bio-enable">Turn on ${esc(bio)}</button><button class="lk-btn ghost" id="lk-bio-no" data-testid="live-bio-skip">Not now</button><div class="lk-err" role="alert"></div>`);
    $l('#lk-bio-no').onclick = open;
    $l('#lk-bio-on').onclick = async () => { const b = $l('#lk-bio-on'); b.disabled = true; err('');
      try { await enrollBio(pk8); open(); }
      catch (e) { console.error(e); b.disabled = false; err(e && e.code === 'no_prf' ? e.message : bio + ' was not turned on. You can use the password instead.'); } };
  }
  // a wrong password: count it, forget the device after MAX_TRIES. Returns true when the device was forgotten.
  async function wrongPassword() {
    const dv = getDev() || { v: 3, tries: 0 }; dv.tries = (dv.tries || 0) + 1; putDev(dv);
    if (dv.tries >= MAX_TRIES) { await forget(); setupScreen('Too many wrong passwords. This portfolio was removed from the device; enter its setup key.'); return true; }
    err(`Wrong password. ${MAX_TRIES - dv.tries} ${MAX_TRIES - dv.tries === 1 ? 'try' : 'tries'} left before this portfolio is removed from the device.`); return false;
  }
  const rightPassword = () => { const dv = getDev(); if (dv) { dv.tries = 0; putDev(dv); } };
  async function unlockScreen(auto) {
    const hasBio = await bioReady();
    screen(`<h1>${esc(CUR.name)}</h1><p>Unlock to see the portfolio.</p>
      ${hasBio ? `<button class="lk-btn" id="lk-bio" data-testid="live-bio-unlock">Unlock with ${esc(bio)}</button><div class="lk-sep">or</div>` : ''}
      <form id="lk-pass" autocomplete="off"><input id="lk-pw" type="password" data-testid="live-password" placeholder="Password" aria-label="Password" autocomplete="current-password">
      <button class="lk-btn ${hasBio ? 'ghost' : ''}" data-testid="live-password-submit">Unlock</button><div class="lk-err" role="alert"></div></form>
      <div class="lk-links">${switchLink()}<button type="button" class="lk-link" id="lk-change" data-testid="live-change-password">Change password</button><button type="button" class="lk-link" id="lk-forget" data-testid="live-forget-device">Forget this portfolio on this device</button></div>`);
    wireSwitch();
    if (hasBio) { $l('#lk-bio').onclick = () => bioUnlock(); if (auto) bioUnlock(true); } else $l('#lk-pw').focus();
    $l('#lk-pass').onsubmit = async (ev) => { ev.preventDefault(); const pw = $l('#lk-pw').value; if (!pw.trim()) return; const b = $l('[data-testid=live-password-submit]'); b.disabled = true; err('Checking…');
      try { const pk8 = await openV3(pw); rightPassword(); await unlocked(pk8); }
      catch (e) { $l('#lk-pw').value = ''; b.disabled = false;
        if (e && e.name === 'OperationError') await wrongPassword();
        else if (e && e.code === 'not_set_up') { console.error(e); ls.del(devLS()); setupScreen('This portfolio needs to be set up again on this device.'); }   // the store is gone (storage cleared); nothing to forget
        else { console.error(e); err('Could not unlock: ' + (e.message || e)); } } };
    $l('#lk-change').onclick = () => changePasswordScreen();
    $l('#lk-forget').onclick = () => forgetScreen(() => unlockScreen(false));
  }
  // the explicit "Forget this portfolio" flow: the one place, besides MAX_TRIES, that removes a portfolio from the device
  function forgetScreen(back, why) {
    screen(`<h1>Forget ${esc(CUR.name)}?</h1><p>${why || ''}You will need its setup key to open it here again.</p>
      <button class="lk-btn" id="lk-f-yes" data-testid="live-forget-confirm">Forget it on this device</button><button class="lk-btn ghost" id="lk-f-no" data-testid="live-forget-cancel">Cancel</button>`);
    $l('#lk-f-yes').onclick = async () => { await forget(); ls.del(CUR_LS); location.reload(); }; $l('#lk-f-no').onclick = back;
  }
  // the site's keys were rotated (rotate_keys.py): this device's key no longer opens the data. Nothing is forgotten here —
  // the user chooses to remove the old setup (the same explicit flow as "Forget this portfolio") and enters the new key.
  function rotatedScreen() {
    screen(`<h1>${esc(CUR.name)}</h1><p data-testid="live-key-rotated">This portfolio's setup key was changed, so the key saved on this device no longer opens it. Ask the owner for the new setup key, then remove the old setup here and enter it.</p>
      <button class="lk-btn" id="lk-rot" data-testid="live-key-rotated-forget">Remove the old setup and enter the new key</button><div class="lk-links">${switchLink()}<button type="button" class="lk-link" id="lk-rot-lock" data-testid="live-key-rotated-lock">Lock</button></div>`);
    wireSwitch(); $l('#lk-rot-lock').onclick = () => lock(false);
    $l('#lk-rot').onclick = () => forgetScreen(rotatedScreen, 'The old setup on this device is useless now. ');
  }
  function changePasswordScreen() {
    screen(`<h1>Change password</h1><p>Enter the current password for ${esc(CUR.name)} on this device first.</p>
      <form id="lk-cur" autocomplete="off"><input id="lk-cur-pw" type="password" data-testid="live-current-password" placeholder="Current password" aria-label="Current password" autocomplete="current-password">
      <button class="lk-btn" data-testid="live-current-password-submit">Continue</button><div class="lk-err" role="alert"></div></form>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-cur-back" data-testid="live-change-back">Back</button></div>`);
    $l('#lk-cur-pw').focus(); $l('#lk-cur-back').onclick = () => unlockScreen(false);
    $l('#lk-cur').onsubmit = async (ev) => { ev.preventDefault(); const pw = $l('#lk-cur-pw').value; if (!pw.trim()) return; const b = $l('.lk-btn'); b.disabled = true; err('Checking…');
      try { const pk8 = await openV3(pw); rightPassword();
        passwordScreen({ title: 'Choose a new password', intro: `The new password replaces the old one on this device only. ${esc(bio)}, if turned on, keeps working.`, back: () => unlockScreen(false),
          done: async (npw) => { await storeV3(pk8, npw); await unlocked(pk8); } }); }
      catch (e) { $l('#lk-cur-pw').value = ''; b.disabled = false;
        if (e && e.name === 'OperationError') await wrongPassword();
        else if (e && e.code === 'not_set_up') { console.error(e); ls.del(devLS()); setupScreen('This portfolio needs to be set up again on this device.'); }
        else { console.error(e); err('Could not check the password: ' + (e.message || e)); } } };
  }
  async function bioUnlock(quiet) {
    try { const pk8 = await bioOpen(); rightPassword(); await unlocked(pk8); }
    catch (e) { if (!quiet) console.error(e); if (!quiet) err(bio + ' did not unlock. Try again or use the password.'); const i = $l('#lk-pw'); if (i) i.focus(); }
  }
  // the device is authenticated: download the data and open the page. A data failure is reported and NEVER forgets the device.
  async function unlocked(pk8) {
    if (!(await keyMatches(pk8))) return rotatedScreen();
    PK8 = pk8;
    try { await start(); } catch (e) { console.error(e); return dataErrorScreen(e); }
    open();
  }
  function dataErrorScreen(e) {
    screen(`<h1>${esc(CUR.name)}</h1><p data-testid="live-data-error">The portfolio data could not be read. Try again later; if it keeps happening, tell Claude.</p><p class="lk-foot">${esc((e && e.message) || e || '')}</p>
      <button class="lk-btn" id="lk-retry" data-testid="live-data-retry">Try again</button><div class="lk-links">${switchLink()}<button type="button" class="lk-link" id="lk-relock" data-testid="live-data-lock">Lock</button></div>`);
    wireSwitch(); $l('#lk-relock').onclick = () => lock(false);
    $l('#lk-retry').onclick = async () => { const b = $l('#lk-retry'); b.disabled = true; b.textContent = 'Trying…'; if (!PK8) return lock(false); await unlocked(PK8); };
  }
  async function start() { publish(await fetchData()); dbResolve(db); livePrices().catch((e) => console.warn('live prices unavailable', e)); }
  async function refresh() { if (!PK8) return; try { const b = await fetchData(); if (b.exportedAt !== DATA_AT) publish(b); } catch (e) { console.warn('refresh failed', e); } }
  window.pdLock = () => { if (CUR) lock(false); };
  window.pdSwitch = () => chooseScreen();
  window.pdSelect = (id) => { const p = PORTFOLIOS.find((x) => x.id === id); if (p && !(CUR && CUR.id === p.id)) select(p); };

  /* ---------- boot ---------- */
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (!PK8 || !lockEl().hidden) return;
    if (Date.now() - hiddenAt > RELOCK_MS) return lock(true);
    if (Date.now() - lastFetch > REFRESH_MS) refresh();
    if (Date.now() - liveAt > 10 * 60e3) livePrices().catch(() => {});
  });
  (async () => {
    if (!window.crypto || !crypto.subtle || !window.DecompressionStream) return screen('<h1>Browser too old</h1><p>Update your browser (Safari 16.4+, Chrome 80+) to open the portfolio.</p>');
    try { PORTFOLIOS = await (await fetch('portfolios.json', { cache: 'no-store' })).json(); } catch (e) { return screen('<h1>Offline</h1><p>The portfolio could not load. Check your connection and reload.</p>'); }
    await migrateLegacy();
    ls.del(OLD_BIO_LS);   // the pre-v3 passkey only gated a screen; v3 enrols afresh with PRF
    whenReady(() => { const sw = document.getElementById('pd-switch'); if (sw && PORTFOLIOS.length > 1) sw.hidden = false; });
    const last = PORTFOLIOS.find((p) => p.id === ls.get(CUR_LS));
    if (last) select(last); else if (PORTFOLIOS.length === 1) select(PORTFOLIOS[0]); else chooseScreen();
  })();
})();
