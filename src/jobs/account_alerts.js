#!/usr/bin/env node
/* Heads-up items for one portfolio from a data folder, for the account email job (run_account_mail.py).
     node account_alerts.js --data <dir> [--today YYYY-MM-DD]
   <dir> holds <collection>/<doc>.json files (raw data or {data}): portfolio/settings, assets, marks, ledger/y*, market/latest,
   history/*. Prints ONE JSON line: {ok, items: [{kind, key, text}], drawdown, errors} from engine2.js PA.headsUp — the same
   checks the page shows live and the inbox job emails (ex-dividend within a week, target / stop reached, a stock or
   sector over the account's own limit, more than 10% below the 12-month high). Exit 1 on bad arguments or unreadable data. */
'use strict';
const fs = require('fs'), path = require('path');
const TOOLS = path.join(__dirname, '..', 'tools');
const PA = require(path.join(TOOLS, 'engine2.js'));
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const dir = arg('--data');
if (!dir) { console.log(JSON.stringify({ ok: false, error: 'usage: account_alerts.js --data <dir> [--today YYYY-MM-DD]' })); process.exit(1); }
const today = arg('--today') || new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
const load = (c, d) => { const p = path.join(dir, c, d + '.json'); if (!fs.existsSync(p)) return null; const x = JSON.parse(fs.readFileSync(p, 'utf8')); return x && x.data && typeof x.data === 'object' ? x.data : x; };
const coll = (c) => (fs.existsSync(path.join(dir, c)) ? fs.readdirSync(path.join(dir, c)).filter((f) => f.endsWith('.json')).sort().map((f) => [f.slice(0, -5), load(c, f.slice(0, -5))]) : []);
try {
  const tx = [];
  coll('ledger').forEach(([, d]) => ((d && d.rows) || []).forEach((r) => tx.push(r)));
  const history = Object.fromEntries(coll('history'));
  const r = PA.headsUp({ today, tx, assets: (load('portfolio', 'assets') || {}).items || {}, settings: load('portfolio', 'settings'),
    marks: (load('portfolio', 'marks') || {}).months || {}, market: load('market', 'latest'), history });
  console.log(JSON.stringify({ ok: true, today, items: r.items, drawdown: r.drawdown, errors: r.errors }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  process.exit(1);
}
