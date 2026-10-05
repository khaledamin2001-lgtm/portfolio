#!/usr/bin/env node
/* The monthly trading report card (engine2.js reportCard): how last month's trading went next to the month before (closed
   trades, win rate, holding days, best and worst trade, the month's return vs the EGX30 Capped, your limits, tips), from an
   export folder. The account job (run_account_mail.py) emails it.
     node report_card.js --data DIR [--overlay <plan dir>/write] --month YYYY-MM [--today YYYY-MM-DD]
   Overlay files (a sync plan's write/ dir) replace the folder's documents as in weekly.js: ledger_yYYYY.json, marks.json,
   settings.json, assets_update.json (merged into assets). Prints one JSON line: {ok, card} or {ok: false, error}. */
'use strict';
const fs = require('fs'), path = require('path');
const PE = require('./engine.js'); global.PE = PE;
const PA = require('./engine2.js');
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
try {
  const dir = arg('data'), M = arg('month'), overlay = arg('overlay');
  if (!dir || !fs.existsSync(path.join(dir, 'portfolio', 'settings.json'))) throw new Error('--data must be an export folder (portfolio/settings.json)');
  if (!/^\d{4}-\d{2}$/.test(M || '')) throw new Error('--month YYYY-MM is required');
  const unwrap = (x) => (x && x.data !== undefined && x.id !== undefined ? x.data : x);
  const docs = {};
  for (const c of fs.readdirSync(dir)) {
    const cd = path.join(dir, c);
    if (!fs.statSync(cd).isDirectory() || c === 'sync') continue;
    for (const f of fs.readdirSync(cd).filter((x) => x.endsWith('.json'))) docs[c + '/' + f.slice(0, -5)] = unwrap(JSON.parse(fs.readFileSync(path.join(cd, f), 'utf8')));
  }
  if (overlay && fs.existsSync(overlay)) for (const f of fs.readdirSync(overlay)) {
    let m; const v = () => unwrap(JSON.parse(fs.readFileSync(path.join(overlay, f), 'utf8')));
    if ((m = f.match(/^ledger_y(\d{4})\.json$/))) docs['ledger/y' + m[1]] = v();
    else if (f === 'marks.json') docs['portfolio/marks'] = v();
    else if (f === 'settings.json') docs['portfolio/settings'] = v();
    else if (f === 'assets_update.json') docs['portfolio/assets'] = { items: { ...((docs['portfolio/assets'] || {}).items || {}), ...(v().items || {}) } };
  }
  const run = PA.portfolioRun(docs, null, { today: arg('today') || undefined });
  if (!run) throw new Error('no portfolio in the folder yet');
  console.log(JSON.stringify({ ok: true, name: (docs['portfolio/settings'] || {}).name || '', card: PA.reportCard(run, M) }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  process.exit(1);
}
