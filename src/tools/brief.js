#!/usr/bin/env node
/* The morning brief (engine2.js morningBrief), from an export folder: the last session (value, P/L, the index), every
   holding's move, ex-dividend and earnings dates in the next 7 days for held and watch-list stocks, holdings near their
   target or stop, unusual volume, your limits and what a 5% index drop would likely do. jobs/run_morning.py emails it
   before the EGX opens (Sunday to Thursday), to the owner and to the site accounts that switched it on.
     node brief.js --data DIR [--today YYYY-MM-DD]
   Prints one JSON line: {ok, name, brief} or {ok: false, error}. */
'use strict';
const fs = require('fs'), path = require('path');
const PE = require('./engine.js'); global.PE = PE;
const PA = require('./engine2.js');
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
try {
  const dir = arg('data');
  if (!dir || !fs.existsSync(path.join(dir, 'portfolio', 'settings.json'))) throw new Error('--data must be an export folder (portfolio/settings.json)');
  const unwrap = (x) => (x && x.data !== undefined && x.id !== undefined ? x.data : x);
  const docs = {};
  for (const c of fs.readdirSync(dir)) {
    const cd = path.join(dir, c);
    if (!fs.statSync(cd).isDirectory() || c === 'sync') continue;
    for (const f of fs.readdirSync(cd).filter((x) => x.endsWith('.json'))) docs[c + '/' + f.slice(0, -5)] = unwrap(JSON.parse(fs.readFileSync(path.join(cd, f), 'utf8')));
  }
  const today = arg('today') || undefined;
  const run = PA.portfolioRun(docs, null, { today });
  if (!run) throw new Error('no portfolio in the folder yet');
  console.log(JSON.stringify({ ok: true, name: (docs['portfolio/settings'] || {}).name || '', brief: PA.morningBrief(run, { today: run.today }) }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  process.exit(1);
}
