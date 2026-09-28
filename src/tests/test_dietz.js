/* Modified Dietz checks: a synthetic month, a no-flow month against the legacy formula, and the real Khaled export.
   node test_dietz.js → PASS/FAIL lines, exit 1 on any failure. */
const fs = require('fs'), path = require('path');
const PE = require('../engine.js'), PA = require('../engine2.js');
let fail = 0;
const check = (name, ok, detail) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail != null ? ' · ' + detail : '')); if (!ok) fail++; };

// 1. synthetic: opening 1000, one deposit of 500 on the 16th of a 31-day month, closing 1600
const settings = { inception: '2026-01', openingValue: 1000, riskFree: 0.2, volLow: 0.03, volHigh: 0.08, staleDays: 7, openThreshold: 0.5, cash: 0, fxStart: 50 };
const tx = [{ id: 'd1', d: '2026-01-16', t: 'Deposit', amt: 500 }];
const marks = { '2026-01': { cash: 0, securities: 1600 } };
const R = PE.run({ settings, marks, assets: {}, tx }, { type: 'Since Inception' }, { today: '2026-02-10', live: false });
const row = R.months.find((r) => r.month === '2026-01');
const w = 16 / 31, expected = (1600 - 1000 - 500) / (1000 + 500 * w);
check('Dietz weight 16/31 on a 2026-01-16 deposit', Math.abs(row.weightedFlow - 500 * w) < 1e-9, `weightedFlow ${row.weightedFlow}`);
check('Dietz return matches (1600-1000-500)/(1000+500×16/31)', Math.abs(row.ret - expected) < 1e-12, `${row.ret} vs ${expected}`);
check('retSimple keeps the legacy figure', Math.abs(row.retSimple - (1600 / 1500 - 1)) < 1e-12, `${row.retSimple}`);
const Rs = PE.run({ settings, marks, assets: {}, tx }, { type: 'Since Inception' }, { today: '2026-02-10', live: false, flowTiming: 'start' });
check("flowTiming:'start' reproduces the legacy formula", Math.abs(Rs.months[0].ret - (1600 / 1500 - 1)) < 1e-12, `${Rs.months[0].ret}`);
// a flow on the 1st weighs 1, so it equals the legacy figure
const R1 = PE.run({ settings, marks, assets: {}, tx: [{ id: 'd2', d: '2026-01-01', t: 'Deposit', amt: 500 }] }, { type: 'Since Inception' }, { today: '2026-02-10', live: false });
check('Deposit on the 1st equals the legacy figure', Math.abs(R1.months[0].ret - (1600 / 1500 - 1)) < 1e-12, `${R1.months[0].ret}`);

// 2. no-flow month equals legacy
const marks2 = { '2026-01': { cash: 0, securities: 1600 }, '2026-02': { cash: 100, securities: 1700 } };
const R2 = PE.run({ settings, marks: marks2, assets: {}, tx }, { type: 'Since Inception' }, { today: '2026-03-10', live: false });
const feb = R2.months.find((r) => r.month === '2026-02');
check('No-flow month: Dietz == legacy', feb.ret === feb.retSimple && Math.abs(feb.ret - (1800 / 1600 - 1)) < 1e-12, `${feb.ret}`);
check('No-flow month: weightedFlow 0', feb.weightedFlow === 0);

// 3. real Khaled export
const SP = path.join(__dirname, '..'), dir = process.env.KHALED_EXPORT || path.join(SP, 'private', 'export-khaled'); // private database export, never in the repo
if (fs.existsSync(dir)) {
  const J = (f) => { const x = JSON.parse(fs.readFileSync(f)); return x.data || x; };
  const D = (...p) => path.join(dir, ...p);
  const s = J(D('portfolio', 'settings.json')), mk = J(D('portfolio', 'marks.json')).months, assets = J(D('portfolio', 'assets.json')).items;
  const ktx = fs.readdirSync(D('ledger')).filter((f) => /^y\d{4}\.json$/.test(f)).sort().flatMap((f) => J(D('ledger', f)).rows || []);
  const market = J(D('market', 'latest.json'));
  const RK = PE.run({ settings: s, marks: mk, assets, tx: ktx, market }, { type: 'Since Inception' }, { today: '2026-09-27' });
  const aug = RK.months.find((r) => r.month === '2025-08');
  check('Khaled 2025-08 Modified Dietz return between -7% and -6%', aug.ret > -0.07 && aug.ret < -0.06, `${(aug.ret * 100).toFixed(3)}% (legacy ${(aug.retSimple * 100).toFixed(3)}%)`);
  check('Khaled since-inception TWR below 0.4585', RK.stats.twr < 0.4585, `${RK.stats.twr}`);
  const over = RK.ledger.filter((t) => t.oversold);
  check('Khaled: no oversold rows after same-day ordering', over.length === 0, over.map((t) => `${t.a} ${t.d}`).join(', ') || 'none');
  const X = process.env.EXPECTED_JSON || path.join(__dirname, 'expected.json');   // private workbook figures, see tests/test.js
  if (fs.existsSync(X)) {
    const sd = JSON.parse(fs.readFileSync(X)).sameDay, row = RK.pos.rows.find((r) => r.name === sd.name);
    check(`Khaled: the workbook's same-day sell/buy name closes at expected.json's realized figure and is a ${sd.outcome}`, row && Math.abs(row.realized - sd.realized) < 0.01 && row.outcome === sd.outcome, row && `${row.realized} ${row.outcome}`);
  } else console.log('SKIP same-day realized check (expected.json is private; set EXPECTED_JSON)');
  check('Khaled: ledger ids unique', RK.checks.find((c) => c.label === 'Ledger ids are unique').status === 'ok');
} else console.log('SKIP real export (not found - the Khaled export is private; point KHALED_EXPORT at a copy to run these checks)');

// 4. Bonus type
const btx = [{ id: 'b1', d: '2026-01-05', t: 'Buy', a: 'X', q: 100, p: 10, amt: -1000 }, { id: 'b2', d: '2026-01-10', t: 'Bonus', a: 'X', q: 25, amt: 0 }, { id: 'b3', d: '2026-01-20', t: 'Sell', a: 'X', q: 50, p: 9, amt: 450 }];
const L = PE.runLedger(btx);
check('Bonus: sell basis uses the diluted average cost (50 × 8)', Math.abs(L[2].basis - 400) < 1e-9 && !L[2].oversold, `${L[2].basis}`);
const P = PE.positions(L, [], null, settings, '2026-02-01', null);
check('Bonus: open shares = 100 + 25 − 50', P.rows[0].open === 75 && P.rows[0].bonus === 25, `${P.rows[0].open}`);
const pbE = PA.priceBook({});
const H = PA.holdingsAt(L, {}, pbE, '2026-01-31');
check('Bonus: holdingsAt shares 75 at cost 600', H.rows[0].shares === 75 && Math.abs(H.rows[0].cost - 600) < 1e-9, `${H.rows[0].shares} @ ${H.rows[0].cost}`);

// 5. same-day order: Sell printed before Buy on the same day still gets the buy's basis
const sd = PE.runLedger([{ id: 's1', d: '2026-05-03', t: 'Sell', a: 'T', q: 10, p: 14, amt: 140 }, { id: 's2', d: '2026-05-03', t: 'Buy', a: 'T', q: 10, p: 13.9, amt: -139 }]);
check('Same-day Sell before Buy is re-ordered (basis 139, not 0)', sd[0].t === 'Buy' && Math.abs(sd[1].basis - 139) < 1e-9, `${sd[1].basis}`);

// 6. a missing month spans: Feb has no mark, so Mar's return covers Feb 1 → Mar 31 (59 days) with the flows of both months
{
  const st = { ...settings, openingValue: 1000 };
  const mk = { '2026-01': { cash: 0, securities: 1100, cpi: 0.005, benchReturn: 0.01 }, '2026-02': { benchReturn: 0.02, cpi: 0.01 }, '2026-03': { cash: 0, securities: 1500, benchReturn: 0.03, cpi: 0.02 } };
  const gtx = [{ id: 'g1', d: '2026-02-10', t: 'Deposit', amt: 200 }, { id: 'g2', d: '2026-03-05', t: 'Deposit', amt: 100 }];
  const G = PE.run({ settings: st, marks: mk, assets: {}, tx: gtx }, { type: 'Since Inception' }, { today: '2026-04-10', live: false });
  const feb = G.months.find((r) => r.month === '2026-02'), mar = G.months.find((r) => r.month === '2026-03');
  check('Gap month: has=false, gap=true, spans=0, ret=null', !feb.has && feb.gap && feb.spans === 0 && feb.ret === null, JSON.stringify({ has: feb.has, gap: feb.gap, spans: feb.spans, ret: feb.ret }));
  check('Spanning month: spans=2, spanFrom=2026-02, opening = last valued value', mar.spans === 2 && mar.spanFrom === '2026-02' && mar.opening === 1100 && !mar.gap, JSON.stringify({ spans: mar.spans, spanFrom: mar.spanFrom, opening: mar.opening }));
  const wf = 200 * 50 / 59 + 100 * 27 / 59, expG = (1500 - 1100 - 300) / (1100 + wf);
  check('Spanning month: flows of both months, Dietz weights over 59 days (50/59, 27/59)', mar.deposits === 300 && Math.abs(mar.weightedFlow - wf) < 1e-9 && Math.abs(mar.ret - expG) < 1e-12, `${mar.ret} vs ${expG}`);
  check('Spanning month: retSimple over the span', Math.abs(mar.retSimple - (1500 / 1400 - 1)) < 1e-12, `${mar.retSimple}`);
  check('Spanning month: typed benchmark compounded (1.02×1.03−1)', Math.abs(mar.bench - (1.02 * 1.03 - 1)) < 1e-12 && feb.bench === null, `${mar.bench}`);
  check('Spanning month: CPI compounded (cpiSpan 1.01×1.02−1) and realRet over the span', Math.abs(mar.cpiSpan - (1.01 * 1.02 - 1)) < 1e-12 && Math.abs(mar.realRet - ((1 + mar.ret) / (1.01 * 1.02) - 1)) < 1e-12, `${mar.cpiSpan} ${mar.realRet}`);
  const gs = G.stats;
  check('periodStats: n=2 returns, monthsElapsed=3, gaps=[2026-02], deposits 300, inflation over all 3 months', gs.n === 2 && gs.monthsElapsed === 3 && gs.gaps.join() === '2026-02' && gs.deposits === 300 && Math.abs(gs.inflation - (1.005 * 1.01 * 1.02 - 1)) < 1e-12, JSON.stringify({ n: gs.n, monthsElapsed: gs.monthsElapsed, gaps: gs.gaps, deposits: gs.deposits, inflation: gs.inflation }));
  check('periodStats: TWR chains Jan and the Feb–Mar span', Math.abs(gs.twr - ((1 + G.months[0].ret) * (1 + mar.ret) - 1)) < 1e-12, `${gs.twr}`);
  check("checks: 'Monthly marks have no gaps' still lists Feb-26", /Feb-26/.test(G.checks.find((c) => c.label === 'Monthly marks have no gaps').detail) && G.checks.find((c) => c.label === 'Monthly marks have no gaps').status === 'error');
  // annualization uses elapsed calendar months: 11 valued months over a 12-month range still annualize
  const mk12 = {}; for (let i = 0; i < 12; i++) if (i !== 5) mk12[PE.addMonths('2026-01', i)] = { cash: 0, securities: 1000 * (1 + 0.01 * (i + 1)) };
  const G12 = PE.run({ settings: st, marks: mk12, assets: {}, tx: [] }, { type: 'Since Inception' }, { today: '2027-01-10', live: false });
  check('Annualized uses the 12 elapsed months although only 11 have a return', G12.stats.n === 11 && G12.stats.monthsElapsed === 12 && Math.abs(G12.stats.annualized - (1.12 / 1 - 1)) < 1e-12, `${G12.stats.n} ${G12.stats.monthsElapsed} ${G12.stats.annualized}`);
}

// 7. round trips: a stock bought, sold out, and bought again is two trips; a dividend paid while flat goes to the previous trip
{
  const ttx = [
    { id: 't1', d: '2026-01-05', t: 'Buy', a: 'X', q: 100, p: 10, amt: -1000 }, { id: 't2', d: '2026-01-20', t: 'Sell', a: 'X', q: 100, p: 12, amt: 1200 },
    { id: 't3', d: '2026-01-25', t: 'Dividend', a: 'X', amt: 50 }, // paid after the sale, while flat → trip 1
    { id: 't4', d: '2026-02-03', t: 'Buy', a: 'X', q: 200, p: 11, amt: -2200 }, { id: 't5', d: '2026-02-10', t: 'Dividend', a: 'X', amt: 30 }, // held → trip 2
    { id: 't6', d: '2026-02-15', t: 'Sell', a: 'X', q: 100, p: 10, amt: 1000 }, { id: 't7', d: '2026-03-01', t: 'Sell', a: 'X', q: 100, p: 9, amt: 900 },
    { id: 't8', d: '2026-03-10', t: 'Buy', a: 'X', q: 10, p: 9, amt: -90 }, // open again: not a closed trip
    { id: 't9', d: '2026-01-06', t: 'Buy', a: 'thndrsavings', q: 500, p: 1, amt: -500 }, { id: 't10', d: '2026-01-30', t: 'Sell', a: 'thndrsavings', q: 500, p: 1, amt: 501 },
  ];
  const A = [{ name: 'X', symbol: 'X', sector: 'Banks' }, { name: 'thndrsavings', symbol: 'SAVINGS', sector: 'Cash & Savings' }];
  const period = { from: '2026-01', to: '2026-03' };
  const TP = PE.positions(PE.runLedger(ttx), A, null, settings, '2026-03-20', period);
  const xt = TP.trips.filter((t) => t.name === 'X');
  check('Trips: X has 2 closed trips (newest first) and its row is Open with trips=2', xt.length === 2 && xt[0].trip === 2 && xt[1].trip === 1 && TP.rows.find((r) => r.name === 'X').status === 'Open' && TP.rows.find((r) => r.name === 'X').trips === 2, JSON.stringify(xt.map((t) => [t.trip, t.firstBuy, t.lastSell])));
  const t1 = xt[1], t2 = xt[0];
  check('Trip 1: 100 sh, realized 200, dividend 50 paid after the sale, WIN, 15 days', t1.bought === 100 && t1.sold === 100 && Math.abs(t1.realized - 200) < 1e-9 && t1.divs === 50 && t1.total === 250 && t1.outcome === 'WIN' && t1.holdDays === 15 && Math.abs(t1.roi - 0.25) < 1e-12, JSON.stringify(t1));
  check('Trip 2: 200 sh over two sells, realized −300, dividend 30, LOSS, closedInPeriod', t2.bought === 200 && t2.sold === 200 && Math.abs(t2.realized + 300) < 1e-9 && t2.divs === 30 && t2.outcome === 'LOSS' && t2.lastSell === '2026-03-01' && t2.closedInPeriod === true, JSON.stringify(t2));
  const PS = PE.periodStats(PE.monthly({ ...settings, openingValue: 1000 }, { '2026-01': { cash: 0, securities: 1000 }, '2026-02': { cash: 0, securities: 1000 }, '2026-03': { cash: 0, securities: 1000 } }, PE.runLedger(ttx), null), period, PE.runLedger(ttx), settings, TP);
  check('Closed-trade stats default to trips and skip the cash-like fund (closedCount 2, closedCashLike 1)', PS.closedTrades === 'trip' && PS.closedCount === 2 && PS.closedCashLike === 1 && PS.wins === 1 && PS.losses === 1, JSON.stringify({ closedTrades: PS.closedTrades, closedCount: PS.closedCount, closedCashLike: PS.closedCashLike }));
  const PN = PE.periodStats(PE.monthly({ ...settings, openingValue: 1000 }, { '2026-01': { cash: 0, securities: 1000 } }, PE.runLedger(ttx), null), period, PE.runLedger(ttx), settings, TP, { closedTrades: 'name' });
  check("closedTrades:'name' keeps the legacy per-name rows (only the fund is closed by name)", PN.closedTrades === 'name' && PN.closedCount === 1 && PN.closed[0].name === 'thndrsavings' && PN.closedCashLike === 0, JSON.stringify({ closedCount: PN.closedCount, names: PN.closed.map((r) => r.name) }));
}

// 8. broker-cash check labels an unverified source
{
  const base = { settings: { ...settings, cash: 500, cashDate: '2026-01-31' }, marks, assets: {}, tx: [{ id: 'c1', d: '2026-01-16', t: 'Deposit', amt: 500 }] };
  const cashCheck = (s) => PE.run({ ...base, settings: { ...base.settings, ...s } }, { type: 'Since Inception' }, { today: '2026-02-10', live: false }).checks.find((c) => c.label === 'Broker cash reconciles to ledger');
  const noSrc = cashCheck({}), wb = cashCheck({ cashSource: 'workbook (Portfolio sheet)' }), stm = cashCheck({ cashSource: 'Thndr Statement to 2026-01-31' });
  check('Cash check: matching numbers but no cashSource → warn, "no source"', noSrc.status === 'warn' && /not from a Thndr statement \(no source\), so this check cannot confirm the ledger$/.test(noSrc.detail), noSrc.detail);
  check('Cash check: workbook source → warn naming the source', wb.status === 'warn' && /\(workbook \(Portfolio sheet\)\), so this check cannot confirm the ledger$/.test(wb.detail), wb.detail);
  check('Cash check: statement source (case-insensitive) → ok', stm.status === 'ok' && /broker figure from Thndr Statement/.test(stm.detail), stm.detail);
}

// 9. real exports (fix/export-*): attribution identity, gap-spanning on real data, trips vs legacy, the workbook cut-off, the cash-source warn
const fixK = process.env.KHALED_EXPORT || path.join(SP, 'private', 'export-khaled'), fixY = process.env.YASSIN_EXPORT || path.join(SP, 'private', 'export-yassin'); // private exports
if (fs.existsSync(fixK) && fs.existsSync(fixY)) {
  const load = (dir, today) => {
    const J = (f) => { const x = JSON.parse(fs.readFileSync(f)); return x.data || x; };
    const D = (...p) => path.join(dir, ...p);
    const s = J(D('portfolio', 'settings.json')), mk0 = J(D('portfolio', 'marks.json')).months, assets = J(D('portfolio', 'assets.json')).items;
    const tx = fs.readdirSync(D('ledger')).filter((f) => /^y\d{4}\.json$/.test(f)).sort().flatMap((f) => J(D('ledger', f)).rows || []);
    const history = {}; fs.readdirSync(D('history')).forEach((f) => { history[f.replace('.json', '')] = J(D('history', f)); });
    const market = J(D('market', 'latest.json')), bench = J(D('bench', 'egx30.json'));
    const pb = PA.priceBook(history), ledger = PE.runLedger(tx), mk = PA.estimateMarks(s, mk0, ledger, assets, pb, today);
    const pricer = PA.makePricer(assets, ledger, pb), fallback = (n) => { const p = pricer(n, today); return p ? { p: p.p, d: pb.last } : null; };
    return { s, mk, assets, tx, market, bench, pb, run: (opts, marksIn) => PE.run({ settings: s, marks: marksIn || mk, assets, tx, market }, { type: 'Since Inception' }, { today, fallback, ...(opts || {}) }) };
  };
  const today = '2026-09-27';
  // 9a. attribution identity on Yassin (inception month starts from zero)
  const Y = load(fixY, today), RY = Y.run();
  const AY = PA.attribution(RY.months, RY.range, RY.ledger, Y.assets, Y.pb, Y.bench, today);
  const eff = AY.alloc + AY.sel + AY.trading + AY.replication;
  check('Yassin: attribution R equals stats.twr and active equals twr − benchTwr (1e-9)', Math.abs(AY.R - RY.stats.twr) < 1e-9 && Math.abs(AY.active - (RY.stats.twr - RY.stats.benchTwr)) < 1e-9, `R ${AY.R} twr ${RY.stats.twr} · active ${AY.active} alpha ${RY.stats.alpha}`);
  check('Yassin: Carino-linked effects add up to active (1e-9) and the zero-start month is in the chain', Math.abs(eff - AY.active) < 1e-9 && AY.months[0].month === '2025-08' && AY.months[0].startValue === 0 && AY.months[0].Rh === 0 && AY.months[0].sel === 0, `effects ${eff} · first ${AY.months[0].month} startValue ${AY.months[0].startValue}`);
  // 9b. gap-spanning on Khaled: drop the Jul-26 mark
  const K = load(fixK, today), RK = K.run();
  const mkGap = { ...K.mk }; delete mkGap['2026-07'];
  const RG = K.run({}, mkGap), jun = RG.months.find((r) => r.month === '2026-06'), aug = RG.months.find((r) => r.month === '2026-08');
  const flows = RG.ledger.filter((t) => (t.t === 'Deposit' || t.t === 'Withdrawal') && t.d >= '2026-07-01' && t.d <= '2026-08-31');
  const Dsp = PE.dayNum('2026-08-31') - PE.dayNum('2026-07-01') + 1;
  const wfK = flows.reduce((a, t) => a + ((Dsp - (PE.dayNum(t.d) - PE.dayNum('2026-07-01') + 1) + 1) / Dsp) * t.amt, 0), nfK = flows.reduce((a, t) => a + t.amt, 0);
  check('Khaled without Jul-26: Aug-26 row spans=2 and ret = (Aug − Jun − flows)/(Jun + weighted flows)', aug.spans === 2 && RG.months.find((r) => r.month === '2026-07').gap && Math.abs(aug.ret - (aug.value - jun.value - nfK) / (jun.value + wfK)) < 1e-12, `${aug.ret}`);
  check('Khaled without Jul-26: since-inception TWR within 0.05 pp of the full-data figure', Math.abs(RG.stats.twr - RK.stats.twr) < 0.0005, `${(RG.stats.twr * 100).toFixed(3)}% vs ${(RK.stats.twr * 100).toFixed(3)}%`);
  check('Khaled without Jul-26: Sharpe within 0.15 of the full-data figure, n 13 of 14 elapsed', Math.abs(RG.stats.sharpe - RK.stats.sharpe) < 0.15 && RG.stats.n === 13 && RG.stats.monthsElapsed === 14 && RG.stats.gaps.join() === '2026-07', `${RG.stats.sharpe} vs ${RK.stats.sharpe}`);
  check('Khaled without Jul-26: deposits, withdrawals, dividends and trades totals unchanged', RG.stats.deposits === RK.stats.deposits && RG.stats.withdrawals === RK.stats.withdrawals && Math.abs(RG.stats.dividends - RK.stats.dividends) < 1e-9 && RG.stats.trades === RK.stats.trades);
  // 9c. trips vs legacy closed-trade stats
  const RN = K.run({ closedTrades: 'name' }), sN = RN.stats, sT = RK.stats;
  check('Khaled legacy (name) closed trades: 42, win rate 54.8%, avg hold 64 days', sN.closedCount === 42 && Math.abs(sN.winRate - 0.5476) < 1e-3 && Math.abs(sN.avgHold - 64) < 0.5 && sN.closedCashLike === 0, `${sN.closedCount} ${(sN.winRate * 100).toFixed(1)}% ${sN.avgHold.toFixed(1)}d`);
  check('Khaled trips: 52 closed round trips (10 cash-like excluded), win rate ~54%, avg hold ~40 days', sT.closedTrades === 'trip' && sT.closedCount === 52 && sT.closedCashLike === 10 && Math.abs(sT.winRate - 0.5385) < 1e-3 && sT.avgHold > 38 && sT.avgHold < 44, `${sT.closedCount} ${(sT.winRate * 100).toFixed(1)}% ${sT.avgHold.toFixed(1)}d`);
  const tmg = RK.pos.trips.filter((t) => t.name === 'TMG Holding');
  check('Khaled: TMG Holding has two closed trips (Mar-26 and May→Jun-26) and rows[].trips = 2', tmg.length === 2 && tmg[1].firstBuy === '2026-03-04' && tmg[1].lastSell === '2026-03-08' && tmg[0].firstBuy === '2026-05-03' && tmg[0].lastSell === '2026-06-16' && RK.pos.rows.find((r) => r.name === 'TMG Holding').trips === 2, tmg.map((t) => `${t.trip}: ${t.firstBuy}→${t.lastSell}`).join(', '));
  const offRows = RK.pos.rows.filter((r) => r.status === 'Closed').filter((r) => { const tt = RK.pos.trips.filter((t) => t.name === r.name); return Math.abs(tt.reduce((a, t) => a + t.realized, 0) - r.realized) > 0.01 || Math.abs(tt.reduce((a, t) => a + t.divs, 0) - r.divs) > 0.01; });
  check('Khaled: every closed name\'s trips add up to its row (realized and dividends)', offRows.length === 0, offRows.map((r) => r.name).join(', ') || 'all match');
  check('Khaled: S.realized unchanged between modes', sN.realized === sT.realized, `${sT.realized}`);
  // 9d. workbook cut-off (tools/excel.js run as a child process)
  const xlOut = path.join(SP, 'fix2', 'tmp', 'engine', 'xl_test.json');
  try {
    fs.mkdirSync(path.dirname(xlOut), { recursive: true });
    require('child_process').execFileSync(process.execPath, ['excel.js', '--data', fixK, '--month', '2026-08', '--out', xlOut], { cwd: path.join(SP, 'tools'), stdio: 'pipe' });
    const X = JSON.parse(fs.readFileSync(xlOut));
    const rebAug = K.tx.filter((t) => t.t === 'Rebate' && t.d >= '2026-01-01' && t.d <= '2026-08-31').reduce((a, t) => a + (t.amt || 0), 0);
    const y26 = X.incomeYears.find((y) => y.year === '2026');
    check('Workbook Aug-26: 2026 rebates equal the ledger through 31 Aug (16,615.83)', Math.abs(y26.rebT - rebAug) < 0.005 && Math.abs(rebAug - 16615.83) < 0.005 && y26.reb[8] === 0, `${y26.rebT.toFixed(2)} vs ${rebAug.toFixed(2)}`);
    check('Workbook Aug-26: closed sheet has TMG Holding\'s trip ending 2026-06-16 and nothing after August', X.closed.some((r) => r.name === 'TMG Holding' && r.lastSell === '2026-06-16' && r.trip === 2) && X.closed.every((r) => r.lastSell <= '2026-08-31') && X.ledger.every((t) => t.date <= '2026-08-31'), `${X.closed.length} closed trips, latest ${X.closed[0] && X.closed[0].lastSell}`);
  } catch (e) { check('Workbook Aug-26 build (tools/excel.js)', false, String(e.stderr || e.message).slice(0, 300)); }
  // 9e. cash-source warn
  const cY = RY.checks.find((c) => c.label === 'Broker cash reconciles to ledger'), cK = RK.checks.find((c) => c.label === 'Broker cash reconciles to ledger');
  check('Yassin: broker cash check warns (source is the workbook, not a statement)', cY.status === 'warn' && /not from a Thndr statement \(workbook/.test(cY.detail), cY.detail);
  check('Khaled: broker cash check stays ok (Thndr statement)', cK.status === 'ok' && /from Thndr statement/.test(cK.detail), cK.detail);
} else console.log('SKIP fix/export-* checks (not found)');

console.log(fail ? `FAIL ${fail}` : 'ALL PASS');
process.exit(fail ? 1 : 0);
