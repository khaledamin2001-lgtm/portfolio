/* site/lock.js: everything specific to the live site, wrapped around the page (app.html) by build_site.py.

   Contents (search for the "---------- name" line):
     portfolios ........ portfolios.json, the current portfolio
     device storage .... the per-device key store (IndexedDB) and its bookkeeping (localStorage)
     keys / data ....... unwrapping a portfolio's private key; downloading and decrypting its data
     the page's database  window.pdHost: the documents the page reads, and saves when editing is on
     editing from the site  GitHub token, encrypted commits to the engine repository, job buttons
     live prices ....... TradingView's scanner, straight from the browser
     WebAuthn with PRF . Face ID / Touch ID / fingerprint that really unwraps the key
     screens ........... the lock screens: choose, setup key, password, unlock, forget
     accounts .......... Firebase sign-up / sign-in, the account's encrypted documents, onboarding, email updates, Gmail
     friends ........... friend requests (checked against directory/{email}), shared copies, status, reset / delete
     admin ............. the site owner's account list
     linked account .... a setup-key portfolio linked to a site account
     the friends hub ... the top-left menu and the Overview cards, ranked over the page's period
     installable app ... the service worker and "Install app"
     boot .............. start-up

   How the setup-key portfolios are protected (device store v3):
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
   the browser key and the user chooses a real password.
   Installable app: sw.js (built from pwa/sw.js) keeps a copy of the page and of the ENCRYPTED data files on the device, so the
   Home Screen app opens offline with the last loaded data. Nothing about the key changes: the private key stays in IndexedDB
   wrapped by the password / passkey, and unlocking an offline copy needs exactly the same password. When the data on screen
   came from that saved copy, or the device is offline, a small banner says so (#pd-offline).
   Editing (portfolios with an "engine" repository): a device can also keep a GitHub token for that repository, sealed to the
   portfolio's public key in IndexedDB 'tok:<id>'; saves are encrypted here and committed to the engine repository (see
   "editing from the site" below). Forgetting the portfolio removes the token with the key. */
(function(){
  'use strict';
  const MAX_TRIES = 10, RELOCK_MS = 5 * 60e3, REFRESH_MS = 30 * 60e3, LIVE_MS = 10 * 60e3, PBKDF2_ITER = 310000;
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
  async function forget() { ls.del(devLS()); await idbDel('dev:' + CUR.id); await idbDel('bio:' + CUR.id); await idbDel('tok:' + CUR.id); await idbDel('link:' + CUR.id); LINK = null;
    if (CUR.cloud) { await idbDel('acct:' + CUR.id); await idbDel('cache:' + CUR.id); dropAccount(CUR.id); CLOUD = null; } }
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
  let KEYS = null, PK8 = null, DATA_AT = null, lastFetch = 0, fetchTry = 0;
  let LINK = null;   // {uid, email, refresh, pk8, pub, name}: the site account linked to this setup-key portfolio, see "linked account" below
  let SAVED_AT = null;   // set when the last data answer was sw.js's saved copy (its x-pd-saved-at header), null when it came from the network
  async function unwrapWithSetupKey(code) { return unwrapKey(KEYS.wrap, code.toUpperCase().replace(/[^A-Z0-9]/g, '')); }
  // a keys.json-style wrap {salt, iv, ct, iter} opened with a secret: the setup key / recovery code (cleaned), or an account password
  async function unwrapKey(w, clean) {
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
  async function unseal(e, label, pk8) {
    const priv = await crypto.subtle.importKey('pkcs8', pk8 || PK8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const epk = ub64(e.epk);
    const pub = await crypto.subtle.importKey('raw', epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
    const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: enc.encode(label) }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(e.iv), additionalData: enc.encode(label) }, key, ub64(e.ct));
  }
  async function fetchData() {
    if (CUR && CUR.cloud) return fetchCloudData();
    const r = await fetch(base() + 'data.enc.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('Could not download the portfolio data (' + r.status + ')');
    const gz = await unseal(await r.json(), 'portfolio-data-v1');
    const plain = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    const bundle = JSON.parse(plain);
    lastFetch = Date.now(); SAVED_AT = r.headers.get('x-pd-saved-at');
    return bundle;
  }
  // month-end Excel workbooks, published encrypted under p/<id>/exports/ (exports/index.json lists them)
  let EXPORTS = null;
  window.pdExports = async () => { if (EXPORTS) return EXPORTS; try { const r = await fetch(base() + 'exports/index.json?t=' + Date.now(), { cache: 'no-store' }); EXPORTS = r.ok ? await r.json() : []; } catch (e) { EXPORTS = []; } return EXPORTS; };
  // kind 'xlsx' (default): the Excel workbook (entry.file); 'pdf': the PDF factsheet (entry.pdf), both encrypted the same way
  const FILE_KINDS = { xlsx: { key: 'file', what: 'workbook', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, pdf: { key: 'pdf', what: 'PDF factsheet', type: 'application/pdf' } };
  // accounts made on the site get their month-end files by email (run_account_mail.py), not as downloads here
  window.pdExportsNote = (month) => (!CUR || !CUR.cloud ? null
    : (mailPrefs() || {}).reports ? `Your month-end Excel workbook and PDF factsheet are emailed to you when a monthly statement is posted. Look for "month-end report ${month}" in your email.`
      : 'Month-end Excel and PDF files are sent by email: open Account → Email updates and tick "Month-end report". They come each time a monthly statement is posted.');
  window.pdDownloadExport = async (month, kind) => {
    if (window.pdExportsNote(month)) throw new Error(window.pdExportsNote(month));
    if (!PK8) throw new Error('The portfolio is locked. Unlock it first.');
    const k = FILE_KINDS[kind || 'xlsx']; if (!k) throw new Error('Unknown file kind ' + kind);
    const list = await window.pdExports(); const x = list.find((e) => e.month === month); if (!x || !x[k.key]) throw new Error('No ' + k.what + ' published for ' + month);
    const r = await fetch(base() + x[k.key] + '?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) throw new Error('Could not download the ' + k.what + ' (' + r.status + ')');
    const e = await r.json(); const bytes = await unseal(e, 'portfolio-file-v1');
    const fallback = kind === 'pdf' ? String(x.pdf).split('/').pop().replace(/\.enc\.json$/, '') : x.name;
    await downloads.save({ filename: e.name || fallback, data: new Blob([bytes], { type: k.type }) });
  };

  /* ---------- the page's database: the published documents, and saves to the engine repository when editing is on ---------- */
  let DOCS = {}, dbResolve; const listeners = new Set();
  const dbReady = new Promise((r) => (dbResolve = r));
  const snap = (id, d) => ({ id, exists: d != null, data: () => (d == null ? undefined : JSON.parse(JSON.stringify(d))), metadata: {} });
  const fire = (l) => { try {
    if (l.kind === 'doc') l.f(snap(l.path.split('/').pop(), DOCS[l.path]));
    else { const docs = Object.keys(DOCS).filter((p) => p.startsWith(l.path + '/') && p.split('/').length === l.path.split('/').length + 1).sort().map((p) => snap(p.split('/').pop(), DOCS[p])); l.f({ docs, size: docs.length, empty: !docs.length }); }
  } catch (e) { console.error(e); } };
  const sub = (kind, path) => ({ onSnapshot(f) { const l = { kind, path, f }; listeners.add(l); setTimeout(() => fire(l), 0); return () => listeners.delete(l); } });
  const db = Object.freeze({
    doc: (p) => ({ ...sub('doc', p), get: async () => snap(p.split('/').pop(), DOCS[p]), set: (d) => saveDoc('set', p, d), update: (d) => saveDoc('update', p, d), delete: () => saveDoc('delete', p) }),
    collection: (p) => ({ ...sub('col', p), get: async () => { const docs = Object.keys(DOCS).filter((k) => k.startsWith(p + '/')).map((k) => snap(k.split('/').pop(), DOCS[k])); return { docs, size: docs.length, empty: !docs.length }; } }),
  });
  // Downloads work normally on a real website, so the page's export buttons save straight to the device.
  const downloads = Object.freeze({ save: async ({ filename, data }) => {
    const blob = data instanceof Blob ? data : new Blob([data], { type: /\.json$/.test(filename) ? 'application/json' : /\.html$/.test(filename) ? 'text/html' : 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } });
  // the services the page runs on (app.html reads them through window.pdHost.use): 'db' = this portfolio's documents
  // (pdStore), 'downloads' = saving a file
  window.pdHost = Object.freeze({ use: async (n) => (n === 'db' ? dbReady : n === 'downloads' ? downloads : null) });

  /* ---------- editing from the site ----------
     A portfolio whose portfolios.json entry names an "engine" repository (its private data repository) can be edited here.
     The device then holds a fine-grained GitHub token for that one repository (Contents and Actions: read and write), sealed
     to the portfolio's public key in IndexedDB 'tok:<id>' (label 'portfolio-token-v1'): only an unlocked page can read it,
     and locking drops it from memory together with the private key. A save reads the document from the engine repository,
     applies the page's change with the engine's own rules (store.js, pinned by src/jobs/merge_vectors.json; a whole-document
     save made from an older copy keeps what the jobs changed meanwhile), encrypts it for the site key exactly like
     src/jobs/store.py and commits it through the GitHub Contents API pinned to the file's current sha, so a job's commit in
     between is never overwritten: the save is redone on the newer file. The engine's "Publish site" workflow runs on that
     commit and republishes the site's data within a few minutes; until then this page keeps showing the saved version. The
     price update and the inbox check can be started from here too (workflow_dispatch). */
  const GH_API = 'https://api.github.com', TOK_LABEL = 'portfolio-token-v1', FILE_LABEL = 'portfolio-file-v1';
  // a portfolio's engine data may sit in a folder of the repository ("engineDir", e.g. Yassin's under yassin/) with its own
  // workflows ("workflows": {market, sync}; a kind left out has no button)
  const JOB_NAMES = { market: 'Price update', sync: 'Inbox check' };
  const jobFile = (kind) => { const w = (CUR && CUR.workflows) || { market: 'market.yml', sync: 'sync.yml' }; return w[kind] || null; };
  const edir = () => (CUR && CUR.engineDir ? CUR.engineDir.replace(/^\/+|\/+$/g, '') + '/' : '');
  let EDIT = null;                  // {token, repo, expires} while unlocked and this device is set up for editing
  const OVERLAY = new Map();        // 'coll/doc' -> {data, at}: saves the published data does not show yet
  const RECENT = new Map();         // 'coll/doc' -> {sha, doc, at}: this device's last commit of a document (the API can lag)
  let QUEUE = Promise.resolve();    // saves run one at a time, in the order the page made them
  const engineRepo = () => (CUR && CUR.engine) || null;
  const canEdit = () => !!(PK8 && ((CUR && CUR.cloud && CLOUD) || (EDIT && engineRepo())));
  window.pdCanEdit = canEdit;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const b64big = (u) => { u = u instanceof Uint8Array ? u : new Uint8Array(u); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const toast = (m, k) => { if (window.pdToast) window.pdToast(m, k); };
  // encrypt for the portfolio's public key: the same scheme unseal() opens and src/jobs/store.py seal() writes
  async function seal(bytes, label, pubB64) {
    const site = await crypto.subtle.importKey('raw', ub64(pubB64 || KEYS.pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: site }, eph.privateKey, 256);
    const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: enc.encode(label) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = rnd(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(label) }, key, bytes);
    return { epk: b64big(epk), iv: b64big(iv), ct: b64big(ct) };
  }
  async function loadEdit() {
    EDIT = null;
    if (!engineRepo() || !PK8) return;
    try {
      const r = await idbGet('tok:' + CUR.id); if (!r || !r.ct) return;
      const t = JSON.parse(dec.decode(await unseal(r, TOK_LABEL)));
      if (t && typeof t.token === 'string' && t.repo === engineRepo()) EDIT = { token: t.token, repo: t.repo, expires: t.expires || null };
    } catch (e) { console.warn('the editing key saved on this device could not be read', e); }
  }
  async function storeEdit(t) { await idbPut('tok:' + CUR.id, Object.assign({ v: 1 }, await seal(enc.encode(JSON.stringify(t)), TOK_LABEL))); }
  const ghErr = (status, msg, repo) => Object.assign(new Error(
    status === 401 ? 'GitHub no longer accepts the editing key on this device (it expired or was deleted). Turn editing on again with a new key'
    : status === 403 && /rate limit/i.test(msg) ? 'GitHub is limiting requests right now. Try again in a few minutes'
    : status === 403 ? `The editing key is not allowed to do this. It needs Contents and Actions set to "Read and write" on ${repo}`
    : status === 404 ? 'Not found on GitHub'
    : 'GitHub answered ' + status + (msg ? ': ' + msg : '')),
  { status, code: status === 401 ? 'auth' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 409 || status === 422 ? 'conflict' : 'github' });
  let ghExp = null;   // the token's expiry as GitHub reports it (header github-authentication-token-expiration), when readable
  async function gh(method, path, body, token) {
    const tok = token || (EDIT && EDIT.token), repo = path.split('/').slice(2, 4).join('/');
    if (!tok) throw Object.assign(new Error('Editing is not turned on on this device'), { code: 'read_only' });
    let r;
    try {
      r = await fetch(GH_API + path, { method, cache: 'no-store', referrerPolicy: 'no-referrer', body: body ? JSON.stringify(body) : undefined,
        headers: Object.assign({ Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, body ? { 'Content-Type': 'application/json' } : {}) });
    } catch (e) { throw Object.assign(new Error('GitHub could not be reached. Check the connection and try again'), { code: 'network' }); }
    const x = r.headers.get('github-authentication-token-expiration'); if (x) ghExp = x;
    if (r.ok) return r.status === 204 ? null : r.json();
    let msg = ''; try { msg = (await r.json()).message || ''; } catch (e) { /* no body */ }
    throw ghErr(r.status, msg, repo);
  }
  const fileText = (b64s) => dec.decode(ub64(String(b64s).replace(/\s/g, '')));
  // the engine repository's copy of one document -> {sha, doc: {version, updatedAt, data}}; {sha: null, doc: null} when absent
  async function readEngineDoc(c, d, token, repo) {
    repo = repo || EDIT.repo;
    let f;
    try { f = await gh('GET', `/repos/${repo}/contents/${edir()}db/${c}/${d}.enc.json?ref=main`, null, token); }
    catch (e) { if (e.code === 'not_found') return { sha: null, doc: null }; throw e; }
    const b = f.content && f.encoding === 'base64' ? f.content : (await gh('GET', `/repos/${repo}/git/blobs/${f.sha}`, null, token)).content;   // files over 1 MB come as a blob
    let p;
    try { p = JSON.parse(dec.decode(await unseal(JSON.parse(fileText(b)), FILE_LABEL))); }
    catch (e) { throw Object.assign(new Error(`${c}/${d} in ${repo} cannot be opened with this portfolio's key`), { code: 'wrong_key' }); }
    if (!p || !Number.isInteger(p.version) || p.version < 1 || !p.data || typeof p.data !== 'object' || Array.isArray(p.data)) throw new Error(`${c}/${d} in ${repo} has the wrong shape`);
    return { sha: f.sha, doc: { version: p.version, updatedAt: p.updatedAt, data: p.data } };
  }
  function saveDoc(op, p, data) {
    if (!canEdit()) return Promise.reject(Object.assign(new Error(engineRepo() ? 'Editing is not turned on on this device. Use "Turn on editing" at the bottom of the page' : 'This portfolio can only be viewed on the site'), { code: 'read_only' }));
    const seen = Object.prototype.hasOwnProperty.call(DOCS, p) ? JSON.parse(JSON.stringify(DOCS[p])) : undefined;   // what the page showed when it made the change
    const run = () => commitDoc(op, p, data, seen);
    const done = QUEUE.then(run, run); QUEUE = done.catch(() => {});
    return done;
  }
  async function commitDoc(op, p, data, seen) {
    if (!canEdit()) throw Object.assign(new Error('The portfolio was locked before the change was saved'), { code: 'read_only' });
    const parts = String(p).split('/'), c = parts[0], d = parts[1];
    if (parts.length !== 2 || !pdStore.NAME_RE.test(c) || !pdStore.NAME_RE.test(d)) throw Object.assign(new Error('invalid document ' + p), { code: 'invalid' });
    const cloud = !!CUR.cloud, repo = cloud ? null : EDIT.repo, path = `${edir()}db/${c}/${d}.enc.json`, msg = `Site edit: ${CUR.id} ${p}`;
    for (let attempt = 0; ; attempt++) {
      const rc = RECENT.get(p);
      const cur = attempt === 0 && rc && Date.now() - rc.at < 120e3 ? rc : cloud ? await readCloudDoc(c, d) : await readEngineDoc(c, d);
      const w = op === 'set' && seen !== undefined && cur.doc ? { op, data: pdStore.rebase(seen, data, cur.doc.data) } : { op, data };
      const step = (await pdStore.applyWrites([Object.assign(w, { collection: c, doc_id: d })], async () => cur.doc)).plan[0];
      try {
        if (!step) return settle(p, cur.doc ? cur.doc.data : undefined);   // unchanged
        if (step.action === 'rm') {
          if (cloud) await deleteCloudDoc(c, d, cur.sha); else await gh('DELETE', `/repos/${repo}/contents/${path}`, { message: msg, sha: cur.sha, branch: 'main' });
          RECENT.delete(p); return settle(p, undefined);
        }
        const plain = enc.encode(JSON.stringify(step.doc));
        const env = Object.assign({ v: 1, name: d + '.json', bytes: plain.length }, await seal(plain, FILE_LABEL));
        if (cloud) { RECENT.set(p, { sha: await writeCloudDoc(c, d, env, step.doc, cur.sha), doc: step.doc, at: Date.now() }); return settle(p, step.doc.data); }
        const r = await gh('PUT', `/repos/${repo}/contents/${path}`, Object.assign({ message: msg, content: b64big(enc.encode(JSON.stringify(env) + '\n')), branch: 'main' }, cur.sha ? { sha: cur.sha } : {}));
        RECENT.set(p, { sha: r && r.content ? r.content.sha : null, doc: step.doc, at: Date.now() });
        return settle(p, step.doc.data);
      } catch (e) {
        if (e.code === 'conflict' && attempt < 4) { RECENT.delete(p); await sleep(800 * 2 ** attempt); continue; }   // the file changed meanwhile: redo on the new one
        throw e;
      }
    }
  }
  function settle(p, data) {   // a save went through: show it now, and keep showing it until the published data has it
    if (!PK8) return;
    OVERLAY.set(p, { data, at: Date.now() });
    if (data === undefined) delete DOCS[p]; else DOCS[p] = data;
    listeners.forEach(fire);
    if (CUR && (CUR.cloud || LINK)) shareSoon();   // friends see the change too
  }
  function applyOverlay() {
    for (const [p, o] of OVERLAY) {
      if (Date.now() - o.at > 30 * 60e3 || Date.parse(DATA_AT) > o.at + 120e3 || pdStore.canon(DOCS[p]) === pdStore.canon(o.data)) OVERLAY.delete(p);
      else if (o.data === undefined) delete DOCS[p]; else DOCS[p] = o.data;
    }
  }
  const expDate = () => { const x = EDIT && (EDIT.expires || ghExp); const t = x ? Date.parse(String(x).replace(' UTC', 'Z').replace(' ', 'T')) : NaN; return isFinite(t) ? t : null; };
  const dayText = (t) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(t));
  let JOB_NOTE = '';
  function editBar() {
    whenReady(() => {
      const on = canEdit(), el = (id) => document.getElementById(id), exp = expDate();
      const st = el('pd-edit-state');
      if (st) {
        const soon = on && exp && exp - Date.now() < 14 * 864e5;
        st.textContent = CUR && CUR.cloud ? (on ? 'Your account · changes save as you make them' : 'Your account') : !engineRepo() ? 'View only' : !on ? 'View only on this device' : JOB_NOTE || (soon ? `Editing on · the editing key expires ${dayText(exp)}` : 'Editing on · saved changes reach the site in a few minutes');
        st.classList.toggle('stale', !!soon && !JOB_NOTE);
      }
      const cloud = !!(CUR && CUR.cloud);
      for (const [id, kind] of [['pd-run-market', 'market'], ['pd-run-sync', 'sync'], ['pd-edit-menu', null]]) { const b = el(id); if (b) b.hidden = !on || cloud || (kind && !jobFile(kind)); }
      const b = el('pd-edit-on'); if (b) b.hidden = on || cloud || !engineRepo() || !PK8;
      const ac = el('pd-account'); if (ac) ac.hidden = !PK8;   // a setup-key portfolio offers to link the site account
      document.body.classList.toggle('pd-edit', on);
    });
  }
  const TOKEN_URL = (owner) => 'https://github.com/settings/personal-access-tokens/new?name=' + encodeURIComponent('Portfolio site editing') +
    '&description=' + encodeURIComponent('Lets the portfolio website save edits') + '&target_name=' + encodeURIComponent(owner) + '&expires_in=366&contents=write&actions=write';
  function editOnScreen(note) {
    const repo = engineRepo(), [owner, name] = repo.split('/');
    screen(`<h1>Turn on editing</h1><p>Changes made here are saved to <b>${esc(name)}</b>, the portfolio's private data on GitHub, and reach the site a few minutes later. This device needs a GitHub key for that one repository; you make it once:</p>
      <ol class="lk-steps"><li>Open <a href="${esc(TOKEN_URL(owner))}" target="_blank" rel="noopener noreferrer" data-testid="edit-token-link">GitHub → new fine-grained token</a>, signed in as <b>${esc(owner)}</b>.</li>
      <li><b>Expiration</b>: the longest offered (the site warns before it runs out).</li>
      <li><b>Repository access</b>: Only select repositories → <b>${esc(name)}</b>.</li>
      <li><b>Permissions</b> → Repository permissions: <b>Contents</b> and <b>Actions</b> set to <b>Read and write</b>.</li>
      <li><b>Generate token</b>, copy it and paste it here.</li></ol>
      <form id="lk-edit" autocomplete="off"><input id="lk-tok" type="password" data-testid="edit-token" placeholder="github_pat_…" aria-label="GitHub token" autocapitalize="none" spellcheck="false">
      <button class="lk-btn" id="lk-edit-go" data-testid="edit-token-submit">Turn on editing</button><div class="lk-err" role="alert">${esc(note || '')}</div></form>
      <p class="lk-foot">The key stays on this device, encrypted like the portfolio, and opens only that repository. You can delete it any time on GitHub (Settings → Developer settings → Personal access tokens).</p>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-edit-back" data-testid="edit-token-cancel">Cancel</button></div>`);
    $l('#lk-edit-back').onclick = open;
    $l('#lk-tok').focus();
    $l('#lk-edit').onsubmit = async (ev) => {
      ev.preventDefault(); const go = $l('#lk-edit-go'), tok = $l('#lk-tok').value.trim();
      if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(tok)) return err('That is not a GitHub token. It starts with github_pat_ and is about 90 characters long.');
      go.disabled = true; err('Checking the key with GitHub…'); ghExp = null;
      try {
        const cfg = await gh('GET', `/repos/${repo}/contents/${edir()}config.json?ref=main`, null, tok).catch((e) => { throw e.code === 'not_found' ? new Error(`The key cannot open ${name}. Under "Repository access" pick Only select repositories → ${name}`) : e; });
        let id = null; try { id = JSON.parse(fileText(cfg.content)).portfolioId; } catch (e) { /* checked below */ }
        if (id !== CUR.id) throw new Error(`${name} does not hold ${CUR.name}`);
        await readEngineDoc('portfolio', 'settings', tok, repo);   // opens with this portfolio's key: the right data
        await gh('GET', `/repos/${repo}/actions/workflows?per_page=1`, null, tok).catch((e) => { throw e.code === 'forbidden' || e.code === 'not_found' ? new Error('The key needs Actions set to "Read and write" as well (Permissions → Repository permissions)') : e; });
        const t = { token: tok, repo, expires: ghExp, at: new Date().toISOString() };
        await storeEdit(t);
        EDIT = { token: tok, repo, expires: ghExp };
        RECENT.clear(); open(); listeners.forEach(fire); editBar();
        toast('Editing is on for this device. Saves go to GitHub and reach the site in a few minutes.');
      } catch (e) { console.error(e); go.disabled = false; err(e.message || String(e)); }
    };
  }
  function editMenuScreen() {
    const exp = expDate();
    screen(`<h1>Editing on this device</h1><p>Saves go to <b>${esc(engineRepo())}</b> on GitHub.${exp ? ` The editing key expires on <b>${esc(dayText(exp))}</b>; make a new one before then.` : ''}</p>
      <button class="lk-btn ghost" id="lk-edit-new" data-testid="edit-replace">Use a new editing key</button>
      <button class="lk-btn ghost" id="lk-edit-off" data-testid="edit-off">Turn off editing on this device</button>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-edit-close" data-testid="edit-menu-close">Back</button></div>`);
    $l('#lk-edit-close').onclick = open;
    $l('#lk-edit-new').onclick = () => editOnScreen();
    $l('#lk-edit-off').onclick = async () => { await idbDel('tok:' + CUR.id); EDIT = null; RECENT.clear(); open(); listeners.forEach(fire); editBar(); toast('Editing is off on this device. Delete the key on GitHub too if you no longer need it.'); };
  }
  window.pdEditOn = () => { if (PK8 && engineRepo()) editOnScreen(); };
  window.pdEditMenu = () => { if (canEdit()) editMenuScreen(); };
  // start the price update or the inbox check on GitHub, follow it, and load the new figures when it is done
  window.pdRunJob = async (kind, btn) => {
    const f = jobFile(kind), j = f && { file: f, what: JOB_NAMES[kind] }; if (!j || !canEdit()) return;
    const repo = EDIT.repo, runs = async () => ((await gh('GET', `/repos/${repo}/actions/workflows/${j.file}/runs?per_page=10`)).workflow_runs || []);
    if (btn) btn.disabled = true;
    const note = (t) => { JOB_NOTE = t; editBar(); };
    try {
      const before = new Set((await runs()).map((r) => r.id));
      await gh('POST', `/repos/${repo}/actions/workflows/${j.file}/dispatches`, { ref: 'main' });
      note(`${j.what} started on GitHub…`);
      toast(`${j.what} started. It takes a few minutes; the page updates when it is done.`);
      let run = null;
      for (let i = 0; i < 80 && canEdit(); i++) {
        await sleep(i < 6 ? 5e3 : 15e3);
        try { run = (await runs()).filter((r) => !before.has(r.id)).sort((a, b) => a.id - b.id)[0] || null; } catch (e) { continue; }
        if (run) note(`${j.what} ${run.status === 'completed' ? 'finished' : run.status === 'in_progress' ? 'running' : 'queued'} on GitHub…`);
        if (run && run.status === 'completed') break;
      }
      if (!run || run.status !== 'completed') toast(`${j.what} is still running. The page picks up the result on its own.`);
      else if (run.conclusion === 'success') { toast(`${j.what} finished. Loading the new figures…`); RECENT.clear(); for (const t of [30e3, 90e3, 180e3]) setTimeout(refresh, t); }
      else toast(`${j.what} did not finish (${run.conclusion}). GitHub emails the details.`, 'error');
    } catch (e) { console.error(e); toast(`${j.what} could not start: ${e.message}`, 'error'); }
    finally { if (btn) btn.disabled = false; note(''); }
  };

  /* ---------- live prices straight from TradingView (15-min delayed; the scanner allows this site's origin) ---------- */
  let LIVE = null, liveAt = 0, liveTry = 0;
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
    const cols = ['close', 'change', 'time', 'close[1]|1M', 'description', 'dividends_yield_current', 'ex_dividend_date_upcoming', 'dividend_amount_upcoming', 'ex_dividend_date_recent', 'dividend_amount_recent',
      'price_earnings_ttm', 'price_book_fq', 'return_on_equity', 'market_cap_basic', 'price_52_week_high', 'price_52_week_low'];   // valuation for the watchlist
    // every stock listed on the EGX in one call, plus the indices, plus USD/EGP and gold. Only the stock scan is required: a failed
    // index or FX/gold call keeps the saved values (each carries its own date), and asOf is the time the stock scan came back.
    let scanAt = null;
    const [allR, egR, glR] = await Promise.allSettled([
      scan('egypt', { columns: cols, range: [0, 800], symbols: { query: { types: ['stock', 'dr', 'fund'] } } }).then((d) => { scanAt = new Date().toISOString(); return d; }),
      scan('egypt', { symbols: { tickers: idx.map((s) => 'EGX:' + s) }, columns: cols }),
      scan('global', { symbols: { tickers: ['FX_IDC:USDEGP', 'OANDA:XAUUSD'] }, columns: ['close', 'change', 'close[1]|1M'] })]);
    if (allR.status !== 'fulfilled') throw allR.reason;
    const all = allR.value, eg = egR.status === 'fulfilled' ? egR.value : {}, gl = glR.status === 'fulfilled' ? glR.value : {};
    if (egR.status !== 'fulfilled') console.warn('index quotes unavailable, keeping the saved ones', egR.reason);
    if (glR.status !== 'fulfilled') console.warn('USD/EGP and gold unavailable, keeping the saved ones', glR.reason);
    const prev = DOCS['market/latest'] || {}, quotes = {}, index = {}, missing = [], carried = [];
    const put = (s, d) => { quotes[s] = { price: d[0], chg: +(d[1] || 0).toFixed(4), date: d[2] ? cairoDay(d[2]) : today, prevMonthClose: d[3], name: d[4], dy: d[5] == null ? null : +d[5].toFixed(4),
      exDate: d[6] ? cairoDay(d[6]) : null, divUp: d[7] ?? null, exRecent: d[8] ? cairoDay(d[8]) : null, divRecent: d[9] ?? null,
      pe: num(d[10], 2), pb: num(d[11], 2), roe: num(d[12], 2), mcap: d[13] == null ? null : Math.round(d[13]), hi52: d[14] ?? null, lo52: d[15] ?? null }; };
    const num = (x, dp) => (x == null || !isFinite(x) ? null : +(+x).toFixed(dp));
    for (const [t, d] of Object.entries(all)) { if (d && d[0] != null) put(t.replace(/^EGX:/, ''), d); }
    for (const s of syms) { if (!quotes[s]) { if (prev.quotes && prev.quotes[s]) quotes[s] = prev.quotes[s]; else missing.push(s); } }
    for (const s of idx) { const d = eg['EGX:' + s]; if (d && d[0] != null) index[s] = { close: d[0], chg: +(d[1] || 0).toFixed(4), date: d[2] ? cairoDay(d[2]) : today, prevMonthClose: d[3] };
      else if (prev.index && prev.index[s]) { index[s] = prev.index[s]; if (s === 'EGX30CAPPED') carried.push('EGX30 Capped'); } }
    if (!Object.keys(quotes).length || !index.EGX30CAPPED) throw new Error('TradingView returned no EGX prices');
    const fx = gl['FX_IDC:USDEGP'], xau = gl['OANDA:XAUUSD'];
    if (!fx) carried.push('USD/EGP'); if (!(fx && xau)) carried.push('gold');
    // everything else the market job wrote (rates, …) is kept; jobAsOf remembers when the job itself last ran (Settings → Jobs)
    LIVE = { ...prev, jobAsOf: prev.jobAsOf || prev.asOf || null, asOf: scanAt || new Date().toISOString(), source: 'TradingView scanner (15-min delayed), fetched by this browser', quotes, index,
      fx: fx ? { USDEGP: { price: fx[0], chg: +(fx[1] || 0).toFixed(4), prevMonthClose: fx[2], date: today } } : prev.fx || {},
      gold: fx && xau ? { XAUUSD: xau[0], gram24kEgp: +(xau[0] * fx[0] / 31.1035).toFixed(2), date: today } : prev.gold || {}, missing, carried };
    liveAt = Date.now();
    if (PK8) { DOCS['market/latest'] = LIVE; listeners.forEach(fire); }   // never repopulate a locked page
    return Object.keys(quotes).length;
  }
  const cairoTime = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Africa/Cairo' });
  function priceStatus(ok) {
    whenReady(() => { const el = document.getElementById('pd-prices'); if (!el) return;
      el.textContent = ok && LIVE ? `Prices as of ${cairoTime(LIVE.asOf)} Cairo (15-min delayed)${LIVE.carried && LIVE.carried.length ? ` · ${LIVE.carried.join(', ')} from the last daily update` : ''}`
        : 'Prices from the last daily update · live prices unavailable';
      el.dataset.state = ok ? 'live' : 'saved'; });
  }
  // livePrices() plus the footer status; every caller goes through here (rethrows so the Refresh button can report the error)
  async function updateLive() {
    liveTry = Date.now();
    try { const n = await livePrices(); priceStatus(true); return n; } catch (e) { priceStatus(false); throw e; }
  }
  // a short notice once the page is actually showing (the lock screen hides the toast); uses the page's own toast when present
  function notice(msg, tries = 0) {
    if (!PK8) return;
    if (!lockEl().hidden) { if (tries < 240) setTimeout(() => notice(msg, tries + 1), 500); return; }
    if (window.pdToast) window.pdToast(msg);
  }
  window.pdRefreshPrices = async (btn, toast) => {
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
    try { await refresh(); const n = await updateLive(); const miss = (LIVE && LIVE.missing) || []; const items = Object.values((DOCS['portfolio/assets'] || {}).items || {}); const funds = items.filter((a) => !a.symbol || a.symbol === 'SAVINGS' || a.symbol === 'THNDRGOLD').length;
      toast && toast(`Refreshed every EGX-listed stock (${n}), EGX30 Capped, USD/EGP and gold as of ${cairoTime(LIVE.asOf)} Cairo (15-minute delayed).${LIVE.carried && LIVE.carried.length ? ` ${LIVE.carried.join(', ')} could not be fetched; the last daily values are kept.` : ''}${funds ? ` ${funds} fund${funds > 1 ? 's' : ''} priced from your last trade.` : ''}${miss.length ? ` No TradingView listing for ${miss.join(', ')}.` : ''}`); }
    catch (e) { console.error(e); toast && toast('Could not reach TradingView: ' + (e.message || e) + '. Showing the last saved prices.', 'error'); }
    finally { const b = document.getElementById('refresh-prices'); if (b) { b.disabled = false; b.textContent = 'Refresh now'; } }
  };
  // Site data freshness: the market job publishes Sunday to Thursday at 3:40 PM Cairo (and every inbox check after). Stale = older than 26 hours on an EGX
  // weekday, older than 74 hours otherwise (Friday, Saturday, and Sunday until the day's job has had time to run at 4 PM).
  const FRESH_H = { weekday: 26, other: 74 };
  function dataStale(iso, now = Date.now()) {
    const t = Date.parse(iso); if (!isFinite(t)) return true;
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
    const hm = (+p.hour % 24) * 60 + +p.minute, weekday = ['Mon', 'Tue', 'Wed', 'Thu'].includes(p.weekday) || (p.weekday === 'Sun' && hm >= 16 * 60);
    return (now - t) / 36e5 > (weekday ? FRESH_H.weekday : FRESH_H.other);
  }
  window.pdDataAt = () => DATA_AT; window.pdDataStale = dataStale;
  const cairoAt = (iso) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', day: 'numeric', month: 'short', year: 'numeric' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    return `${p.day} ${p.month} ${p.year}, ${cairoTime(iso)} Cairo`; };
  function footerFresh() {
    const t = document.getElementById('pd-updated'); if (!t || !DATA_AT) return;
    const stale = dataStale(DATA_AT);
    t.textContent = `Updated ${cairoAt(DATA_AT)}${stale ? ' (later than usual)' : ''}`;
    t.classList.toggle('stale', stale); t.dataset.state = stale ? 'stale' : 'fresh';
    t.title = stale ? 'The daily site update has not arrived when expected; the figures may be out of date.' : '';
  }
  function publish(bundle) {
    DOCS = bundle.docs || {}; DATA_AT = bundle.exportedAt; OPENED = CUR.id;
    applyOverlay();   // saves made here that the published data does not show yet
    const jm = DOCS['market/latest'] || {};   // the market job's own document in this bundle: its asOf is the job's heartbeat
    if (LIVE && Date.parse(LIVE.asOf) > Date.parse(jm.asOf || 0)) DOCS['market/latest'] = { ...jm, ...LIVE, jobAsOf: jm.asOf || LIVE.jobAsOf };
    listeners.forEach(fire);
    document.title = CUR.name + ' · Stock Market Portfolio Tracker';
    whenReady(() => {   // the bottom bar is the last thing in the document; the data can be ready before it is parsed
      footerFresh();
      const w = document.getElementById('pd-who'); if (w) w.textContent = CUR.name;
    });
    offlineBanner();
  }
  // Offline banner: shown while the page is unlocked and either the device is offline or the data on screen is the copy saved
  // on this device (sw.js answered from its cache: no network, or no answer within 4 s). Back online, the data is fetched
  // again and the banner goes as soon as a fresh copy arrives from the network.
  function offlineBanner() {
    whenReady(() => { const el = document.getElementById('pd-offline'); if (!el) return;
      const off = !!PK8 && !!DATA_AT && (navigator.onLine === false || !!SAVED_AT);
      el.hidden = !off; el.textContent = off ? `Offline — showing the data saved on this device (as of ${cairoAt(DATA_AT)})` : '';
      el.dataset.state = !off ? 'online' : navigator.onLine === false ? 'offline' : 'saved'; });
  }
  window.addEventListener('offline', offlineBanner);
  window.addEventListener('online', () => { offlineBanner(); if (!PK8) return; refresh().then(offlineBanner); updateLive().catch(() => {}); });
  const whenReady = (fn) => { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true }); else fn(); };
  // Lock means locked: drop the key and every decrypted document, tell the page (its state is rebuilt from the snapshots it
  // receives, so it renders its empty state) and blank whatever it had drawn. LIVE (public market prices) is kept for reuse.
  function blank() {
    const u = document.getElementById('pd-updated'); if (u) { u.classList.remove('stale'); delete u.dataset.state; u.title = ''; }
    for (const id of ['main', 'tape', 'feed', 'period', 'pf-name-text', 'pf-menu', 'pd-updated', 'pd-who']) { const el = document.getElementById(id); if (el) el.textContent = ''; }
    const t = document.getElementById('toast'); if (t) { t.hidden = true; t.textContent = ''; }
  }
  function lock(auto) {
    closeProfile(); FRIENDS = null; MY_HANDLE = null; LINK = null;
    PK8 = null; DOCS = {}; DATA_AT = null; lastFetch = 0; EXPORTS = null; SAVED_AT = null; EDIT = null; CLOUD = null; MEMBERS = null; OVERLAY.clear(); RECENT.clear(); JOB_NOTE = ''; editBar();
    document.title = 'Stock Market Portfolio Tracker';
    listeners.forEach(fire); blank(); offlineBanner();
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
  const switchLink = () => (allPortfolios().length > 1 || CUR.cloud ? '<button type="button" class="lk-link" id="lk-switch" data-testid="live-switch">Switch portfolio</button>' : '');
  const wireSwitch = () => { const b = $l('#lk-switch'); if (b) b.onclick = () => chooseScreen(); };

  // The first screen: portfolios this device can open, then sign in / create an account; portfolios opened with a setup key
  // (the site's own, from portfolios.json) sit behind a link unless this device is already set up for them.
  function chooseScreen() {
    const mine = allPortfolios().filter((p) => p.cloud || !!ls.get('pd.dev.' + p.id)), others = PORTFOLIOS.filter((p) => !ls.get('pd.dev.' + p.id));
    screen(`<h1>Stock Market Portfolio Tracker</h1><p>${mine.length ? 'Choose a portfolio to open.' : 'Track your EGX portfolio: returns, dividends, risk and the index, private to you.'}</p>
      ${mine.length ? `<div class="lk-list">${mine.map((p) => `<button class="lk-btn" data-pick="${esc(p.id)}" data-testid="live-pick-${esc(p.id)}">${esc(p.name)}<small>${p.cloud ? 'your account' : 'ready on this device'}</small></button>`).join('')}</div>` : ''}
      <div class="lk-list"><button class="lk-btn ${mine.length ? 'ghost' : ''}" id="lk-new-acct" data-testid="live-signup">Create your portfolio</button><button class="lk-btn ghost" id="lk-signin" data-testid="live-signin">Sign in</button></div>
      ${others.length ? `<details class="lk-more"${mine.length || !accounts().length ? '' : ''}><summary data-testid="live-setup-key-list">Open a portfolio with a setup key</summary><div class="lk-list">${others.map((p) => `<button class="lk-btn ghost" data-pick="${esc(p.id)}" data-testid="live-pick-${esc(p.id)}">${esc(p.name)}<small>needs its setup key</small></button>`).join('')}</div></details>` : ''}`);
    document.querySelectorAll('#lock [data-pick]').forEach((b) => { b.onclick = () => select(findPortfolio(b.dataset.pick)); });
    $l('#lk-new-acct').onclick = () => signUpScreen();
    $l('#lk-signin').onclick = () => signInScreen();
  }
  async function select(p) {
    if (OPENED && OPENED !== p.id) { ls.set(CUR_LS, p.id); location.reload(); return; }   // the page already shows another portfolio: start clean
    CUR = p; ls.set(CUR_LS, p.id); KEYS = null; PK8 = null; EXPORTS = null; EDIT = null; CLOUD = null;
    if (p.cloud) {   // an account: its public keys are kept on this device; without the device store, sign in
      const a = accounts().find((x) => x.id === p.id); KEYS = a ? a.keys : null;
      if (!KEYS || !isV3(getDev())) return signInScreen(p.email);
      return unlockScreen(true);
    }
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
  function passwordScreen({ title, intro, done, back, backText }) {
    screen(`<h1>${title}</h1><p>${intro}</p>
      <form id="lk-choose" autocomplete="off"><input id="lk-new" type="password" data-testid="live-new-password" placeholder="Password" aria-label="Password" autocomplete="new-password">
      <input id="lk-rep" type="password" data-testid="live-new-password-repeat" placeholder="Repeat the password" aria-label="Repeat the password" autocomplete="new-password">
      <ul class="lk-rules" id="lk-rules" data-testid="live-password-rules"></ul>
      <button class="lk-btn" id="lk-choose-go" data-testid="live-password-continue" disabled>Continue</button><div class="lk-err" role="alert"></div></form>
      ${safariTip()}${back ? '<div class="lk-links"><button type="button" class="lk-link" id="lk-choose-back" data-testid="live-password-back">' + esc(backText || 'Back') + '</button></div>' : ''}`);
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
      if (e && e.code === 'not_set_up') { ls.del(devLS()); await idbDel('dev:' + CUR.id); return setupAgain(); }
      screen(`<h1>${esc(CUR.name)}</h1><p>This device's saved setup could not be opened just now. Nothing was removed.</p><button class="lk-btn" id="lk-mig-retry" data-testid="live-migrate-retry">Try again</button><div class="lk-links"><button type="button" class="lk-link" id="lk-mig-other">Open another portfolio</button></div>`);
      $l('#lk-mig-retry').onclick = () => migrateScreen(); $l('#lk-mig-other').onclick = () => chooseScreen(); return;
    }
    passwordScreen({ title: 'Choose a password for this device', intro: `${esc(CUR.name)} is already set up here. The site now protects it with a password that only this device knows, so pick one now; the old password no longer applies. ${esc(bio)} can be turned on again afterwards.`,
      done: async (pw) => { await storeV3(pk8, pw); ls.del(OLD_BIO_LS); await idbDel('bio:' + CUR.id); await afterSetup(pk8); },
      back: () => chooseScreen(), backText: 'Not now: open another portfolio' });   // nothing changes until a password is chosen
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
  // this device's saved copy of the key is gone (storage cleared): a setup-key portfolio asks for its setup key, an
  // account signs in again
  function setupAgain() {
    if (CUR && CUR.cloud) { const e = CUR.email; dropAccount(CUR.id); return signInScreen(e, 'Sign in again on this device.'); }
    return setupScreen('This portfolio needs to be set up again on this device.');
  }
  async function wrongPassword() {
    const dv = getDev() || { v: 3, tries: 0 }; dv.tries = (dv.tries || 0) + 1; putDev(dv);
    if (dv.tries >= MAX_TRIES) {
      const acct = CUR.cloud ? CUR.email : null;
      await forget();
      if (acct != null) signInScreen(acct, 'Too many wrong passwords on this device. Sign in again with your email and password (or your recovery code).');
      else setupScreen('Too many wrong passwords. This portfolio was removed from the device; enter its setup key.');
      return true;
    }
    err(`Wrong password. ${MAX_TRIES - dv.tries} ${MAX_TRIES - dv.tries === 1 ? 'try' : 'tries'} left before this portfolio is removed from the device.`); return false;
  }
  const rightPassword = () => { const dv = getDev(); if (dv) { dv.tries = 0; putDev(dv); } };
  async function unlockScreen(auto) {
    const hasBio = await bioReady();
    screen(`<h1>${esc(CUR.name)}</h1><p>Unlock to see the portfolio.</p>
      ${hasBio ? `<button class="lk-btn" id="lk-bio" data-testid="live-bio-unlock">Unlock with ${esc(bio)}</button><div class="lk-sep">or</div>` : ''}
      <form id="lk-pass" autocomplete="off"><input id="lk-pw" type="password" data-testid="live-password" placeholder="Password" aria-label="Password" autocomplete="current-password">
      <button class="lk-btn ${hasBio ? 'ghost' : ''}" data-testid="live-password-submit">Unlock</button><div class="lk-err" role="alert"></div></form>
      <div class="lk-links">${switchLink()}${CUR.cloud ? '' : '<button type="button" class="lk-link" id="lk-change" data-testid="live-change-password">Change password</button>'}<button type="button" class="lk-link" id="lk-forget" data-testid="live-forget-device">Forget this portfolio on this device</button></div>`);
    wireSwitch();
    if (hasBio) { $l('#lk-bio').onclick = () => bioUnlock(); if (auto) bioUnlock(true); } else $l('#lk-pw').focus();
    $l('#lk-pass').onsubmit = async (ev) => { ev.preventDefault(); const pw = $l('#lk-pw').value; if (!pw.trim()) return; const b = $l('[data-testid=live-password-submit]'); b.disabled = true; err('Checking…');
      try { const pk8 = await openV3(pw); rightPassword(); await unlocked(pk8); }
      catch (e) { $l('#lk-pw').value = ''; b.disabled = false;
        if (e && e.name === 'OperationError') await wrongPassword();
        else if (e && e.code === 'not_set_up') { console.error(e); ls.del(devLS()); setupAgain(); }   // the store is gone (storage cleared); nothing to forget
        else { console.error(e); err('Could not unlock: ' + (e.message || e)); } } };
    if ($l('#lk-change')) $l('#lk-change').onclick = () => changePasswordScreen();
    $l('#lk-forget').onclick = () => forgetScreen(() => unlockScreen(false));
  }
  // the explicit "Forget this portfolio" flow: the one place, besides MAX_TRIES, that removes a portfolio from the device
  function forgetScreen(back, why) {
    screen(`<h1>Forget ${esc(CUR.name)}?</h1><p>${why || ''}${CUR.cloud ? 'To open it here again, sign in with your email and password. Nothing is deleted from your account.' : 'You will need its setup key to open it here again.'}</p>
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
        else if (e && e.code === 'not_set_up') { console.error(e); ls.del(devLS()); setupAgain(); }
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
    try { await start(); } catch (e) { if (e && e.code === 'gone') return; console.error(e); if (CUR.cloud && e && (e.code === 'signin' || e.code === 'auth')) return signInScreen(CUR.email, e.message); return dataErrorScreen(e); }
    open();
  }
  function dataErrorScreen(e) {
    screen(`<h1>${esc(CUR.name)}</h1><p data-testid="live-data-error">The portfolio data could not be read. Try again later; if it keeps happening, tell the site owner.</p><p class="lk-foot">${esc((e && e.message) || e || '')}</p>
      <button class="lk-btn" id="lk-retry" data-testid="live-data-retry">Try again</button><div class="lk-links">${switchLink()}<button type="button" class="lk-link" id="lk-relock" data-testid="live-data-lock">Lock</button></div>`);
    wireSwitch(); $l('#lk-relock').onclick = () => lock(false);
    $l('#lk-retry').onclick = async () => { const b = $l('#lk-retry'); b.disabled = true; b.textContent = 'Trying…'; if (!PK8) return lock(false); await unlocked(PK8); };
  }
  async function start() {
    if (CUR.cloud) { await loadSession(); const g = await accountGone().catch(() => null); if (g) { await leaveGoneAccount(g); throw Object.assign(new Error('account ' + g), { code: 'gone' }); } }
    await loadEdit(); publish(await fetchData()); dbResolve(db);
    if (!CUR.cloud) await loadLink().catch((e) => { console.warn('linked account not opened', e); LINK = null; CLOUD = null; });
    editBar();
    if (CUR.cloud || LINK) housekeeping().catch((e) => console.warn('account housekeeping', e));
    updateLive().catch((e) => { console.warn('live prices unavailable', e); notice('Live prices are unavailable right now: showing prices from the last daily update.'); }); }
  async function refresh() { if (!PK8) return; fetchTry = Date.now(); try { const b = await fetchData(); if (b.exportedAt !== DATA_AT) publish(b); else offlineBanner(); } catch (e) { console.warn('refresh failed', e); }
    if (CUR && (CUR.cloud || LINK) && CLOUD) listFriends().catch(() => {}); }
  window.pdLock = () => { if (CUR) lock(false); };
  window.pdSwitch = () => chooseScreen();
  window.pdSelect = (id) => { const p = findPortfolio(id); if (p && !(CUR && CUR.id === p.id)) select(p); };


  /* ---------- accounts: anyone can make their own portfolio here (Firebase sign-in + encrypted documents) ----------
     Firebase (project portfolio-desk-4d14a) is used through its REST APIs only: Identity Toolkit for the email/password
     account and Firestore for storage. Nothing readable is stored there. At sign-up the browser makes the account's own
     key pair; the private key is kept in users/{uid}.keys wrapped twice, like a site keys.json: "pwrap" by the account
     password (PBKDF2 310,000) and "wrap" by a recovery code shown once (PBKDF2 600,000, the setup-key format). Every
     portfolio document is sealed to the account's public key exactly like an engine document ('portfolio-file-v1') and
     stored as users/{uid}/docs/<collection>__<doc> {blob, v, at}; saves are pinned to the document's updateTime (a clash
     is redone on the newer copy, like the GitHub saves). The rules (src/cloud/firestore.rules) let each account touch only
     its own documents. Market data is shared: the daily job (run_shared_market.py) publishes m/market.enc.json sealed to
     the MEMBERS key, whose private half signed-in accounts read from shared/members (made by the first account). On this
     device an account works like any other portfolio (device store 'dev:<id>' under the account password, Face ID), and
     its Firebase session (refresh token) is kept sealed to the account's key in IndexedDB 'acct:<id>'. */
  const FB = { apiKey: 'AIzaSyAYvh69A5VWAgmhKXt07RTgLpB_1hYBjA8', projectId: 'portfolio-desk-4d14a' };
  const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FB.projectId}/databases/(default)/documents`;
  const ACCTS_LS = 'pd.accounts', SESSION_LABEL = 'portfolio-session-v1', CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const MARKET_COLLS = new Set(['market', 'history', 'bench']);
  let CLOUD = null;     // {uid, email, idToken, refresh, exp} while an account is open
  let MEMBERS = null;   // the members private key (PKCS8) for the shared market data
  const accounts = () => (ls.get(ACCTS_LS) || []).filter((a) => a && a.id && a.uid && a.keys);
  const saveAccount = (a) => ls.set(ACCTS_LS, accounts().filter((x) => x.id !== a.id).concat([a]));
  const dropAccount = (id) => ls.set(ACCTS_LS, accounts().filter((x) => x.id !== id));
  const acctPortfolio = (a) => ({ id: a.id, name: a.name, cloud: true, uid: a.uid, email: a.email });
  const allPortfolios = () => PORTFOLIOS.concat(accounts().map(acctPortfolio));
  const findPortfolio = (id) => allPortfolios().find((p) => p.id === id);
  const netErr = () => Object.assign(new Error('The connection failed. Check the internet and try again.'), { code: 'network' });
  // a dropped connection is tried again (up to 3 tries). Safe for every call here: sign-in calls are idempotent, and a save
  // is pinned to the document's updateTime, so a repeat of one that did land is refused and redone on the newer copy.
  async function netFetch(url, opt) {
    for (let i = 0; ; i++) {
      try { return await fetch(url, opt); }
      catch (e) { if (i >= 2) throw netErr(); await sleep(600 * 3 ** i); }
    }
  }
  const AUTH_TEXT = { EMAIL_EXISTS: 'An account with that email already exists. Sign in instead.', INVALID_LOGIN_CREDENTIALS: 'Wrong email or password.',
    EMAIL_NOT_FOUND: 'Wrong email or password.', INVALID_PASSWORD: 'Wrong email or password.', USER_DISABLED: 'This account has been switched off.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many tries. Wait a few minutes and try again.', WEAK_PASSWORD: 'Choose a longer password (at least 8 characters).',
    INVALID_EMAIL: 'That email address does not look right.', MISSING_PASSWORD: 'Enter the password.', OPERATION_NOT_ALLOWED: 'New accounts are switched off right now.',
    TOKEN_EXPIRED: 'You were signed out. Sign in again.', USER_NOT_FOUND: 'This account no longer exists.', INVALID_REFRESH_TOKEN: 'You were signed out. Sign in again.',
    CREDENTIAL_TOO_OLD_LOGIN_AGAIN: 'For safety, sign in again first.' };
  const authErr = (code) => Object.assign(new Error(AUTH_TEXT[String(code).split(/[ :]/)[0]] || 'Sign-in failed (' + code + ')'), { code: 'auth', fb: String(code) });
  async function fbAuth(endpoint, body) {
    let r;
    r = await netFetch(`https://identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${FB.apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), referrerPolicy: 'no-referrer' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw authErr((j.error && j.error.message) || r.status);
    return j;
  }
  async function refreshToken(refresh) {
    let r;
    r = await netFetch(`https://securetoken.googleapis.com/v1/token?key=${FB.apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refresh), referrerPolicy: 'no-referrer' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw authErr((j.error && j.error.message) || 'TOKEN_EXPIRED');
    return { idToken: j.id_token, refresh: j.refresh_token, uid: j.user_id, exp: Date.now() + (+j.expires_in || 3600) * 1000 };
  }
  const session = (a) => ({ uid: a.localId, email: a.email, idToken: a.idToken, refresh: a.refreshToken, exp: Date.now() + (+a.expiresIn || 3600) * 1000 });
  async function idToken() {
    if (!CLOUD) throw Object.assign(new Error('Not signed in'), { code: 'auth' });
    if (!CLOUD.idToken || Date.now() > CLOUD.exp - 300e3) {
      const t = await refreshToken(CLOUD.refresh);
      const changed = t.refresh !== CLOUD.refresh;
      Object.assign(CLOUD, t);
      if (changed) { await storeSession().catch(() => {}); if (LINK) await storeLink().catch(() => {}); }
    }
    return CLOUD.idToken;
  }
  // Firestore REST. Errors carry code: not_found | conflict (a precondition failed: someone saved first) | forbidden | cloud
  async function fsReq(method, path, body, query, anon) {
    const url = FS_BASE + '/' + path + (query ? '?' + query : '');
    for (let attempt = 0; ; attempt++) {
      const tok = anon ? null : await idToken();
      let r;
      r = await netFetch(url, { method, cache: 'no-store', referrerPolicy: 'no-referrer', body: body ? JSON.stringify(body) : undefined, headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: 'Bearer ' + tok } : {}) });
      if (r.ok) return r.json().catch(() => ({}));
      const j = await r.json().catch(() => ({})), st = (j.error && j.error.status) || '';
      if (r.status === 401 && attempt === 0 && !anon && CLOUD) { CLOUD.exp = 0; continue; }
      const code = r.status === 404 ? 'not_found' : (r.status === 409 || st === 'FAILED_PRECONDITION' || st === 'ALREADY_EXISTS' || st === 'ABORTED') ? 'conflict' : r.status === 403 ? 'forbidden' : 'cloud';
      throw Object.assign(new Error(code === 'forbidden' ? 'Your account is not allowed to do that.' : 'Saving to your account failed (' + (st || r.status) + ')'), { status: r.status, code });
    }
  }
  const fStr = (doc, k) => (doc && doc.fields && doc.fields[k] && doc.fields[k].stringValue) || null;
  const docId = (c, d) => `${c}__${d}`;
  async function openBlob(blob, c, d) {
    let p;
    try { p = JSON.parse(dec.decode(await unseal(JSON.parse(blob), FILE_LABEL))); }
    catch (e) { throw Object.assign(new Error(`${c}/${d} in your account cannot be opened with this key`), { code: 'wrong_key' }); }
    if (!p || !Number.isInteger(p.version) || !p.data || typeof p.data !== 'object' || Array.isArray(p.data)) throw new Error(`${c}/${d} in your account has the wrong shape`);
    return { version: p.version, updatedAt: p.updatedAt, data: p.data };
  }
  async function readCloudDoc(c, d) {
    let j;
    try { j = await fsReq('GET', `users/${CLOUD.uid}/docs/${docId(c, d)}`); }
    catch (e) { if (e.code === 'not_found') return { sha: null, doc: null }; throw e; }
    return { sha: j.updateTime, doc: await openBlob(fStr(j, 'blob'), c, d) };
  }
  async function writeCloudDoc(c, d, env, doc, sha) {
    const q = sha ? 'currentDocument.updateTime=' + encodeURIComponent(sha) : 'currentDocument.exists=false';
    const j = await fsReq('PATCH', `users/${CLOUD.uid}/docs/${docId(c, d)}`, { fields: { blob: { stringValue: JSON.stringify(env) }, v: { integerValue: String(doc.version) }, at: { stringValue: doc.updatedAt } } }, q);
    return j.updateTime || null;
  }
  async function deleteCloudDoc(c, d, sha) { await fsReq('DELETE', `users/${CLOUD.uid}/docs/${docId(c, d)}`, null, 'currentDocument.updateTime=' + encodeURIComponent(sha)); }
  // the members key for the shared market data; the first account to sign in makes it (each half can be created once)
  async function membersKey() {
    if (MEMBERS) return MEMBERS;
    try { MEMBERS = ub64(fStr(await fsReq('GET', 'shared/members'), 'pk8')); return MEMBERS; }
    catch (e) { if (e.code !== 'not_found') throw e; }
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pk8 = b64big(await crypto.subtle.exportKey('pkcs8', kp.privateKey)), pub = b64big(await crypto.subtle.exportKey('raw', kp.publicKey));
    try {
      await fsReq('PATCH', 'shared/members', { fields: { pk8: { stringValue: pk8 }, pub: { stringValue: pub } } }, 'currentDocument.exists=false');
      await fsReq('PATCH', 'shared/membersPub', { fields: { pub: { stringValue: pub } } }, 'currentDocument.exists=false');
    } catch (e) { if (e.code !== 'conflict') throw e; }   // another account made it at the same moment: use theirs
    MEMBERS = ub64(fStr(await fsReq('GET', 'shared/members'), 'pk8'));
    return MEMBERS;
  }
  async function fetchMarket() {
    let r;
    try { r = await fetch('m/market.enc.json?t=' + Date.now(), { cache: 'no-store' }); } catch (e) { r = null; }
    if (!r || !r.ok) return { exportedAt: null, docs: {} };   // not published yet: live prices still come from TradingView
    const e = await r.json();
    const gz = await unseal(e, 'portfolio-data-v1', await membersKey());
    return JSON.parse(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
  }
  // month-end market fields the market job used to write into each portfolio's marks, filled in on the page instead
  function macroMarks(docs) {
    const mk = docs['portfolio/marks'], mac = docs['market/macro'];
    if (!mk || !mk.months || !mac) return;
    const cur = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date()).slice(0, 7), num = (x) => typeof x === 'number' && isFinite(x);
    for (const [M, v] of Object.entries(mk.months)) {
      if (!v || M >= cur) continue;
      if (!num(v.benchClose) && num((mac.benchClose || {})[M])) v.benchClose = mac.benchClose[M];
      if (!num(v.cpi) && num((mac.cpiMoM || {})[M])) { v.cpi = mac.cpiMoM[M]; v.cpiSource = mac.cpiSource || null; }
      if (!num(v.usdegp) && num((mac.fxEom || {})[M])) { v.usdegp = mac.fxEom[M]; v.usdegpSource = mac.fxSource || null; }
      if (!num(v.cashRate) && num((mac.cashRate || {})[M])) { v.cashRate = mac.cashRate[M]; v.cashRateSource = mac.cashRateSource || null; }
    }
  }
  async function listCloudDocs() {
    const out = [];
    let tok = '';
    do {
      const j = await fsReq('GET', `users/${CLOUD.uid}/docs`, null, 'pageSize=300' + (tok ? '&pageToken=' + encodeURIComponent(tok) : ''));
      (j.documents || []).forEach((x) => out.push(x));
      tok = j.nextPageToken || '';
    } while (tok);
    return out;
  }
  async function fetchCloudData() {
    await loadSession();
    let list, market, saved = null;
    try { [market, list] = await Promise.all([fetchMarket(), listCloudDocs()]); await idbPut('cache:' + CUR.id, { at: new Date().toISOString(), list: list.map((x) => ({ name: x.name, blob: fStr(x, 'blob') })) }).catch(() => {}); }
    catch (e) {
      if (e.code !== 'network') throw e;
      const c = await idbGet('cache:' + CUR.id).catch(() => null);   // offline: the encrypted copy saved on this device
      if (!c || !c.list) throw e;
      list = c.list.map((x) => ({ name: x.name, fields: { blob: { stringValue: x.blob } } })); saved = c.at; market = { exportedAt: null, docs: {} };
      try { const r = await fetch('m/market.enc.json', { cache: 'force-cache' }); if (r.ok) market = JSON.parse(await new Response(new Blob([await unseal(await r.json(), 'portfolio-data-v1', MEMBERS || undefined)]).stream().pipeThrough(new DecompressionStream('gzip'))).text()); } catch (e2) { /* no saved prices either */ }
    }
    const docs = Object.assign({}, market.docs || {});
    for (const x of list) {
      const id = String(x.name).split('/').pop(), i = id.indexOf('__'); if (i < 1) continue;
      const c = id.slice(0, i), d = id.slice(i + 2); if (MARKET_COLLS.has(c)) continue;
      docs[c + '/' + d] = (await openBlob(fStr(x, 'blob'), c, d)).data;
    }
    macroMarks(docs);
    lastFetch = Date.now(); SAVED_AT = saved;
    if (!saved) resealMail().catch((e) => console.warn('email updates not refreshed', e));
    // "how new is this data": the later of the market file and the account's newest document, so a refresh shows trades the
    // email job imported, or edits from another device, without waiting for tomorrow's market file
    const newest = Math.max(Date.parse(market.exportedAt) || 0, ...list.map((x) => Date.parse(x.updateTime) || 0));
    return { exportedAt: newest ? new Date(newest).toISOString() : new Date().toISOString(), docs };
  }
  // the Firebase session on this device, sealed to the account's key (readable only while it is unlocked)
  async function storeSession() { if (CLOUD && CUR && CUR.cloud) await idbPut('acct:' + CUR.id, Object.assign({ v: 1 }, await seal(enc.encode(JSON.stringify({ uid: CLOUD.uid, email: CLOUD.email, refresh: CLOUD.refresh })), SESSION_LABEL))); }
  async function loadSession() {
    if (CLOUD && CLOUD.uid === CUR.uid) return;
    const r = await idbGet('acct:' + CUR.id).catch(() => null);
    if (!r || !r.ct) throw Object.assign(new Error('Sign in to open your account on this device.'), { code: 'signin' });
    const s = JSON.parse(dec.decode(await unseal(r, SESSION_LABEL)));
    CLOUD = { uid: s.uid, email: s.email, refresh: s.refresh, idToken: null, exp: 0 };
  }
  // a keys.json-style wrap of the private key under a secret (the recovery code cleaned, or the password as typed, trimmed)
  async function wrapKey(pk8, secret, iter) {
    const salt = rnd(16), iv = rnd(12);
    const k0 = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
    const k = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, k0, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('portfolio-key-v1') }, k, pk8);
    return { kdf: 'PBKDF2-SHA256', iter, salt: b64big(salt), iv: b64big(iv), ct: b64big(ct) };
  }
  const recoveryCode = () => { const r = rnd(20); return Array.from({ length: 5 }, (_, g) => Array.from(r.slice(g * 4, g * 4 + 4), (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('')).join('-'); };
  const cleanCode = (c) => String(c).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cleanPw = (p) => String(p).trim();
  // the account is open on this device: remember it, keep the key under the account password (and the session), load the data
  // Everything one open portfolio or account leaves in memory, cleared before another account takes the page (otherwise
  // its unsaved edits, its linked account, the friend being viewed or friends' figures would carry over)
  function resetSession() {
    OVERLAY.clear(); RECENT.clear(); EDIT = null; LINK = null; FRIENDS = null; MY_HANDLE = null; closeProfile();
    Object.keys(CONFIRMED).forEach((k) => delete CONFIRMED[k]);
    HUB.you = null; HUB.youData = null; HUB.friends = {}; HUB.market = null; HUB.marketAt = 0;
  }
  async function adoptAccount(a, pk8, keys, name, pw, email) {
    const p = { id: 'u_' + a.localId, name: name || 'My portfolio', cloud: true, uid: a.localId, email };
    if (OPENED && OPENED !== p.id) resetSession();   // signing in while another portfolio is on the page
    saveAccount({ id: p.id, uid: p.uid, email, name: p.name, keys: { v: 3, pub: keys.pub, wrap: keys.wrap } });
    CUR = p; ls.set(CUR_LS, p.id); KEYS = { v: 3, pub: keys.pub, wrap: keys.wrap }; PK8 = pk8;
    CLOUD = session(a);
    await storeV3(pk8, pw);
    await storeSession();
    await membersKey().catch((e) => console.warn('members key unavailable', e));
  }
  async function readProfile(uid) {
    const j = await fsReq('GET', `users/${uid}`);
    return { keys: JSON.parse(fStr(j, 'keys')), name: fStr(j, 'name') };
  }
  function signUpScreen(note) {
    screen(`<h1>Create your portfolio</h1><p>Your portfolio is private: it is locked with your password on this device. Nobody else can read it unless you add them as a friend.</p>
      <form id="lk-su" autocomplete="on"><input id="lk-su-name" data-testid="signup-name" placeholder="Your name" aria-label="Your name" autocomplete="name">
      <input id="lk-su-email" type="email" data-testid="signup-email" placeholder="Email" aria-label="Email" autocomplete="email" autocapitalize="none" spellcheck="false">
      <input id="lk-new" type="password" data-testid="signup-password" placeholder="Password" aria-label="Password" autocomplete="new-password">
      <input id="lk-rep" type="password" data-testid="signup-password-repeat" placeholder="Repeat the password" aria-label="Repeat the password" autocomplete="new-password">
      <ul class="lk-rules" id="lk-rules"></ul>
      <button class="lk-btn" id="lk-su-go" data-testid="signup-submit" disabled>Create account</button><div class="lk-err" role="alert">${esc(note || '')}</div></form>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-su-in" data-testid="signup-to-signin">I already have an account</button><button type="button" class="lk-link" id="lk-su-back">Back</button></div>`);
    const nm = $l('#lk-su-name'), em = $l('#lk-su-email'), nw = $l('#lk-new'), rp = $l('#lk-rep'), go = $l('#lk-su-go'), ul = $l('#lk-rules');
    const check = () => { const p = nw.value.trim(), rs = [{ ok: nm.value.trim().length > 0, text: 'Your name' }, { ok: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em.value.trim()), text: 'An email address' },
      { ok: p.length >= 8, text: 'A password of at least 8 characters' }, { ok: p.length > 0 && rp.value.trim() === p, text: 'Both passwords match' }];
      ul.innerHTML = rs.map((r) => `<li class="${r.ok ? 'ok' : ''}">${esc(r.text)}</li>`).join(''); go.disabled = !rs.every((r) => r.ok); return !go.disabled; };
    nm.oninput = em.oninput = nw.oninput = rp.oninput = check; check(); nm.focus();
    $l('#lk-su-in').onclick = () => signInScreen(em.value.trim());
    $l('#lk-su-back').onclick = () => chooseScreen();
    $l('#lk-su').onsubmit = async (ev) => {
      ev.preventDefault(); if (!check()) return; go.disabled = true; err('Creating your account…');
      const name = nm.value.trim(), email = em.value.trim(), pw = cleanPw(nw.value);
      try {
        const a = await fbAuth('signUp', { email, password: pw, returnSecureToken: true });
        const { code, pname } = await newProfile(a, name, email, pw);
        // the "confirm your email" link goes out now, so it is already in their inbox when they want to add a friend
        fbAuth('sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: a.idToken }).catch((e) => console.warn('verification email not sent', e));
        recoveryScreen(code, () => onboardScreen(name, pname));
      } catch (e) { console.error(e); go.disabled = false; err(e.message || String(e)); check(); }
    };
  }
  // a new account's key pair and profile (sign-up, or starting again after the site owner reset the account)
  async function newProfile(a, name, email, pw) {
    CLOUD = session(a);
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pk8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
    const pub = b64big(await crypto.subtle.exportKey('raw', kp.publicKey));
    const code = recoveryCode();
    err('Locking your key…');
    const keys = { v: 3, pub, wrap: await wrapKey(pk8, cleanCode(code), 600000), pwrap: await wrapKey(pk8, pw, 310000) };
    const pname = name + (/s$/i.test(name) ? "' Portfolio" : "'s Portfolio");
    await fsReq('PATCH', `users/${a.localId}`, { fields: { keys: { stringValue: JSON.stringify(keys) }, name: { stringValue: pname }, createdAt: { stringValue: new Date().toISOString() } } }, 'currentDocument.exists=false');
    ['pd.mail.', 'pd.dir.', 'pd.status.'].forEach((k) => ls.del(k + 'u_' + a.localId));   // nothing from before a reset
    await adoptAccount(a, pk8, keys, pname, pw, email);
    await writeStatus({ createdAt: new Date().toISOString() }).catch((e) => console.warn('status', e));
    return { code, pname };
  }
  function recoveryScreen(code, next) {
    screen(`<h1>Save your recovery code</h1><p>If you ever forget your password, this code is the only way back in. Copy it into your notes, or take a screenshot. It is shown only now.</p>
      <p class="lk-code" data-testid="recovery-code">${esc(code)}</p>
      <button type="button" class="lk-btn ghost" id="lk-rc-copy" data-testid="recovery-copy">Copy the code</button>
      <label class="lk-check"><input type="checkbox" id="lk-rc-ok" data-testid="recovery-saved"> I have saved it</label>
      <button class="lk-btn" id="lk-rc-go" data-testid="recovery-continue" disabled>Continue</button>`);
    const ok = $l('#lk-rc-ok'), go = $l('#lk-rc-go');
    ok.onchange = () => { go.disabled = !ok.checked; };
    $l('#lk-rc-copy').onclick = async () => { try { await navigator.clipboard.writeText(code); $l('#lk-rc-copy').textContent = 'Copied: paste it into your notes'; } catch (e) { $l('#lk-rc-copy').textContent = 'Copy did not work: take a screenshot instead'; } };
    go.onclick = () => next();
  }
  // first-run: the starting point. Tracking starts today: cash plus the shares held now, valued at today's prices
  function onboardScreen(first, pname, note) {
    screen(`<h1>Set up your portfolio</h1><p>The site builds it for you from your Thndr emails: your holdings, trades and returns. No typing.</p>
      <button class="lk-btn" id="lk-ob-hist" data-testid="onboard-history">Build it from my Thndr emails<small>needs the Gmail your Thndr emails go to · about 3 minutes</small></button>
      <details class="lk-more" id="lk-ob-manual"><summary data-testid="onboard-manual">My Thndr emails don't go to Gmail</summary>
      <p class="lk-hint">Type what you hold today instead; tracking starts from today.</p>
      <form id="lk-ob" autocomplete="off"><input id="lk-ob-name" data-testid="onboard-name" value="${esc(pname)}" aria-label="Portfolio name" placeholder="Portfolio name">
      <input id="lk-ob-cash" type="number" step="any" min="0" inputmode="decimal" data-testid="onboard-cash" placeholder="Cash in your broker account (EGP)" aria-label="Cash in your broker account (EGP)">
      <textarea id="lk-ob-hold" rows="4" data-testid="onboard-holdings" placeholder="Shares you hold, one per line, e.g.\nCOMI 100\nETEL 250" aria-label="Shares you hold"></textarea>
      <button class="lk-btn ghost" id="lk-ob-go" data-testid="onboard-submit">Start tracking from today</button></form></details>
      <div class="lk-err" role="alert">${esc(note || '')}</div>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-ob-skip" data-testid="onboard-skip">Skip: start with an empty portfolio</button></div>`);
    if (note) $l('#lk-ob-manual').open = true;   // an error in the typed holdings: keep the form open
    $l('#lk-ob-hist').onclick = async () => {
      const b = $l('#lk-ob-hist'); b.disabled = true; err('Setting up…');
      try { await createPortfolio($l('#lk-ob-name').value.trim() || pname, '', '0', '', { history: true }); await start(); gmailSetupScreen(async () => { open(); await offerBio(PK8); }, true, false, true); }
      catch (e) { console.error(e); b.disabled = false; err(e.message || String(e)); }
    };
    const run = async (holdText, cashText) => {
      const go = $l('#lk-ob-go'); go.disabled = true; err('Setting up…');
      try { await createPortfolio($l('#lk-ob-name').value.trim() || pname, '', cashText, holdText); await start(); gmailScreen(async () => { open(); await offerBio(PK8); }, true); }
      catch (e) { console.error(e); go.disabled = false; err(e.message || String(e)); }
    };
    $l('#lk-ob').onsubmit = (ev) => { ev.preventDefault(); run($l('#lk-ob-hold').value, $l('#lk-ob-cash').value); };
    $l('#lk-ob-skip').onclick = () => run('', '0');
  }
  // history: built later from the Thndr emails (run_account_mail.py + history_seed.js): no start date yet, nothing typed
  async function createPortfolio(pname, holder, cashText, holdText, opts) {
    const history = !!(opts && opts.history);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
    const cash = cashText === '' || cashText == null ? 0 : parseFloat(String(cashText).replace(/[, ]/g, ''));
    if (!isFinite(cash) || cash < 0) throw new Error('Enter the cash as a number (0 if none).');
    const mk = await fetchMarket().catch(() => ({ docs: {} }));
    let quotes = ((mk.docs || {})['market/latest'] || {}).quotes || {};
    const lines = String(holdText || '').split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length && !Object.keys(quotes).length) { try { const L = await livePrices(); quotes = (L && L.quotes) || {}; } catch (e) { /* checked below */ } }
    const rows = [], items = {}, members = (((mk.docs || {})['bench/egx30'] || {}).members) || [];
    const rid = () => Math.random().toString(36).slice(2, 10);
    let invested = 0;
    for (const l of lines) {
      const m = l.match(/^([A-Za-z0-9.]+)[\s,:]+([\d,.]+)$/);
      if (!m) throw new Error(`"${l}": write the symbol and the number of shares, like COMI 100`);
      const sym = m[1].toUpperCase(), q = parseFloat(m[2].replace(/,/g, '')), qt = quotes[sym];
      if (!(q > 0)) throw new Error(`"${l}": the number of shares must be above 0`);
      if (!qt || !(qt.price > 0)) throw new Error(`${sym}: no price for this symbol today. Check the symbol (the EGX ticker, like COMI).`);
      const name = qt.name || sym, mem = members.find((x) => x.s === sym);
      items[name] = { name, symbol: sym, sector: (mem && mem.sector) || 'Unclassified' };
      const amt = Math.round(q * qt.price * 100) / 100; invested += amt;
      rows.push({ id: rid(), d: today, t: 'Buy', a: name, q, p: qt.price, amt: -amt, acc: 'Main', src: 'manual', opening: true, note: 'Holding at sign-up, valued at that day\'s price' });
    }
    if (invested + cash > 0) rows.unshift({ id: rid(), d: today, t: 'Deposit', amt: Math.round((invested + cash) * 100) / 100, acc: 'Main', src: 'manual', opening: true, note: 'Starting value at sign-up (cash + holdings at that day\'s prices)' });
    const L = (mk.docs || {})['market/latest'] || {}, ix = (L.index || {}).EGX30CAPPED || {}, pol = ((L.rates || {}).policy || {}).rate, fx = ((L.fx || {}).USDEGP || {}).price;
    // trackFrom: Thndr emails and statements are used from the day after sign-up; the opening rows cover everything before
    const settings = { name: pname, portfolioId: CUR.id, inception: today.slice(0, 7), openingValue: 0, cash, cashDate: today, cashSource: history ? 'from the Thndr emails (not built yet)' : 'entered at sign-up',
      // both empty for a new account: its first Thndr statement sets the account (statement.js ownerCheck)
      account: { holder: holder || '', unifiedCode: '' },
      riskFree: typeof pol === 'number' ? pol : 0.22, fxStart: typeof fx === 'number' ? fx : 50, benchCloseStart: typeof ix.prevMonthClose === 'number' ? ix.prevMonthClose : null,
      openThreshold: 0.5, staleDays: 7, volLow: 0.03, volHigh: 0.08, priceDate: today, factsheetEmail: '', returnMethod: 'dietz' };
    if (history) settings.historyImport = { status: 'pending' }; else settings.trackFrom = today;
    await saveDoc('set', 'portfolio/settings', settings);
    await saveDoc('set', 'portfolio/assets', { items });
    await saveDoc('set', 'portfolio/marks', { months: {} });
    await saveDoc('set', 'ledger/y' + today.slice(0, 4), { rows });
  }
  function signInScreen(email, note) {
    screen(`<h1>Sign in</h1><p>Open your portfolio on this device.</p>
      <form id="lk-si" autocomplete="on"><input id="lk-si-email" type="email" data-testid="signin-email" placeholder="Email" aria-label="Email" autocomplete="email" autocapitalize="none" spellcheck="false" value="${esc(email || '')}">
      <input id="lk-si-pw" type="password" data-testid="signin-password" placeholder="Password" aria-label="Password" autocomplete="current-password">
      <button class="lk-btn" id="lk-si-go" data-testid="signin-submit">Sign in</button><div class="lk-err" role="alert">${esc(note || '')}</div></form>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-si-forgot" data-testid="signin-forgot">Forgot password</button><button type="button" class="lk-link" id="lk-si-new" data-testid="signin-to-signup">Create an account</button><button type="button" class="lk-link" id="lk-si-back">Back</button></div>`);
    const em = $l('#lk-si-email'), pw = $l('#lk-si-pw'), go = $l('#lk-si-go');
    (email ? pw : em).focus();
    $l('#lk-si-new').onclick = () => signUpScreen();
    $l('#lk-si-back').onclick = () => chooseScreen();
    $l('#lk-si-forgot').onclick = async () => {
      const e = em.value.trim(); if (!e) return err('Enter your email first, then tap Forgot password.');
      try { await fbAuth('sendOobCode', { requestType: 'PASSWORD_RESET', email: e }); err(''); signInScreen(e, 'If that email has an account, a link to choose a new password is on its way. After that, sign in with the new password; you will need your recovery code once.'); }
      catch (x) { err(x.message || String(x)); }
    };
    $l('#lk-si').onsubmit = async (ev) => {
      ev.preventDefault(); const e = em.value.trim(), p = cleanPw(pw.value); if (!e || !p) return;
      go.disabled = true; err('Signing in…');
      try {
        const a = await fbAuth('signInWithPassword', { email: e, password: p, returnSecureToken: true });
        CLOUD = session(a);
        if (await tombstoned(a.localId)) { await fsDel(`deleted/${a.localId}`).catch(() => {}); await fbAuth('delete', { idToken: a.idToken }).catch(() => {}); CLOUD = null; return goneScreen(); }
        let prof;
        try { prof = await readProfile(a.localId); }
        catch (x) { if (x && x.code === 'not_found') return restartScreen(a, p, e); throw x; }
        let pk8;
        try { pk8 = await unwrapKey(prof.keys.pwrap, p); }
        catch (x) { if (x && x.name === 'OperationError') return recoverScreen(a, prof, p, e); throw x; }   // the password was reset: the key needs the recovery code once
        await adoptAccount(a, pk8, prof.keys, prof.name, p, e);
        await start(); open(); await offerBio(PK8);
      } catch (x) { console.error(x); go.disabled = false; err(x.message || String(x)); }
    };
  }
  // after a password reset the key is still locked by the old password: the recovery code opens it, and it is re-locked with the new one
  function recoverScreen(a, prof, pw, email) {
    screen(`<h1>Enter your recovery code</h1><p>Your password was changed, so this one time your portfolio needs the recovery code you saved when you made the account.</p>
      <form id="lk-rc" autocomplete="off"><input id="lk-rc-code" data-testid="recover-code" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" autocapitalize="characters" spellcheck="false" aria-label="Recovery code">
      <button class="lk-btn" id="lk-rc-go2" data-testid="recover-submit">Unlock</button><div class="lk-err" role="alert"></div></form>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-rc-back">Back</button></div>`);
    $l('#lk-rc-back').onclick = () => signInScreen(email);
    $l('#lk-rc').onsubmit = async (ev) => {
      ev.preventDefault(); const b = $l('#lk-rc-go2'); b.disabled = true; err('Checking…');
      try {
        const pk8 = await unwrapKey(prof.keys.wrap, cleanCode($l('#lk-rc-code').value));
        const keys = Object.assign({}, prof.keys, { pwrap: await wrapKey(pk8, pw, 310000) });
        await fsReq('PATCH', `users/${a.localId}`, { fields: { keys: { stringValue: JSON.stringify(keys) } } }, 'updateMask.fieldPaths=keys');
        await adoptAccount(a, pk8, keys, prof.name, pw, email);
        await start(); open(); await offerBio(PK8);
      } catch (x) { console.error(x); b.disabled = false; err(x && x.name === 'OperationError' ? 'That recovery code is not right. Check it and try again.' : (x.message || String(x))); }
    };
  }
  function accountScreen() {
    if (LINK && !CUR.cloud) return linkedScreen();
    screen(`<h1>${esc(CUR.name)}</h1><p>Signed in as <b>${esc(CUR.email || (CLOUD && CLOUD.email) || '')}</b>. Your portfolio is saved in your account, locked with your password.</p>
      <button class="lk-btn ghost" id="lk-ac-pw" data-testid="account-password">Change password</button>
      <button class="lk-btn ghost" id="lk-ac-friends" data-testid="account-friends">Friends${incoming() ? ` · ${incoming()} new` : ''}</button>
      <button class="lk-btn ghost" id="lk-ac-gmail" data-testid="account-gmail">Thndr emails${gmailOn() ? ' · connected' : ''}</button>
      <button class="lk-btn ghost" id="lk-ac-mail" data-testid="account-email">Email updates${mailOn() ? ' · on' : ''}</button>
      <button class="lk-btn ghost" id="lk-ac-code" data-testid="account-new-code">Make a new recovery code</button>
      <button class="lk-btn ghost" id="lk-ac-out" data-testid="account-signout">Sign out on this device</button>
      <button class="lk-btn ghost" id="lk-ac-admin" data-testid="account-admin" ${isOwner() ? '' : 'hidden'}>Admin: your friends' accounts</button>
      <p class="lk-hint" id="lk-ac-owner" data-testid="account-owner-note" hidden>This is your sign-in for Admin and Friends. Your main portfolio already reads your Thndr emails and sends your emails, so nothing else is needed here.</p>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-ac-back" data-testid="account-back">Back</button><button type="button" class="lk-link" id="lk-ac-del" data-testid="account-delete">Delete my account</button></div>`);
    $l('#lk-ac-friends').onclick = () => friendsScreen();
    listFriends().then(() => { const b = $l('#lk-ac-friends'); if (b) b.textContent = 'Friends' + (incoming() ? ` · ${incoming()} new` : ''); }).catch(() => {});
    $l('#lk-ac-del').onclick = () => deleteScreen();
    $l('#lk-ac-admin').onclick = () => adminScreen();
    // the owner's own account is just the sign-in for admin and friends: the main portfolio does the Thndr emails and emails
    const ownerView = (y) => { const b = $l('#lk-ac-admin'); if (b) b.hidden = !y; ['#lk-ac-gmail', '#lk-ac-mail'].forEach((id) => { const x = $l(id); if (x) x.hidden = y; }); const n = $l('#lk-ac-owner'); if (n) n.hidden = !y; };
    ownerView(isOwner()); checkOwner().then(ownerView).catch(() => {});
    $l('#lk-ac-back').onclick = open;
    $l('#lk-ac-mail').onclick = () => mailScreen();
    $l('#lk-ac-gmail').onclick = () => gmailScreen(accountScreen);
    $l('#lk-ac-out').onclick = () => forgetScreen(() => accountScreen(), 'Your portfolio stays in your account; sign in again to open it here. ');
    $l('#lk-ac-code').onclick = async () => {
      const b = $l('#lk-ac-code'); b.disabled = true;
      try {
        const prof = await readProfile(CLOUD.uid), code = recoveryCode();
        const keys = Object.assign({}, prof.keys, { wrap: await wrapKey(PK8, cleanCode(code), 600000) });
        await fsReq('PATCH', `users/${CLOUD.uid}`, { fields: { keys: { stringValue: JSON.stringify(keys) } } }, 'updateMask.fieldPaths=keys');
        const a = accounts().find((x) => x.id === CUR.id); if (a) saveAccount(Object.assign(a, { keys: { v: 3, pub: keys.pub, wrap: keys.wrap } })); KEYS = { v: 3, pub: keys.pub, wrap: keys.wrap };
        recoveryScreen(code, open);
      } catch (e) { console.error(e); b.disabled = false; toast('Could not make a new code: ' + (e.message || e), 'error'); }
    };
    $l('#lk-ac-pw').onclick = () => passwordScreen({ title: 'Choose a new password', intro: 'It replaces your account password everywhere. Other devices ask for the new one next time.', back: accountScreen,
      done: async (npw) => {
        const p = cleanPw(npw);
        const j = await fbAuth('update', { idToken: await idToken(), password: p, returnSecureToken: true });
        if (j.idToken) Object.assign(CLOUD, { idToken: j.idToken, refresh: j.refreshToken || CLOUD.refresh, exp: Date.now() + (+j.expiresIn || 3600) * 1000 });
        const prof = await readProfile(CLOUD.uid);
        const keys = Object.assign({}, prof.keys, { pwrap: await wrapKey(PK8, p, 310000) });
        await fsReq('PATCH', `users/${CLOUD.uid}`, { fields: { keys: { stringValue: JSON.stringify(keys) } } }, 'updateMask.fieldPaths=keys');
        await storeV3(PK8, p); await storeSession(); await resealMail().catch((e) => console.warn('email updates not refreshed', e));
        open(); toast('Password changed.');
      } });
  }
  /* Email updates (opt-in): the account lets the site owner's daily email job open its portfolio to write its heads-up
     alerts and weekly summary (src/jobs/run_account_mail.py). The browser seals {uid, email, refresh token, private key,
     prefs} to the MAIL key (the public key in p/khaled/keys.json, label 'portfolio-mail-v1') and stores it as Firestore
     mail/{uid}; switching off deletes it. The job reads the portfolio with the account's own token. */
  const MAIL_LABEL = 'portfolio-mail-v1';
  const mailLS = () => 'pd.mail.' + CUR.id;
  const mailPrefs = () => ls.get(mailLS());
  const mailOn = () => { const m = mailPrefs(); return !!(m && (m.alerts || m.weekly || m.reports)); };
  const gmailOn = () => !!(mailPrefs() || {}).gmail;
  const sha = async (s) => b64big(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  const sealTo = (pubB64, bytes, label) => seal(bytes, label, pubB64);
  async function writeMail(prefs) {
    const mk = await (await fetch('p/khaled/keys.json', { cache: 'no-store' })).json();
    const pkg = { v: 1, uid: CLOUD.uid, email: prefs.email, refresh: CLOUD.refresh, pk8: b64big(acctKey()), prefs: { alerts: !!prefs.alerts, weekly: !!prefs.weekly, reports: !!prefs.reports, leaderboard: prefs.leaderboard !== false, reportCard: prefs.reportCard !== false, gmail: !!prefs.gmail, shareMain: !!prefs.shareMain }, at: new Date().toISOString() };
    const env = Object.assign({ v: 1 }, await sealTo(mk.pub, enc.encode(JSON.stringify(pkg)), MAIL_LABEL));
    await fsReq('PATCH', `mail/${CLOUD.uid}`, { fields: { pkg: { stringValue: JSON.stringify(env) }, at: { stringValue: pkg.at } } });
    ls.set(mailLS(), Object.assign({}, prefs, { ref: await sha(CLOUD.refresh) }));
  }
  // nothing left on: the package is deleted, so the job no longer opens the portfolio
  async function setMail(prefs) {
    if (prefs.alerts || prefs.weekly || prefs.reports || prefs.leaderboard || prefs.reportCard || prefs.gmail || prefs.shareMain) return writeMail(prefs);
    await fsReq('DELETE', `mail/${CLOUD.uid}`); ls.del(mailLS());
  }
  // the job signs in with the saved refresh token: after a password change (which ends old sessions) it is sealed again
  async function resealMail() { const m = mailPrefs(); if (m && CLOUD && CLOUD.refresh && m.ref !== (await sha(CLOUD.refresh))) await writeMail(m); }
  function mailScreen(note) {
    const on = mailOn(), m = on ? mailPrefs() : Object.assign({ email: CUR.email || (CLOUD && CLOUD.email) || '' }, mailPrefs() || {}, { alerts: true, weekly: true, reports: true, leaderboard: true, reportCard: true });
    screen(`<h1>Email updates</h1><p>Get an email when something needs your attention (a dividend coming up, a target or stop reached, a big drop), a summary every Thursday evening, your month-end report (Excel workbook + PDF factsheet) when each monthly statement is posted, and early each month a report card on your trading and how you ranked among your friends (percentages only).</p>
      <p class="lk-tip">To write these, the site owner's email job has to open your portfolio, so while this is on your figures are not private from that job. Switch it off any time: nothing is kept after that.</p>
      <form id="lk-ml" autocomplete="off"><input id="lk-ml-email" type="email" data-testid="mail-address" value="${esc(m.email)}" placeholder="Email address" aria-label="Email address">
      <label class="lk-check"><input type="checkbox" id="lk-ml-alerts" data-testid="mail-alerts" ${m.alerts ? 'checked' : ''}> Heads-up alerts</label>
      <label class="lk-check"><input type="checkbox" id="lk-ml-weekly" data-testid="mail-weekly" ${m.weekly ? 'checked' : ''}> Weekly summary (Thursday evening)</label>
      <label class="lk-check"><input type="checkbox" id="lk-ml-reports" data-testid="mail-reports" ${m.reports ? 'checked' : ''}> Month-end report (Excel + PDF)</label>
      <label class="lk-check"><input type="checkbox" id="lk-ml-leaderboard" data-testid="mail-leaderboard" ${m.leaderboard !== false ? 'checked' : ''}> Friends leaderboard (1st of the month)</label>
      <label class="lk-check"><input type="checkbox" id="lk-ml-card" data-testid="mail-report-card" ${m.reportCard !== false ? 'checked' : ''}> Trading report card (early each month)</label>
      <button class="lk-btn" id="lk-ml-go" data-testid="mail-on">${on ? 'Save' : 'Turn on email updates'}</button><div class="lk-err" role="alert">${esc(note || '')}</div></form>
      ${on ? '<button class="lk-btn ghost" id="lk-ml-off" data-testid="mail-off">Turn off email updates</button>' : ''}
      <div class="lk-links"><button type="button" class="lk-link" id="lk-ml-back" data-testid="mail-back">Back</button></div>`);
    $l('#lk-ml-back').onclick = accountScreen;
    $l('#lk-ml').onsubmit = async (ev) => {
      ev.preventDefault(); const email = $l('#lk-ml-email').value.trim(), alerts = $l('#lk-ml-alerts').checked, weekly = $l('#lk-ml-weekly').checked, reports = $l('#lk-ml-reports').checked, leaderboard = $l('#lk-ml-leaderboard').checked, reportCard = $l('#lk-ml-card').checked;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err('Enter an email address.');
      if (!alerts && !weekly && !reports && !leaderboard && !reportCard) return err('Pick at least one kind of email, or turn email updates off.');
      const b = $l('#lk-ml-go'); b.disabled = true; err('Saving…');
      try { await writeMail(Object.assign({}, mailPrefs() || {}, { email, alerts, weekly, reports, leaderboard, reportCard, gmail: gmailOn() })); open(); toast('Email updates are on. The first ones come after the next market close.'); }
      catch (e) { console.error(e); b.disabled = false; err(e.message || String(e)); }
    };
    const off = $l('#lk-ml-off');
    if (off) off.onclick = async () => {
      off.disabled = true;
      try { await setMail(Object.assign({}, mailPrefs(), { alerts: false, weekly: false, reports: false, leaderboard: false, reportCard: false })); open(); toast('Email updates are off.'); }
      catch (e) { console.error(e); off.disabled = false; err(e.message || String(e)); }
    };
  }
  /* Thndr emails (opt-in): the account connects its own Gmail with a Google app password, and the account job imports its
     Thndr invoices and statements three times a day, 4:15 pm, 6:15 pm and 11 pm Cairo (email-run.yml: run_account_mail.py: imap_fetch.py, then sync.js). The login is the
     account's own document sync/gmail, encrypted to its key like every other document; the mail package says gmail: true
     so the job opens it. Turning it off deletes that document. Every screen says plainly what to do and what it means. */
  const GOOGLE_2SV = 'https://myaccount.google.com/signinoptions/twosv', GOOGLE_APPPW = 'https://myaccount.google.com/apppasswords';
  // done: where "Not now" / "Done" leads (the portfolio after sign-up, the Account menu otherwise)
  function gmailScreen(done, first) {
    if (gmailOn()) return gmailStatusScreen(done);
    screen(`<h1>Add your trades automatically?</h1>
      <p>Thndr emails you after every trade. If those emails go to your Gmail, the site can read them and add your trades for you, so you never have to type them in.</p>
      <button class="lk-btn" id="lk-gm-go" data-testid="gmail-start">Yes, set it up (about 3 minutes)</button>
      <button class="lk-btn ghost" id="lk-gm-skip" data-testid="gmail-skip">${first ? "No thanks, I'll add trades myself" : 'Back'}</button>
      <p class="lk-hint">You can turn this on or off later: Account → Thndr emails.</p>`);
    $l('#lk-gm-go').onclick = () => gmailSetupScreen(done, first);
    $l('#lk-gm-skip').onclick = () => done();
  }
  // one screen: the Gmail address, the two Google pages (opened in that Google account), the code. No Thndr name to type:
  // the first Thndr statement found records the portfolio's Thndr account number, and from then on only that account's
  // documents are used (statement.js ownerCheck)
  async function gmailSetupScreen(done, first, change, history) {
    const [set, login] = await Promise.all([readCloudDoc('portfolio', 'settings').catch(() => ({})), readCloudDoc('sync', 'gmail').catch(() => ({}))]);
    const S0 = (set.doc && set.doc.data) || {}, L0 = (login.doc && login.doc.data) || {};
    const email = CUR.email || (CLOUD && CLOUD.email) || '';
    const addr0 = L0.address || (/@(gmail|googlemail)\.com$/i.test(email) ? email : '');
    let n = 0;
    const step = (title, sub) => `<div class="lk-step"><span class="lk-num">${++n}</span><div><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</div></div>`;
    screen(`<h1>${change ? 'New app password' : history ? 'Build it from your Thndr emails' : 'Connect your Gmail'}</h1>
      ${history ? '<p>Connect the Gmail your Thndr emails go to. The site finds your Thndr statements there and builds your portfolio from them: no typing. About 3 minutes.</p>' : ''}
      <form id="lk-gm" autocomplete="off">
      ${step('Type your Gmail', 'The one your Thndr emails go to.')}
      <input id="lk-gm-addr" type="email" data-testid="gmail-address" value="${esc(addr0)}" placeholder="you@gmail.com" autocapitalize="none" spellcheck="false" aria-label="Your Gmail address">
      ${change ? '' : `${step('Turn on 2-Step Verification', 'Tap the button, then turn it on. Already says <b>On</b>? Skip this step.')}
      <a class="lk-btn ghost" id="lk-gm-2sv" href="${GOOGLE_2SV}" target="_blank" rel="noopener noreferrer" data-testid="gmail-2sv-link">Open 2-Step Verification ↗</a>`}
      ${step('Make an app password', 'Tap the button. Type <b>EGX Tracker</b> as the name, tap <b>Create</b>, and copy the 16 letters Google shows you.')}
      <a class="lk-btn ghost" id="lk-gm-app" href="${GOOGLE_APPPW}" target="_blank" rel="noopener noreferrer" data-testid="gmail-apppw-link">Open App passwords ↗</a>
      ${step('Paste the 16 letters here')}
      <input id="lk-gm-pw" data-testid="gmail-app-password" placeholder="abcd efgh ijkl mnop" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="App password">
      ${change || mailOn() ? '' : '<label class="lk-check"><input type="checkbox" id="lk-gm-mail" data-testid="gmail-also-mail" checked> Also email me alerts, a weekly summary and my month-end report</label>'}
      <button class="lk-btn" id="lk-gm-go" data-testid="gmail-connect">${change ? 'Save' : 'Connect'}</button><div class="lk-err" role="alert"></div></form>
      <p class="lk-hint">Google says "not available for your account"? Do the 2-Step Verification step first. Work or school Gmail accounts may not allow this.</p>
      <details class="lk-more"><summary>Is this safe?</summary><p>The app password lets the site open your Gmail, but it only searches for emails from Thndr. It never sends, changes or deletes anything. While this is on, the site's daily job can open your portfolio to add the trades. To stop it, turn it off in Account → Thndr emails, or delete "EGX Tracker" in your Google App passwords.</p></details>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-gm-back" data-testid="gmail-back">Back</button></div>`);
    $l('#lk-gm-back').onclick = () => (change ? gmailStatusScreen(done) : history ? done() : gmailScreen(done, first));
    // the Google buttons open the Google account of the address typed (authuser), not whichever is signed in first
    const links = () => { const a = $l('#lk-gm-addr').value.trim(), q = /@/.test(a) ? '?authuser=' + encodeURIComponent(a) : '';
      const s = $l('#lk-gm-2sv'); if (s) s.href = GOOGLE_2SV + q; $l('#lk-gm-app').href = GOOGLE_APPPW + q; };
    $l('#lk-gm-addr').oninput = links; links();
    ($l('#lk-gm-addr').value ? $l('#lk-gm-pw') : $l('#lk-gm-addr')).focus();
    $l('#lk-gm').onsubmit = async (ev) => {
      ev.preventDefault();
      const address = $l('#lk-gm-addr').value.trim(), appPassword = $l('#lk-gm-pw').value.replace(/\s+/g, '').toLowerCase();
      const also = !change && !!($l('#lk-gm-mail') || {}).checked;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return err('Step 1: type your Gmail address.');
      if (!/^[a-z]{16}$/.test(appPassword)) return err('The app password is 16 letters (Google shows it as 4 groups of 4). Copy it again from Google.');
      const b = $l('#lk-gm-go'); b.disabled = true; err('Connecting…');
      try {
        await saveDoc('set', 'sync/gmail', { address, appPassword, connectedAt: new Date().toISOString() });
        if (!change) {
          const patch = {};
          if (!S0.trackFrom && !(S0.historyImport && S0.historyImport.status === 'pending')) patch.trackFrom = cairoDay(Date.now() / 1000);   // the ledger so far stands; emails count from the next day
          if (Object.keys(patch).length) await saveDoc('update', 'portfolio/settings', patch);
          const m = Object.assign({ email: email || address, alerts: false, weekly: false, reports: false, leaderboard: false, reportCard: false }, mailPrefs() || {});
          if (also) Object.assign(m, { email: m.email || address, alerts: true, weekly: true, reports: true, leaderboard: true, reportCard: true });
          await writeMail(Object.assign(m, { gmail: true }));
          return gmailDoneScreen(done, history || !!(S0.historyImport && S0.historyImport.status === 'pending'));
        }
        toast('App password saved. The next check uses it.'); gmailStatusScreen(done);
      } catch (e) { console.error(e); b.disabled = false; err(e.message || String(e)); }
    };
  }
  function gmailDoneScreen(done, history) {
    if (history) {
      screen(`<h1>You're connected</h1>
        <p data-testid="gmail-done-when">Your portfolio is being built now. It usually takes <b>about 10 minutes</b>, and <b>we email you when it is ready</b>. You can close the site meanwhile.</p>
        <ul class="lk-steps"><li>It starts from your first monthly Thndr statement and adds every statement and trade since, so your returns go back to then.</li>
          <li>After that, new Thndr emails are added by themselves three times a day (4:15 pm, 6:15 pm and 11 pm Cairo).</li></ul>
        <button class="lk-btn" id="lk-gm-done" data-testid="gmail-done">Done</button>`);
      $l('#lk-gm-done').onclick = () => done();
      return;
    }
    screen(`<h1>You're connected</h1>
      <p data-testid="gmail-done-when">The first check runs <b>within about 10 minutes</b>. After that the site checks your Gmail three times a day (4:15 pm, 6:15 pm and 11 pm Cairo) and adds your new Thndr trades by itself.</p>
      <ul class="lk-steps"><li>Your monthly Thndr statement corrects everything to Thndr's numbers${(mailPrefs() || {}).reports ? ', and your month-end report is emailed to you' : ''}.</li>
        <li>If something does not match, nothing is changed and you get an email saying what to check.</li></ul>
      <button class="lk-btn" id="lk-gm-done" data-testid="gmail-done">Done</button>`);
    $l('#lk-gm-done').onclick = () => done();
  }
  async function gmailStatusScreen(done) {
    const [login, rec] = await Promise.all([readCloudDoc('sync', 'gmail').catch(() => ({})), readCloudDoc('sync', 'mail').catch(() => ({}))]);
    const addr = ((login.doc && login.doc.data) || {}).address || '', g = (((rec.doc && rec.doc.data) || {}).gmail) || null;
    const when = g && g.at ? new Date(g.at).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const hs = (((rec.doc && rec.doc.data) || {}).history) || null;
    const status = !g ? 'Not checked yet: the first check runs within about 10 minutes of connecting.'
      : g.ok ? `<span class="lk-ok">Working.</span> Last checked ${esc(when)}: ${g.new ? `${g.new} new Thndr email${g.new > 1 ? 's' : ''}` : 'no new Thndr emails'}${g.held ? `, ${g.held} need${g.held > 1 ? '' : 's'} a look (see the email you got)` : ''}.`
      : `<b>The last check failed</b> (${esc(when)}): ${esc(g.error || 'unknown error')}. Usually the app password was deleted or changed: tap <b>Change app password</b>.`;
    const hline = !hs ? '' : hs.status === 'waiting' ? `<p class="lk-tip" data-testid="gmail-history">Building your portfolio from your Thndr emails: waiting, because ${esc(hs.reason || 'no monthly statement was found yet')}. It is built by itself as soon as one arrives.</p>`
      : hs.status === 'done' ? `<p class="lk-hint" data-testid="gmail-history">Built from your Thndr emails, starting from your ${esc(hs.from || '')} monthly statement.</p>` : '';
    screen(`<h1>Thndr emails</h1><p>Connected to <b>${esc(addr)}</b>. New Thndr invoices and statements are added to your portfolio three times a day (4:15 pm, 6:15 pm and 11 pm Cairo time).</p>${hline}
      <p class="lk-tip" data-testid="gmail-status">${status}</p>
      <button class="lk-btn ghost" id="lk-gm-change" data-testid="gmail-change">Change app password</button>
      <button class="lk-btn ghost" id="lk-gm-off" data-testid="gmail-off">Turn off</button>
      <div class="lk-err" role="alert"></div>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-gm-back" data-testid="gmail-back">Back</button></div>`);
    $l('#lk-gm-back').onclick = () => done();
    $l('#lk-gm-change').onclick = () => gmailSetupScreen(done, false, true);
    $l('#lk-gm-off').onclick = async () => {
      const b = $l('#lk-gm-off'); b.disabled = true; err('Turning off…');
      try {
        await setMail(Object.assign({}, mailPrefs(), { gmail: false }));
        await saveDoc('delete', 'sync/gmail');
        toast('Thndr emails are off. You can delete the "EGX Tracker" app password in your Google account too.'); done();
      } catch (e) { console.error(e); b.disabled = false; err(e.message || String(e)); }
    };
  }
  /* ---------- friends, status for the site owner, deleting or restarting an account ----------
     Friends compare returns, in percentages only. links/{uid}/with/{other} holds each side of a friendship ('sent',
     'received', then 'friends' once the one who received it accepts); a friend is found by their @username through
     handles/{handle} = {uid, name, pub, at} or by their sign-in email through directory/{email} = {uid, name, pub}. Each
     side keeps shares/{me}/to/{friend} = its PERCENTAGES PROFILE (engine2.js friendProfile: returns by month, holdings by
     weight, trades as %; never an amount, a share count or a price) gzipped and sealed to the friend's public key
     ('portfolio-share-v1'): refreshed when the account opens or saves (and by the email job for accounts that have it),
     readable only by that friend. Tapping a friend opens their profile page; the Overview shows the friends ranking and
     their latest trades. Removing a friend deletes both sides and both copies.
     status/{uid} = {name, email, createdAt, lastSeen, site: JSON {mail, reports, gmail, friends}, job: JSON (written by
     the email job)} is what the site owner's admin screen lists: no figures. The owner (OWNER_EMAIL, verified) can reset
     an account there: everything of it is deleted except the sign-in; signing in again starts afresh (restartScreen). */
  // the site owner's sign-in email, as its SHA-256 (the address itself is not published); the database rules hold the
  // address and decide, this only shows the Admin button and the "main portfolio" choice
  const OWNER_HASH = '467022c320757248bf70115c83d305a7e4d139c35e1be5f8117fb30d7f769347', SHARE_LABEL = 'portfolio-share-v1';
  const JOB_URL = 'https://github.com/khaledamin2001-lgtm/portfolio-engine/actions/workflows/account-mail.yml';
  let FRIENDS = null;   // the open account's links: [{uid, status, name, pub, email, handle, at}]
  let MY_HANDLE = null;   // the open account's @username: '' none yet, null not looked up this session
  let OWNER = { email: null, yes: false };
  const hex = async (t) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(t))), (b) => b.toString(16).padStart(2, '0')).join('');
  async function checkOwner() { const e = String((CLOUD && CLOUD.email) || '').toLowerCase(); if (OWNER.email !== e) OWNER = { email: e, yes: !!e && (await hex(e)) === OWNER_HASH }; return OWNER.yes; }
  const isOwner = () => !!(CLOUD && OWNER.yes && OWNER.email === String(CLOUD.email || '').toLowerCase());
  const incoming = () => (FRIENDS || []).filter((f) => f.status === 'received').length;
  const fsFields = (o) => ({ fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { stringValue: String(v) }])) });
  const fsData = (doc) => Object.fromEntries(Object.entries((doc && doc.fields) || {}).map(([k, v]) => [k, v.stringValue != null ? v.stringValue : v.integerValue != null ? +v.integerValue : v.booleanValue]));
  const maskOf = (keys) => keys.map((k) => 'updateMask.fieldPaths=' + k).join('&');
  const jparse = (x) => { try { return JSON.parse(x); } catch (e) { return null; } };
  // dates written by an account (status lines) can be anything: an unreadable one shows as '—' instead of breaking the screen
  const okDate = (iso) => !!iso && isFinite(Date.parse(iso));
  const dayOf = (iso) => (okDate(iso) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: 'numeric', month: 'short' }).format(new Date(iso)) : '—');
  const whenOf = (iso) => (okDate(iso) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—');
  async function listAll(path, extra) {
    const out = []; let t = '';
    do { const j = await fsReq('GET', path, null, 'pageSize=300' + (extra ? '&' + extra : '') + (t ? '&pageToken=' + encodeURIComponent(t) : '')); (j.documents || []).forEach((d) => out.push(d)); t = j.nextPageToken || ''; } while (t);
    return out;
  }
  const fsDel = (p) => fsReq('DELETE', p).catch((e) => { if (e.code !== 'not_found') throw e; });
  async function writeStatus(extra) {
    const m = mailPrefs() || {};
    const o = Object.assign({ name: CUR.name, email: CLOUD.email || CUR.email || '', lastSeen: new Date().toISOString(),
      site: JSON.stringify({ mail: !!(m.alerts || m.weekly), reports: !!m.reports, gmail: !!m.gmail, friends: (FRIENDS || []).filter((f) => f.status === 'friends').length }) }, extra || {});
    await fsReq('PATCH', `status/${CLOUD.uid}`, fsFields(o), maskOf(Object.keys(o)));
  }
  async function listFriends() {
    FRIENDS = (await listAll(`links/${CLOUD.uid}/with`)).map((d) => Object.assign({ uid: d.name.split('/').pop() }, fsData(d)));
    accountBadge();
    return FRIENDS;
  }
  function accountBadge() { whenReady(() => { const b = document.getElementById('pd-account'); if (b) b.textContent = incoming() ? `Account (${incoming()})` : 'Account'; }); }
  // directory/{email}: how friends find this account. Written only once Google has confirmed the email is really this
  // person's (email_verified; the database rules insist), so nobody can sign up with someone else's email to catch their
  // friend requests. Returns whether the email is verified.
  let verifyCheckedAt = 0;
  async function ensureDirectory() {
    if (!claims(await idToken()).email_verified) {
      // not verified in this sign-in token: get a fresh one (at most once a minute) in case the link was clicked since
      if (Date.now() - verifyCheckedAt < 60e3) return false;
      verifyCheckedAt = Date.now(); CLOUD.exp = 0;
      if (!claims(await idToken()).email_verified) return false;
    }
    const email = String(CLOUD.email || CUR.email || '').toLowerCase(), dk = 'pd.dir.' + CUR.id, dsig = acctPub() + '|' + CUR.name;
    if (email && ls.get(dk) !== dsig) { await fsReq('PATCH', `directory/${encodeURIComponent(email)}`, fsFields({ uid: CLOUD.uid, name: CUR.name, pub: acctPub() })); ls.set(dk, dsig); }
    return true;
  }
  // after an account opens: its directory entry (how friends find it), friend requests, the status line for the site owner
  // (once a day, or when a setting changed) and fresh copies of the portfolio for friends
  async function housekeeping() {
    await checkOwner();
    if (await ensureDirectory()) await ensureHandle().catch((e) => console.warn('no @username yet', e));
    await listFriends();
    const sk = 'pd.status.' + CUR.id, ssig = cairoDay(Date.now() / 1000) + JSON.stringify(mailPrefs() || {}) + FRIENDS.map((f) => f.status).join();
    if (ls.get(sk) !== ssig) { await writeStatus(); ls.set(sk, ssig); }
    if (incoming()) toast(`${FRIENDS.filter((f) => f.status === 'received').map((f) => f.name).join(', ')} sent you a friend request: tap Account, then Friends.`);
    if (/[?&]friends\b/.test(location.search)) { history.replaceState(null, '', location.pathname); if (PK8 && lockEl().hidden) friendsScreen(); }
    await refreshShares();
  }
  const gzip = async (text) => new Uint8Array(await new Response(new Blob([enc.encode(text)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const gunzip = async (bytes) => new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  async function refreshShares(force) {
    if (!FRIENDS || !CLOUD || !PK8) return;
    if (isOwner() && (mailPrefs() || {}).shareMain) return;   // the email job shares the owner's main portfolio instead
    const fr = FRIENDS.filter((f) => f.status === 'friends' && f.pub); if (!fr.length) return;
    const prof = myProfile(); if (!prof) return;
    const snapObj = { v: 2, at: new Date().toISOString(), name: CUR.name, profile: Object.assign({}, prof, { name: CUR.name, handle: MY_HANDLE || '' }) };
    const h = await sha(JSON.stringify(snapObj.profile)), body = JSON.stringify(snapObj);
    for (const f of fr) {
      const k = 'pd.share.' + CUR.id + '.' + f.uid, o = ls.get(k);
      if (!force && o && o.h === h && Date.now() - o.t < 20 * 3600e3) continue;
      try {
        if (!(await confirmedFriend(f))) { console.warn('friend copy not written: this link does not match its account', f.uid); continue; }
        const env = Object.assign({ v: 1 }, await sealTo(f.pub, await gzip(body), SHARE_LABEL));
        await fsReq('PATCH', `shares/${CLOUD.uid}/to/${f.uid}`, fsFields({ pkg: JSON.stringify(env), name: CUR.name, at: snapObj.at }));
        ls.set(k, { h, t: Date.now() });
      } catch (e) { console.warn('friend copy not refreshed', e); }
    }
  }
  // A link's name, email and public key are written by the OTHER person, so before anything is sealed to that key it is
  // checked against directory/{email}, which only the owner of that sign-in email can write: same account, same key.
  // A request sent to an @username has no email on the asker's side until it is accepted: it is checked against
  // handles/{handle} instead, which only that account can hold. A request that does not match (someone posing as another
  // person) is never accepted and never gets a copy.
  const CONFIRMED = {};   // uid -> the public key confirmed for it this session
  async function confirmedFriend(f) {
    if (!f || !f.pub || !(f.email || f.handle)) return false;
    if (CONFIRMED[f.uid] === f.pub) return true;
    let d = null;
    if (f.email) { try { d = fsData(await fsReq('GET', `directory/${encodeURIComponent(String(f.email).toLowerCase())}`)); } catch (e) { if (e.code !== 'not_found') throw e; } }
    else d = await readHandle(cleanHandle(f.handle));
    const ok = !!d && d.uid === f.uid && d.pub === f.pub;
    if (ok) CONFIRMED[f.uid] = f.pub;
    return ok;
  }
  /* @usernames. handles/{handle} = {uid, name, pub, at}: how friends find an account without its email. Taken by itself
     once the email is confirmed, from the portfolio name ("Omar's Portfolio" -> @omar, or @omar2 ... when that is taken),
     and changed on the Friends screen. The account's own username is also kept in its status/{uid} (handle) so every
     device knows it. The database rules make a username impossible to take over while someone holds it. */
  const HANDLE_RE = /^[a-z][a-z0-9_]{2,19}$/;
  const cleanHandle = (s) => String(s || '').trim().replace(/^@+/, '').toLowerCase();
  async function readHandle(h) {
    if (!HANDLE_RE.test(h)) return null;
    try { return fsData(await fsReq('GET', `handles/${h}`)); } catch (e) { if (e.code === 'not_found') return null; throw e; }
  }
  async function myHandle() {
    if (MY_HANDLE != null) return MY_HANDLE;
    let st = {}; try { st = fsData(await fsReq('GET', `status/${CLOUD.uid}`)); } catch (e) { if (e.code !== 'not_found') throw e; }
    const h = cleanHandle(st.handle), d = h ? await readHandle(h).catch(() => null) : null;
    MY_HANDLE = d && d.uid === CLOUD.uid ? h : '';
    return MY_HANDLE;
  }
  function handleCandidates(name) {
    let b = String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019]s\b/g, '')
      .replace(/\bportfolio\b/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+$/, '').slice(0, 16);
    if (b.length < 3) b = b ? b + '_egx' : 'investor';
    const out = [b];
    for (let i = 2; i <= 9; i++) out.push(b + i);
    for (let i = 0; i < 3; i++) out.push(b + (100 + Math.floor(Math.random() * 900)));
    return out.filter((c) => HANDLE_RE.test(c));
  }
  // takes @h for this account and frees its old one; false when someone else holds it
  async function takeHandle(h) {
    const d = await readHandle(h);
    if (d && d.uid !== CLOUD.uid) return false;
    const body = fsFields({ uid: CLOUD.uid, name: CUR.name, pub: acctPub(), at: new Date().toISOString() });
    try { await fsReq('PATCH', `handles/${h}`, body, d ? '' : 'currentDocument.exists=false'); }
    catch (e) { if (e.code === 'conflict' || (e.code === 'forbidden' && (await readHandle(h).catch(() => null)))) return false; throw e; }
    const old = await myHandle();
    if (old && old !== h) await fsDel(`handles/${old}`).catch(() => {});
    MY_HANDLE = h; ls.set('pd.handle.' + CUR.id, h + '|' + acctPub() + '|' + CUR.name);
    await fsReq('PATCH', `status/${CLOUD.uid}`, fsFields({ handle: h }), maskOf(['handle']));
    return true;
  }
  // once the email is confirmed: the account has a username, and its entry shows the current name and key
  async function ensureHandle() {
    const h = await myHandle(), k = 'pd.handle.' + CUR.id, sig = h + '|' + acctPub() + '|' + CUR.name;
    if (h) { if (ls.get(k) !== sig) { await fsReq('PATCH', `handles/${h}`, fsFields({ uid: CLOUD.uid, name: CUR.name, pub: acctPub(), at: new Date().toISOString() })); ls.set(k, sig); } return h; }
    for (const c of handleCandidates(CUR.name)) if (await takeHandle(c)) return c;
    return '';
  }
  let shareTimer = null;
  function shareSoon() { clearTimeout(shareTimer); shareTimer = setTimeout(() => refreshShares().catch(() => {}), 8000); }
  /* ---------- a profile page: what a friend (or you) shares, percentages only ----------
     Opened by tapping a friend (or yourself) in the friends cards, the activity feed, the hub or the Friends screen: a
     sheet over the page with the return over the page's period next to yours and the index's, the months, holdings by
     weight, sectors, the latest trades and trading stats. Nothing on it is an amount: the profile has none. */
  let PROFILE_UID = null;
  function closeProfile() {
    PROFILE_UID = null;
    const sh = document.getElementById('pd-sheet'); if (sh) sh.remove();
    document.body.classList.remove('pd-sheet-open');
  }
  async function openProfile(uid, fresh) {
    const me = uid === 'me', f = me ? null : (FRIENDS || []).find((x) => x.uid === uid);
    if (!me && !f) return;
    let p = me ? myProfile() : fresh ? null : (HUB.friends[uid] || {}).p;
    if (!me && !p) {
      try { p = await friendProfile(f); HUB.friends[uid] = { p, t: Date.now() }; }
      catch (e) { toast(e.code === 'not_found' ? `${f.name} has not shared yet. It appears after they next open the site.` : 'Could not open it: ' + (e.message || e), 'error'); return; }
    }
    if (!p) { toast('Nothing to show yet.', 'error'); return; }
    closeProfile(); PROFILE_UID = uid;
    const sh = document.createElement('div'); sh.id = 'pd-sheet'; sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true'); sh.dataset.testid = 'profile-sheet';
    sh.innerHTML = profileHTML(p, f, me);
    document.body.appendChild(sh); document.body.classList.add('pd-sheet-open');
    sh.addEventListener('click', (e) => { if (e.target === sh || e.target.closest('[data-ps-close]')) closeProfile(); });
    const c = sh.querySelector('[data-ps-close]'); if (c) c.focus();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && PROFILE_UID) closeProfile(); });
  const verb = (t) => (t.side === 'buy' ? (t.kind === 'new' ? 'bought' : 'bought more') : t.kind === 'closed' ? 'sold all of' : 'sold part of');
  const ago = (d) => {
    const n = Math.round((Date.parse(window.PE.cairoToday()) - Date.parse(d)) / 864e5);
    return n <= 0 ? 'today' : n === 1 ? 'yesterday' : n < 7 ? `${n} days ago` : dayOf(d + 'T12:00:00Z');
  };
  const pcH = (x) => `<span class="${toneH(x)}">${pctH(x)}</span>`;
  const wH = (x) => pctH(x).replace('+', '');   // a weight: no sign
  function profileHTML(p, f, me) {
    const P = period(), per = (x, q) => (x && window.PA.profilePeriod(x, q)) || null;
    const mine = me ? null : myProfile(), pick = per(p, P.sel), yours = mine ? per(mine, P.sel) : null;
    const handle = me ? MY_HANDLE : cleanHandle((f && f.handle) || p.handle);
    const rows = [['This month', { type: 'Month' }], ['This year', { type: 'YTD' }], ['Last 12 months', { type: 'Last 12 Months' }], ['All time', { type: 'Since Inception' }]]
      .map(([l, q]) => { const t = per(p, q), y = mine ? per(mine, q) : null; return `<tr><td>${l}</td><td class="n">${pcH(t && t.r)}</td>${me ? '' : `<td class="n">${pcH(y && y.r)}</td>`}<td class="n muted">${pctH(t && t.b)}</td></tr>`; }).join('');
    const last = (p.months || []).slice(-12), top = Math.max(0.0001, ...last.map((m) => Math.abs(m.r)));
    const bars = last.map((m) => `<div class="ps-bar"><span>${esc(window.PE.fmtMonth(m.m))}${m.live ? '*' : ''}</span><i><b class="${m.r < 0 ? 'neg' : 'pos'}" style="width:${Math.round((Math.abs(m.r) / top) * 100)}%"></b></i>${pcH(m.r)}</div>`).join('');
    const w0 = Math.max(0.0001, ((p.holdings || [])[0] || {}).w || 0);
    const hold = (p.holdings || []).map((h) => `<div class="ps-hold"><div><b>${esc(h.s || h.n)}</b><small>${esc(h.s ? h.n : h.sec)}</small></div><i><b style="width:${Math.round(Math.min(1, h.w / w0) * 100)}%"></b></i><span class="ps-w">${wH(h.w)}</span>${pcH(h.ret)}</div>`).join('');
    const secs = (p.sectors || []).map((x) => `<span class="ps-chip">${esc(x.sec)} ${wH(x.w)}</span>`).join('') + (p.cashW > 0.0005 ? `<span class="ps-chip">Cash ${wH(p.cashW)}</span>` : '');
    const trades = (p.trades || []).slice(0, 15).map((t) => `<div class="ps-trade"><span>${verb(t)} <b>${esc(t.s || t.n)}</b>${t.side === 'sell' && t.ret != null ? ' ' + pcH(t.ret) : ''}</span><small>${esc(ago(t.d))}</small></div>`).join('');
    const S = p.stats || {};
    return `<div class="ps-card">
      <div class="ps-top"><div class="ps-av">${esc((p.name || '?').trim().charAt(0).toUpperCase())}</div>
        <div class="ps-id"><b data-testid="profile-name">${esc(me ? p.name || CUR.name : (f && f.name) || p.name)}</b><small>${handle ? '@' + esc(handle) + ' · ' : ''}${me ? 'what your friends see' : 'updated ' + esc(whenOf(p.at || p.asOf))}</small></div>
        <button type="button" class="ps-x" data-ps-close data-testid="profile-close" aria-label="Close">×</button></div>
      <div class="ps-hero"><small>${esc(P.label)}</small><div class="ps-big ${toneH(pick && pick.r)}" data-testid="profile-picked">${pctH(pick && pick.r)}</div>
        <small>EGX30 Capped ${pctH(pick && pick.b)}${yours ? ` · you ${pctH(yours.r)}` : ''}</small></div>
      <div class="ps-sec"><h4>Returns</h4><table class="ps-tbl"><thead><tr><th></th><th class="n">${me ? 'You' : 'Them'}</th>${me ? '' : '<th class="n">You</th>'}<th class="n">Index</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${bars ? `<div class="ps-sec"><h4>Month by month</h4>${bars}${last.some((m) => m.live) ? '<small class="ps-note">* so far this month</small>' : ''}</div>` : ''}
      <div class="ps-sec" data-testid="profile-holdings"><h4>Holdings</h4>${hold || '<p class="ps-note">No holdings right now.</p>'}${secs ? `<div class="ps-chips">${secs}</div>` : ''}</div>
      <div class="ps-sec" data-testid="profile-trades"><h4>Latest trades</h4>${trades || '<p class="ps-note">No trades yet.</p>'}</div>
      <div class="ps-sec"><h4>Trading</h4><div class="ps-stats"><div><b>${S.closed != null ? S.closed : '—'}</b><small>trades closed</small></div><div><b>${wH(S.winRate)}</b><small>won</small></div><div><b>${S.avgHold != null ? S.avgHold + 'd' : '—'}</b><small>average hold</small></div><div>${pcH(S.best)}<small>best trade</small></div><div>${pcH(S.worst)}<small>worst trade</small></div><div>${pcH(S.maxDD)}<small>deepest drop</small></div></div></div>
      <p class="ps-foot">Percentages only: ${me ? 'friends never see' : 'nobody sees'} amounts, share counts or prices.</p></div>`;
  }
  async function friendsScreen(note) {
    screen('<h1>Friends</h1><p>Loading…</p>');
    let verified = false, handle = '';
    try {
      verified = await ensureDirectory();
      if (verified) handle = await ensureHandle().catch((e) => { console.warn('no @username yet', e); return ''; });
      await listFriends(); refreshShares().catch(() => {});
    }
    catch (e) { console.error(e); screen(`<h1>Friends</h1><p class="lk-err">${esc(e.message || e)}</p><div class="lk-links"><button type="button" class="lk-link" id="lk-fr-back">Back</button></div>`); $l('#lk-fr-back').onclick = accountScreen; return; }
    const by = (st) => FRIENDS.filter((f) => f.status === st);
    const who = (f) => (f.handle ? '@' + cleanHandle(f.handle) : f.email || '');
    const row = (f, btns) => `<div class="lk-friend" data-testid="friend-${esc(f.status)}"><div><b>${esc(f.name)}</b><small>${esc(who(f))}</small></div><div class="lk-friend-btns">${btns}</div></div>`;
    // your own @username: what friends type to find you
    const mine = !verified ? '' : handle
      ? `<div class="lk-handle" data-testid="my-handle-card"><div><small>Your username</small><b data-testid="my-handle">@${esc(handle)}</b><small>Friends add you with it: no email needed.</small></div>
          <div class="lk-friend-btns"><button type="button" class="lk-btn ghost" id="lk-h-copy" data-testid="my-handle-copy">Copy</button><button type="button" class="lk-btn ghost" id="lk-h-edit" data-testid="my-handle-change">Change</button></div></div>
        <form id="lk-h-form" hidden autocomplete="off"><label class="lk-lbl" for="lk-h-new">New username</label>
          <input id="lk-h-new" type="text" data-testid="my-handle-input" value="${esc(handle)}" autocapitalize="none" spellcheck="false" maxlength="21">
          <p class="lk-hint">3 to 20 letters, numbers or _ , starting with a letter.</p>
          <button class="lk-btn" data-testid="my-handle-save">Save username</button></form>`
      : `<p class="lk-hint" data-testid="my-handle-none">Your @username appears here once usernames are switched on for this site. Until then friends add you with your email.</p>`;
    const main = isOwner() && !!(mailPrefs() || {}).shareMain;
    screen(`<h1>Friends</h1><p>Friends see each other's portfolios: holdings, returns and activity. They can look, never change anything.</p>
      ${mine}
      ${by('received').length ? `<p class="lk-lbl">Friend requests</p>${by('received').map((f) => row(f, `<button class="lk-btn" data-acc="${esc(f.uid)}" data-testid="friend-accept">Accept</button><button class="lk-btn ghost" data-del="${esc(f.uid)}" data-testid="friend-decline">Decline</button>`)).join('')}` : ''}
      ${by('friends').length ? `<p class="lk-lbl">Your friends</p>${by('friends').map((f) => row(f, `<button class="lk-btn" data-view="${esc(f.uid)}" data-testid="friend-view">View</button><button class="lk-btn ghost" data-del="${esc(f.uid)}" data-testid="friend-remove">Remove</button>`)).join('')}` : ''}
      ${by('sent').length ? `<p class="lk-lbl">Waiting for them to accept</p>${by('sent').map((f) => row(f, `<button class="lk-btn ghost" data-del="${esc(f.uid)}" data-testid="friend-cancel">Cancel</button>`)).join('')}` : ''}
      ${verified ? `<form id="lk-fr-add" autocomplete="off"><label class="lk-lbl" for="lk-fr-email">Add a friend</label>
      <input id="lk-fr-email" type="text" inputmode="email" data-testid="friend-email" placeholder="@username or email" autocapitalize="none" autocorrect="off" spellcheck="false">
      <button class="lk-btn" id="lk-fr-go" data-testid="friend-add">Send friend request</button><div class="lk-err" role="alert">${esc(note || '')}</div></form>`
        : `<div class="lk-tip" data-testid="friends-unverified"><p><b>One quick step first:</b> confirm your email. We sent a link to <b>${esc(CLOUD.email || '')}</b> when you signed up (check spam too). Tap the link, then come back here.</p>
          <button type="button" class="lk-btn" id="lk-fr-check" data-testid="friends-verify-done">I tapped the link</button>
          <button type="button" class="lk-btn ghost" id="lk-fr-resend" data-testid="friends-verify-send">Send the link again</button></div><div class="lk-err" role="alert">${esc(note || '')}</div>`}
      <p class="lk-hint">They see your request next time they open the site (and by email if they have email updates on). Once they accept, you both see each other's portfolio. Either of you can remove it any time and it stops at once.</p>
      ${isOwner() ? `<p class="lk-tip" data-testid="friend-owner">${main ? 'Friends see <b>your main portfolio</b>, refreshed by the job three times a day (4:15 pm, 6:15 pm and 11 pm Cairo time).' : "Friends see this account's portfolio."} <button type="button" class="lk-link" id="lk-fr-main" data-testid="friend-owner-toggle">${main ? "Show this account's portfolio instead" : 'Show my main portfolio instead'}</button></p>` : ''}
      <div class="lk-links"><button type="button" class="lk-link" id="lk-fr-back" data-testid="friends-back">Back</button></div>`);
    $l('#lk-fr-back').onclick = accountScreen;
    const fc = $l('#lk-fr-check'), fr = $l('#lk-fr-resend');
    if (fc) fc.onclick = async () => { verifyCheckedAt = Date.now(); CLOUD.exp = 0; const ok = !!claims(await idToken()).email_verified; friendsScreen(ok ? '' : 'Not confirmed yet. Tap the link in the email first (check spam too), then try again.'); };
    if (fr) fr.onclick = async () => { fr.disabled = true; try { await fbAuth('sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: await idToken() }); fr.textContent = 'Sent: check your inbox'; } catch (e) { fr.disabled = false; err(e.message || String(e)); } };
    const find = (uid) => FRIENDS.find((f) => f.uid === uid);
    const busy = (b, t) => { document.querySelectorAll('#lock button').forEach((x) => { x.disabled = true; }); if (b && t) b.textContent = t; };
    document.querySelectorAll('#lock [data-acc]').forEach((b) => { b.onclick = async () => {
      const f = find(b.dataset.acc); busy(b, 'Accepting…');
      try { await acceptFriend(f); toast(`You and ${f.name} are friends now.`); friendsScreen(); } catch (e) { console.error(e); friendsScreen(e.message || String(e)); }
    }; });
    document.querySelectorAll('#lock [data-del]').forEach((b) => { b.onclick = async () => {
      const f = find(b.dataset.del);
      if (f.status === 'friends' && !confirm(`Remove ${f.name}? You stop seeing each other's portfolios.`)) return;
      busy(b, '…');
      try { await unfriend(f.uid); friendsScreen(); } catch (e) { console.error(e); friendsScreen(e.message || String(e)); }
    }; });
    document.querySelectorAll('#lock [data-view]').forEach((b) => { b.onclick = async () => { open(); await openProfile(b.dataset.view, true); }; });
    const om = $l('#lk-fr-main');
    if (om) om.onclick = async () => {
      busy(om);
      try {
        const m = Object.assign({ email: CLOUD.email, alerts: false, weekly: false, reports: false, gmail: false }, mailPrefs() || {}, { shareMain: !main });
        await setMail(m);
        if (main) await refreshShares(true);   // back to this account's portfolio: share it now
        toast(main ? "Friends now see this account's portfolio." : 'Friends will see your main portfolio after the next daily update.'); friendsScreen();
      } catch (e) { console.error(e); friendsScreen(e.message || String(e)); }
    };
    const hc = $l('#lk-h-copy'), he = $l('#lk-h-edit'), hf = $l('#lk-h-form');
    if (hc) hc.onclick = async () => { try { await navigator.clipboard.writeText('@' + handle); hc.textContent = 'Copied'; } catch (e) { hc.textContent = '@' + handle; } };
    if (he) he.onclick = () => { hf.hidden = false; he.hidden = true; $l('#lk-h-new').focus(); };
    if (hf) hf.onsubmit = async (ev) => {
      ev.preventDefault();
      const h = cleanHandle($l('#lk-h-new').value);
      if (h === handle) return friendsScreen();
      if (!HANDLE_RE.test(h)) return err('Use 3 to 20 letters, numbers or _ , starting with a letter.');
      busy(hf.querySelector('button'), 'Saving…');
      try { if (await takeHandle(h)) { toast(`You are @${h} now.`); friendsScreen(); } else friendsScreen(`@${h} is taken. Try another.`); }
      catch (e) { console.error(e); friendsScreen(e.message || String(e)); }
    };
    if ($l('#lk-fr-add')) $l('#lk-fr-add').onsubmit = async (ev) => {
      ev.preventDefault();
      const raw = $l('#lk-fr-email').value.trim(), isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw), h = isEmail ? '' : cleanHandle(raw);
      if (!isEmail && !HANDLE_RE.test(h)) return err('Type their @username (or the email they sign in with).');
      if (isEmail && raw.toLowerCase() === String(CLOUD.email || '').toLowerCase()) return err('That is your own email.');
      if (h && h === handle) return err('That is your own username.');
      busy($l('#lk-fr-go'), 'Sending…');
      try { const name = await requestFriend(isEmail ? { email: raw.toLowerCase() } : { handle: h }); toast(`Friend request sent to ${name}.`); friendsScreen(); }
      catch (e) { if (e.code !== 'user') console.error(e); friendsScreen(e.message || String(e)); }
    };
  }
  // a request to {email} or {handle}: both sides of the link, the asker's own side first
  async function requestFriend({ email, handle }) {
    const user = (m) => Object.assign(new Error(m), { code: 'user' });
    let d;
    if (handle) {
      try { d = await readHandle(handle); } catch (e) { if (e.code === 'forbidden') throw user('Adding friends by @username is not switched on for this site yet. Use their email for now.'); throw e; }
      if (!d) throw user(`Nobody has the username @${handle}. Check the spelling, or use the email they sign in with.`);
    } else {
      try { d = fsData(await fsReq('GET', `directory/${encodeURIComponent(email)}`)); }
      catch (e) { if (e.code === 'not_found') throw user(`Nobody has an account with ${email} yet. Send them the site link first: ${location.origin + location.pathname}`); throw e; }
    }
    if (d.uid === CLOUD.uid) throw user('That is you.');
    const have = (FRIENDS || []).find((f) => f.uid === d.uid);
    if (have) throw Object.assign(new Error(have.status === 'friends' ? `You and ${have.name} are already friends.` : have.status === 'sent' ? `You already asked ${have.name}; waiting for them to accept.` : `${have.name} already sent you a request: accept it above.`), { code: 'user' });
    const at = new Date().toISOString();
    await fsReq('PATCH', `links/${CLOUD.uid}/with/${d.uid}`, fsFields(Object.assign({ status: 'sent', name: d.name, pub: d.pub, at }, handle ? { handle } : { email })), 'currentDocument.exists=false');
    const me = await myHandle().catch(() => '');
    try { await fsReq('PATCH', `links/${d.uid}/with/${CLOUD.uid}`, fsFields(Object.assign({ status: 'received', name: CUR.name, pub: acctPub(), email: String(CLOUD.email || '').toLowerCase(), at }, me ? { handle: me } : {})), 'currentDocument.exists=false'); }
    catch (e) { await fsDel(`links/${CLOUD.uid}/with/${d.uid}`); throw e; }
    return d.name;
  }
  async function acceptFriend(f) {
    if (!(await confirmedFriend(f))) throw new Error(`This request does not match the account of ${f.email || (f.handle ? '@' + f.handle : '') || 'its sender'}, so it was not accepted. Decline it, and ask your friend to send a new one.`);
    const at = new Date().toISOString(), upd = fsFields({ status: 'friends', at });
    // the asker's side gets this account's verified email, so the friendship no longer depends on a username (rules from
    // before @usernames refuse the extra field: then without it)
    try { await fsReq('PATCH', `links/${f.uid}/with/${CLOUD.uid}`, fsFields({ status: 'friends', at, email: String(CLOUD.email || '').toLowerCase() }), maskOf(['status', 'at', 'email'])); }
    catch (e) { if (e.code !== 'forbidden') throw e; await fsReq('PATCH', `links/${f.uid}/with/${CLOUD.uid}`, upd, maskOf(['status', 'at'])); }
    await fsReq('PATCH', `links/${CLOUD.uid}/with/${f.uid}`, upd, maskOf(['status', 'at']));
    await listFriends();
    await refreshShares(true);
  }
  async function unfriend(uid) {
    for (const p of [`shares/${CLOUD.uid}/to/${uid}`, `shares/${uid}/to/${CLOUD.uid}`, `links/${uid}/with/${CLOUD.uid}`, `links/${CLOUD.uid}/with/${uid}`]) await fsDel(p);
    ls.del('pd.share.' + CUR.id + '.' + uid);
    if (PROFILE_UID === uid) closeProfile();
  }
  // everything of an account except its sign-in: friends (both sides), copies, email package, directory entry, documents,
  // profile, status. The account itself (deleting) or the site owner (reset) does it.
  async function wipeAccount(uid, email) {
    for (const d of await listAll(`links/${uid}/with`)) {
      const o = d.name.split('/').pop();
      for (const p of [`shares/${uid}/to/${o}`, `shares/${o}/to/${uid}`, `links/${o}/with/${uid}`, `links/${uid}/with/${o}`]) await fsDel(p);
    }
    await fsDel(`mail/${uid}`);
    if (email) await fsDel(`directory/${encodeURIComponent(String(email).toLowerCase())}`);
    try { const h = cleanHandle(fsData(await fsReq('GET', `status/${uid}`)).handle), d = h ? await readHandle(h) : null; if (d && d.uid === uid) await fsDel(`handles/${h}`); }
    catch (e) { if (e.code !== 'not_found') console.warn('username not freed', e); }
    for (const d of await listAll(`users/${uid}/docs`)) await fsDel(`users/${uid}/docs/${d.name.split('/').pop()}`);
    await fsDel(`users/${uid}`);
    await fsDel(`status/${uid}`);
  }
  // the site owner deleted (deleted/{uid}) or reset (no profile) this account while this device was still signed in
  async function tombstoned(uid) { try { await fsReq('GET', `deleted/${uid}`); return true; } catch (e) { return false; } }
  async function accountGone() {
    if (await tombstoned(CLOUD.uid)) return 'deleted';
    try { await fsReq('GET', `users/${CLOUD.uid}`); return null; } catch (e) { if (e.code === 'not_found') return 'reset'; throw e; }
  }
  async function leaveGoneAccount(kind) {
    const email = CLOUD.email || CUR.email, id = CUR.id;
    if (kind === 'deleted') { await fsDel(`deleted/${CLOUD.uid}`).catch(() => {}); await fbAuth('delete', { idToken: await idToken() }).catch(() => {}); }
    await forget(); dropAccount(id); ['pd.mail.', 'pd.dir.', 'pd.status.'].forEach((k) => ls.del(k + id)); ls.del(CUR_LS);
    resetSession(); PK8 = null; CLOUD = null; FRIENDS = null; DOCS = {}; CUR = null; OPENED = null; listeners.forEach(fire); blank();
    if (kind === 'deleted') goneScreen(); else signInScreen(email, 'Your account was reset by the site owner. Sign in to set up a fresh portfolio.');
  }
  function goneScreen() {
    screen(`<h1>Account deleted</h1><p data-testid="gone-screen">The site owner deleted this account and everything in it. You can create a new account any time.</p>
      <button class="lk-btn" id="lk-gone-new" data-testid="gone-signup">Create an account</button>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-gone-back">Back</button></div>`);
    $l('#lk-gone-new').onclick = () => signUpScreen(); $l('#lk-gone-back').onclick = () => chooseScreen();
  }
  function deleteScreen() {
    screen(`<h1>Delete my account</h1><p>This deletes your portfolio, your sign-in, email updates, Thndr emails and your friends, for good. It cannot be undone.</p>
      <p class="lk-tip">Only want to start over? Ask the site owner to reset your account instead: you keep your email and password and set up a fresh portfolio.</p>
      <form id="lk-del" autocomplete="off"><input id="lk-del-word" data-testid="delete-confirm" placeholder="Type DELETE to confirm" autocapitalize="characters" spellcheck="false">
      <button class="lk-btn danger" id="lk-del-go" data-testid="delete-go">Delete everything</button><div class="lk-err" role="alert"></div></form>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-del-back" data-testid="delete-back">Back</button></div>`);
    $l('#lk-del-back').onclick = accountScreen;
    $l('#lk-del').onsubmit = async (ev) => {
      ev.preventDefault();
      if ($l('#lk-del-word').value.trim().toUpperCase() !== 'DELETE') return err('Type DELETE to confirm.');
      const b = $l('#lk-del-go'); b.disabled = true; err('Deleting…');
      try {
        const uid = CLOUD.uid, email = CLOUD.email || CUR.email;
        await wipeAccount(uid, email);
        await fbAuth('delete', { idToken: await idToken() });
        const id = CUR.id;
        await forget(); dropAccount(id); ['pd.mail.', 'pd.dir.', 'pd.status.'].forEach((k) => ls.del(k + id)); ls.del(CUR_LS);
        resetSession(); PK8 = null; CLOUD = null; FRIENDS = null; DOCS = {}; CUR = null; OPENED = null; listeners.forEach(fire); blank();
        chooseScreen(); toast('Your account is deleted.');
      } catch (e) { console.error(e); b.disabled = false; err(e.message || String(e)); }
    };
  }
  // signed in, but the profile is gone: the site owner reset the account. Same email and password, a fresh portfolio.
  function restartScreen(a, pw, email) {
    screen(`<h1>Start again</h1><p>Your account was reset, so it has no portfolio yet. You keep the same email and password: set up a fresh portfolio now.</p>
      <form id="lk-rs" autocomplete="off"><input id="lk-rs-name" data-testid="restart-name" placeholder="Your name" aria-label="Your name" autocomplete="name">
      <button class="lk-btn" id="lk-rs-go" data-testid="restart-go">Set up my portfolio</button><div class="lk-err" role="alert"></div></form>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-rs-back">Back</button></div>`);
    $l('#lk-rs-back').onclick = () => chooseScreen();
    $l('#lk-rs').onsubmit = async (ev) => {
      ev.preventDefault(); const name = $l('#lk-rs-name').value.trim(); if (!name) return err('Enter your name.');
      const b = $l('#lk-rs-go'); b.disabled = true;
      try { const { code, pname } = await newProfile(a, name, email, pw); recoveryScreen(code, () => onboardScreen(name, pname)); }
      catch (e) { console.error(e); b.disabled = false; err(e.message || String(e)); }
    };
  }

  /* ---------- admin (the site owner only: OWNER_EMAIL, verified) ---------- */
  const claims = (t) => { try { return JSON.parse(atob(String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return {}; } };
  async function adminScreen() {
    screen('<h1>Admin</h1><p>Loading…</p>');
    try {
      if (!claims(await idToken()).email_verified) return verifyScreen();
      // everyone who signed up (their profiles: name and join date only), with the status line of those who opened the site since
      const [docs, mk, dels, profs] = await Promise.all([listAll('status'), fetch('m/market.enc.json?t=' + Date.now(), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null), listAll('deleted').catch(() => []),
        listAll('users', 'mask.fieldPaths=name&mask.fieldPaths=createdAt').catch(() => [])]);
      const byUid = {};
      for (const d of profs) { const x = fsData(d); byUid[d.name.split('/').pop()] = { uid: d.name.split('/').pop(), name: x.name, createdAt: x.createdAt, site: {}, job: null, quiet: true }; }
      for (const d of docs) { const x = fsData(d), u = d.name.split('/').pop(); byUid[u] = Object.assign(byUid[u] || {}, x, { uid: u, site: jparse(x.site) || {}, job: jparse(x.job) || null, quiet: false }); if (!x.createdAt && byUid[u].createdAt == null) delete byUid[u].createdAt; }
      const rows = Object.values(byUid).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      const now = Date.now(), old = (iso, days) => !iso || now - Date.parse(iso) > days * 864e5;
      const card = (r) => {
        const s = r.site, j = r.job || {}, g = j.gmail || null, bad = [], ok = [];
        if (j.error) bad.push(`The daily job could not open this account: ${j.error}`);
        if (s.gmail) {
          if (g && g.ok === false) bad.push(`Thndr emails failing since ${whenOf(g.at)}: ${g.error || 'unknown error'}`);
          else if (g && g.ok) (old(g.at, 2) ? bad : ok).push(`Thndr emails: last check ${whenOf(g.at)}${g.new ? `, ${g.new} new` : ''}${g.held ? `, ${g.held} need a look` : ''}`);
          else ok.push('Thndr emails connected, not checked yet');
        }
        if ((s.mail || s.reports || s.gmail) && r.job && old(j.at, 2)) bad.push(`The daily job has not reached this account since ${whenOf(j.at)}`);
        if (j.report) ok.push(`Last month-end report: ${j.report}`);
        const facts = r.quiet ? [`Joined ${dayOf(r.createdAt)} · has not opened the site since the admin page started (details appear when they do)`]
          : [`Joined ${dayOf(r.createdAt)} · last opened ${dayOf(r.lastSeen)}`, `Email updates ${s.mail ? 'on' : 'off'} · month-end report ${s.reports ? 'on' : 'off'} · Thndr emails ${s.gmail ? 'on' : 'off'} · friends ${s.friends || 0}`];
        return `<div class="lk-card${bad.length ? ' bad' : ''}" data-testid="admin-row"><div class="lk-card-head"><b>${esc(r.name || '(no name)')}</b><small>${esc([r.handle ? '@' + r.handle : '', r.email || (r.quiet ? 'email shown once they open the site' : '')].filter(Boolean).join(' · '))}</small></div>
          <ul class="lk-facts">${facts.map((t) => `<li>${esc(t)}</li>`).join('')}${ok.map((t) => `<li class="ok">${esc(t)}</li>`).join('')}${bad.map((t) => `<li class="bad">${esc(t)}</li>`).join('')}</ul>
          ${r.uid === CLOUD.uid ? '' : `<div class="lk-friend-btns"><button class="lk-btn ghost" data-reset="${esc(r.uid)}" data-testid="admin-reset">Reset (start over)</button><button class="lk-btn danger" data-delete="${esc(r.uid)}" data-testid="admin-delete">Delete account</button></div>`}</div>`;
      };
      const problems = rows.filter((r) => /class="lk-card bad/.test(card(r))).length;
      screen(`<h1>Admin</h1><p><b>${rows.length} ${rows.length === 1 ? 'person has' : 'people have'} signed up</b>${problems ? `, <b>${problems} with a problem</b>` : ', no problems'}, newest first. Shared prices updated ${esc(mk && mk.at ? whenOf(mk.at) : '—')}.</p>
        <p class="lk-hint">You see names, emails and whether things work, never anyone's figures.</p>
        ${rows.map(card).join('') || '<p>No accounts yet.</p>'}
        ${dels.length ? `<p class="lk-hint" data-testid="admin-deleted">Deleted, sign-in removed the next time they try it: ${dels.map((d) => esc(fsData(d).email || '?')).join(', ')}</p>` : ''}
        <a class="lk-btn ghost" href="${JOB_URL}" target="_blank" rel="noopener noreferrer" data-testid="admin-job-link">Run the daily friends' job now (GitHub)</a>
        <div class="lk-err" role="alert"></div>
        <div class="lk-links"><button type="button" class="lk-link" id="lk-ad-back" data-testid="admin-back">Back</button></div>`);
      $l('#lk-ad-back').onclick = accountScreen;
      document.querySelectorAll('#lock [data-reset]').forEach((b) => { b.onclick = () => resetScreen(rows.find((r) => r.uid === b.dataset.reset)); });
      document.querySelectorAll('#lock [data-delete]').forEach((b) => { b.onclick = () => resetScreen(rows.find((r) => r.uid === b.dataset.delete), true); });
    } catch (e) {
      console.error(e);
      if (e.code === 'forbidden') return verifyScreen('The database did not accept this sign-in as the admin yet. If you just verified your email, tap "I clicked the link".');
      screen(`<h1>Admin</h1><p class="lk-err">${esc(e.message || e)}</p><div class="lk-links"><button type="button" class="lk-link" id="lk-ad-back">Back</button></div>`); $l('#lk-ad-back').onclick = accountScreen;
    }
  }
  // "Verify your email": Google emails a link; once clicked, a fresh sign-in token carries email_verified. Used by the
  // admin screen and by Friends (opts: why = the sentence on top, then = where "I clicked the link" goes, tid = test id prefix)
  function verifyScreen(note, opts) {
    const o = Object.assign({ why: 'The admin screen opens only once Google has confirmed that this email is yours.', then: adminScreen, tid: 'admin' }, opts || {});
    screen(`<h1>Verify your email</h1><p>${esc(o.why)}</p><p><b>${esc(CLOUD.email || '')}</b></p>
      <ol class="lk-steps"><li>Tap <b>Send the link</b>.</li><li>Open the email from Firebase (check spam too) and click the link.</li><li>Come back and tap <b>I clicked the link</b>.</li></ol>
      <button class="lk-btn" id="lk-vf-send" data-testid="${o.tid}-verify-send">Send the link</button>
      <button class="lk-btn ghost" id="lk-vf-done" data-testid="${o.tid}-verify-done">I clicked the link</button><div class="lk-err" role="alert">${esc(note || '')}</div>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-vf-back">Back</button></div>`);
    $l('#lk-vf-back').onclick = accountScreen;
    $l('#lk-vf-send').onclick = async () => { try { await fbAuth('sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: await idToken() }); err('Sent. Check your inbox.'); } catch (e) { err(e.message || String(e)); } };
    $l('#lk-vf-done').onclick = () => { CLOUD.exp = 0; o.then(); };   // a fresh token carries email_verified
  }
  function resetScreen(r, del) {
    const W = del ? 'DELETE' : 'RESET';
    screen((del ? `<h1>Delete ${esc(r.name || 'this account')}?</h1><p>This deletes the whole account: portfolio, email updates, Thndr emails connection, friends and the sign-in (${esc(r.email || '')}). Their email becomes free to sign up again.</p>`
        : `<h1>Reset ${esc(r.name || 'this account')}?</h1><p>This deletes their portfolio, email updates, Thndr emails connection and friends. Their sign-in stays: when they sign in again, they set up a fresh portfolio with the same email and password.</p>`) + `
      <p class="lk-tip">Only do this when they asked for it. It cannot be undone.</p>
      <form id="lk-rst" autocomplete="off"><input id="lk-rst-word" data-testid="admin-reset-confirm" placeholder="Type ${W} to confirm" autocapitalize="characters" spellcheck="false">
      <button class="lk-btn danger" id="lk-rst-go" data-testid="admin-reset-go">${del ? 'Delete the account' : 'Reset the account'}</button><div class="lk-err" role="alert"></div></form>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-rst-back">Back</button></div>`);
    $l('#lk-rst-back').onclick = adminScreen;
    $l('#lk-rst').onsubmit = async (ev) => {
      ev.preventDefault();
      if ($l('#lk-rst-word').value.trim().toUpperCase() !== W) return err(`Type ${W} to confirm.`);
      const b = $l('#lk-rst-go'); b.disabled = true; err(del ? 'Deleting…' : 'Resetting…');
      try {
        // the marker first: if the rules do not allow it yet, nothing is wiped
        if (del) await fsReq('PATCH', `deleted/${r.uid}`, fsFields({ email: r.email || '', at: new Date().toISOString() }), 'currentDocument.exists=false').catch((e) => { if (e.code !== 'conflict') throw e; });
        await wipeAccount(r.uid, r.email);
        toast(del ? `${r.name || 'The account'} is deleted.` : `${r.name || 'The account'} is reset. They can sign in and start again.`); adminScreen();
      }
      catch (e) { console.error(e); b.disabled = false; err(e.message || String(e)); }
    };
  }
  /* ---------- linked account: one place for everything ----------
     A setup-key portfolio (the owner's main one) can carry its owner's site account, so Friends and Admin open from that
     portfolio's Account button and there is no second, empty portfolio to switch to. Signing in once stores the account's
     session and private key on this device in IndexedDB 'link:<id>', sealed to the portfolio's own key ('portfolio-link-v1'):
     unlocking the portfolio opens both; locking forgets both. The account's separate entry on this device is removed. */
  const LINK_LABEL = 'portfolio-link-v1';
  const acctKey = () => (LINK ? LINK.pk8 : PK8), acctPub = () => (LINK ? LINK.pub : KEYS.pub);
  async function storeLink() { const o = { uid: LINK.uid, email: LINK.email, refresh: (CLOUD && CLOUD.refresh) || LINK.refresh, pk8: b64big(LINK.pk8), pub: LINK.pub, name: LINK.name };
    await idbPut('link:' + CUR.id, Object.assign({ v: 1 }, await seal(enc.encode(JSON.stringify(o)), LINK_LABEL))); }
  async function loadLink() {
    LINK = null;
    const r = await idbGet('link:' + CUR.id).catch(() => null); if (!r || !r.ct) return;
    const o = JSON.parse(dec.decode(await unseal(r, LINK_LABEL)));
    LINK = { uid: o.uid, email: o.email, refresh: o.refresh, pk8: ub64(o.pk8), pub: o.pub, name: o.name };
    CLOUD = { uid: o.uid, email: o.email, refresh: o.refresh, idToken: null, exp: 0 };
  }
  function linkScreen(note) {
    screen(`<h1>Friends and Admin</h1><p>Sign in with your site account once, and Friends (and Admin, for the site owner) open right here from <b>${esc(CUR.name)}</b>. No second portfolio to switch to.</p>
      <form id="lk-ln" autocomplete="on"><input id="lk-ln-email" type="email" data-testid="link-email" placeholder="Email of your site account" autocomplete="email" autocapitalize="none" spellcheck="false">
      <input id="lk-ln-pw" type="password" data-testid="link-password" placeholder="Its password" autocomplete="current-password">
      <button class="lk-btn" id="lk-ln-go" data-testid="link-go">Sign in</button><div class="lk-err" role="alert">${esc(note || '')}</div></form>
      <p class="lk-hint">No site account yet? Switch portfolio, then Create your portfolio. Come back here and sign in with it.</p>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-ln-back" data-testid="link-back">Back</button></div>`);
    $l('#lk-ln-back').onclick = open;
    $l('#lk-ln').onsubmit = async (ev) => {
      ev.preventDefault(); const email = $l('#lk-ln-email').value.trim(), pw = cleanPw($l('#lk-ln-pw').value); if (!email || !pw) return;
      const b = $l('#lk-ln-go'); b.disabled = true; err('Signing in…');
      try {
        const a = await fbAuth('signInWithPassword', { email, password: pw, returnSecureToken: true });
        CLOUD = session(a);
        const prof = await readProfile(a.localId);
        let pk8;
        try { pk8 = new Uint8Array(await unwrapKey(prof.keys.pwrap, pw)); }
        catch (x) { CLOUD = null; b.disabled = false; return err(x && x.name === 'OperationError' ? 'That account\'s password was reset: open it once on its own (Switch portfolio, Sign in) to finish with the recovery code, then link it here.' : (x.message || String(x))); }
        LINK = { uid: a.localId, email: a.email || email, refresh: a.refreshToken, pk8, pub: prof.keys.pub, name: prof.name };
        await storeLink();
        // the account's own entry on this device goes: this portfolio is now the one place for it
        const id = 'u_' + a.localId, mp = ls.get('pd.mail.' + id);
        if (mp && !ls.get('pd.mail.' + CUR.id)) ls.set('pd.mail.' + CUR.id, mp);
        ls.del('pd.dev.' + id); for (const k of ['dev:', 'bio:', 'tok:', 'acct:', 'cache:']) await idbDel(k + id).catch(() => {});
        dropAccount(id); ['pd.mail.', 'pd.dir.', 'pd.status.'].forEach((k) => ls.del(k + id));
        editBar(); await housekeeping().catch((e) => console.warn('account housekeeping', e));
        toast('Signed in. Friends and Admin are under Account in this portfolio now.'); linkedScreen();
      } catch (e) { console.error(e); CLOUD = null; LINK = null; b.disabled = false; err(e.message || String(e)); }
    };
  }
  function linkedScreen() {
    screen(`<h1>Account</h1><p>Signed in as <b>${esc(LINK.email)}</b>. Friends and Admin work from here.</p>
      <button class="lk-btn ghost" id="lk-lk-friends" data-testid="account-friends">Friends${incoming() ? ` · ${incoming()} new` : ''}</button>
      <button class="lk-btn ghost" id="lk-lk-admin" data-testid="account-admin" ${isOwner() ? '' : 'hidden'}>Admin: your friends' accounts</button>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-lk-back" data-testid="account-back">Back</button><button type="button" class="lk-link" id="lk-lk-out" data-testid="link-signout">Sign out of the site account here</button></div>`);
    $l('#lk-lk-back').onclick = open;
    $l('#lk-lk-friends').onclick = () => friendsScreen();
    $l('#lk-lk-admin').onclick = () => adminScreen();
    checkOwner().then((y) => { const x = $l('#lk-lk-admin'); if (x) x.hidden = !y; }).catch(() => {});
    listFriends().then(() => { const x = $l('#lk-lk-friends'); if (x) x.textContent = 'Friends' + (incoming() ? ` · ${incoming()} new` : ''); }).catch(() => {});
    $l('#lk-lk-out').onclick = async () => {
      await idbDel('link:' + CUR.id).catch(() => {}); LINK = null; CLOUD = null; FRIENDS = null; MY_HANDLE = null; accountBadge();
      editBar(); open(); toast('Signed out of the site account on this device. Your portfolio is unchanged.');
    };
  }
  /* ---------- the friends hub (the top-left menu), the Overview's friends cards and the friends' activity ----------
     You and your friends, ranked by the return over the period picked at the top of the page (This month, This year,
     All time, ... : the page's own period selector, window.pdPeriod), with this month / this year / all time underneath.
     Every figure comes from the same percentages profiles friends share (engine2.js friendProfile / profilePeriod), yours
     included, so the ranking compares like with like. Below the cards: the friends' latest trades, newest first. Tapping a
     row, a card or a trade opens that profile. A friend's profile is kept in memory only (refreshed every 10 minutes).
     Your other portfolios on this device and "Another portfolio" sit below in the hub. */
  const HUB = { you: null, youData: null, friends: {}, market: null, marketAt: 0, busy: false };
  // the page's period: { sel: {type, asOf, from, to}, label } (app.html pdPeriod); All time when the page has none
  const period = () => (window.pdPeriod && window.pdPeriod()) || { sel: { type: 'Since Inception' }, label: 'All time' };
  // a portfolio's percentages profile from its documents (with the live prices when they are newer than the documents')
  function profileFrom(docs, info) {
    if (!window.PA || !window.PE) return null;
    let market = docs['market/latest'] || null;
    if (market && LIVE && Date.parse(LIVE.asOf) > Date.parse(market.asOf || 0)) market = Object.assign({}, market, LIVE);
    try { const run = window.PA.portfolioRun(docs, null, { market }); return run ? window.PA.friendProfile(run, info) : null; }
    catch (e) { console.warn('profile', e); return null; }
  }
  // this portfolio's own profile, rebuilt when its documents change
  function myProfile() {
    if (!HUB.you || HUB.youData !== DATA_AT) { HUB.you = profileFrom(DOCS, { handle: MY_HANDLE || '' }); HUB.youData = DATA_AT; }
    return HUB.you;
  }
  async function hubMarket() {
    if (!HUB.market || Date.now() - HUB.marketAt > 600e3) { HUB.market = (await fetchMarket().catch(() => ({ docs: {} }))).docs || {}; HUB.marketAt = Date.now(); }
    return HUB.market;
  }
  // a friend's profile from their share; a copy from before profiles (the documents themselves) is turned into one here
  async function friendProfile(f) {
    const j = await fsReq('GET', `shares/${f.uid}/to/${CLOUD.uid}`);
    const snap = JSON.parse(await gunzip(await unseal(JSON.parse(fStr(j, 'pkg')), SHARE_LABEL, acctKey())));
    if (snap.v >= 2 && snap.profile) return Object.assign({}, snap.profile, { at: snap.at });
    const docs = Object.assign({}, snap.full ? {} : await hubMarket(), snap.docs || {});
    macroMarks(docs);
    const p = profileFrom(docs, { name: snap.name });
    if (!p) throw Object.assign(new Error('their copy could not be read'), { code: 'bad' });
    return Object.assign(p, { at: snap.at });
  }
  const pctH = (x) => { if (x == null || !isFinite(x)) return '—'; const t = (Math.abs(x) * 100).toFixed(1); return (t === '0.0' ? '' : x > 0 ? '+' : '−') + t + '%'; };
  const toneH = (x) => (x == null || Math.abs(x) < 0.0005 ? '' : x > 0 ? 'pos' : 'neg');
  const hasAcct = () => !!(CLOUD && PK8 && CUR && (CUR.cloud || LINK));
  // a profile's figures for the page's period: the picked one, this month, this year, all time
  function figures(p, sel) {
    if (!p) return null;
    const r = (q) => { const x = window.PA.profilePeriod(p, q); return x ? x.r : null; };
    return { picked: r(sel), month: r({ type: 'Month' }), ytd: r({ type: 'YTD' }), all: r({ type: 'Since Inception' }) };
  }
  const friendsNow = () => ((hasAcct() && FRIENDS) || []).filter((f) => f.status === 'friends');
  // you first, then your friends; ranked by the return over the picked period (a row still loading goes last)
  function hubRows() {
    const sel = period().sel, mine = myProfile();
    const rows = [{ uid: 'me', me: true, name: (mine && mine.name) || CUR.name, handle: hasAcct() ? MY_HANDLE || '' : '', s: figures(mine, sel) }].concat(friendsNow()
      .map((f) => { const h = HUB.friends[f.uid] || {}; return { uid: f.uid, name: f.name, handle: cleanHandle(f.handle || (h.p && h.p.handle)), s: figures(h.p, sel), err: h.err }; }));
    const v = (r) => (r.s && r.s.picked != null ? r.s.picked : -1e9);
    return rows.sort((a, b) => v(b) - v(a));
  }
  // the friends' latest trades, newest first (yours are not in it: you know them)
  function feedItems(n) {
    const out = [];
    for (const f of friendsNow()) { const h = HUB.friends[f.uid]; if (h && h.p) (h.p.trades || []).forEach((t) => out.push({ f, h: cleanHandle(f.handle || h.p.handle), t })); }
    return out.sort((a, b) => (a.t.d < b.t.d ? 1 : a.t.d > b.t.d ? -1 : 0)).slice(0, n);
  }
  // under the big number: the other standard periods (the picked one is already the big number)
  const otherPeriods = (s, sel) => [['Month', 'Month', s.month], ['YTD', 'This year', s.ytd], ['Since Inception', 'All time', s.all]]
    .filter(([t]) => t !== sel.type || sel.asOf || sel.from).map(([, l, x]) => `${l} ${pctH(x)}`).join(' · ');
  // the Overview section: the ranking as cards, then the friends' activity
  function panelInner() {
    const rows = hubRows(), inc = incoming(), P = period(), feed = feedItems(8);
    const card = (r, i) => `<button type="button" class="pdf-card${r.me ? ' cur' : ''}" data-hub="profile" data-uid="${esc(r.uid)}" data-testid="panel-${r.me ? 'me' : 'friend'}">
        <span class="pdf-top"><span class="pdf-rank">#${i + 1}</span><b>${esc(r.name || '')}</b></span>${r.handle ? `<small class="pdf-handle">@${esc(r.handle)}</small>` : ''}
        <span class="pdf-ytd ${toneH(r.s && r.s.picked)}" data-testid="panel-picked">${pctH(r.s && r.s.picked)}</span><small>${esc(P.label)}</small>
        <small>${r.err ? esc(r.err) : r.s ? otherPeriods(r.s, P.sel) : 'Loading…'}</small>
        <small class="pdf-tag">${r.me ? 'You · tap to see what friends see' : 'Tap to see their profile'}</small></button>`;
    const item = (x) => `<button type="button" class="pdf-feed-row" data-hub="profile" data-uid="${esc(x.f.uid)}" data-testid="feed-item">
        <span class="pdf-av">${esc((x.f.name || '?').trim().charAt(0).toUpperCase())}</span>
        <span class="pdf-feed-txt"><b>${esc(x.h ? '@' + x.h : x.f.name)}</b> ${verb(x.t)} <b>${esc(x.t.s || x.t.n)}</b>${x.t.side === 'sell' && x.t.ret != null ? ' ' + pcH(x.t.ret) : ''}<small>${esc(ago(x.t.d))}</small></span></button>`;
    return `<div class="pdf-head"><h3>Friends · ${esc(P.label)}</h3><button type="button" class="pdf-add" data-hub="friends" data-testid="panel-add">+ Add friend</button></div>
      ${inc ? `<button type="button" class="pdf-note" data-hub="friends" data-testid="panel-requests">${inc} friend request${inc > 1 ? 's' : ''} waiting: tap to answer</button>` : ''}
      <div class="pdf-cards">${rows.map(card).join('')}</div>
      ${rows.length === 1 ? '<p class="pdf-empty">Add friends by their @username to compare returns. They need an account on this site first: send them the link. Friends see percentages only, never amounts.</p>' : ''}
      ${feed.length ? `<div class="pdf-feed" data-testid="friends-feed"><h3>Friends' activity</h3>${feed.map(item).join('')}</div>` : ''}`;
  }
  window.pdFriendsPanel = () => {
    if (!hasAcct()) return '';
    setTimeout(() => refreshHub(document.getElementById('pf-menu'), true).catch(() => {}), 0);
    const pend = ((DOCS['portfolio/settings'] || {}).historyImport || {}).status === 'pending';
    const card = !pend ? '' : gmailOn()
      ? '<section class="pd-friends pd-building" data-testid="history-pending"><h3>Building your portfolio…</h3><p class="pdf-empty">Your holdings, trades and returns are being built from your Thndr emails. It usually takes <b>about 10 minutes</b> after connecting Gmail. <b>We email you when it is ready</b>, and this page fills in by itself.</p></section>'
      : '<section class="pd-friends pd-building" data-testid="history-pending"><h3>One step left</h3><p class="pdf-empty">Connect the Gmail your Thndr emails go to, and your portfolio is built from them in about 10 minutes.</p><button type="button" class="pdf-add" data-hub="gmail" data-testid="pending-connect">Connect Gmail</button></section>';
    return card
      + `<section class="pd-friends" id="pd-friends" data-testid="friends-panel">${panelInner()}</section>`;
  };
  function hubHTML() {
    const acct = hasAcct(), rows = hubRows(), P = period();
    const row = (r, i) => `<button type="button" class="hub-row${r.me ? ' cur' : ''}" data-hub="profile" data-uid="${esc(r.uid)}" data-testid="hub-${r.me ? 'me' : 'friend'}">
        <span class="hub-rank">${i + 1}</span>
        <span class="hub-who"><b>${esc(r.name || '')}</b><small>${r.me ? 'You' : r.err ? esc(r.err) : r.handle ? '@' + esc(r.handle) : ''}</small><small>${r.s ? otherPeriods(r.s, P.sel) : r.err ? '' : 'Loading…'}</small></span>
        <span class="hub-num ${toneH(r.s && r.s.picked)}">${pctH(r.s && r.s.picked)}<small>${esc(P.label)}</small></span></button>`;
    const others = allPortfolios().filter((p) => p.id !== CUR.id && (p.cloud || !!ls.get('pd.dev.' + p.id)));
    const inc = acct ? incoming() : 0;
    return `<div class="hub-head"><span>Friends · ${esc(P.label)}</span>${acct ? '<button type="button" class="hub-add" data-hub="friends" data-testid="hub-add">+ Add friend</button>' : ''}</div>
      ${inc ? `<button type="button" class="hub-note" data-hub="friends" data-testid="hub-requests">${inc} friend request${inc > 1 ? 's' : ''} waiting</button>` : ''}
      ${rows.map(row).join('')}
      ${!acct ? `<button type="button" class="hub-note" data-hub="link" data-testid="hub-signin">See your friends here<small>${CUR.cloud ? 'sign in again to load them' : 'sign in with your site account'}</small></button>`
        : rows.length === 1 ? '<p class="hub-empty">Add friends to compare returns.</p>' : ''}
      ${others.length ? `<div class="hub-head"><span>Your other portfolios</span></div>${others.map((p) => `<div class="hub-otherrow"><button type="button" class="hub-other" data-pid="${esc(p.id)}" data-testid="switch-${esc(p.id)}">${esc(p.name)}</button><button type="button" class="hub-forget" data-hub="forget" data-id="${esc(p.id)}" data-testid="forget-${esc(p.id)}" title="Remove from this device">Remove</button></div>`).join('')}` : ''}
      <button type="button" class="hub-other" data-testid="switch-other" onclick="pdSwitch()">Another portfolio<small>sign in, or open one with a setup key</small></button>`;
  }
  async function refreshHub(m, fromPanel) {
    const draw = () => { if (m && !m.hidden) m.innerHTML = hubHTML(); const p = document.getElementById('pd-friends'); if (p) p.innerHTML = panelInner(); };
    if (m && !fromPanel) m.innerHTML = hubHTML();   // drawn now; the page shows the menu right after this returns
    if (fromPanel) draw();
    if (HUB.busy || !(CLOUD && PK8 && (CUR.cloud || LINK))) return;
    HUB.busy = true;
    try {
      await listFriends().catch(() => {}); draw();
      for (const f of (FRIENDS || []).filter((x) => x.status === 'friends')) {
        const h = HUB.friends[f.uid]; if (h && Date.now() - h.t < 600e3) continue;
        try { HUB.friends[f.uid] = { p: await friendProfile(f), t: Date.now() }; }
        catch (e) { HUB.friends[f.uid] = { err: e.code === 'not_found' ? 'not shared yet' : 'could not load', t: Date.now() }; }
        draw();
      }
      // the owner (admin) drops this device's entries for accounts that no longer exist (reset or deleted)
      if (isOwner()) for (const a of accounts()) { if (a.uid === CLOUD.uid) continue; try { await fsReq('GET', `users/${a.uid}`, null, 'mask.fieldPaths=name'); } catch (e) { if (e.code === 'not_found') { dropAccount(a.id); ls.del('pd.dev.' + a.id); draw(); } } }
    } finally { HUB.busy = false; }
  }
  window.pdHub = (m) => { m.classList.add('pd-hub'); refreshHub(m); };
  // a portfolio in "Your other portfolios" leaves this device's list (nothing is deleted: its setup key or sign-in adds it again)
  async function forgetOther(id) {
    const p = findPortfolio(id); if (!p || (CUR && CUR.id === id)) return;
    ls.del('pd.dev.' + id); for (const k of ['dev:', 'bio:', 'tok:', 'link:', 'acct:', 'cache:']) await idbDel(k + id).catch(() => {});
    if (p.cloud) dropAccount(id);
    ['pd.mail.', 'pd.dir.', 'pd.status.'].forEach((k) => ls.del(k + id));
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('#pf-menu [data-hub], #pd-friends [data-hub], .pd-building [data-hub]'); if (!b) return;
    const m = document.getElementById('pf-menu'), what = b.dataset.hub;
    if (what === 'forget') {
      const p = findPortfolio(b.dataset.id); if (!p) return;
      if (!confirm(`Remove ${p.name} from this device?\n\nNothing is deleted and it keeps updating. To add it back: open this menu, tap Another portfolio, and open it with its ${p.cloud ? 'email and password' : 'setup key'}.`)) return;
      await forgetOther(p.id); m.innerHTML = hubHTML(); toast(`${p.name} removed from this device.`); return;
    }
    m.hidden = true; const t = document.getElementById('pf-name'); if (t) t.setAttribute('aria-expanded', 'false');
    if (what === 'friends') return friendsScreen();
    if (what === 'gmail') return gmailSetupScreen(() => open(), false, false, true);
    if (what === 'link') return CUR.cloud ? lock(false) : linkScreen();
    if (what === 'profile') return openProfile(b.dataset.uid);
  });
  window.pdAccountMenu = () => { if (!CUR || !PK8) return; if (CUR.cloud) accountScreen(); else if (LINK) linkedScreen(); else linkScreen(); };
  window.pdPortfolioList = () => allPortfolios().filter((p) => (CUR && p.id === CUR.id) || !!ls.get('pd.dev.' + p.id)).map((p) => ({ id: p.id, name: p.name }));
  window.pdCurrentId = () => (CUR ? CUR.id : null);

  /* ---------- installable app: the service worker (offline copy) and the "Install app" button ---------- */
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {   // feature-detected; failure only means no offline copy
    const reg = () => navigator.serviceWorker.register('sw.js', { scope: './' }).catch((e) => console.warn('offline support unavailable', e));
    if (document.readyState === 'complete') reg(); else window.addEventListener('load', reg, { once: true });
  }
  // Chromium browsers fire beforeinstallprompt when the site can be installed: keep it and offer a small button in the bottom
  // bar instead of the browser's own banner. Never shown inside the installed app; iOS Safari has no such event (Share → Add to
  // Home Screen, as the Safari tip on the lock screen says).
  let installEvt = null;
  const standalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const installBtn = (show) => whenReady(() => { const b = document.getElementById('pd-install'); if (b) b.hidden = !show; });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); if (standalone()) return; installEvt = e; installBtn(true); });
  window.addEventListener('appinstalled', () => { installEvt = null; installBtn(false); });
  window.pdInstall = async () => { const e = installEvt; installEvt = null; installBtn(false); if (!e) return;
    try { await e.prompt(); await e.userChoice; } catch (err) { console.warn('install prompt failed', err); } };

  /* ---------- boot ---------- */
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (!PK8 || !lockEl().hidden) return;
    if (Date.now() - hiddenAt > RELOCK_MS) return lock(true);
    if (Date.now() - lastFetch > REFRESH_MS) refresh();
    if (Date.now() - liveAt > LIVE_MS) updateLive().catch(() => {});
  });
  // EGX session, Sunday to Thursday 10:00-14:45 Cairo (the 14:30 close shows up 15 minutes later on the delayed feed)
  function egxOpen(t) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const hm = (+p.hour % 24) * 60 + +p.minute;
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'].includes(p.weekday) && hm >= 600 && hm <= 885;
  }
  // while the page is visible and unlocked: the data every 30 minutes (every 2 minutes while a new portfolio is being
  // built from the Thndr emails, so it appears by itself), live prices every 10 minutes during the session
  const building = () => ((DOCS['portfolio/settings'] || {}).historyImport || {}).status === 'pending';
  function tick() {
    if (document.hidden || !PK8 || !lockEl().hidden) return;
    const now = Date.now(); footerFresh();
    if (now - Math.max(lastFetch, fetchTry) > (building() ? 2 * 60e3 : REFRESH_MS)) refresh();
    if (egxOpen(now) && now - Math.max(liveAt, liveTry) > LIVE_MS) updateLive().catch((e) => console.warn('live prices unavailable', e));
  }
  setInterval(tick, 60e3);
  window.pdTick = tick; window.pdEgxOpen = egxOpen; window.pdFooterFresh = footerFresh;   // for tests
  (async () => {
    if (!window.crypto || !crypto.subtle || !window.DecompressionStream) return screen('<h1>Browser too old</h1><p>Update your browser (Safari 16.4+, Chrome 80+) to open the portfolio.</p>');
    try { PORTFOLIOS = await (await fetch('portfolios.json', { cache: 'no-store' })).json(); } catch (e) { return screen('<h1>Offline</h1><p>The portfolio could not load. Check your connection and reload.</p>'); }
    await migrateLegacy();
    ls.del(OLD_BIO_LS);   // the pre-v3 passkey only gated a screen; v3 enrols afresh with PRF
    whenReady(() => { const sw = document.getElementById('pd-switch'); if (sw && PORTFOLIOS.length > 1) sw.hidden = false; });
    const last = findPortfolio(ls.get(CUR_LS));
    if (last && (last.cloud || ls.get('pd.dev.' + last.id))) select(last); else chooseScreen();
  })();
})();
