#!/usr/bin/env node
/* The yearly wrap-up (engine2.js yearWrapped): year Y in review, from an export folder: the year's return against the
   EGX30 Capped, best and worst month, every sale (win rate, best and worst), the most traded stock, the longest hold,
   dividends and money in / out. The account job (run_account_mail.py) emails it in the first days of January, with the
   ranking among friends.
     node wrapped.js --data DIR --year YYYY [--today YYYY-MM-DD]
   Prints one JSON line: {ok, name, wrapped} or {ok: false, error}. */
'use strict';
const fs = require('fs'), path = require('path');
const PE = require('./engine.js'); global.PE = PE;
const PA = require('./engine2.js');
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
try {
  const dir = arg('data'), Y = arg('year');
  if (!dir || !fs.existsSync(path.join(dir, 'portfolio', 'settings.json'))) throw new Error('--data must be an export folder (portfolio/settings.json)');
  if (!/^\d{4}$/.test(Y || '')) throw new Error('--year YYYY is required');
  const unwrap = (x) => (x && x.data !== undefined && x.id !== undefined ? x.data : x);
  const docs = {};
  for (const c of fs.readdirSync(dir)) {
    const cd = path.join(dir, c);
    if (!fs.statSync(cd).isDirectory() || c === 'sync') continue;
    for (const f of fs.readdirSync(cd).filter((x) => x.endsWith('.json'))) docs[c + '/' + f.slice(0, -5)] = unwrap(JSON.parse(fs.readFileSync(path.join(cd, f), 'utf8')));
  }
  const run = PA.portfolioRun(docs, null, { today: arg('today') || undefined });
  if (!run) throw new Error('no portfolio in the folder yet');
  console.log(JSON.stringify({ ok: true, name: (docs['portfolio/settings'] || {}).name || '', wrapped: PA.yearWrapped(run, Y) }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  process.exit(1);
}
