#!/usr/bin/env node
/* The percentages profile a portfolio shares with friends (engine2.js friendProfile: returns, weights, trades as %, never an
   amount), built from an export folder the way the site builds it from the open portfolio. The email job seals it to
   each friend's key (jobs/run_account_mail.py share_to_friends) and reads friends' months from it for the leaderboard.
     node profile.js --data DIR [--name NAME] [--handle H] [--today YYYY-MM-DD]
   Prints one JSON line: {ok, profile} or {ok: false, error}. */
'use strict';
const fs = require('fs'), path = require('path');
const PE = require('./engine.js'); global.PE = PE;
const PA = require('./engine2.js');
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
try {
  const dir = arg('data');
  if (!dir || !fs.existsSync(path.join(dir, 'portfolio', 'settings.json'))) throw new Error('--data must be an export folder (portfolio/settings.json)');
  // every <coll>/<doc>.json of the folder, as the site's {"coll/doc": data}
  const docs = {};
  for (const c of fs.readdirSync(dir)) {
    const cd = path.join(dir, c);
    if (!fs.statSync(cd).isDirectory() || c === 'sync') continue;
    for (const f of fs.readdirSync(cd).filter((x) => x.endsWith('.json'))) { const x = JSON.parse(fs.readFileSync(path.join(cd, f), 'utf8')); docs[c + '/' + f.slice(0, -5)] = x && x.data !== undefined && x.id !== undefined ? x.data : x; }
  }
  const run = PA.portfolioRun(docs, null, { today: arg('today') || undefined });
  if (!run) throw new Error('no portfolio in the folder yet');
  const info = {}; if (arg('name')) info.name = arg('name'); if (arg('handle')) info.handle = arg('handle');
  console.log(JSON.stringify({ ok: true, profile: PA.friendProfile(run, info) }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  process.exit(1);
}
