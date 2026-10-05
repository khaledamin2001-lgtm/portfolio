/* Portfolio Desk service worker. build_site.py fills in the stamps and the static file list; the built copy sits at the site
   root next to index.html so its scope is the whole site (…/portfolio/ on GitHub Pages).
   - The page, portfolios.json, the members' shared market data (m/market.enc.json) and each portfolio's keys.json,
     data.enc.json and exports/*: network first. If the network has
     not answered within 4 s, or fails outright, or answers 5xx, the copy saved on this device is served instead (a 404 or
     any other answer is passed through as is, so a missing file still reads as missing). Every 200 answer replaces the
     saved copy; a .json file is saved only if it parses. The saved copy carries an x-pd-saved-at header: lock.js shows its
     offline banner when the data came from here.
   - Fonts, icons and the manifest: cache first (they only change with a new build, which gets a new cache).
   - Anything cross-origin (the TradingView scanner) and anything that is not a GET is never touched: it goes straight to the
     network and fails normally when offline.
   Everything the site serves is either public or encrypted (data.enc.json, exports), so nothing readable lands in the cache.
   A new build is a new cache name: the new worker installs, skips waiting, takes over open pages, carries the saved data
   files over from the old cache (only those missing from the new one) and deletes the old caches. */
'use strict';
const BUILD = '57aab6302dba 2026-10-05 20:11';     // the page's pd-build stamp
const SITE = 'e423ecf852';       // hash over this site build (index.html, sw.js template, icons, manifest, fonts)
const PREFIX = 'portfolio-desk-';  // the github.io origin is shared by every Pages site of the account: touch only our caches
const CACHE = PREFIX + BUILD.split(' ')[0] + '-' + SITE;
const STATIC = ["manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png", "icon-maskable-192.png", "icon-maskable-512.png", "fonts/ibm-plex-mono-latin-500.woff2", "fonts/ibm-plex-mono-latin-ext-500.woff2", "fonts/public-sans-latin-400.woff2", "fonts/public-sans-latin-ext-400.woff2", "fonts/spectral-latin-500.woff2", "fonts/spectral-latin-600.woff2", "fonts/spectral-latin-ext-500.woff2", "fonts/spectral-latin-ext-600.woff2", "vendor/pdf.min.js", "vendor/pdf.worker.min.js"];      // cache-first files, relative to the scope
const TIMEOUT_MS = 4000;
const SCOPE = new URL(self.registration.scope);
const STATIC_SET = new Set(STATIC);
const DATA = /^(?:portfolios\.json|m\/market\.enc\.json|p\/[^/]+\/(?:keys\.json|data\.enc\.json|exports\/[^/]+))$/;
const rel = (url) => (url.origin === self.location.origin && url.pathname.startsWith(SCOPE.pathname) ? decodeURIComponent(url.pathname.slice(SCOPE.pathname.length)) : null);
const keyFor = (u) => { const url = new URL(u, SCOPE); url.search = ''; url.hash = ''; return url.href; };   // ?t=<now> cache busters share one entry
const SHELL = keyFor('./');

async function save(cache, key, res) {   // only complete 200 answers; a .json file must parse
  if (!res || res.status !== 200 || res.type === 'opaque' || res.type === 'error') return;
  const body = await res.arrayBuffer();
  if (/\.json$/.test(new URL(key).pathname)) { try { JSON.parse(new TextDecoder().decode(body)); } catch (e) { return; } }
  const h = new Headers(res.headers); h.delete('content-encoding'); h.delete('content-length'); h.set('x-pd-saved-at', new Date().toISOString());
  await cache.put(key, new Response(body, { status: 200, statusText: res.statusText, headers: h }));
}

function networkFirst(event, key) {
  const cacheP = caches.open(CACHE);
  let saving = Promise.resolve();
  const net = fetch(event.request).then((res) => { const copy = res.clone(); saving = cacheP.then((c) => save(c, key, copy)).catch(() => {}); return res; });
  event.waitUntil(net.then(() => saving, () => {}));   // registered now, so the copy is saved even when the timeout answered first
  event.respondWith((async () => {
    const saved = async () => (await cacheP).match(key);
    let timer;
    try {
      const r = await Promise.race([net, new Promise((res) => { timer = setTimeout(res, TIMEOUT_MS, null); })]);
      if (r && r.status < 500) return r;
      const c = await saved(); if (c) return c;
      return r || await net;   // nothing saved yet: wait for the network after all
    } catch (e) {
      const c = await saved(); if (c) return c;
      throw e;                 // offline and nothing saved: fail exactly like the network did
    } finally { clearTimeout(timer); }
  })());
}

function cacheFirst(event, key) {
  event.respondWith((async () => {
    const c = await caches.open(CACHE), hit = await c.match(key);
    if (hit) return hit;
    const res = await fetch(event.request);
    await save(c, key, res.clone()).catch(() => {});
    return res;
  })());
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const c = await caches.open(CACHE);
    const get = async (path) => { const r = await fetch(new URL(path, SCOPE).href, { cache: 'reload' }); if (r.status !== 200) throw new Error(path + ' ' + r.status); await save(c, keyFor(path), r); };
    await get('./');   // the page itself is required; everything else is best effort
    await Promise.allSettled([...STATIC, 'portfolios.json'].map(get));
    try {   // each portfolio's keys and data, so the app opens offline right after the first visit
      const list = await (await c.match(keyFor('portfolios.json'))).json();
      await Promise.allSettled(list.flatMap((p) => ['p/' + p.id + '/keys.json', 'p/' + p.id + '/data.enc.json']).map(get));
    } catch (e) {}
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cur = await caches.open(CACHE);
    for (const name of await caches.keys()) {
      if (!name.startsWith(PREFIX) || name === CACHE) continue;
      try {   // keep the last loaded data across a deploy if the new install could not fetch it
        const old = await caches.open(name);
        for (const req of await old.keys()) {
          const r = rel(new URL(req.url));
          if (r && /^p\//.test(r) && !(await cur.match(req))) { const res = await old.match(req); if (res) await cur.put(req, res); }
        }
      } catch (e) {}
      await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url), r = rel(url);
  if (r == null) return;   // cross-origin (TradingView) or outside the site: not handled, never cached
  if (req.mode === 'navigate') { if (r === '' || r === 'index.html') networkFirst(event, SHELL); return; }
  if (DATA.test(r)) return networkFirst(event, keyFor(req.url));
  if (STATIC_SET.has(r)) return cacheFirst(event, keyFor(req.url));
});
