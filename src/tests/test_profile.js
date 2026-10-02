#!/usr/bin/env node
/* engine2.js portfolioRun / friendProfile / profilePeriod: the percentages profile friends see, on the synthetic portfolio
   (fixtures/make_synthetic.js): percentages only (no amount, share count or price anywhere), the same returns as the
   engine, weights that add up, trades in order, and a period compounded from the months.
   node src/tests/test_profile.js      exit 0 = all checks passed */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const PE = require(path.join(__dirname, '..', 'engine.js')); global.PE = PE;
const PA = require(path.join(__dirname, '..', 'engine2.js'));
let fail = 0;
const check = (name, ok, detail) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail != null ? ' · ' + detail : '')); if (!ok) fail++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
cp.execFileSync('node', [path.join(__dirname, 'fixtures', 'make_synthetic.js'), dir], { stdio: 'ignore' });
const out = JSON.parse(cp.execFileSync('node', [path.join(__dirname, '..', 'tools', 'profile.js'), '--data', dir, '--name', 'Demo', '--handle', 'demo', '--today', '2026-09-24']).toString());
const p = out.profile, js = JSON.stringify(p);
check('tools/profile.js builds a profile (v2, name, @username, months, holdings, trades, stats)', out.ok && p.v === 2 && p.name === 'Demo' && p.handle === 'demo' && p.months.length && p.holdings.length && p.trades.length && p.stats);
const allowed = new Set(['v', 'name', 'handle', 'inception', 'asOf', 'bench', 'months', 'holdings', 'sectors', 'cashW', 'trades', 'stats', 'm', 'r', 'b', 'live', 's', 'n', 'sec', 'w', 'ret', 'chg', 'days', 'd', 'side', 'kind', 'closed', 'winRate', 'avgHold', 'best', 'worst', 'maxDD']);
const keys = new Set(); JSON.parse(js, (k, v) => { if (k && isNaN(+k)) keys.add(k); return v; });
check('percentages only: every field is a return, a weight, a name, a date or a count (no amount, share count or price)', [...keys].every((k) => allowed.has(k)), [...keys].filter((k) => !allowed.has(k)).join(','));
const pcts = []; JSON.parse(js, (k, v) => { if (['r', 'b', 'w', 'ret', 'chg', 'cashW', 'winRate', 'best', 'worst', 'maxDD'].includes(k) && typeof v === 'number') pcts.push(v); return v; });
check('every percentage is a fraction (|x| < 10), so no amount hides in one', pcts.length > 10 && pcts.every((x) => Math.abs(x) < 10), String(Math.max(...pcts.map(Math.abs))));
const tw = (p.holdings.reduce((a, h) => a + h.w, 0) + p.cashW);
check('holdings weights plus cash add up to 100%', Math.abs(tw - 1) < 1e-3, tw.toFixed(5));
// the same all-time return as the engine run on the same documents
const docs = {};
for (const c of fs.readdirSync(dir)) { const cd = path.join(dir, c); if (!fs.statSync(cd).isDirectory()) continue; for (const f of fs.readdirSync(cd)) { const x = JSON.parse(fs.readFileSync(path.join(cd, f))); docs[c + '/' + f.slice(0, -5)] = x.data !== undefined && x.id !== undefined ? x.data : x; } }
const run = PA.portfolioRun(docs, null, { today: '2026-09-24' });
const all = PA.profilePeriod(p, { type: 'Since Inception' });
check('All time from the profile equals the engine\'s time-weighted return', Math.abs(all.r - run.R.stats.twr) < 1e-4, `${all.r} vs ${run.R.stats.twr}`);
const ytd = PA.profilePeriod(p, { type: 'Last 12 Months' }), Ry = PA.portfolioRun(docs, { type: 'Last 12 Months' }, { today: '2026-09-24' }).R;
check('Last 12 months from the profile equals the engine\'s', Math.abs(ytd.r - Ry.stats.twr) < 1e-4, `${ytd.r} vs ${Ry.stats.twr}`);
const mo = PA.profilePeriod(p, { type: 'Month', asOf: '2026-08' }), Rm = PA.portfolioRun(docs, { type: 'Month', asOf: '2026-08' }, { today: '2026-09-24' }).R;
check('a single month (Aug 2026) from the profile equals the engine\'s, and differs from all time', Math.abs(mo.r - Rm.stats.twr) < 1e-4 && Math.abs(mo.r - all.r) > 1e-3, `${mo.r} vs ${Rm.stats.twr}`);
check('trades are newest first, each a buy (new / added) or a sale (trimmed / closed)', p.trades.every((t, i) => (i === 0 || t.d <= p.trades[i - 1].d) && ['buy', 'sell'].includes(t.side) && ['new', 'added', 'trimmed', 'closed'].includes(t.kind)));
check('a period with no month in it gives nothing', PA.profilePeriod(p, { type: 'Custom', from: '2020-01', to: '2020-02' }) === null && PA.profilePeriod(null, {}) === null);
// days held count from the buy that opened the current position: sold out and bought back starts again
const rb = { 'portfolio/settings': { name: 'T', inception: '2026-06', cash: 0, openingValue: 0, riskFree: 0.2, fxStart: 50, volLow: 0.02, volHigh: 0.05, openThreshold: 0.5, staleDays: 7 },
  'portfolio/assets': { items: { COMI: { name: 'COMI', symbol: 'COMI', sector: 'Banks' } } }, 'portfolio/marks': { months: {} },
  'ledger/y2026': { rows: [{ id: '1', d: '2026-06-01', t: 'Deposit', amt: 10000 }, { id: '2', d: '2026-06-02', t: 'Buy', a: 'COMI', q: 10, p: 100, amt: -1000 },
    { id: '3', d: '2026-07-20', t: 'Sell', a: 'COMI', q: 10, p: 110, amt: 1100 }, { id: '4', d: '2026-09-20', t: 'Buy', a: 'COMI', q: 10, p: 120, amt: -1200 }] } };
const rbp = PA.friendProfile(PA.portfolioRun(rb, null, { today: '2026-09-27' }), {});
check('days held: a stock sold out and bought back counts from the new buy', rbp.holdings[0].days === 7, String(rbp.holdings[0].days));
fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? `FAIL ${fail}` : 'ALL PASS');
process.exit(fail ? 1 : 0);
