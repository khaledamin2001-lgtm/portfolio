// JS side of the store contract, run by test_store.py (Node 18+, WebCrypto only -- the same calls the browser makes).
//   node js_compat.mjs vectors <merge_vectors.json>   -> checks a reference JS deepMerge / stripMarkers / applyBatch
//   node js_compat.mjs crypto  < {pkcs8, pub, envelope, plain}   (a THROWAWAY test key and synthetic data only)
//        -> decrypts a store.py envelope exactly like lock.js unseal(e, 'portfolio-file-v1'), then seals a new document
//           with the public key (the site editor's write path) and prints it for store.py to decrypt.
// Track C: deepMerge / stripMarkers / applyBatch below are the reference JS port; copy them rather than re-deriving.
import fs from 'node:fs';
const { subtle } = globalThis.crypto;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u) => Buffer.from(u).toString('base64'), ub64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

export const isDeleteMarker = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && v.__delete__ === true;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const copy = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
export function stripMarkers(v) {
  if (!isObj(v)) return copy(v);
  const o = {};
  for (const [k, x] of Object.entries(v)) if (!isDeleteMarker(x)) o[k] = stripMarkers(x);
  return o;
}
export function deepMerge(base, patch) {
  if (!isObj(patch)) return copy(patch);
  const out = isObj(base) ? copy(base) : {};
  for (const [k, v] of Object.entries(patch)) {
    if (isDeleteMarker(v)) delete out[k];
    else if (isObj(v)) out[k] = deepMerge(out[k], v);
    else out[k] = copy(v);
  }
  return out;
}
// canonical JSON (sorted keys) to decide "unchanged"
const canon = (v) => (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : isObj(v) ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v));
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export class VersionConflict extends Error { constructor(c, d, e, a) { super(`version conflict on ${c}/${d}`); Object.assign(this, { collection: c, doc_id: d, expected: e, actual: a }); } }
// docs: {"coll/doc": {version, data}} -> {results, docs} (new object; throws before changing anything)
export function applyBatch(docs, writes) {
  const state = copy(docs), results = [];
  writes.forEach((w, i) => {
    if (!['set', 'update', 'delete'].includes(w.op)) throw new Error(`invalid op in write #${i}`);
    const c = w.collection, d = w.doc_id ?? w.doc ?? w.id;
    if (typeof c !== 'string' || !NAME.test(c) || typeof d !== 'string' || !NAME.test(d)) throw new Error(`invalid name in write #${i}`);
    if (w.op !== 'delete' && !isObj(w.data)) throw new Error(`invalid data in write #${i}`);
    const k = `${c}/${d}`, cur = state[k] || null, ver = cur ? cur.version : 0;
    if (w.if_version != null && w.if_version !== ver) throw new VersionConflict(c, d, w.if_version, ver);
    if (w.op === 'delete') { results.push({ status: cur ? 'deleted' : 'absent', version: ver }); delete state[k]; return; }
    const nd = w.op === 'set' ? stripMarkers(w.data) : deepMerge(cur ? cur.data : {}, w.data);
    if (cur && canon(nd) === canon(cur.data)) { results.push({ status: 'unchanged', version: ver }); return; }
    state[k] = { version: ver + 1, data: nd };
    results.push({ status: cur ? 'updated' : 'created', version: ver + 1 });
  });
  return { results, docs: state };
}

async function unseal(pkcs8, e, label) {
  const priv = await subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const epk = ub64(e.epk);
  const pub = await subtle.importKey('raw', epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: enc.encode(label) }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: ub64(e.iv), additionalData: enc.encode(label) }, key, ub64(e.ct)));
}
async function seal(pubB64, plain, name, label) {
  const site = await subtle.importKey('raw', ub64(pubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const epk = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const shared = await subtle.deriveBits({ name: 'ECDH', public: site }, eph.privateKey, 256);
  const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: enc.encode(label) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(label) }, key, plain));
  return { v: 1, name, bytes: plain.length, epk: b64(epk), iv: b64(iv), ct: b64(ct) };
}

const deq = (a, b) => canon(a) === canon(b);
const [mode, file] = process.argv.slice(2);
if (mode === 'vectors') {
  const V = JSON.parse(fs.readFileSync(file, 'utf8'));
  const fails = [];
  for (const t of V.merge) {
    const b0 = canon(t.base), p0 = canon(t.patch);
    const got = deepMerge(t.base, t.patch);
    if (!deq(got, t.expect) || canon(t.base) !== b0 || canon(t.patch) !== p0) fails.push('merge: ' + t.name);
  }
  for (const t of V.set) if (!deq(stripMarkers(t.data), t.expect)) fails.push('set: ' + t.name);
  for (const t of V.batches) {
    const before = canon(t.docs);
    try {
      const r = applyBatch(t.docs, t.writes);
      if (t.expectError || !deq(r.results, t.expect.results) || !deq(r.docs, t.expect.docs)) fails.push('batch: ' + t.name);
    } catch (e) {
      const x = t.expectError;
      const ok = x && (x.type === 'version_conflict' ? e instanceof VersionConflict && e.collection === x.collection && e.doc_id === x.doc_id && e.expected === x.expected && e.actual === x.actual : !(e instanceof VersionConflict));
      if (!ok) fails.push('batch: ' + t.name);
    }
    if (canon(t.docs) !== before) fails.push('batch mutated its input: ' + t.name);
  }
  console.log(JSON.stringify({ ok: !fails.length, merge: V.merge.length, set: V.set.length, batches: V.batches.length, fails }));
  process.exit(fails.length ? 1 : 0);
} else if (mode === 'crypto') {
  const inp = JSON.parse(fs.readFileSync(0, 'utf8'));
  const plain = await unseal(ub64(inp.pkcs8), inp.envelope, 'portfolio-file-v1');
  const doc = JSON.parse(dec.decode(plain));
  const readOk = deq(doc, inp.plain);
  const next = { version: doc.version + 1, updatedAt: '2026-09-29T12:00:00Z', data: deepMerge(doc.data, { edited: { by: 'browser' } }) };
  const env = await seal(inp.pub, enc.encode(JSON.stringify(next)), inp.envelope.name, 'portfolio-file-v1');
  console.log(JSON.stringify({ readOk, envelope: env, wrote: next }));
} else {
  console.error('usage: node js_compat.mjs vectors <file> | crypto < input.json');
  process.exit(1);
}
