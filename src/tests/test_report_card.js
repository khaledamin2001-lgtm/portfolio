#!/usr/bin/env node
/* engine2.js reportCard (tools/report_card.js): the monthly trading report card. Every sale counts, a part sale too, its
   result over the average cost of the shares sold; cash-like funds are left out; the month next to the one before; best and
   worst sale; plain tips from the numbers. On the synthetic portfolio through the tool, then on a small hand-made ledger.
   node src/tests/test_report_card.js      exit 0 = all checks passed */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const PE = require(path.join(__dirname, '..', 'engine.js')); global.PE = PE;
const PA = require(path.join(__dirname, '..', 'engine2.js'));
let fail = 0;
const check = (name, ok, detail) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail != null ? ' · ' + detail : '')); if (!ok) fail++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-'));
cp.execFileSync('node', [path.join(__dirname, 'fixtures', 'make_synthetic.js'), dir], { stdio: 'ignore' });
const card = (m) => JSON.parse(cp.execFileSync('node', [path.join(__dirname, '..', 'tools', 'report_card.js'), '--data', dir, '--month', m, '--today', '2026-09-30']).toString().trim().split('\n').pop());
const o = card('2026-09'), c = o.card;
check('tools/report_card.js: a card for the month and the one before', o.ok && o.name === 'Demo Portfolio' && c.month === '2026-09' && c.prevMonth === '2026-08');
check('the synthetic September: one part sale (TMGH), at a profit, held from its first buy', c.cur && c.cur.n === 1 && c.cur.wins === 1 && c.best.s === 'TMGH' && c.best.kind === 'trimmed' && c.best.days > 0 && c.worst === null, JSON.stringify(c.best));
// the sale's result is the ledger's own: amount over the basis of the shares sold
const docs = {};
for (const k of fs.readdirSync(dir)) { const cd = path.join(dir, k); if (!fs.statSync(cd).isDirectory()) continue; for (const f of fs.readdirSync(cd)) { const x = JSON.parse(fs.readFileSync(path.join(cd, f))); docs[k + '/' + f.slice(0, -5)] = x.data !== undefined && x.id !== undefined ? x.data : x; } }
const run = PA.portfolioRun(docs, null, { today: '2026-09-30' });
const sale = run.R.ledger.find((t) => t.t === 'Sell' && t.d === c.best.d && t.a === c.best.n);
check('a sale\'s return is its amount over the average cost of the shares sold', sale && Math.abs(c.best.roi - (sale.amt - sale.basis) / sale.basis) < 1e-9 && Math.abs(c.best.pl - (sale.amt - sale.basis)) < 1e-6);
const m = run.R.months.find((r) => r.month === '2026-09');
check('the month\'s return and the index\'s are the engine\'s', Math.abs(c.ret - m.ret) < 1e-12 && Math.abs(c.bench - m.bench) < 1e-12 && c.provisional === !!(m.provisional || m.live || m.estimate));
check('activity: buys and sales of stocks, money in and out', c.activity.buys === run.R.ledger.filter((t) => t.t === 'Buy' && t.d.startsWith('2026-09') && !/Cash|Mutual/.test((docs['portfolio/assets'].items[t.a] || {}).sector || '')).length && c.activity.withdrawals === 5000, JSON.stringify(c.activity));
const a = card('2026-08').card;
check('a month without sales: no score, and it says so', a.cur === null && a.best === null && /sold nothing/.test(a.tips[0]));

// a small hand-made month: three sales, two at a loss held long, a fund sale that must not count
const L = [
  { d: '2026-05-03', t: 'Buy', a: 'Alpha', q: 100, amt: -1000 }, { d: '2026-05-04', t: 'Buy', a: 'Beta', q: 100, amt: -1000 },
  { d: '2026-07-01', t: 'Buy', a: 'Gamma', q: 100, amt: -1000 }, { d: '2026-07-02', t: 'Buy', a: 'Fund', q: 10, amt: -1000 },
  { d: '2026-07-20', t: 'Sell', a: 'Gamma', q: 100, amt: 1100, basis: 1000 },                     // +10%, 19 days
  { d: '2026-08-10', t: 'Sell', a: 'Alpha', q: 100, amt: 700, basis: 1000 },                      // −30%, 99 days
  { d: '2026-08-12', t: 'Sell', a: 'Beta', q: 50, amt: 450, basis: 500 },                         // −10%, 100 days, part sale
  { d: '2026-08-15', t: 'Sell', a: 'Fund', q: 10, amt: 1200, basis: 1000 },                       // a fund: not a trade
  { d: '2026-08-20', t: 'Buy', a: 'Gamma', q: 100, amt: -1000 }, { d: '2026-08-28', t: 'Sell', a: 'Gamma', q: 100, amt: 1050, basis: 1000 },   // +5%, 8 days
];
const fake = { R: { ledger: L, settings: { openThreshold: 0.5, limits: { on: true, stock: 0.2 } }, pos: { open: [{ name: 'Beta', symbol: 'BETA', sector: 'Banks', mv: 600 }], mvTotal: 600 }, liveCash: 400,
  months: [{ month: '2026-08', has: true, ret: -0.04, bench: 0.02 }, { month: '2026-07', has: true, ret: 0.03, bench: 0.01 }] },
  data: { assets: { Alpha: { name: 'Alpha', symbol: 'ALP', sector: 'Banks' }, Beta: { name: 'Beta', symbol: 'BETA', sector: 'Banks' }, Gamma: { name: 'Gamma', symbol: 'GAM', sector: 'Real Estate' }, Fund: { name: 'Fund', symbol: 'FND', sector: 'Mutual Funds' } } } };
const h = PA.reportCard(fake, '2026-08');
check('every sale counts (a part sale too), a cash-like fund does not', h.cur.n === 3 && h.cur.wins === 1 && h.cur.losses === 2 && Math.abs(h.cur.pl - (-300 - 50 + 50)) < 1e-9, JSON.stringify(h.cur));
check('holding days from the buy that opened the position (a new trip restarts the clock)', h.best.s === 'GAM' && h.best.days === 8 && h.worst.s === 'ALP' && h.worst.days === 99 && Math.abs(h.cur.holdLoss - 99.5) < 1e-9);
check('the month before: one sale, a win', h.prev.n === 1 && h.prev.winRate === 1 && Math.abs(h.prev.avgRoi - 0.1) < 1e-9);
check('tips: losers held longer than winners, the index did better, a limit crossed', h.tips.some((t) => /held the losing sales 100 days on average and the winners 8/.test(t))
  && h.tips.some((t) => /index did better this month: the EGX30 Capped \+2%, the portfolio −4%/.test(t)) && h.tips.some((t) => /1 of your limits is crossed right now: BETA 60%/.test(t)), JSON.stringify(h.tips));
check('activity counts stock buys and sales only', h.activity.buys === 1 && h.activity.sells === 3, JSON.stringify(h.activity));
fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? `FAIL ${fail}` : 'ALL PASS');
process.exit(fail ? 1 : 0);
