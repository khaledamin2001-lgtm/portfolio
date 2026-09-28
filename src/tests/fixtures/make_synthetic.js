#!/usr/bin/env node
/* Synthetic ArtifactData export for the CI smoke tests. EVERYTHING HERE IS MADE UP: the portfolio is "Demo Portfolio",
   the holder "Demo Holder", and every price, share count, amount and mark is generated from a fixed seed. Only the ticker
   symbols are real EGX tickers (public) so the tools see familiar shapes.
     node make_synthetic.js <out dir>
   Writes the same layout a real export has (see docs/SCHEMA.md):
     portfolio/settings.json, portfolio/marks.json, portfolio/assets.json, ledger/y2026.json,
     history/2026-05.json … 2026-09.json, market/latest.json, bench/egx30.json, imports/2026-06.json … 2026-08.json,
     sync/state.json
   History: every EGX session (Sun–Thu) from 2026-05-31 to 2026-09-24. Inception 2026-06; month-end marks for Jun–Aug are
   computed from the synthetic ledger and closes, so the engine's reconciliation checks see a consistent book.
   Deterministic: the same output on every run. Prints one JSON line with what it wrote. */
'use strict';
const fs = require('fs'), path = require('path');
const OUT = process.argv[2];
if (!OUT) { console.error('usage: node make_synthetic.js <out dir>'); process.exit(1); }

// ---------- deterministic randomness ----------
let seed = 0x5eed2026;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
const r2 = (x) => Math.round(x * 100) / 100;
const addDays = (d, k) => new Date(Date.parse(d + 'T00:00:00Z') + k * 864e5).toISOString().slice(0, 10);
const wday = (d) => new Date(d + 'T12:00:00Z').getUTCDay();
const eom = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };

// ---------- instruments (real public tickers, invented prices) ----------
const STOCKS = [
  { name: 'Demo Bank', symbol: 'COMI', sector: 'Banks', p0: 80, vol: 0.0125 },
  { name: 'Demo Securities', symbol: 'HRHO', sector: 'Non-bank Financial Services', p0: 20, vol: 0.0185 },
  { name: 'Demo Real Estate', symbol: 'TMGH', sector: 'Real Estate', p0: 30, vol: 0.02 },
  { name: 'Demo Telecom', symbol: 'ETEL', sector: 'Telecommunications', p0: 40, vol: 0.01 },
];
const OTHERS = [{ symbol: 'SWDY', p0: 55, vol: 0.015, sector: 'Industrial Goods' }, { symbol: 'EAST', p0: 25, vol: 0.0115, sector: 'Food & Beverage' }];
const SERIES = [...STOCKS, ...OTHERS, { symbol: 'EGX30CAPPED', p0: 40000, vol: 0.008 }, { symbol: 'EGX30', p0: 34500, vol: 0.008 },
  { symbol: 'USDEGP', p0: 48.5, vol: 0.001 }, { symbol: 'GOLD24K', p0: 5200, vol: 0.006 }];

// ---------- daily closes ----------
const days = [];
for (let d = '2026-05-31'; d <= '2026-09-24'; d = addDays(d, 1)) if (wday(d) <= 4) days.push(d);
const close = {}; // sym -> {date: close}
SERIES.forEach((s) => { let p = s.p0; close[s.symbol] = {}; days.forEach((d) => { p = p * (1 + 0.0004 + s.vol * (rnd() * 2 - 1)); close[s.symbol][d] = r2(p); }); });
const history = {};
days.forEach((d) => { const m = d.slice(0, 7); const h = history[m] || (history[m] = { month: m, days: {} }); h.days[d] = Object.fromEntries(SERIES.map((s) => [s.symbol, close[s.symbol][d]])); });
const lastOnOrBefore = (date) => { let r = null; for (const d of days) if (d <= date) r = d; return r; };
const px = (sym, date) => close[sym][lastOnOrBefore(date)];

// ---------- ledger ----------
const tx = []; let n = 0;
const id = () => 'syn' + String(++n).padStart(3, '0');
const bySym = Object.fromEntries(STOCKS.map((s) => [s.symbol, s]));
const buy = (d, sym, q) => { const p = px(sym, d); tx.push({ id: id(), d, t: 'Buy', a: bySym[sym].name, q, p, amt: -r2(q * p * 1.001), acc: 'Main', src: 'synthetic' }); };
const sell = (d, sym, q) => { const p = px(sym, d); tx.push({ id: id(), d, t: 'Sell', a: bySym[sym].name, q, p, amt: r2(q * p * 0.999), acc: 'Main', src: 'synthetic' }); };
const cash = (d, t, amt, a) => tx.push({ id: id(), d, t, ...(a ? { a } : {}), amt, acc: 'Main', src: 'synthetic' });
const GOLD_NAV0 = 10;   // the demo gold fund: units at a NAV that follows GOLD24K
const fundBuy = (d, q) => { const p = r2(GOLD_NAV0 * px('GOLD24K', d) / px('GOLD24K', '2026-06-01')); tx.push({ id: id(), d, t: 'Buy', a: 'thndrgold', q, p, amt: -r2(q * p), acc: 'MF', src: 'synthetic' }); };
cash('2026-06-01', 'Deposit', 100000);
buy('2026-06-02', 'COMI', 400);
buy('2026-06-03', 'HRHO', 1500);
buy('2026-06-10', 'TMGH', 1000);
fundBuy('2026-06-17', 500);
cash('2026-07-08', 'Dividend', r2(400 * 1.5), 'Demo Bank');
sell('2026-07-15', 'HRHO', 600);
cash('2026-07-20', 'Fee', -25);
cash('2026-07-30', 'Rebate', 10);
buy('2026-08-04', 'ETEL', 500);
cash('2026-08-18', 'Deposit', 15500);
buy('2026-08-19', 'COMI', 100);
sell('2026-09-07', 'TMGH', 400);
buy('2026-09-09', 'HRHO', 300);
cash('2026-09-15', 'Withdrawal', -5000);
tx.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));

// ---------- month-end marks from the synthetic book ----------
const assets = Object.fromEntries(STOCKS.map((s) => [s.name, { name: s.name, symbol: s.symbol, sector: s.sector }]));
assets.thndrgold = { name: 'thndrgold', symbol: '', sector: 'Gold', fund: true, proxy: 'GOLD24K' };
assets['Demo Telecom'].target = r2(STOCKS[3].p0 * 0.5);   // already met: the heads-up digest lists a target item
assets['Demo Real Estate'].stop = r2(STOCKS[2].p0 * 0.2);  // far away: no stop item
const book = (date) => {
  const sh = {}; let c = 0, fundCost = null;
  tx.filter((t) => t.d <= date).forEach((t) => { c += t.amt; if (t.t === 'Buy' || t.t === 'Sell') sh[t.a] = (sh[t.a] || 0) + (t.t === 'Sell' ? -1 : 1) * t.q; if (t.a === 'thndrgold' && t.t === 'Buy') fundCost = t; });
  let sec = 0;
  Object.entries(sh).forEach(([name, q]) => {
    if (q < 0.5) return;
    if (name === 'thndrgold') sec += q * fundCost.p * px('GOLD24K', date) / px('GOLD24K', fundCost.d);
    else sec += q * px(assets[name].symbol, date);
  });
  return { cash: r2(c), securities: r2(sec) };
};
const months = ['2026-06', '2026-07', '2026-08'], marks = {};
const CPI = { '2026-06': 0.0105, '2026-07': 0.013, '2026-08': 0.009 };   // monthly inflation, a fraction (docs/SCHEMA.md)
months.forEach((m) => { const e = eom(m), b = book(e); marks[m] = { cash: b.cash, securities: b.securities, source: 'statement', provisional: false, benchClose: px('EGX30CAPPED', e), usdegp: px('USDEGP', e), cpi: CPI[m], cpiSource: 'synthetic', cashRate: 0.24, cashRateSource: 'synthetic' }; });
const last = days[days.length - 1];
const settings = {
  name: 'Demo Portfolio', portfolioId: 'demo', inception: '2026-06', openingValue: 0,
  cash: marks['2026-08'].cash, cashDate: '2026-08-31', cashSource: 'synthetic statement',
  account: { holder: 'Demo Holder', unifiedCode: null }, riskFree: 0.22, fxStart: px('USDEGP', '2026-05-31'),
  benchCloseStart: px('EGX30CAPPED', '2026-05-31'), openThreshold: 0.5, staleDays: 7, volLow: 0.03, volHigh: 0.08,
  priceDate: last, factsheetEmail: '', returnMethod: 'dietz',
};

// ---------- market / bench ----------
const prevMonthClose = (sym, d) => px(sym, eom(d.slice(0, 7) === '2026-09' ? '2026-08' : '2026-07'));
const quote = (s) => ({ price: close[s.symbol][last], chg: r2((close[s.symbol][last] / close[s.symbol][days[days.length - 2]] - 1) * 100), date: last, prevMonthClose: prevMonthClose(s.symbol, last), name: s.name || s.symbol, dy: 3.5, pe: 8, pb: 1.2 });
const quotes = Object.fromEntries([...STOCKS, ...OTHERS].map((s) => [s.symbol, quote(s)]));
quotes.COMI.exDate = addDays(last, 4); quotes.COMI.divUp = 1.75;   // ex-dividend within the week: a heads-up item
const idx = (sym) => ({ close: close[sym][last], chg: 0.4, date: last, prevMonthClose: prevMonthClose(sym, last) });
const market = {
  asOf: last + 'T15:10:00+03:00', source: 'synthetic', quotes, index: { EGX30CAPPED: idx('EGX30CAPPED'), EGX30: idx('EGX30') },
  fx: { USDEGP: { price: close.USDEGP[last], chg: 0, date: last, prevMonthClose: prevMonthClose('USDEGP', last) } },
  gold: { XAUUSD: 3400, gram24kEgp: close.GOLD24K[last], date: last }, missing: [], rates: { policy: { rate: 0.24, date: '2026-09', source: 'synthetic' } },
};
const bench = {
  members: [...STOCKS, ...OTHERS].map((s, i) => ({ s: s.symbol, name: s.name || s.symbol, sector: s.sector, floatShares: (i + 2) * 1e8, totalShares: (i + 3) * 1e8 })),
  capWeight: 0.15, asOf: last, divYield: 0.03, divYieldAsOf: last, index: 'EGX30CAPPED', source: 'synthetic', actions: [], actionsSource: 'synthetic',
};
const imports = Object.fromEntries(months.map((m) => [m, { month: m, messageId: 'synthetic-' + m, postedAt: eom(m) + 'T12:00:00Z', postedBy: 'synthetic', added: 0, corrected: 0, removed: 0, marks: true, fullMonth: true, reportsPending: false, reports: { factsheetSentAt: eom(m) + 'T12:00:00Z', workbooksPublishedAt: eom(m) + 'T12:00:00Z' } }]));

// ---------- write ----------
const W = (rel, o) => { const f = path.join(OUT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 1)); return rel; };
const files = [
  W('portfolio/settings.json', settings), W('portfolio/marks.json', { months: marks }), W('portfolio/assets.json', { items: assets }),
  W('ledger/y2026.json', { rows: tx }), ...Object.values(history).map((h) => W(`history/${h.month}.json`, h)),
  W('market/latest.json', market), W('bench/egx30.json', bench), ...Object.entries(imports).map(([m, o]) => W(`imports/${m}.json`, o)),
  W('sync/state.json', { seen: {}, alerts: {} }),
];
console.log(JSON.stringify({ ok: true, out: OUT, files: files.length, sessions: days.length, first: days[0], last, ledgerRows: tx.length, marks: Object.keys(marks) }));
