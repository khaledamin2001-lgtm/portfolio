#!/usr/bin/env node
/* The site editor's write semantics (src/site/store.js) against the shared vectors src/jobs/merge_vectors.json, the same file
   src/tests/test_store.py runs against src/jobs/store.py. Results are compared with order-insensitive deep equality.
     node src/tests/test_site_store.js        exit 0 = every vector passed */
'use strict';
const path = require('path');
const S = require(path.join(__dirname, '..', 'site', 'store.js'));
const V = require(path.join(__dirname, '..', 'jobs', 'merge_vectors.json'));
let pass = 0, fail = 0;
const eq = (a, b) => S.canon(a) === S.canon(b);
const check = (name, ok, detail) => { if (ok) pass++; else { fail++; console.log('FAIL ' + name + (detail ? ' · ' + detail : '')); } };
const clone = (x) => JSON.parse(JSON.stringify(x));

for (const t of V.merge) {
  const base = clone(t.base), patch = clone(t.patch);
  const got = S.deepMerge(base, patch);
  check('merge: ' + t.name, eq(got, t.expect), JSON.stringify(got));
  check('merge leaves inputs alone: ' + t.name, eq(base, t.base) && eq(patch, t.patch));
}
for (const t of V.set) {
  const got = S.stripMarkers(clone(t.data));
  check('set: ' + t.name, eq(got, t.expect), JSON.stringify(got));
}
// rebase(base, target, theirs): a whole-document save made from an older copy keeps what changed elsewhere meanwhile
const R = [
  ['nothing changed elsewhere: the save is taken as is', { a: 1, b: { x: 1 } }, { a: 2, c: 3 }, { a: 1, b: { x: 1 } }, { a: 2, c: 3 }],
  ['a key changed elsewhere and not by the page stays', { s: { rf: 0.2, fx: 50 } }, { s: { rf: 0.25, fx: 50 } }, { s: { rf: 0.2, fx: 51 } }, { s: { rf: 0.25, fx: 51 } }],
  ['a key added elsewhere stays', { items: { A: { n: 1 } } }, { items: { A: { n: 2 } } }, { items: { A: { n: 1, px: 9 }, B: { n: 5 } } }, { items: { A: { n: 2, px: 9 }, B: { n: 5 } } }],
  ['a key the page removed goes', { items: { A: 1, B: 2 } }, { items: { A: 1 } }, { items: { A: 1, B: 2, C: 3 } }, { items: { A: 1, C: 3 } }],
  ['the page wins on a key both changed', { a: 1 }, { a: 2 }, { a: 3 }, { a: 2 }],
  ['ledger rows: a row added elsewhere survives the page deleting another', { rows: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }] }, { rows: [{ id: 'a', v: 1 }] },
    { rows: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'c', v: 3 }] }, { rows: [{ id: 'a', v: 1 }, { id: 'c', v: 3 }] }],
  ['ledger rows: edits and additions from both sides', { rows: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }] }, { rows: [{ id: 'a', v: 10 }, { id: 'b', v: 2 }, { id: 'n', v: 7 }] },
    { rows: [{ id: 'a', v: 1 }, { id: 'b', v: 20 }, { id: 'c', v: 3 }] }, { rows: [{ id: 'a', v: 10 }, { id: 'b', v: 20 }, { id: 'c', v: 3 }, { id: 'n', v: 7 }] }],
  ['plain arrays replace', { seen: ['x'] }, { seen: ['x', 'y'] }, { seen: ['x', 'z'] }, { seen: ['x', 'y'] }],
  ['delete markers in the save are dropped', { a: 1 }, { a: 1, b: { __delete__: true } }, { a: 1, c: 2 }, { a: 1, c: 2 }],
];
for (const [name, base, target, theirs, expect] of R) {
  const args = clone([base, target, theirs]);
  const got = S.rebase(...args);
  check('rebase: ' + name, eq(got, expect), JSON.stringify(got));
  check('rebase leaves inputs alone: ' + name, eq(args, [base, target, theirs]));
}
// with no change elsewhere, a rebased save equals the plain save for every merge vector's result
for (const t of V.merge) check('rebase identity: ' + t.name, eq(S.rebase(t.base, t.expect, clone(t.base)), S.stripMarkers(t.expect)));
(async () => {
  for (const t of V.batches) {
    const docs = clone(t.docs), before = clone(t.docs);
    const read = async (c, d) => (docs[c + '/' + d] ? { version: docs[c + '/' + d].version, updatedAt: 'x', data: clone(docs[c + '/' + d].data) } : null);
    let out, err;
    try { out = await S.applyWrites(clone(t.writes), read, '2026-09-29T10:00:00Z'); } catch (e) { err = e; }
    if (t.expectError) {
      const x = t.expectError;
      const ok = !!err && err.code === x.type && (x.type !== 'version_conflict' || (err.collection === x.collection && err.docId === x.doc_id && err.expected === x.expected && err.actual === x.actual));
      check('batch error: ' + t.name, ok, err ? err.code + ' ' + err.message : 'no error');
      check('batch error leaves docs alone: ' + t.name, eq(docs, before));
      continue;
    }
    if (err) { check('batch: ' + t.name, false, 'raised ' + err.message); continue; }
    check('batch results: ' + t.name, eq(out.results.map((r) => ({ status: r.status, version: r.version })), t.expect.results), JSON.stringify(out.results));
    const fin = clone(docs);
    for (const p of out.plan) { const k = p.collection + '/' + p.doc_id; if (p.action === 'rm') delete fin[k]; else fin[k] = { version: p.doc.version, data: p.doc.data }; }
    check('batch docs: ' + t.name, eq(fin, t.expect.docs), JSON.stringify(fin));
    const touched = new Set(out.plan.map((p) => p.collection + '/' + p.doc_id));
    for (const k of Object.keys(before)) if (!touched.has(k)) check('batch leaves untouched docs alone: ' + t.name + ' ' + k, eq(fin[k], before[k]));
  }
  console.log(`test_site_store.js: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
