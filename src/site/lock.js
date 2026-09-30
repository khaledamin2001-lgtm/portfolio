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
  async function forget() { ls.del(devLS()); await idbDel('dev:' + CUR.id); await idbDel('bio:' + CUR.id); await idbDel('tok:' + CUR.id);
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
  let VIEW = null;   // {uid, name}: a friend's shared portfolio is on the page (read-only), see "friends" below
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
    if (VIEW) return fetchShareData();
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
  window.claude = Object.freeze({ use: async (n) => (n === 'db' ? dbReady : n === 'downloads' ? downloads : null) });

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
  const canEdit = () => !!(PK8 && !VIEW && ((CUR && CUR.cloud && CLOUD) || (EDIT && engineRepo())));
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
    if (CUR && CUR.cloud) shareSoon();   // friends see the change too
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
        st.textContent = VIEW ? `Viewing ${VIEW.name} · read-only` : CUR && CUR.cloud ? (on ? 'Your account · changes save as you make them' : 'Your account') : !engineRepo() ? 'View only' : !on ? 'View only on this device' : JOB_NOTE || (soon ? `Editing on · the editing key expires ${dayText(exp)}` : 'Editing on · saved changes reach the site in a few minutes');
        st.classList.toggle('stale', !!soon && !JOB_NOTE);
      }
      const cloud = !!(CUR && CUR.cloud);
      for (const [id, kind] of [['pd-run-market', 'market'], ['pd-run-sync', 'sync'], ['pd-edit-menu', null]]) { const b = el(id); if (b) b.hidden = !on || cloud || (kind && !jobFile(kind)); }
      const b = el('pd-edit-on'); if (b) b.hidden = on || cloud || !engineRepo() || !PK8;
      const ac = el('pd-account'); if (ac) ac.hidden = !(cloud && PK8);
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
  // Site data freshness: the site job publishes Sunday to Thursday at 3:38 PM Cairo. Stale = older than 26 hours on an EGX
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
    t.textContent = `Ledger data as of ${cairoAt(DATA_AT)}${stale ? ' · stale' : ''}`;
    t.classList.toggle('stale', stale); t.dataset.state = stale ? 'stale' : 'fresh';
    t.title = stale ? 'The daily site update has not arrived when expected; the figures may be out of date.' : '';
  }
  function publish(bundle) {
    DOCS = bundle.docs || {}; DATA_AT = bundle.exportedAt; OPENED = CUR.id;
    if (!VIEW) applyOverlay();   // saves made here that the published data does not show yet
    const jm = DOCS['market/latest'] || {};   // the market job's own document in this bundle: its asOf is the job's heartbeat
    if (LIVE && Date.parse(LIVE.asOf) > Date.parse(jm.asOf || 0)) DOCS['market/latest'] = { ...jm, ...LIVE, jobAsOf: jm.asOf || LIVE.jobAsOf };
    listeners.forEach(fire);
    document.title = (VIEW ? VIEW.name : CUR.name) + ' · Stock Market Portfolio Tracker';
    whenReady(() => {   // the bottom bar is the last thing in the document; the data can be ready before it is parsed
      footerFresh();
      const w = document.getElementById('pd-who'); if (w) w.textContent = VIEW ? VIEW.name : CUR.name;
      viewBanner();
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
    VIEW = null; FRIENDS = null; viewBanner();
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
      if (e && e.code === 'not_set_up') { ls.del(devLS()); await idbDel('dev:' + CUR.id); return setupScreen('This portfolio needs to be set up again on this device.'); }
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
      <div class="lk-links">${switchLink()}${CUR.cloud ? '' : '<button type="button" class="lk-link" id="lk-change" data-testid="live-change-password">Change password</button>'}<button type="button" class="lk-link" id="lk-forget" data-testid="live-forget-device">Forget this portfolio on this device</button></div>`);
    wireSwitch();
    if (hasBio) { $l('#lk-bio').onclick = () => bioUnlock(); if (auto) bioUnlock(true); } else $l('#lk-pw').focus();
    $l('#lk-pass').onsubmit = async (ev) => { ev.preventDefault(); const pw = $l('#lk-pw').value; if (!pw.trim()) return; const b = $l('[data-testid=live-password-submit]'); b.disabled = true; err('Checking…');
      try { const pk8 = await openV3(pw); rightPassword(); await unlocked(pk8); }
      catch (e) { $l('#lk-pw').value = ''; b.disabled = false;
        if (e && e.name === 'OperationError') await wrongPassword();
        else if (e && e.code === 'not_set_up') { console.error(e); ls.del(devLS()); setupScreen('This portfolio needs to be set up again on this device.'); }   // the store is gone (storage cleared); nothing to forget
        else { console.error(e); err('Could not unlock: ' + (e.message || e)); } } };
    if ($l('#lk-change')) $l('#lk-change').onclick = () => changePasswordScreen();
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
    try { await start(); } catch (e) { console.error(e); if (CUR.cloud && e && (e.code === 'signin' || e.code === 'auth')) return signInScreen(CUR.email, e.message); return dataErrorScreen(e); }
    open();
  }
  function dataErrorScreen(e) {
    screen(`<h1>${esc(CUR.name)}</h1><p data-testid="live-data-error">The portfolio data could not be read. Try again later; if it keeps happening, tell Claude.</p><p class="lk-foot">${esc((e && e.message) || e || '')}</p>
      <button class="lk-btn" id="lk-retry" data-testid="live-data-retry">Try again</button><div class="lk-links">${switchLink()}<button type="button" class="lk-link" id="lk-relock" data-testid="live-data-lock">Lock</button></div>`);
    wireSwitch(); $l('#lk-relock').onclick = () => lock(false);
    $l('#lk-retry').onclick = async () => { const b = $l('#lk-retry'); b.disabled = true; b.textContent = 'Trying…'; if (!PK8) return lock(false); await unlocked(PK8); };
  }
  async function start() { await loadEdit(); publish(await fetchData()); dbResolve(db); editBar();
    if (CUR.cloud && !VIEW) housekeeping().catch((e) => console.warn('account housekeeping', e));
    updateLive().catch((e) => { console.warn('live prices unavailable', e); notice('Live prices are unavailable right now: showing prices from the last daily update.'); }); }
  async function refresh() { if (!PK8) return; fetchTry = Date.now(); try { const b = await fetchData(); if (b.exportedAt !== DATA_AT) publish(b); else offlineBanner(); } catch (e) { console.warn('refresh failed', e); }
    if (CUR && CUR.cloud && CLOUD) listFriends().catch(() => {}); }
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
      if (changed) await storeSession().catch(() => {});
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
    return { exportedAt: market.exportedAt || new Date().toISOString(), docs };
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
  async function adoptAccount(a, pk8, keys, name, pw, email) {
    const p = { id: 'u_' + a.localId, name: name || 'My portfolio', cloud: true, uid: a.localId, email };
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
    screen(`<h1>Create your portfolio</h1><p>Your portfolio is private: it is locked with your password before it leaves this device. Nobody else can read it unless you add them as a friend. The site owner sees only your name, email and whether your automatic updates work, never your figures.</p>
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
    screen(`<h1>Your recovery code</h1><p>Write this down or keep a photo of it somewhere safe. If you ever forget your password, this code is the only way back into your portfolio. It is shown only now.</p>
      <p class="lk-code" data-testid="recovery-code">${esc(code)}</p>
      <label class="lk-check"><input type="checkbox" id="lk-rc-ok" data-testid="recovery-saved"> I have saved my recovery code</label>
      <button class="lk-btn" id="lk-rc-go" data-testid="recovery-continue" disabled>Continue</button>`);
    const ok = $l('#lk-rc-ok'), go = $l('#lk-rc-go');
    ok.onchange = () => { go.disabled = !ok.checked; };
    go.onclick = () => next();
  }
  // first-run: the starting point. Tracking starts today: cash plus the shares held now, valued at today's prices
  function onboardScreen(first, pname, note) {
    screen(`<h1>Set up your portfolio</h1><p>Tracking starts today. Enter your cash and the shares you hold now; each holding is valued at today's price. After this you can connect your Gmail so new trades are added by themselves.</p>
      <form id="lk-ob" autocomplete="off"><input id="lk-ob-name" data-testid="onboard-name" value="${esc(pname)}" aria-label="Portfolio name" placeholder="Portfolio name">
      <input id="lk-ob-cash" type="number" step="any" min="0" inputmode="decimal" data-testid="onboard-cash" placeholder="Cash in your broker account (EGP)" aria-label="Cash in your broker account (EGP)">
      <textarea id="lk-ob-hold" rows="5" data-testid="onboard-holdings" placeholder="Shares you hold, one per line, e.g.\nCOMI 100\nETEL 250" aria-label="Shares you hold"></textarea>
      <button class="lk-btn" id="lk-ob-go" data-testid="onboard-submit">Start tracking</button><div class="lk-err" role="alert">${esc(note || '')}</div></form>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-ob-skip" data-testid="onboard-skip">Skip: start with an empty portfolio</button></div>`);
    const run = async (holdText, cashText) => {
      const go = $l('#lk-ob-go'); go.disabled = true; err('Setting up…');
      try { await createPortfolio($l('#lk-ob-name').value.trim() || pname, first, cashText, holdText); await start(); gmailScreen(async () => { open(); await offerBio(PK8); }, true); }
      catch (e) { console.error(e); go.disabled = false; err(e.message || String(e)); }
    };
    $l('#lk-ob').onsubmit = (ev) => { ev.preventDefault(); run($l('#lk-ob-hold').value, $l('#lk-ob-cash').value); };
    $l('#lk-ob-skip').onclick = () => run('', '0');
  }
  async function createPortfolio(pname, holder, cashText, holdText) {
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
    const settings = { name: pname, portfolioId: CUR.id, inception: today.slice(0, 7), trackFrom: today, openingValue: 0, cash, cashDate: today, cashSource: 'entered at sign-up',
      account: { holder, unifiedCode: '' }, riskFree: typeof pol === 'number' ? pol : 0.22, fxStart: typeof fx === 'number' ? fx : 50, benchCloseStart: typeof ix.prevMonthClose === 'number' ? ix.prevMonthClose : null,
      openThreshold: 0.5, staleDays: 7, volLow: 0.03, volHigh: 0.08, priceDate: today, factsheetEmail: '', returnMethod: 'dietz' };
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
    screen(`<h1>${esc(CUR.name)}</h1><p>Signed in as <b>${esc(CUR.email || (CLOUD && CLOUD.email) || '')}</b>. Your portfolio is saved in your account, locked with your password.</p>
      <button class="lk-btn ghost" id="lk-ac-pw" data-testid="account-password">Change password</button>
      <button class="lk-btn ghost" id="lk-ac-friends" data-testid="account-friends">Friends${incoming() ? ` · ${incoming()} new` : ''}</button>
      <button class="lk-btn ghost" id="lk-ac-gmail" data-testid="account-gmail">Thndr emails${gmailOn() ? ' · connected' : ''}</button>
      <button class="lk-btn ghost" id="lk-ac-mail" data-testid="account-email">Email updates${mailOn() ? ' · on' : ''}</button>
      <button class="lk-btn ghost" id="lk-ac-code" data-testid="account-new-code">Make a new recovery code</button>
      <button class="lk-btn ghost" id="lk-ac-out" data-testid="account-signout">Sign out on this device</button>
      <button class="lk-btn ghost" id="lk-ac-admin" data-testid="account-admin" ${isOwner() ? '' : 'hidden'}>Admin: your friends' accounts</button>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-ac-back" data-testid="account-back">Back</button><button type="button" class="lk-link" id="lk-ac-del" data-testid="account-delete">Delete my account</button></div>`);
    $l('#lk-ac-friends').onclick = () => friendsScreen();
    listFriends().then(() => { const b = $l('#lk-ac-friends'); if (b) b.textContent = 'Friends' + (incoming() ? ` · ${incoming()} new` : ''); }).catch(() => {});
    $l('#lk-ac-del').onclick = () => deleteScreen();
    $l('#lk-ac-admin').onclick = () => adminScreen();
    checkOwner().then((y) => { const b = $l('#lk-ac-admin'); if (b) b.hidden = !y; }).catch(() => {});
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
    const pkg = { v: 1, uid: CLOUD.uid, email: prefs.email, refresh: CLOUD.refresh, pk8: b64big(PK8), prefs: { alerts: !!prefs.alerts, weekly: !!prefs.weekly, reports: !!prefs.reports, gmail: !!prefs.gmail, shareMain: !!prefs.shareMain }, at: new Date().toISOString() };
    const env = Object.assign({ v: 1 }, await sealTo(mk.pub, enc.encode(JSON.stringify(pkg)), MAIL_LABEL));
    await fsReq('PATCH', `mail/${CLOUD.uid}`, { fields: { pkg: { stringValue: JSON.stringify(env) }, at: { stringValue: pkg.at } } });
    ls.set(mailLS(), Object.assign({}, prefs, { ref: await sha(CLOUD.refresh) }));
  }
  // nothing left on: the package is deleted, so the job no longer opens the portfolio
  async function setMail(prefs) {
    if (prefs.alerts || prefs.weekly || prefs.reports || prefs.gmail || prefs.shareMain) return writeMail(prefs);
    await fsReq('DELETE', `mail/${CLOUD.uid}`); ls.del(mailLS());
  }
  // the job signs in with the saved refresh token: after a password change (which ends old sessions) it is sealed again
  async function resealMail() { const m = mailPrefs(); if (m && CLOUD && CLOUD.refresh && m.ref !== (await sha(CLOUD.refresh))) await writeMail(m); }
  function mailScreen(note) {
    const on = mailOn(), m = on ? mailPrefs() : Object.assign({ email: CUR.email || (CLOUD && CLOUD.email) || '' }, mailPrefs() || {}, { alerts: true, weekly: true, reports: true });
    screen(`<h1>Email updates</h1><p>Get an email when something needs your attention (a dividend coming up, a target or stop reached, a big drop), a summary every Thursday evening, and your month-end report (Excel workbook + PDF factsheet) when each monthly statement is posted.</p>
      <p class="lk-tip">To write these, the site owner's email job has to open your portfolio, so while this is on your figures are not private from that job. Switch it off any time: nothing is kept after that.</p>
      <form id="lk-ml" autocomplete="off"><input id="lk-ml-email" type="email" data-testid="mail-address" value="${esc(m.email)}" placeholder="Email address" aria-label="Email address">
      <label class="lk-check"><input type="checkbox" id="lk-ml-alerts" data-testid="mail-alerts" ${m.alerts ? 'checked' : ''}> Heads-up alerts</label>
      <label class="lk-check"><input type="checkbox" id="lk-ml-weekly" data-testid="mail-weekly" ${m.weekly ? 'checked' : ''}> Weekly summary (Thursday evening)</label>
      <label class="lk-check"><input type="checkbox" id="lk-ml-reports" data-testid="mail-reports" ${m.reports ? 'checked' : ''}> Month-end report (Excel + PDF)</label>
      <button class="lk-btn" id="lk-ml-go" data-testid="mail-on">${on ? 'Save' : 'Turn on email updates'}</button><div class="lk-err" role="alert">${esc(note || '')}</div></form>
      ${on ? '<button class="lk-btn ghost" id="lk-ml-off" data-testid="mail-off">Turn off email updates</button>' : ''}
      <div class="lk-links"><button type="button" class="lk-link" id="lk-ml-back" data-testid="mail-back">Back</button></div>`);
    $l('#lk-ml-back').onclick = accountScreen;
    $l('#lk-ml').onsubmit = async (ev) => {
      ev.preventDefault(); const email = $l('#lk-ml-email').value.trim(), alerts = $l('#lk-ml-alerts').checked, weekly = $l('#lk-ml-weekly').checked, reports = $l('#lk-ml-reports').checked;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err('Enter an email address.');
      if (!alerts && !weekly && !reports) return err('Pick at least one kind of email, or turn email updates off.');
      const b = $l('#lk-ml-go'); b.disabled = true; err('Saving…');
      try { await writeMail({ email, alerts, weekly, reports, gmail: gmailOn() }); open(); toast('Email updates are on. The first ones come after the next market close.'); }
      catch (e) { console.error(e); b.disabled = false; err(e.message || String(e)); }
    };
    const off = $l('#lk-ml-off');
    if (off) off.onclick = async () => {
      off.disabled = true;
      try { await setMail(Object.assign({}, mailPrefs(), { alerts: false, weekly: false, reports: false })); open(); toast('Email updates are off.'); }
      catch (e) { console.error(e); off.disabled = false; err(e.message || String(e)); }
    };
  }
  /* Thndr emails (opt-in): the account connects its own Gmail with a Google app password, and the account job imports its
     Thndr invoices and statements twice a day (run_account_mail.py: imap_fetch.py, then sync.js). The login is the
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
  // one screen: the Gmail address, the two Google pages (opened in that Google account), the code, the Thndr name
  async function gmailSetupScreen(done, first, change) {
    const [set, login] = await Promise.all([readCloudDoc('portfolio', 'settings').catch(() => ({})), readCloudDoc('sync', 'gmail').catch(() => ({}))]);
    const S0 = (set.doc && set.doc.data) || {}, L0 = (login.doc && login.doc.data) || {};
    const email = CUR.email || (CLOUD && CLOUD.email) || '';
    const addr0 = L0.address || (/@(gmail|googlemail)\.com$/i.test(email) ? email : '');
    let n = 0;
    const step = (title, sub) => `<div class="lk-step"><span class="lk-num">${++n}</span><div><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</div></div>`;
    screen(`<h1>${change ? 'New app password' : 'Connect your Gmail'}</h1>
      <form id="lk-gm" autocomplete="off">
      ${step('Type your Gmail', 'The one your Thndr emails go to.')}
      <input id="lk-gm-addr" type="email" data-testid="gmail-address" value="${esc(addr0)}" placeholder="you@gmail.com" autocapitalize="none" spellcheck="false" aria-label="Your Gmail address">
      ${change ? '' : `${step('Turn on 2-Step Verification', 'Tap the button, then turn it on. Already says <b>On</b>? Skip this step.')}
      <a class="lk-btn ghost" id="lk-gm-2sv" href="${GOOGLE_2SV}" target="_blank" rel="noopener noreferrer" data-testid="gmail-2sv-link">Open 2-Step Verification ↗</a>`}
      ${step('Make an app password', 'Tap the button. Type <b>EGX Tracker</b> as the name, tap <b>Create</b>, and copy the 16 letters Google shows you.')}
      <a class="lk-btn ghost" id="lk-gm-app" href="${GOOGLE_APPPW}" target="_blank" rel="noopener noreferrer" data-testid="gmail-apppw-link">Open App passwords ↗</a>
      ${step('Paste the 16 letters here')}
      <input id="lk-gm-pw" data-testid="gmail-app-password" placeholder="abcd efgh ijkl mnop" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="App password">
      ${change ? '' : `${step('Your full name, as the Thndr app shows it', 'So only your own Thndr emails are used.')}
      <input id="lk-gm-name" data-testid="gmail-holder" value="${esc(((S0.account || {}).holder) || '')}" placeholder="First and last name" autocomplete="name" aria-label="Your full name as in Thndr">
      ${mailOn() ? '' : '<label class="lk-check"><input type="checkbox" id="lk-gm-mail" data-testid="gmail-also-mail" checked> Also email me alerts, a weekly summary and my month-end report</label>'}`}
      <button class="lk-btn" id="lk-gm-go" data-testid="gmail-connect">${change ? 'Save' : 'Connect'}</button><div class="lk-err" role="alert"></div></form>
      <p class="lk-hint">Google says "not available for your account"? Do the 2-Step Verification step first. Work or school Gmail accounts may not allow this.</p>
      <details class="lk-more"><summary>Is this safe?</summary><p>The app password lets the site open your Gmail, but it only searches for emails from Thndr. It never sends, changes or deletes anything. While this is on, the site's daily job can open your portfolio to add the trades. To stop it, turn it off in Account → Thndr emails, or delete "EGX Tracker" in your Google App passwords.</p></details>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-gm-back" data-testid="gmail-back">Back</button></div>`);
    $l('#lk-gm-back').onclick = () => (change ? gmailStatusScreen(done) : gmailScreen(done, first));
    // the Google buttons open the Google account of the address typed (authuser), not whichever is signed in first
    const links = () => { const a = $l('#lk-gm-addr').value.trim(), q = /@/.test(a) ? '?authuser=' + encodeURIComponent(a) : '';
      const s = $l('#lk-gm-2sv'); if (s) s.href = GOOGLE_2SV + q; $l('#lk-gm-app').href = GOOGLE_APPPW + q; };
    $l('#lk-gm-addr').oninput = links; links();
    ($l('#lk-gm-addr').value ? $l('#lk-gm-pw') : $l('#lk-gm-addr')).focus();
    $l('#lk-gm').onsubmit = async (ev) => {
      ev.preventDefault();
      const address = $l('#lk-gm-addr').value.trim(), appPassword = $l('#lk-gm-pw').value.replace(/\s+/g, '').toLowerCase();
      const holder = change ? null : $l('#lk-gm-name').value.replace(/\s+/g, ' ').trim(), also = !change && !!($l('#lk-gm-mail') || {}).checked;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return err('Step 1: type your Gmail address.');
      if (!/^[a-z]{16}$/.test(appPassword)) return err('The app password is 16 letters (Google shows it as 4 groups of 4). Copy it again from Google.');
      if (!change && holder.split(' ').length < 2) return err('Type your full name as the Thndr app shows it (first and last name at least).');
      const b = $l('#lk-gm-go'); b.disabled = true; err('Connecting…');
      try {
        await saveDoc('set', 'sync/gmail', { address, appPassword, connectedAt: new Date().toISOString() });
        if (!change) {
          const patch = {};
          if (((S0.account || {}).holder || '') !== holder) patch.account = { holder };
          if (!S0.trackFrom) patch.trackFrom = cairoDay(Date.now() / 1000);   // the ledger so far stands; emails count from the next day
          if (Object.keys(patch).length) await saveDoc('update', 'portfolio/settings', patch);
          const m = Object.assign({ email: email || address, alerts: false, weekly: false, reports: false }, mailPrefs() || {});
          if (also) Object.assign(m, { email: m.email || address, alerts: true, weekly: true, reports: true });
          await writeMail(Object.assign(m, { gmail: true }));
          return gmailDoneScreen(done);
        }
        toast('App password saved. The next check uses it.'); gmailStatusScreen(done);
      } catch (e) { console.error(e); b.disabled = false; err(e.message || String(e)); }
    };
  }
  function gmailDoneScreen(done) {
    screen(`<h1>You're connected</h1>
      <p>From now on the site checks your Gmail at about <b>4 pm</b> and <b>6:30 pm</b> (Cairo time) and adds your new Thndr trades by itself.</p>
      <ul class="lk-steps"><li>Your monthly Thndr statement corrects everything to Thndr's numbers${(mailPrefs() || {}).reports ? ', and your month-end report is emailed to you' : ''}.</li>
        <li>If something does not match, nothing is changed and you get an email saying what to check.</li>
        <li>Only trades from after today are added: what you entered today covers everything before.</li></ul>
      <button class="lk-btn" id="lk-gm-done" data-testid="gmail-done">Done</button>`);
    $l('#lk-gm-done').onclick = () => done();
  }
  async function gmailStatusScreen(done) {
    const [login, rec] = await Promise.all([readCloudDoc('sync', 'gmail').catch(() => ({})), readCloudDoc('sync', 'mail').catch(() => ({}))]);
    const addr = ((login.doc && login.doc.data) || {}).address || '', g = (((rec.doc && rec.doc.data) || {}).gmail) || null;
    const when = g && g.at ? new Date(g.at).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const status = !g ? 'Not checked yet. The first check is at about 4 pm or 6:30 pm Cairo time, whichever comes next.'
      : g.ok ? `<span class="lk-ok">Working.</span> Last checked ${esc(when)}: ${g.new ? `${g.new} new Thndr email${g.new > 1 ? 's' : ''}` : 'no new Thndr emails'}${g.held ? `, ${g.held} need${g.held > 1 ? '' : 's'} a look (see the email you got)` : ''}.`
      : `<b>The last check failed</b> (${esc(when)}): ${esc(g.error || 'unknown error')}. Usually the app password was deleted or changed: tap <b>Change app password</b>.`;
    screen(`<h1>Thndr emails</h1><p>Connected to <b>${esc(addr)}</b>. New Thndr invoices and statements are added to your portfolio twice a day.</p>
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
     Friends see each other's portfolios, read-only. links/{uid}/with/{other} holds each side of a friendship ('sent',
     'received', then 'friends' once the one who received it accepts); a friend is found by their sign-in email through
     directory/{email} = {uid, name, pub}. Each side keeps shares/{me}/to/{friend} = a copy of its own portfolio documents
     (portfolio, ledger, imports; the Thndr account number and email settings left out) gzipped and sealed to the friend's
     public key ('portfolio-share-v1'): refreshed when the account opens or saves (and by the email job for accounts that
     have it), readable only by that friend. Viewing one swaps the page's documents for the copy plus the shared market
     data, with editing off, until "Back to mine". Removing a friend deletes both sides and both copies.
     status/{uid} = {name, email, createdAt, lastSeen, site: JSON {mail, reports, gmail, friends}, job: JSON (written by
     the email job)} is what the site owner's admin screen lists: no figures. The owner (OWNER_EMAIL, verified) can reset
     an account there: everything of it is deleted except the sign-in; signing in again starts afresh (restartScreen). */
  // the site owner's sign-in email, as its SHA-256 (the address itself is not published); the database rules hold the
  // address and decide, this only shows the Admin button and the "main portfolio" choice
  const OWNER_HASH = '467022c320757248bf70115c83d305a7e4d139c35e1be5f8117fb30d7f769347', SHARE_LABEL = 'portfolio-share-v1', SHARE_COLLS = new Set(['portfolio', 'ledger', 'imports']);
  const JOB_URL = 'https://github.com/khaledamin2001-lgtm/portfolio-engine/actions/workflows/account-mail.yml';
  let FRIENDS = null;   // the open account's links: [{uid, status, name, pub, email, at}]
  let OWNER = { email: null, yes: false };
  const hex = async (t) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(t))), (b) => b.toString(16).padStart(2, '0')).join('');
  async function checkOwner() { const e = String((CLOUD && CLOUD.email) || '').toLowerCase(); if (OWNER.email !== e) OWNER = { email: e, yes: !!e && (await hex(e)) === OWNER_HASH }; return OWNER.yes; }
  const isOwner = () => !!(CLOUD && OWNER.yes && OWNER.email === String(CLOUD.email || '').toLowerCase());
  const incoming = () => (FRIENDS || []).filter((f) => f.status === 'received').length;
  const fsFields = (o) => ({ fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { stringValue: String(v) }])) });
  const fsData = (doc) => Object.fromEntries(Object.entries((doc && doc.fields) || {}).map(([k, v]) => [k, v.stringValue != null ? v.stringValue : v.integerValue != null ? +v.integerValue : v.booleanValue]));
  const maskOf = (keys) => keys.map((k) => 'updateMask.fieldPaths=' + k).join('&');
  const jparse = (x) => { try { return JSON.parse(x); } catch (e) { return null; } };
  const dayOf = (iso) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: 'numeric', month: 'short' }).format(new Date(iso)) : '—');
  const whenOf = (iso) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—');
  async function listAll(path) {
    const out = []; let t = '';
    do { const j = await fsReq('GET', path, null, 'pageSize=300' + (t ? '&pageToken=' + encodeURIComponent(t) : '')); (j.documents || []).forEach((d) => out.push(d)); t = j.nextPageToken || ''; } while (t);
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
  // after an account opens: its directory entry (how friends find it), friend requests, the status line for the site owner
  // (once a day, or when a setting changed) and fresh copies of the portfolio for friends
  async function housekeeping() {
    await checkOwner();
    const email = String(CLOUD.email || CUR.email || '').toLowerCase(), dk = 'pd.dir.' + CUR.id, dsig = KEYS.pub + '|' + CUR.name;
    if (email && ls.get(dk) !== dsig) { await fsReq('PATCH', `directory/${encodeURIComponent(email)}`, fsFields({ uid: CLOUD.uid, name: CUR.name, pub: KEYS.pub })); ls.set(dk, dsig); }
    await listFriends();
    const sk = 'pd.status.' + CUR.id, ssig = cairoDay(Date.now() / 1000) + JSON.stringify(mailPrefs() || {}) + FRIENDS.map((f) => f.status).join();
    if (ls.get(sk) !== ssig) { await writeStatus(); ls.set(sk, ssig); }
    if (incoming()) toast(`${FRIENDS.filter((f) => f.status === 'received').map((f) => f.name).join(', ')} sent you a friend request: tap Account, then Friends.`);
    if (/[?&]friends\b/.test(location.search)) { history.replaceState(null, '', location.pathname); if (PK8 && lockEl().hidden) friendsScreen(); }
    await refreshShares();
  }
  // the copy friends see: the portfolio documents only, without the Thndr account number or email settings
  function shareSnapshot() {
    const docs = {};
    for (const [k, v] of Object.entries(DOCS)) if (SHARE_COLLS.has(k.split('/')[0])) docs[k] = v;
    if (docs['portfolio/settings']) { const c = Object.assign({}, docs['portfolio/settings']); delete c.account; delete c.factsheetEmail; delete c.recipient; docs['portfolio/settings'] = c; }
    return { v: 1, at: new Date().toISOString(), name: CUR.name, full: false, docs };
  }
  const gzip = async (text) => new Uint8Array(await new Response(new Blob([enc.encode(text)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const gunzip = async (bytes) => new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  async function refreshShares(force) {
    if (VIEW || !FRIENDS || !CLOUD || !PK8) return;
    if (isOwner() && (mailPrefs() || {}).shareMain) return;   // the email job shares the owner's main portfolio instead
    const fr = FRIENDS.filter((f) => f.status === 'friends' && f.pub); if (!fr.length) return;
    const snapObj = shareSnapshot(), h = await sha(JSON.stringify(snapObj.docs)), body = JSON.stringify(snapObj);
    for (const f of fr) {
      const k = 'pd.share.' + CUR.id + '.' + f.uid, o = ls.get(k);
      if (!force && o && o.h === h && Date.now() - o.t < 20 * 3600e3) continue;
      try {
        const env = Object.assign({ v: 1 }, await sealTo(f.pub, await gzip(body), SHARE_LABEL));
        await fsReq('PATCH', `shares/${CLOUD.uid}/to/${f.uid}`, fsFields({ pkg: JSON.stringify(env), name: CUR.name, at: snapObj.at }));
        ls.set(k, { h, t: Date.now() });
      } catch (e) { console.warn('friend copy not refreshed', e); }
    }
  }
  let shareTimer = null;
  function shareSoon() { clearTimeout(shareTimer); shareTimer = setTimeout(() => refreshShares().catch(() => {}), 8000); }
  // a friend's copy on the page, read-only
  async function fetchShareData() {
    const j = await fsReq('GET', `shares/${VIEW.uid}/to/${CLOUD.uid}`);
    const snapObj = JSON.parse(await gunzip(await unseal(JSON.parse(fStr(j, 'pkg')), SHARE_LABEL)));
    const market = snapObj.full ? { docs: {} } : await fetchMarket().catch(() => ({ docs: {} }));
    const docs = Object.assign({}, market.docs || {}, snapObj.docs || {});
    macroMarks(docs);
    VIEW.at = snapObj.at; lastFetch = Date.now(); SAVED_AT = null;
    return { exportedAt: snapObj.at, docs };
  }
  async function viewFriend(f) {
    const was = VIEW; VIEW = { uid: f.uid, name: f.name };
    try { publish(await fetchData()); editBar(); open(); window.scrollTo(0, 0); }
    catch (e) { VIEW = was; throw e; }
  }
  async function viewMine() { VIEW = null; publish(await fetchData()); editBar(); window.scrollTo(0, 0); }
  function viewBanner() {
    whenReady(() => {
      let b = document.getElementById('pd-view');
      if (!VIEW) { if (b) b.hidden = true; return; }
      if (!b) { b = document.createElement('div'); b.id = 'pd-view'; b.setAttribute('role', 'status'); b.dataset.testid = 'view-banner'; document.body.insertBefore(b, document.body.firstChild); }
      b.hidden = false;
      b.innerHTML = `Viewing <b>${esc(VIEW.name)}</b>, shared with you${VIEW.at ? ` (as of ${esc(whenOf(VIEW.at))})` : ''}. You can look, not change. <button type="button" id="pd-view-back" data-testid="view-back">Back to mine</button>`;
      b.querySelector('#pd-view-back').onclick = () => viewMine().catch((e) => toast('Could not reopen your portfolio: ' + (e.message || e), 'error'));
    });
  }
  window.pdViewing = () => (VIEW ? { uid: VIEW.uid, name: VIEW.name } : null);

  async function friendsScreen(note) {
    screen('<h1>Friends</h1><p>Loading…</p>');
    try { await listFriends(); refreshShares().catch(() => {}); }
    catch (e) { console.error(e); screen(`<h1>Friends</h1><p class="lk-err">${esc(e.message || e)}</p><div class="lk-links"><button type="button" class="lk-link" id="lk-fr-back">Back</button></div>`); $l('#lk-fr-back').onclick = accountScreen; return; }
    const by = (st) => FRIENDS.filter((f) => f.status === st);
    const row = (f, btns) => `<div class="lk-friend" data-testid="friend-${esc(f.status)}"><div><b>${esc(f.name)}</b><small>${esc(f.email || '')}</small></div><div class="lk-friend-btns">${btns}</div></div>`;
    const main = isOwner() && !!(mailPrefs() || {}).shareMain;
    screen(`<h1>Friends</h1><p>Friends see each other's portfolios: holdings, returns and activity. They can look, never change anything.</p>
      ${by('received').length ? `<p class="lk-lbl">Friend requests</p>${by('received').map((f) => row(f, `<button class="lk-btn" data-acc="${esc(f.uid)}" data-testid="friend-accept">Accept</button><button class="lk-btn ghost" data-del="${esc(f.uid)}" data-testid="friend-decline">Decline</button>`)).join('')}` : ''}
      ${by('friends').length ? `<p class="lk-lbl">Your friends</p>${by('friends').map((f) => row(f, `<button class="lk-btn" data-view="${esc(f.uid)}" data-testid="friend-view">View</button><button class="lk-btn ghost" data-del="${esc(f.uid)}" data-testid="friend-remove">Remove</button>`)).join('')}` : ''}
      ${by('sent').length ? `<p class="lk-lbl">Waiting for them to accept</p>${by('sent').map((f) => row(f, `<button class="lk-btn ghost" data-del="${esc(f.uid)}" data-testid="friend-cancel">Cancel</button>`)).join('')}` : ''}
      <form id="lk-fr-add" autocomplete="off"><label class="lk-lbl" for="lk-fr-email">Add a friend</label>
      <input id="lk-fr-email" type="email" data-testid="friend-email" placeholder="The email they sign in with" autocapitalize="none" spellcheck="false">
      <button class="lk-btn" id="lk-fr-go" data-testid="friend-add">Send friend request</button><div class="lk-err" role="alert">${esc(note || '')}</div></form>
      <p class="lk-hint">They see your request next time they open the site (and by email if they have email updates on). Once they accept, you both see each other's portfolio. Either of you can remove it any time and it stops at once.</p>
      ${isOwner() ? `<p class="lk-tip" data-testid="friend-owner">${main ? 'Friends see <b>your main portfolio</b>, refreshed by the daily job at about 4 pm and 6:30 pm.' : "Friends see this account's portfolio."} <button type="button" class="lk-link" id="lk-fr-main" data-testid="friend-owner-toggle">${main ? "Show this account's portfolio instead" : 'Show my main portfolio instead'}</button></p>` : ''}
      <div class="lk-links"><button type="button" class="lk-link" id="lk-fr-back" data-testid="friends-back">Back</button></div>`);
    $l('#lk-fr-back').onclick = accountScreen;
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
    document.querySelectorAll('#lock [data-view]').forEach((b) => { b.onclick = async () => {
      const f = find(b.dataset.view); busy(b, 'Opening…');
      try { await viewFriend(f); }
      catch (e) { console.error(e); friendsScreen(e.code === 'not_found' ? `${f.name} has not shared a copy yet. It appears after they next open the site (or at the next daily update if their automatic updates are on).` : (e.message || String(e))); }
    }; });
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
    $l('#lk-fr-add').onsubmit = async (ev) => {
      ev.preventDefault();
      const email = $l('#lk-fr-email').value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err('Enter their email address.');
      if (email === String(CLOUD.email || '').toLowerCase()) return err('That is your own email.');
      busy($l('#lk-fr-go'), 'Sending…');
      try { const name = await requestFriend(email); toast(`Friend request sent to ${name}.`); friendsScreen(); }
      catch (e) { if (e.code !== 'user') console.error(e); friendsScreen(e.message || String(e)); }
    };
  }
  async function requestFriend(email) {
    let d;
    try { d = fsData(await fsReq('GET', `directory/${encodeURIComponent(email)}`)); }
    catch (e) { if (e.code === 'not_found') throw Object.assign(new Error(`Nobody has an account with ${email} yet. Send them the site link first: ${location.origin + location.pathname}`), { code: 'user' }); throw e; }
    const have = (FRIENDS || []).find((f) => f.uid === d.uid);
    if (have) throw Object.assign(new Error(have.status === 'friends' ? `You and ${have.name} are already friends.` : have.status === 'sent' ? `You already asked ${have.name}; waiting for them to accept.` : `${have.name} already sent you a request: accept it above.`), { code: 'user' });
    const at = new Date().toISOString();
    await fsReq('PATCH', `links/${CLOUD.uid}/with/${d.uid}`, fsFields({ status: 'sent', name: d.name, pub: d.pub, email, at }), 'currentDocument.exists=false');
    try { await fsReq('PATCH', `links/${d.uid}/with/${CLOUD.uid}`, fsFields({ status: 'received', name: CUR.name, pub: KEYS.pub, email: String(CLOUD.email || '').toLowerCase(), at }), 'currentDocument.exists=false'); }
    catch (e) { await fsDel(`links/${CLOUD.uid}/with/${d.uid}`); throw e; }
    return d.name;
  }
  async function acceptFriend(f) {
    const at = new Date().toISOString(), upd = fsFields({ status: 'friends', at });
    await fsReq('PATCH', `links/${f.uid}/with/${CLOUD.uid}`, upd, maskOf(['status', 'at']));
    await fsReq('PATCH', `links/${CLOUD.uid}/with/${f.uid}`, upd, maskOf(['status', 'at']));
    await listFriends();
    await refreshShares(true);
  }
  async function unfriend(uid) {
    for (const p of [`shares/${CLOUD.uid}/to/${uid}`, `shares/${uid}/to/${CLOUD.uid}`, `links/${uid}/with/${CLOUD.uid}`, `links/${CLOUD.uid}/with/${uid}`]) await fsDel(p);
    ls.del('pd.share.' + CUR.id + '.' + uid);
    if (VIEW && VIEW.uid === uid) await viewMine();
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
    for (const d of await listAll(`users/${uid}/docs`)) await fsDel(`users/${uid}/docs/${d.name.split('/').pop()}`);
    await fsDel(`users/${uid}`);
    await fsDel(`status/${uid}`);
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
        PK8 = null; CLOUD = null; VIEW = null; FRIENDS = null; DOCS = {}; CUR = null; OPENED = null; listeners.forEach(fire); blank();
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
      const [docs, mk] = await Promise.all([listAll('status'), fetch('m/market.enc.json?t=' + Date.now(), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)]);
      const rows = docs.map((d) => { const x = fsData(d); return Object.assign(x, { uid: d.name.split('/').pop(), site: jparse(x.site) || {}, job: jparse(x.job) || null }); })
        .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
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
        const facts = [`Joined ${dayOf(r.createdAt)} · last opened ${dayOf(r.lastSeen)}`, `Email updates ${s.mail ? 'on' : 'off'} · month-end report ${s.reports ? 'on' : 'off'} · Thndr emails ${s.gmail ? 'on' : 'off'} · friends ${s.friends || 0}`];
        return `<div class="lk-card${bad.length ? ' bad' : ''}" data-testid="admin-row"><div class="lk-card-head"><b>${esc(r.name || '(no name)')}</b><small>${esc(r.email || '')}</small></div>
          <ul class="lk-facts">${facts.map((t) => `<li>${esc(t)}</li>`).join('')}${ok.map((t) => `<li class="ok">${esc(t)}</li>`).join('')}${bad.map((t) => `<li class="bad">${esc(t)}</li>`).join('')}</ul>
          ${r.uid === CLOUD.uid ? '' : `<button class="lk-btn ghost" data-reset="${esc(r.uid)}" data-testid="admin-reset">Reset account</button>`}</div>`;
      };
      const problems = rows.filter((r) => /class="lk-card bad/.test(card(r))).length;
      screen(`<h1>Admin</h1><p>${rows.length} account${rows.length === 1 ? '' : 's'}${problems ? `, <b>${problems} with a problem</b>` : ', no problems'}. Shared prices updated ${esc(mk && mk.at ? whenOf(mk.at) : '—')}.</p>
        <p class="lk-hint">You see names, emails and whether things work, never anyone's figures. Accounts appear here once they open the site.</p>
        ${rows.map(card).join('') || '<p>No accounts yet.</p>'}
        <a class="lk-btn ghost" href="${JOB_URL}" target="_blank" rel="noopener noreferrer" data-testid="admin-job-link">Run the daily friends' job now (GitHub)</a>
        <div class="lk-err" role="alert"></div>
        <div class="lk-links"><button type="button" class="lk-link" id="lk-ad-back" data-testid="admin-back">Back</button></div>`);
      $l('#lk-ad-back').onclick = accountScreen;
      document.querySelectorAll('#lock [data-reset]').forEach((b) => { b.onclick = () => resetScreen(rows.find((r) => r.uid === b.dataset.reset)); });
    } catch (e) {
      console.error(e);
      if (e.code === 'forbidden') return verifyScreen('The database did not accept this sign-in as the admin yet. If you just verified your email, tap "I clicked the link".');
      screen(`<h1>Admin</h1><p class="lk-err">${esc(e.message || e)}</p><div class="lk-links"><button type="button" class="lk-link" id="lk-ad-back">Back</button></div>`); $l('#lk-ad-back').onclick = accountScreen;
    }
  }
  function verifyScreen(note) {
    screen(`<h1>Verify your email</h1><p>The admin screen opens only once Google has confirmed that <b>${esc(CLOUD.email || '')}</b> is your email.</p>
      <ol class="lk-steps"><li>Tap <b>Send the link</b>.</li><li>Open the email from Firebase (check spam too) and click the link.</li><li>Come back and tap <b>I clicked the link</b>.</li></ol>
      <button class="lk-btn" id="lk-vf-send" data-testid="admin-verify-send">Send the link</button>
      <button class="lk-btn ghost" id="lk-vf-done" data-testid="admin-verify-done">I clicked the link</button><div class="lk-err" role="alert">${esc(note || '')}</div>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-vf-back">Back</button></div>`);
    $l('#lk-vf-back').onclick = accountScreen;
    $l('#lk-vf-send').onclick = async () => { try { await fbAuth('sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: await idToken() }); err('Sent. Check your inbox.'); } catch (e) { err(e.message || String(e)); } };
    $l('#lk-vf-done').onclick = () => { CLOUD.exp = 0; adminScreen(); };   // a fresh token carries email_verified
  }
  function resetScreen(r) {
    screen(`<h1>Reset ${esc(r.name || 'this account')}?</h1><p>This deletes their portfolio, email updates, Thndr emails connection and friends. Their sign-in stays: when they sign in again, they set up a fresh portfolio with the same email and password.</p>
      <p class="lk-tip">Only do this when they asked for it. It cannot be undone.</p>
      <form id="lk-rst" autocomplete="off"><input id="lk-rst-word" data-testid="admin-reset-confirm" placeholder="Type RESET to confirm" autocapitalize="characters" spellcheck="false">
      <button class="lk-btn danger" id="lk-rst-go" data-testid="admin-reset-go">Reset the account</button><div class="lk-err" role="alert"></div></form>
      <div class="lk-links"><button type="button" class="lk-link" id="lk-rst-back">Back</button></div>`);
    $l('#lk-rst-back').onclick = adminScreen;
    $l('#lk-rst').onsubmit = async (ev) => {
      ev.preventDefault();
      if ($l('#lk-rst-word').value.trim().toUpperCase() !== 'RESET') return err('Type RESET to confirm.');
      const b = $l('#lk-rst-go'); b.disabled = true; err('Resetting…');
      try { await wipeAccount(r.uid, r.email); toast(`${r.name || 'The account'} is reset. They can sign in and start again.`); adminScreen(); }
      catch (e) { console.error(e); b.disabled = false; err(e.message || String(e)); }
    };
  }
  window.pdAccountMenu = () => { if (CUR && CUR.cloud && PK8) accountScreen(); };
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
  // while the page is visible and unlocked: the data every 30 minutes, live prices every 10 minutes during the session
  function tick() {
    if (document.hidden || !PK8 || !lockEl().hidden) return;
    const now = Date.now(); footerFresh();
    if (now - Math.max(lastFetch, fetchTry) > REFRESH_MS) refresh();
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
