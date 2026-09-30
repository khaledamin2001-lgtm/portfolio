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
  async function forget() { ls.del(devLS()); await idbDel('dev:' + CUR.id); await idbDel('bio:' + CUR.id); await idbDel('tok:' + CUR.id); }
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
  let SAVED_AT = null;   // set when the last data answer was sw.js's saved copy (its x-pd-saved-at header), null when it came from the network
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
    const bundle = JSON.parse(plain);
    lastFetch = Date.now(); SAVED_AT = r.headers.get('x-pd-saved-at');
    return bundle;
  }
  // month-end Excel workbooks, published encrypted under p/<id>/exports/ (exports/index.json lists them)
  let EXPORTS = null;
  window.pdExports = async () => { if (EXPORTS) return EXPORTS; try { const r = await fetch(base() + 'exports/index.json?t=' + Date.now(), { cache: 'no-store' }); EXPORTS = r.ok ? await r.json() : []; } catch (e) { EXPORTS = []; } return EXPORTS; };
  // kind 'xlsx' (default): the Excel workbook (entry.file); 'pdf': the PDF factsheet (entry.pdf), both encrypted the same way
  const FILE_KINDS = { xlsx: { key: 'file', what: 'workbook', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, pdf: { key: 'pdf', what: 'PDF factsheet', type: 'application/pdf' } };
  window.pdDownloadExport = async (month, kind) => {
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
  const canEdit = () => !!(PK8 && EDIT && engineRepo());
  window.pdCanEdit = canEdit;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const b64big = (u) => { u = u instanceof Uint8Array ? u : new Uint8Array(u); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const toast = (m, k) => { if (window.pdToast) window.pdToast(m, k); };
  // encrypt for the portfolio's public key: the same scheme unseal() opens and src/jobs/store.py seal() writes
  async function seal(bytes, label) {
    const site = await crypto.subtle.importKey('raw', ub64(KEYS.pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
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
    const repo = EDIT.repo, path = `${edir()}db/${c}/${d}.enc.json`, msg = `Site edit: ${CUR.id} ${p}`;
    for (let attempt = 0; ; attempt++) {
      const rc = RECENT.get(p);
      const cur = attempt === 0 && rc && Date.now() - rc.at < 120e3 ? rc : await readEngineDoc(c, d);
      const w = op === 'set' && seen !== undefined && cur.doc ? { op, data: pdStore.rebase(seen, data, cur.doc.data) } : { op, data };
      const step = (await pdStore.applyWrites([Object.assign(w, { collection: c, doc_id: d })], async () => cur.doc)).plan[0];
      try {
        if (!step) return settle(p, cur.doc ? cur.doc.data : undefined);   // unchanged
        if (step.action === 'rm') {
          await gh('DELETE', `/repos/${repo}/contents/${path}`, { message: msg, sha: cur.sha, branch: 'main' });
          RECENT.delete(p); return settle(p, undefined);
        }
        const plain = enc.encode(JSON.stringify(step.doc));
        const env = Object.assign({ v: 1, name: d + '.json', bytes: plain.length }, await seal(plain, FILE_LABEL));
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
        st.textContent = !engineRepo() ? 'View only' : !on ? 'View only on this device' : JOB_NOTE || (soon ? `Editing on · the editing key expires ${dayText(exp)}` : 'Editing on · saved changes reach the site in a few minutes');
        st.classList.toggle('stale', !!soon && !JOB_NOTE);
      }
      for (const [id, kind] of [['pd-run-market', 'market'], ['pd-run-sync', 'sync'], ['pd-edit-menu', null]]) { const b = el(id); if (b) b.hidden = !on || (kind && !jobFile(kind)); }
      const b = el('pd-edit-on'); if (b) b.hidden = on || !engineRepo() || !PK8;
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
    PK8 = null; DOCS = {}; DATA_AT = null; lastFetch = 0; EXPORTS = null; SAVED_AT = null; EDIT = null; OVERLAY.clear(); RECENT.clear(); JOB_NOTE = ''; editBar();
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
    CUR = p; ls.set(CUR_LS, p.id); KEYS = null; PK8 = null; EXPORTS = null; EDIT = null;
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
  async function start() { await loadEdit(); publish(await fetchData()); dbResolve(db); editBar();
    updateLive().catch((e) => { console.warn('live prices unavailable', e); notice('Live prices are unavailable right now: showing prices from the last daily update.'); }); }
  async function refresh() { if (!PK8) return; fetchTry = Date.now(); try { const b = await fetchData(); if (b.exportedAt !== DATA_AT) publish(b); else offlineBanner(); } catch (e) { console.warn('refresh failed', e); } }
  window.pdLock = () => { if (CUR) lock(false); };
  window.pdSwitch = () => chooseScreen();
  window.pdSelect = (id) => { const p = PORTFOLIOS.find((x) => x.id === id); if (p && !(CUR && CUR.id === p.id)) select(p); };

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
    const last = PORTFOLIOS.find((p) => p.id === ls.get(CUR_LS));
    if (last) select(last); else if (PORTFOLIOS.length === 1) select(PORTFOLIOS[0]); else chooseScreen();
  })();
})();
