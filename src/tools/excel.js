#!/usr/bin/env node
/* Month-end workbook data: runs the page's own engine on a plain export folder (<coll>/<doc>.json) and writes one JSON file for excel.py.
     node excel.js --data <export dir> [--overlay <plan dir>/write] --month YYYY-MM --out <data.json> */
'use strict';
const fs = require('fs'), path = require('path');
const PE = require('./engine.js'), PA = require('./engine2.js');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? a.concat([[x.slice(2), arr[i + 1]]]) : a), []));
const J = (f) => { const x = JSON.parse(fs.readFileSync(f)); return x.data || x; };
const D = (...p) => path.join(args.data, ...p);
const M = args.month;

let settings = J(D('portfolio', 'settings.json')), marks = J(D('portfolio', 'marks.json')).months, assets = J(D('portfolio', 'assets.json')).items;
const ledgerDocs = {}; fs.readdirSync(D('ledger')).filter((f) => /^y\d{4}\.json$/.test(f)).forEach((f) => { ledgerDocs[f.slice(1, 5)] = J(D('ledger', f)).rows || []; });
const history = {}; if (fs.existsSync(D('history'))) fs.readdirSync(D('history')).forEach((f) => { history[f.replace('.json', '')] = J(D('history', f)); });
const market = fs.existsSync(D('market', 'latest.json')) ? J(D('market', 'latest.json')) : null;
const bench = fs.existsSync(D('bench', 'egx30.json')) ? J(D('bench', 'egx30.json')) : null;
if (args.overlay && fs.existsSync(args.overlay)) for (const f of fs.readdirSync(args.overlay)) {
  const v = J(path.join(args.overlay, f)); let m;
  if ((m = f.match(/^ledger_y(\d{4})\.json$/))) ledgerDocs[m[1]] = v.rows;
  else if (f === 'marks.json') marks = v.months;
  else if (f === 'settings.json') settings = v;
  else if (f === 'assets_update.json') assets = { ...assets, ...v.items };
}
// the report month's cut-off: nothing booked after its last day reaches the engine, so income, holdings dividends,
// closed trips and the ledger sheet all stop at eom(M) even when the export already carries later months
const cutoff = PE.eom(M);
const tx = Object.keys(ledgerDocs).sort().flatMap((y) => ledgerDocs[y]).filter((t) => t.d <= cutoff);
const today = cutoff < PE.cairoToday() ? cutoff : PE.cairoToday();
const pb = PA.priceBook(history);
const ledger = PE.runLedger(tx);
// closed months with no statement yet get a month-close estimate (ledger cash + holdings at the last closes); stored marks are untouched
marks = PA.estimateMarks(settings, marks, ledger, assets, pb, PE.cairoToday());
const pricer = PA.makePricer(assets, ledger, pb);
const fallback = (name) => { const p = pricer(name, today); return p ? { p: p.p, d: pb.last } : null; };
const R = PE.run({ settings, marks, assets, tx, market, bench }, { type: 'Since Inception', asOf: M }, { today, fallback, live: false });
const st = R.stats;
const H = PA.holdingsAt(R.ledger, assets, pb, PE.eom(M));
const row = R.months.find((r) => r.month === M) || {};
const cash = marks[M] && marks[M].cash != null ? marks[M].cash : H.cash;
const total = H.mv + Math.max(0, cash);
const byName = {}; Object.values(assets).forEach((a) => { byName[a.name] = a; });
const tr = PA.trailing(R.months, M);
const inc = PA.income(R.ledger, assets, R.pos, market, today);
const A = bench ? PA.attribution(R.months, R.range, R.ledger, assets, pb, bench, today) : null;
// one row per closed round trip (a stock bought, sold out and bought again is two rows, `trip` 1 and 2); cash-like funds included here
const closed = R.pos.trips.filter((r) => r.lastSell <= cutoff);
// Summary value = the month's mark (Thndr statement); Holdings total = the same shares at closing prices + cash. The gap is shown.
const statementValue = row.value ?? total;
// the real return falls back to the months that have CPI: say which month it runs to
const realPartial = st.realTwr == null && st.realTwrPartial != null && st.realThrough;
// the cash benchmark uses the settings' risk-free rate for months with no recorded CBE rate: say so
const cashLabel = st.cashTwr != null && !st.cashComplete ? `Cash benchmark (CBE policy rate; settings rate ${(settings.riskFree * 100).toFixed(2)}% for ${st.cashFallbackMonths.length} of ${st.n} months) over the period` : null;

const out = {
  month: M, name: settings.name, inception: settings.inception, generated: PE.cairoToday(), benchmark: 'EGX30 Capped',
  summary: {
    'Portfolio value (EGP)': statementValue, 'Cash (EGP)': cash, 'Securities (EGP)': row.securities ?? H.mv,
    'Difference: statement value vs closing prices (EGP)': Math.round((statementValue - total) * 100) / 100,
    'Month return': row.ret, 'Benchmark month return': row.bench, 'Month alpha': row.alpha,
    'Since inception TWR': st.twr, 'Since inception benchmark': st.benchTwr, 'Alpha since inception': st.alpha, 'Annualized TWR': st.annualized,
    'Money-weighted return (XIRR, annual)': st.xirr, 'Return in USD': st.usdTwr, 'Real return (after CPI)': st.realTwr ?? st.realTwrPartial,
    'Cash benchmark (CBE policy rate) over the period': st.cashTwr, 'Ahead of cash': st.aheadOfCash,
    'Index dividend yield (estimate)': st.benchDivYield, 'Index return with dividends (estimate)': st.benchTrEstimate, 'Return before trading costs': st.twrGross,
    'Monthly volatility': st.vol, 'Annualized volatility': st.vol * Math.sqrt(12), 'Sharpe ratio': st.sharpe, 'Sortino ratio': st.sortino, 'Calmar ratio': st.calmar,
    'Beta vs benchmark': st.beta, "Jensen's alpha (annual)": st.jensen, 'Correlation': st.correl, 'Tracking error (annual)': st.trackingError, 'Upside capture': st.upCapture, 'Downside capture': st.downCapture,
    'Max drawdown (month-end)': st.maxDD, 'Positive months': st.posMonths, 'Months in period': st.monthsElapsed ?? st.n, 'Months beating benchmark': st.beat,
    'Deposits since inception (EGP)': st.deposits, 'Withdrawals since inception (EGP)': st.withdrawals, 'Investment gain since inception (EGP)': st.netGain,
    'Dividends received since inception (EGP)': st.dividends, 'Realized trading P/L (EGP)': st.realized,
    'Trading costs (EGP)': st.tradingCost, 'Trading costs as % of value traded': st.costPct, 'Risk-free rate used': settings.riskFree, 'Opening value before inception (EGP)': settings.openingValue,
  },
  labels: { ...(realPartial ? { 'Real return (after CPI)': `Real return (after CPI, through ${PE.fmtMonth(st.realThrough)})` } : {}), ...(cashLabel ? { 'Cash benchmark (CBE policy rate) over the period': cashLabel } : {}) },
  trailing: tr.map((t) => ({ period: t.label, portfolio: t.p, benchmark: t.b, difference: t.a })),
  attribution: A ? { active: A.active, allocation: A.alloc, selection: A.sel, trading: A.trading, tradingNote: A.tradingNote, replication: A.replication, sectors: A.sectors.map((s) => ({ sector: s.sector, wp: s.wp, wb: s.wb, rp: s.rp, rb: s.rb, alloc: s.alloc, sel: s.sel, total: s.total })) } : null,
  monthly: R.months.filter((r) => r.has && r.month <= M).map((r) => ({ month: r.month, opening: r.opening, deposits: r.deposits, withdrawals: r.withdrawals, netFlow: r.netFlow, weightedFlow: r.weightedFlow, dividends: r.dividends, cash: r.cash, securities: r.securities, value: r.value,
    ret: r.ret, retSimple: r.retSimple, bench: r.bench, alpha: r.alpha, cum: r.pCum, cumBench: r.pBench, dd: r.dd, benchClose: r.benchClose, usdegp: r.usdegp, cpi: r.cpi, usdRet: r.usdRet, realRet: r.realRet, cashRet: r.cashRet, trades: r.trades, tradingCost: r.tradingCost, source: r.estimate ? 'estimate (awaiting statement)' : r.source || 'typed' })),
  holdings: H.rows.filter((h) => h.shares > 0.5).map((h) => ({ symbol: h.symbol, name: h.name, sector: h.sector, shares: h.shares, avgCost: h.shares ? h.cost / h.shares : null, price: h.price, priceSource: h.src, mv: h.mv, cost: h.cost, unreal: h.mv != null ? h.mv - h.cost : null, ret: h.cost ? (h.mv - h.cost) / h.cost : null, weight: total ? (h.mv || 0) / total : 0,
    dividends: R.ledger.filter((t) => t.t === 'Dividend' && t.a && (t.a === h.name || t.a === h.symbol)).reduce((s, t) => s + (t.amt || 0), 0) })).sort((a, b) => (b.mv || 0) - (a.mv || 0)),
  holdingsCash: cash, holdingsTotal: total,
  ledger: R.ledger.filter((t) => t.d <= cutoff).map((t) => ({ date: t.d, type: t.t, asset: t.a || '', symbol: (byName[t.a] || {}).symbol || '', shares: t.q ?? null, price: t.p ?? null, amount: t.amt, basisSold: t.t === 'Sell' ? t.basis : null, realized: t.t === 'Sell' ? t.amt - t.basis : null, account: t.acc || 'Main', source: t.src || '', note: t.note || '' })),
  closed: closed.map((r) => ({ name: r.name, symbol: r.symbol, trip: r.trip, firstBuy: r.firstBuy, lastSell: r.lastSell, holdDays: r.holdDays, buyCost: r.buyCost, proceeds: r.proceeds, dividends: r.divs, total: r.total, roi: r.roi, outcome: r.outcome })),
  incomeYears: inc.years.map((Y) => ({ year: Y.year, div: Y.div, reb: Y.reb, fee: Y.fee, divT: Y.divT, rebT: Y.rebT, feeT: Y.feeT, net: Y.net })),
  incomeByStock: inc.perAsset.map((x) => ({ name: x.name, symbol: x.symbol, payments: x.count, total: x.total, last: x.last })),
  marks: Object.keys(marks).sort().filter((k) => k <= M).map((k) => ({ month: k, ...marks[k] })),
  assets: Object.values(assets).sort((a, b) => a.name.localeCompare(b.name)).map((a) => ({ name: a.name, symbol: a.symbol || '', sector: a.sector || '', target: a.target ?? null, stop: a.stop ?? null, fund: !!a.fund })),
  settings,
};
fs.writeFileSync(args.out, JSON.stringify(out));
console.log(JSON.stringify({ ok: true, month: M, value: out.summary['Portfolio value (EGP)'], holdings: out.holdings.length, ledger: out.ledger.length }));
