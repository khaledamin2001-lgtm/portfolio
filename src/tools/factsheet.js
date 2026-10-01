#!/usr/bin/env node
/* Render a monthly factsheet with the page's own code.
   node factsheet.js --page <published page html> --data <ArtifactData export dir> [--overlay <plan dir>/write] --month YYYY-MM --out <file.html> [--pdf <file.pdf>] [--summary <file.json>]
   The page runs headless with its database replaced by the exported documents (plus any planned writes).
   --out writes the email HTML; --pdf also prints that same HTML to an A4 PDF (Playwright page.pdf, backgrounds on,
   12 mm margins). At least one of the two is required. --summary also writes the headline figures (value, month / year /
   since-inception returns and the index's, top holdings, cash weight, the month's income) for the phone-sized email. */
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
page = page.replace('async function emailFactsheet(m, quiet){', 'window.__fs=(m)=>factsheetHTML(factsheetData(m));\n' +
  'window.__fsum=(m)=>{const F=factsheetData(m),st=F.st||{},c=(F.sectors||[]).find((x)=>x.s===\'Cash & Savings\');return {name:S.settings.name,month:m,live:!!F.live,inception:S.settings.inception,value:F.value,' +
  'monthRet:F.row?F.row.ret:null,monthBench:F.row?F.row.bench:null,ytd:F.tr&&F.tr[3]?F.tr[3].p:null,ytdBench:F.tr&&F.tr[3]?F.tr[3].b:null,si:st.twr,siBench:st.benchTwr,annualized:st.annualized,' +
  'top:(F.top||[]).slice(0,5).map((r)=>({symbol:r.symbol||null,name:r.name,w:r.w})),cashW:c?c.p:0,income:F.incM};};\n' +
  'async function emailFactsheet(m, quiet){');
if (!args.out && !args.pdf) throw new Error('give --out <file.html> and/or --pdf <file.pdf>');
const tmp = path.join(path.dirname(args.out || args.pdf), '_factsheet_page.html');
fs.writeFileSync(tmp, '<!doctype html><html><head><meta charset="utf-8"></head><body>' + mock + page + '</body></html>');
(async () => {
  const b = await playwright.chromium.launch(); const p = await b.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('file://' + path.resolve(tmp)); await p.waitForFunction(() => window.__fs && document.querySelector('#main section'), null, { timeout: 30000 });
  const html = await p.evaluate((m) => window.__fs(m), args.month);
  if (errs.length) { await b.close(); throw new Error('page errors: ' + errs.join('; ')); }
  const doc = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;background:#EDF2EF">${html}</body></html>`.replace(/>\s+</g, '><');
  const res = { ok: true };
  if (args.summary) { fs.writeFileSync(args.summary, JSON.stringify(await p.evaluate((m) => window.__fsum(m), args.month))); res.summary = args.summary; }
  if (args.out) { fs.writeFileSync(args.out, doc); Object.assign(res, { out: args.out, bytes: doc.length }); }
  if (args.pdf) {
    // the same HTML, printed: the email's 16px page padding and grey page background are dropped (the PDF has its own
    // 12 mm white margins), colours kept, table rows never split across pages.
    // The email is laid out for up to 760px but A4 minus margins is 703 CSS px: measure the content at a wide viewport and
    // scale the print down so it keeps the email's layout (no table spilling past the card).
    const q = await b.newPage({ viewport: { width: 1000, height: 1400 } });
    await q.setContent(doc.replace('<head>', '<head><style>tr,img{break-inside:avoid}</style>').replace(/<body style="margin:0;padding:16px;background:#[0-9A-Fa-f]{3,6}/, '<body style="margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact'), { waitUntil: 'load' });
    const width = await q.evaluate(() => { const c = document.body.firstElementChild, l = c.getBoundingClientRect().left; return Math.max(c.offsetWidth, ...[...c.querySelectorAll('*')].map((e) => e.getBoundingClientRect().right - l)); });
    const printable = (210 - 24) / 25.4 * 96, scale = Math.max(0.5, Math.min(1, Math.floor(printable / width * 1000) / 1000));
    const pdf = await q.pdf({ path: args.pdf, format: 'A4', printBackground: true, scale, margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' } });
    Object.assign(res, { pdf: args.pdf, pdfBytes: pdf.length, scale, contentWidth: Math.round(width), pages: (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length });
  }
  await b.close();
  fs.rmSync(tmp, { force: true });
  console.log(JSON.stringify(res));
})().catch((e) => { console.error(e); process.exit(1); });
