/* Engine store write semantics for the live site's editor: the JavaScript copy of src/jobs/store.py deep_merge,
   strip_markers and apply_writes (the in-memory part; lock.js does the reading, encrypting and committing). Pinned by
   src/jobs/merge_vectors.json, checked by src/tests/test_site_store.js. Pure functions, no I/O: build_site.py inlines this
   file before lock.js (window.pdStore); node loads it with require(). */
(function (root) {
  'use strict';
  const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isDel = (v) => isObj(v) && v.__delete__ === true;
  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  class StoreError extends Error { constructor(m) { super(m); this.code = 'invalid'; } }
  class VersionConflict extends Error {
    constructor(collection, docId, expected, actual) {
      super(`version conflict on ${collection}/${docId}: expected ${expected}, found ${actual}`);
      Object.assign(this, { code: 'version_conflict', collection, docId, expected, actual });
    }
  }
  // copy of v with delete-marker keys removed from every (nested) object; arrays are copied verbatim
  function stripMarkers(v) {
    if (!isObj(v)) return copy(v);
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!isDel(x)) o[k] = stripMarkers(x);
    return o;
  }
  // 'update' semantics: objects merge recursively; arrays, scalars and null replace; {"__delete__": true} removes the key
  function deepMerge(base, patch) {
    if (!isObj(patch)) return copy(patch);
    const out = isObj(base) ? copy(base) : {};
    for (const [k, v] of Object.entries(patch)) {
      if (isDel(v)) delete out[k];
      else if (isObj(v)) out[k] = deepMerge(out[k], v);
      else out[k] = copy(v);
    }
    return out;
  }
  // canonical JSON (sorted keys), for "did this write change anything"
  const canon = (v) => (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
    : isObj(v) ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v));
  const checkName = (kind, s) => { if (typeof s !== 'string' || !NAME_RE.test(s)) throw new StoreError(`invalid ${kind} name`); return s; };
  function normWrite(w, i) {
    if (!isObj(w)) throw new StoreError(`write #${i} is not an object`);
    const op = w.op;
    if (!['set', 'update', 'delete'].includes(op)) throw new StoreError(`write #${i}: op must be set, update or delete`);
    const c = checkName('collection', w.collection), d = checkName('doc', w.doc_id != null ? w.doc_id : w.doc != null ? w.doc : w.id);
    if (op !== 'delete' && !isObj(w.data)) throw new StoreError(`write #${i} (${c}/${d}): data must be an object`);
    const iv = w.if_version;
    if (iv != null && !(Number.isInteger(iv) && iv >= 0)) throw new StoreError(`write #${i} (${c}/${d}): if_version must be a non-negative integer`);
    return { op, c, d, data: w.data, iv };
  }
  /* Apply writes IN ORDER as one all-or-nothing batch over the current documents.
     readDoc(collection, docId) -> {version, updatedAt, data} | null (may be async; called once per document).
     Returns {results: [{collection, doc_id, op, status, version}], plan: [{collection, doc_id, action: 'put'|'rm', doc}]};
     plan lists only the documents whose final state differs from their starting state. Throws StoreError/VersionConflict
     before anything is planned. */
  async function applyWrites(writes, readDoc, now) {
    if (!Array.isArray(writes)) throw new StoreError('writes must be a list');
    const ts = now || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const norm = writes.map(normWrite);
    const state = new Map(), orig = new Map(), results = [];
    for (const { op, c, d, data, iv } of norm) {
      const k = c + '/' + d;
      if (!state.has(k)) {
        const doc = await readDoc(c, d);
        state.set(k, doc ? { version: doc.version, updatedAt: doc.updatedAt, data: doc.data } : null);
        orig.set(k, doc ? doc.version + ' ' + canon(doc.data) : null);
      }
      const cur = state.get(k), curVer = cur ? cur.version : 0;
      if (iv != null && iv !== curVer) throw new VersionConflict(c, d, iv, curVer);
      if (op === 'delete') {
        if (!cur) results.push({ collection: c, doc_id: d, op, status: 'absent', version: 0 });
        else { state.set(k, null); results.push({ collection: c, doc_id: d, op, status: 'deleted', version: curVer }); }
        continue;
      }
      const nw = op === 'set' ? stripMarkers(data) : deepMerge(cur ? cur.data : {}, data);
      if (cur && canon(nw) === canon(cur.data)) { results.push({ collection: c, doc_id: d, op, status: 'unchanged', version: curVer }); continue; }
      state.set(k, { version: curVer + 1, updatedAt: ts, data: nw });
      results.push({ collection: c, doc_id: d, op, status: cur ? 'updated' : 'created', version: curVer + 1 });
    }
    const plan = [];
    for (const [k, doc] of state) {
      const o = orig.get(k), [collection, doc_id] = k.split('/');
      if (!doc) { if (o != null) plan.push({ collection, doc_id, action: 'rm', doc: null }); }
      else if (o == null || o !== doc.version + ' ' + canon(doc.data)) plan.push({ collection, doc_id, action: 'put', doc });
    }
    return { results, plan };
  }
  /* Three-way merge for a whole-document save made from a possibly older copy. The page replaces a whole document (set) built
     from what it showed (base); the engine may hold a newer version (theirs), e.g. prices the market job wrote since. Keep
     every change the page made (base -> target) and every change it did not touch from theirs. Objects merge key by key;
     arrays of objects that all carry a unique "id" (ledger rows) merge row by row (rows the page removed go, rows it edited
     or added win, rows added elsewhere stay); any other value the page changed replaces theirs. theirs == base -> target. */
  const idList = (a) => Array.isArray(a) && a.every((x) => isObj(x) && typeof x.id === 'string' && x.id) && new Set(a.map((x) => x.id)).size === a.length;
  function rebase(base, target, theirs) {
    target = stripMarkers(target);
    if (canon(theirs) === canon(base)) return target;
    if (isObj(base) && isObj(target) && isObj(theirs)) {
      const out = copy(theirs);
      for (const k of new Set([...Object.keys(base), ...Object.keys(target)])) {
        if (!(k in target)) { delete out[k]; continue; }
        if (!(k in base)) { out[k] = copy(target[k]); continue; }
        if (canon(base[k]) === canon(target[k])) continue;
        out[k] = k in theirs ? rebase(base[k], target[k], theirs[k]) : copy(target[k]);
      }
      return out;
    }
    if (idList(base) && idList(target) && idList(theirs)) {
      const b = new Map(base.map((x) => [x.id, x])), t = new Map(target.map((x) => [x.id, x])), th = new Set(theirs.map((x) => x.id)), out = [];
      for (const x of theirs) {
        if (b.has(x.id) && !t.has(x.id)) continue;
        out.push(copy(t.has(x.id) && b.has(x.id) && canon(t.get(x.id)) !== canon(b.get(x.id)) ? t.get(x.id) : x));
      }
      for (const x of target) if (!b.has(x.id) && !th.has(x.id)) out.push(copy(x));
      return out;
    }
    return target;
  }
  const api = Object.freeze({ NAME_RE, stripMarkers, deepMerge, canon, rebase, applyWrites, StoreError, VersionConflict });
  if (typeof module === 'object' && module.exports) module.exports = api; else root.pdStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
