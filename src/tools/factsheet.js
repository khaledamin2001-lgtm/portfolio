#!/usr/bin/env node
/* Render a monthly factsheet with the page's own code.
   node factsheet.js --page <published page html> --data <ArtifactData export dir> [--overlay <plan dir>/write] --month YYYY-MM --out <file.html>
   The page runs headless with its database replaced by the exported documents (plus any planned writes). */
'use strict';
const fs = require('fs'), path = require('path');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? a.concat([[x.slice(2), arr[i + 1]]]) : a), []));
const J = (f) => { const x = JSON.parse(fs.readFileSync(f)); return x.data || x; };
let playwright; for (const p of [__dirname, path.join(__dirname, 'node_modules'), require('child_process').execSync('npm root -g').toString().trim()]) { try { playwright = require(require.resolve('playwright', { paths: [p] })); break; } catch (e) {} }
const docs = {}, cols = {};
for (const c of fs.readdirSync(args.data)) {
  const d = path.join(args.data, c); if (!fs.statSync(d).isDirectory()) continue;
  cols[c] = {};
  for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) { const id = f.replace('.json', ''); const v = J(path.join(d, f)); cols[c][id] = v; docs[`${c}/${id}`] = v; }
}
if (args.overlay && fs.existsSync(args.overlay)) for (const f of fs.readdirSync(args.overlay)) {
  const v = J(path.join(args.overlay, f)); let m;
  if ((m = f.match(/^ledger_(y\d{4})\.json$/))) { cols.ledger[m[1]] = v; docs[`ledger/${m[1]}`] = v; }
  else if (f === 'marks.json') docs['portfolio/marks'] = v;
  else if (f === 'assets_update.json') docs['portfolio/assets'] = { items: { ...(docs['portfolio/assets'] || {}).items, ...v.items } };
  else if ((m = f.match(/^import_(.+)\.json$/))) { (cols.imports || (cols.imports = {}))[m[1]] = v; }
}
const mock = `<script>window.claude={use:async(n)=>{ if(n!=='db') return null; const D=${JSON.stringify(docs)}, C=${JSON.stringify(cols)};
 const snap=(id,d)=>({id,exists:!!d,data:()=>d,metadata:{}});
 return {doc:(p)=>({onSnapshot:(f)=>{setTimeout(()=>f(snap(p.split('/')[1],D[p])),10);return()=>{}}}),
  collection:(p)=>({onSnapshot:(f)=>{const docs=Object.entries(C[p]||{}).map(([k,v])=>snap(k,v));setTimeout(()=>f({docs,size:docs.length,empty:!docs.length}),10);return()=>{}}})};}};</script>`;
let page = fs.readFileSync(args.page, 'utf8');
page = page.replace(/^<!doctype html><html><head>[\s\S]*?<\/head><body>/i, '');
if (!page.includes('async function emailFactsheet(m, quiet){')) throw new Error('page layout changed: factsheet hook not found');
page = page.replace('async function emailFactsheet(m, quiet){', 'window.__fs=(m)=>factsheetHTML(factsheetData(m));\nasync function emailFactsheet(m, quiet){');
const tmp = path.join(path.dirname(args.out), '_factsheet_page.html');
fs.writeFileSync(tmp, '<!doctype html><html><head><meta charset="utf-8"></head><body>' + mock + page + '</body></html>');
(async () => {
  const b = await playwright.chromium.launch(); const p = await b.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('file://' + path.resolve(tmp)); await p.waitForFunction(() => window.__fs && document.querySelector('#main section'), null, { timeout: 30000 });
  const html = await p.evaluate((m) => window.__fs(m), args.month);
  await b.close();
  if (errs.length) throw new Error('page errors: ' + errs.join('; '));
  const doc = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;background:#EDF2EF">${html}</body></html>`.replace(/>\s+</g, '><');
  fs.writeFileSync(args.out, doc);
  console.log(JSON.stringify({ ok: true, out: args.out, bytes: doc.length }));
})().catch((e) => { console.error(e); process.exit(1); });
