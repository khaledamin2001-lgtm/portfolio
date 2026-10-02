#!/usr/bin/env node
/* engine2.js volumeSpikes (the "unusual volume" heads-up), riskModel (correlation, beta, stress test) and morningBrief
   (tools/brief.js): on a small hand-made history whose answers are known, then on the synthetic portfolio.
   node src/tests/test_brief.js      exit 0 = all checks passed */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const PE = require(path.join(__dirname, '..', 'engine.js')); global.PE = PE;
const PA = require(path.join(__dirname, '..', 'engine2.js'));
let fail = 0;
const check = (name, ok, detail) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail != null ? ' · ' + detail : '')); if (!ok) fail++; };

// ---- unusual volume: held and watch-list stocks, 3x the 30-session average, the latest session only
const assets = { A: { name: 'A', symbol: 'AAA', sector: 'Banks' }, B: { name: 'B', symbol: 'BBB', sector: 'Banks', watch: true }, C: { name: 'C', symbol: 'CCC', sector: 'Banks' }, D: { name: 'D', symbol: 'DDD', sector: 'Banks' } };
const tx = [{ d: '2026-09-01', t: 'Buy', a: 'A', q: 100, amt: -1000 }, { d: '2026-09-01', t: 'Buy', a: 'D', q: 100, amt: -1000 }];
const quotes = { AAA: { vol: 3.2e6, avgVol: 1e6, date: '2026-10-01', chg: 2.5 }, BBB: { vol: 5e6, avgVol: 1e6, date: '2026-10-01', chg: -1 }, CCC: { vol: 9e6, avgVol: 1e6, date: '2026-10-01', chg: 0 },
  DDD: { vol: 2.9e6, avgVol: 1e6, date: '2026-10-01', chg: 0 } };
const v = PA.volumeSpikes(tx, assets, quotes, '2026-10-02');
check('volume: held (AAA) and watch-list (BBB) stocks at 3x or more, biggest first; not a stock you neither hold nor watch (CCC), not under 3x (DDD)',
  JSON.stringify(v.map((x) => [x.s, x.held])) === JSON.stringify([['BBB', false], ['AAA', true]]), JSON.stringify(v));
check('volume: an old session is not news', PA.volumeSpikes(tx, assets, { AAA: { ...quotes.AAA, date: '2026-09-20' } }, '2026-10-02').length === 0);
const hu = PA.headsUp({ today: '2026-10-02', tx, assets, settings: null, marks: {}, market: { quotes }, history: {} });
const vi = hu.items.filter((i) => i.kind === 'volume');
check('volume: heads-up items with a key per stock and session, in plain words', vi.length === 2 && vi[1].key === 'volume:AAA:2026-10-01' && /^AAA traded 3\.2× its usual volume on 1 Oct: 3\.2M shares vs 1\.0M a day, \+2\.5% that day$/.test(vi[1].text) && /BBB \(watch list\)/.test(vi[0].text), JSON.stringify(vi));

// ---- the risk model on a made-up history: X moves exactly 2x the index, Y exactly -1x, Z unrelated noise
const days = {}, ixs = [], rnd = (i) => Math.sin(i * 12.9898) * 43758.5453 % 1;
let I = 1000, X = 100, Y = 100, Z = 100;
for (let i = 0; i < 80; i++) {
  const d = new Date(Date.UTC(2026, 4, 1) + i * 864e5).toISOString().slice(0, 10), r = (rnd(i) - 0.5) * 0.04;
  if (i) { I *= 1 + r; X *= 1 + 2 * r; Y *= 1 - r; Z *= 1 + (rnd(i + 1000) - 0.5) * 0.04; ixs.push(r); }
  days[d] = { EGX30CAPPED: I, XX: X, YY: Y, ZZ: Z };
}
const history = { '2026-05': { days } };
const R = { liveCash: 1000, settings: {}, pos: { mvTotal: 3000, open: [{ name: 'X', symbol: 'XX', sector: 'Banks', mv: 1000 }, { name: 'Y', symbol: 'YY', sector: 'Telecom', mv: 1000 }, { name: 'Z', symbol: 'ZZ', sector: 'Food', mv: 1000 }] } };
const K = PA.riskModel(R, {}, history, { days: 60 });
const h = Object.fromEntries(K.holdings.map((x) => [x.s, x]));
check('risk: the last 60 sessions; beta 2 for a stock that moves twice the index, −1 for one that moves against it', K.days === 60 && Math.abs(h.XX.beta - 2) < 1e-9 && Math.abs(h.YY.beta + 1) < 1e-9 && Math.abs(h.ZZ.beta) < 0.5, JSON.stringify(K.holdings.map((x) => [x.s, x.beta])));
check('risk: correlation 1 with the index for X, −1 for Y; X and Y move exactly opposite', Math.abs(h.XX.corrIdx - 1) < 1e-9 && Math.abs(h.YY.corrIdx + 1) < 1e-9 && Math.abs(K.corr.m[0][1] + 1) < 1e-9 && K.pairs[K.pairs.length - 1].c < -0.99);
check('risk: the portfolio beta is the weighted betas, cash counting as 0 (a quarter each)', Math.abs(K.beta - (2 - 1 + h.ZZ.beta) / 4) < 1e-9 && Math.abs(K.total - 4000) < 1e-9);
check('risk: a 10% index drop: portfolio beta × 10%, each stock its own beta × 10% of its money', Math.abs(K.stress[1].port - K.beta * -0.1) < 1e-12 && Math.abs(K.stress[1].rows[0].egp - 1000 * 2 * -0.1) < 1e-9 && Math.abs(K.stress[1].egp - 4000 * K.beta * -0.1) < 1e-9);
const ds = Object.keys(days), zret = days[K.worst.d].ZZ / days[ds[ds.indexOf(K.worst.d) - 1]].ZZ - 1;
check('risk: the worst index day of the window, replayed on today\'s holdings', K.worst.idx === Math.min(...ixs.slice(-60))
  && Math.abs(K.worst.port - (0.25 * 2 * K.worst.idx + 0.25 * -K.worst.idx + 0.25 * zret)) < 1e-9, K.worst.d);
check('risk: too little history, no model', PA.riskModel(R, {}, { '2026-05': { days: Object.fromEntries(Object.entries(days).slice(0, 20)) } }) === null);

// ---- the morning brief on the synthetic portfolio, through the tool
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-'));
cp.execFileSync('node', [path.join(__dirname, 'fixtures', 'make_synthetic.js'), dir], { stdio: 'ignore' });
const o = JSON.parse(cp.execFileSync('node', [path.join(__dirname, '..', 'tools', 'brief.js'), '--data', dir, '--today', '2026-09-24']).toString().trim().split('\n').pop());
const b = o.brief;
check('tools/brief.js: a brief for the day (value, the last session, the index, every holding best to worst)', o.ok && b.today === '2026-09-24' && b.value > 0 && b.movers.length > 0 && b.movers.every((m, i) => i === 0 || m.chg <= b.movers[i - 1].chg) && b.index != null, JSON.stringify({ v: b.value, n: b.movers.length, ix: b.index }));
check('the session P/L is the sum of the holdings\' moves', Math.abs(b.pl - b.movers.reduce((s, m) => s + m.pl, 0)) < 1e-6);
check('this week: the synthetic ex-dividend date shows, dated and marked held', b.upcoming.some((u) => u.kind === 'exdiv' && u.held && u.d >= '2026-09-24'), JSON.stringify(b.upcoming));
fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? `FAIL ${fail}` : 'ALL PASS');
process.exit(fail ? 1 : 0);
