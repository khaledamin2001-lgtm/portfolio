/* Modified Dietz checks: a synthetic month, a no-flow month against the legacy formula, and the real Khaled export.
   node test_dietz.js → PASS/FAIL lines, exit 1 on any failure. */
const fs = require('fs'), path = require('path');
const PE = require('../engine.js'), PA = require('../engine2.js');
let fail = 0;
const check = (name, ok, detail) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail != null ? ' · ' + detail : '')); if (!ok) fail++; };
// figures of the real exports that the private-data sections pin (expected.json → pins, private like the rest of that file);
// without them those sections still check every internal invariant, only the pinned value is skipped
const PIN = (() => { try { return JSON.parse(fs.readFileSync(process.env.EXPECTED_JSON || path.join(__dirname, 'expected.json'))).pins || {}; } catch (e) { return {}; } })();

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
  // the real counts, win rates and one stock's trip dates are private: pinned in expected.json → pins.trips (skipped without it)
  const PT = PIN.trips;
  check(`Khaled legacy (name) closed trades: counted, cash-like names never excluded${PT ? ' and equal to the pinned count / win rate / hold' : ' (pinned figures skipped)'}`, sN.closedCount > 0 && sN.closedCashLike === 0 && sN.winRate >= 0 && sN.winRate <= 1 && (!PT || (sN.closedCount === PT.legacyCount && Math.abs(sN.winRate - PT.legacyWin) < 1e-3 && Math.abs(sN.avgHold - PT.legacyHold) < 0.5)), `${sN.closedCount} ${(sN.winRate * 100).toFixed(1)}% ${sN.avgHold.toFixed(1)}d`);
  check(`Khaled trips: at least as many round trips as closed names, cash-like trips excluded${PT ? ' and equal to the pinned figures' : ' (pinned figures skipped)'}`, sT.closedTrades === 'trip' && sT.closedCount >= sN.closedCount && sT.closedCashLike >= 0 && (!PT || (sT.closedCount === PT.tripCount && sT.closedCashLike === PT.tripCashLike && Math.abs(sT.winRate - PT.tripWin) < 1e-3 && sT.avgHold > PT.tripHoldLo && sT.avgHold < PT.tripHoldHi)), `${sT.closedCount} ${(sT.winRate * 100).toFixed(1)}% ${sT.avgHold.toFixed(1)}d`);
  if (PT && PT.twoTrips) { const w = PT.twoTrips, tt = RK.pos.trips.filter((t) => t.name === w.name);
    check('Khaled: the pinned name has its two closed trips on the pinned dates and rows[].trips = 2', tt.length === 2 && tt[1].firstBuy === w.t2[0] && tt[1].lastSell === w.t2[1] && tt[0].firstBuy === w.t1[0] && tt[0].lastSell === w.t1[1] && RK.pos.rows.find((r) => r.name === w.name).trips === 2, tt.map((t) => `${t.trip}: ${t.firstBuy}→${t.lastSell}`).join(', '));
  } else { const multi = RK.pos.rows.filter((r) => r.trips >= 2);
    check('Khaled: a name bought again after selling out has one trip per round trip (pinned dates skipped)', multi.every((r) => RK.pos.trips.filter((t) => t.name === r.name).length === r.trips), `${multi.length} names with 2+ trips`); }
  const offRows = RK.pos.rows.filter((r) => r.status === 'Closed').filter((r) => { const tt = RK.pos.trips.filter((t) => t.name === r.name); return Math.abs(tt.reduce((a, t) => a + t.realized, 0) - r.realized) > 0.01 || Math.abs(tt.reduce((a, t) => a + t.divs, 0) - r.divs) > 0.01; });
  check('Khaled: every closed name\'s trips add up to its row (realized and dividends)', offRows.length === 0, offRows.map((r) => r.name).join(', ') || 'all match');
  check('Khaled: S.realized unchanged between modes', sN.realized === sT.realized, `${sT.realized}`);
  // 9d. workbook cut-off (tools/excel.js run as a child process)
  const xlOut = path.join(SP, 'fix3', 'tmp', 'engine', 'xl_test.json');
  try {
    fs.mkdirSync(path.dirname(xlOut), { recursive: true });
    require('child_process').execFileSync(process.execPath, ['excel.js', '--data', fixK, '--month', '2026-08', '--out', xlOut], { cwd: path.join(SP, 'tools'), stdio: 'pipe' });
    const X = JSON.parse(fs.readFileSync(xlOut));
    const rebAug = K.tx.filter((t) => t.t === 'Rebate' && t.d >= '2026-01-01' && t.d <= '2026-08-31').reduce((a, t) => a + (t.amt || 0), 0);
    const y26 = X.incomeYears.find((y) => y.year === '2026');
    check(`Workbook Aug-26: 2026 rebates equal the ledger through 31 Aug${PIN.rebates2026ThroughAug == null ? ' (pinned figure skipped: expected.json pins.rebates2026ThroughAug is private)' : ' and the pinned figure'}`, Math.abs(y26.rebT - rebAug) < 0.005 && (PIN.rebates2026ThroughAug == null || Math.abs(rebAug - PIN.rebates2026ThroughAug) < 0.005) && y26.reb[8] === 0, `${y26.rebT.toFixed(2)} vs ${rebAug.toFixed(2)}`);
    const W2 = PIN.trips && PIN.trips.twoTrips;   // private: the name with two round trips and its dates
    check(`Workbook Aug-26: closed sheet has nothing after August${W2 ? " and the pinned name's second trip" : ' (pinned trip skipped)'}`, (!W2 || X.closed.some((r) => r.name === W2.name && r.lastSell === W2.t1[1] && r.trip === 2)) && X.closed.every((r) => r.lastSell <= '2026-08-31') && X.ledger.every((t) => t.date <= '2026-08-31'), `${X.closed.length} closed trips, latest ${X.closed[0] && X.closed[0].lastSell}`);
  } catch (e) { check('Workbook Aug-26 build (tools/excel.js)', false, String(e.stderr || e.message).slice(0, 300)); }
  // 9e. cash-source warn
  const cY = RY.checks.find((c) => c.label === 'Broker cash reconciles to ledger'), cK = RK.checks.find((c) => c.label === 'Broker cash reconciles to ledger');
  check('Yassin: broker cash check warns (source is the workbook, not a statement)', cY.status === 'warn' && /not from a Thndr statement \(workbook/.test(cY.detail), cY.detail);
  check('Khaled: broker cash check stays ok (Thndr statement)', cK.status === 'ok' && /from Thndr statement/.test(cK.detail), cK.detail);
} else console.log('SKIP fix/export-* checks (not found)');

// 10. polish round: missing benchmark months, small samples, attribution across a gap, calendar-month trailing windows
{
  const st = { ...settings, openingValue: 1000 };
  const mkN = (n, benchOf) => { const m = {}; for (let i = 0; i < n; i++) { const b = benchOf ? benchOf(i) : 0.01 * ((i % 3) - 1); m[PE.addMonths('2026-01', i)] = { cash: 0, securities: 1000 * (1 + 0.02 * (i + 1)) * (1 + 0.01 * (i % 2)), ...(b != null ? { benchReturn: b } : {}) }; } return m; };
  const runN = (marks) => PE.run({ settings: st, marks, assets: {}, tx: [] }, { type: 'Since Inception' }, { today: '2028-01-10', live: false }).stats;
  // 10.1 a month with no benchmark return: benchTwr/alpha null (not chained as 0%), pctBeat over the months that have one
  const S1 = runN(mkN(8, (i) => (i === 4 ? null : 0.001)));
  const b1 = S1.rows.filter((r) => r.bench != null);
  check('Missing benchmark month: benchTwr and alpha null, benchComplete false, pBench null from that month on', S1.benchTwr === null && S1.alpha === null && S1.benchComplete === false && S1.rows[3].pBench != null && S1.rows[4].pBench === null && S1.rows[7].pBench === null, JSON.stringify({ benchTwr: S1.benchTwr, alpha: S1.alpha, pBench: S1.rows.map((r) => r.pBench) }));
  check('Missing benchmark month: pctBeat = beat ÷ 7 months with a benchmark (not ÷ 8)', b1.length === 7 && S1.benchMonths === 7 && Math.abs(S1.pctBeat - S1.beat / 7) < 1e-12 && S1.beat === 7, `${S1.beat}/${S1.benchMonths} = ${S1.pctBeat}`);
  const S1c = runN(mkN(8, () => 0.001));
  check('Complete benchmark: benchTwr chains every month, alpha = twr − benchTwr', S1c.benchComplete && Math.abs(S1c.benchTwr - (Math.pow(1.001, 8) - 1)) < 1e-12 && Math.abs(S1c.alpha - (S1c.twr - S1c.benchTwr)) < 1e-12, `${S1c.benchTwr}`);
  // 10.2 small samples: ratios need 6 returns; smallSample below 12; the risk label needs 3
  const S5 = runN(mkN(5)), S6 = runN(mkN(6)), S12 = runN(mkN(12)), S2 = runN(mkN(2)), S3 = runN(mkN(3));
  const ratios = (x) => [x.sharpe, x.sortino, x.beta, x.correl, x.trackingError, x.upCapture, x.downCapture];
  check('5 returns: Sharpe, Sortino, beta, correlation, tracking error and capture ratios are all null', S5.n === 5 && ratios(S5).every((v) => v === null) && S5.smallSample === true, JSON.stringify(ratios(S5)));
  check('6 returns: ratios computed, still smallSample', S6.n === 6 && ratios(S6).every((v) => v != null && isFinite(v)) && S6.smallSample === true, JSON.stringify(ratios(S6).map((v) => v && +v.toFixed(3))));
  check('12 returns: smallSample false', S12.n === 12 && S12.smallSample === false && S12.sharpe != null);
  check("Risk label: 'n/a' with 2 returns, rated with 3", S2.risk === 'n/a' && S3.risk !== 'n/a' && ['Low', 'Moderate', 'High'].includes(S3.risk), `${S2.risk} / ${S3.risk}`);
  const S6b = runN(mkN(7, (i) => (i < 2 ? null : 0.001)));
  check('Benchmark ratios need 6 months WITH a benchmark (7 returns, 5 with one → beta null, Sharpe computed)', S6b.n === 7 && S6b.benchMonths === 5 && S6b.beta === null && S6b.correl === null && S6b.trackingError === null && S6b.upCapture === null && S6b.sharpe != null, JSON.stringify({ beta: S6b.beta, sharpe: S6b.sharpe }));
  // 10.4 trailing windows are calendar months; a spanning row counts only if it starts inside the window
  const mkT = { '2026-01': { cash: 0, securities: 1010, benchReturn: 0.01 }, '2026-02': { cash: 0, securities: 1030, benchReturn: 0.01 }, '2026-03': { benchReturn: 0.01 }, '2026-04': { cash: 0, securities: 1050, benchReturn: 0.01 }, '2026-05': { cash: 0, securities: 1100, benchReturn: 0.01 }, '2026-06': { cash: 0, securities: 1080, benchReturn: 0.01 } };
  const GT = PE.run({ settings: st, marks: mkT, assets: {}, tx: [] }, { type: 'Since Inception' }, { today: '2026-07-10', live: false });
  const T6 = PA.trailing(GT.months, '2026-06'), T5 = PA.trailing(GT.months, '2026-05'), T4 = PA.trailing(GT.months, '2026-04');
  const tv = (T, l) => T.find((t) => t.label === l);
  const rr = (m) => GT.months.find((r) => r.month === m).ret;
  check('Trailing 3M to Jun-26 is null: Apr-26 spans Mar–Apr and Mar is before the window', tv(T6, '3M').p === null && tv(T6, '3M').n === 0, JSON.stringify(tv(T6, '3M')));
  check('Trailing 3M to May-26 = Mar–Apr span × May, n = 3 calendar months', Math.abs(tv(T5, '3M').p - ((1 + rr('2026-04')) * (1 + rr('2026-05')) - 1)) < 1e-12 && tv(T5, '3M').n === 3, JSON.stringify(tv(T5, '3M')));
  check('Trailing 6M/YTD/Since inception to Jun-26 cover 6 calendar months from 5 returns; 1Y null (before inception)', tv(T6, '6M').n === 6 && tv(T6, 'YTD').n === 6 && tv(T6, 'Since inception').n === 6 && Math.abs(tv(T6, '6M').p - (1080 / 1000 - 1)) < 1e-12 && tv(T6, '1Y').p === null, JSON.stringify([tv(T6, '6M'), tv(T6, '1Y')].map((t) => [t.p, t.n])));
  check('Trailing 1M to Apr-26 (a two-month span) is null; 1M to Jun-26 is Jun alone', tv(T4, '1M').p === null && Math.abs(tv(T6, '1M').p - rr('2026-06')) < 1e-12 && tv(T6, '1M').n === 1);
  check('Trailing benchmark over a covered window chains the span rows (3M to May: 1.01² × 1.01 = 3 months)', Math.abs(tv(T5, '3M').b - ((1 + GT.months.find((r) => r.month === '2026-04').bench) * 1.01 - 1)) < 1e-12 && Math.abs(tv(T5, '3M').b - (Math.pow(1.01, 3) - 1)) < 1e-12, `${tv(T5, '3M').b}`);
}
// 10.3 + 10.4 on real data (fix/export-khaled): attribution across a gap covers the span; trailing 1Y = 12 calendar months
if (fs.existsSync(fixK)) {
  const J = (f) => { const x = JSON.parse(fs.readFileSync(f)); return x.data || x; };
  const D = (...p) => path.join(fixK, ...p), today = '2026-09-27';
  const s = J(D('portfolio', 'settings.json')), mk0 = J(D('portfolio', 'marks.json')).months, assets = J(D('portfolio', 'assets.json')).items;
  const tx = fs.readdirSync(D('ledger')).filter((f) => /^y\d{4}\.json$/.test(f)).sort().flatMap((f) => J(D('ledger', f)).rows || []);
  const history = {}; fs.readdirSync(D('history')).forEach((f) => { history[f.replace('.json', '')] = J(D('history', f)); });
  const market = J(D('market', 'latest.json')), bench = J(D('bench', 'egx30.json'));
  const pb = PA.priceBook(history), mk = PA.estimateMarks(s, mk0, PE.runLedger(tx), assets, pb, today);
  const run = (marks) => PE.run({ settings: s, marks, assets, tx, market }, { type: 'Since Inception' }, { today });
  const RF = run(mk), gap = { ...mk }; delete gap['2026-07']; const RG = run(gap);
  const AF = PA.attribution(RF.months, { from: '2026-07', to: '2026-08' }, RF.ledger, assets, pb, bench, today);
  const AG = PA.attribution(RG.months, { from: '2026-07', to: '2026-08' }, RG.ledger, assets, pb, bench, today);
  const g = AG.months[0], aug = RG.months.find((r) => r.month === '2026-08');
  check('Attribution across a gap: the Aug-26 row (spans 2) starts at the last session of Jun-26 with Jun-26 holdings', AG.months.length === 1 && g.spans === 2 && g.d0 === pb.lastDayOnOrBefore('2026-06-30') && g.d0 > '2026-06-20' && Math.abs(g.startValue - AF.months[0].startValue) < 1e-6, `d0 ${g.d0} d1 ${g.d1} startValue ${g.startValue}`);
  check('Attribution across a gap: R and B are the span figures and the index model gap stays small (|B* − B| < 1 pp)', Math.abs(g.R - aug.ret) < 1e-12 && Math.abs(g.B - aug.bench) < 1e-12 && Math.abs(g.replication) < 0.01, `R ${g.R} B ${g.B} B* ${g.Bs} gap ${g.replication}`);
  check('Attribution across a gap: B* over the span within 0.2 pp of the full data chained over Jul and Aug', Math.abs(g.Bs - (AF.months.reduce((a, m) => a * (1 + m.Bs), 1) - 1)) < 0.002 && Math.abs(AG.alloc + AG.sel + AG.trading + AG.replication - AG.active) < 1e-9, `${g.Bs}`);
  check('Attribution result carries tradingNote', AF.tradingNote === PA.TRADING_NOTE && /dividends, rebates and fees/.test(AF.tradingNote));
  const TK = PA.trailing(RF.months, '2026-08');
  check('Khaled trailing to Aug-26: 1Y from Sep-25 over 12 months, since inception 13 months annualized', TK.find((t) => t.label === '1Y').n === 12 && TK.find((t) => t.label === '1Y').from === '2025-09' && TK.find((t) => t.label === 'Since inception').n === 13 && TK.find((t) => t.label === 'Since inception').ann != null, TK.map((t) => `${t.label} ${t.n}`).join(', '));
  check('Khaled since inception: 14 returns, not a small sample, pctBeat over months with a benchmark', RF.stats.n === 14 && RF.stats.smallSample === false && RF.stats.benchMonths === 14 && Math.abs(RF.stats.pctBeat - RF.stats.beat / 14) < 1e-12, `${RF.stats.beat}/${RF.stats.benchMonths}`);
}

// 11. Excel workbook (tools/excel.js + excel.py) for Aug-26: Monthly holds values, the formulas moved to the last sheet
if (fs.existsSync(fixK)) {
  const T = path.join(SP, 'fix3', 'tmp', 'engine'), cp = require('child_process');
  const J0 = (f) => { const x = JSON.parse(fs.readFileSync(f)); return x.data || x; };
  try {
    fs.mkdirSync(T, { recursive: true });
    cp.execFileSync(process.execPath, ['excel.js', '--data', fixK, '--month', '2026-08', '--out', path.join(T, 'xl.json')], { cwd: path.join(SP, 'tools'), stdio: 'pipe' });
    // formula-injection probe: the same data with hostile text in a ledger note, an asset name and a closed trade
    const X = JSON.parse(fs.readFileSync(path.join(T, 'xl.json')));
    X.ledger[0].note = '=HYPERLINK("http://x","y")'; X.ledger[1].asset = '@SUM(A1)'; X.ledger[2].note = '-5 fee'; X.ledger[3].note = '+20';
    X.marks[0].cpiSource = 'CAPMAS';
    // partial CPI: an overlay whose Aug-26 mark has no CPI makes excel.js fall back to the real return through Jul-26
    const ov = path.join(T, 'overlay-nocpi'); fs.mkdirSync(ov, { recursive: true });
    const mOv = J0(path.join(fixK, 'portfolio', 'marks.json')); delete mOv.months['2026-08'].cpi; fs.writeFileSync(path.join(ov, 'marks.json'), JSON.stringify(mOv));
    cp.execFileSync(process.execPath, ['excel.js', '--data', fixK, '--overlay', ov, '--month', '2026-08', '--out', path.join(T, 'xl_nocpi.json')], { cwd: path.join(SP, 'tools'), stdio: 'pipe' });
    X.labels = JSON.parse(fs.readFileSync(path.join(T, 'xl_nocpi.json'))).labels;
    X.summary['Real return (after CPI)'] = JSON.parse(fs.readFileSync(path.join(T, 'xl_nocpi.json'))).summary['Real return (after CPI)'];
    fs.writeFileSync(path.join(T, 'xl_inj.json'), JSON.stringify(X));
    cp.execFileSync('python3', ['excel.py', path.join(T, 'xl.json'), path.join(T, 'test.xlsx')], { cwd: path.join(SP, 'tools'), stdio: 'pipe' });
    cp.execFileSync('python3', ['excel.py', path.join(T, 'xl_inj.json'), path.join(T, 'test_inj.xlsx')], { cwd: path.join(SP, 'tools'), stdio: 'pipe' });
    const py = `
import json, sys
from openpyxl import load_workbook
T = sys.argv[1]
v = load_workbook(T + '/test.xlsx', data_only=True); f = load_workbook(T + '/test.xlsx'); i = load_workbook(T + '/test_inj.xlsx')
m = v['Monthly']; hdr = [c.value for c in m[3]]; K = hdr.index('Return') + 1
rets = [m.cell(r, K).value for r in range(4, m.max_row + 1)]
fm = f['Monthly (formulas)']
led = i['Ledger']; lh = [c.value for c in led[3]]
cells = [led.cell(4, lh.index('Note') + 1), led.cell(5, lh.index('Asset') + 1), led.cell(6, lh.index('Note') + 1), led.cell(7, lh.index('Note') + 1)]
summ = {r[0].value: r[1] for r in v['Summary'].iter_rows(min_row=1) if r[0].value}
summI = {r[0].value: r[1] for r in i['Summary'].iter_rows(min_row=1) if r[0].value}
closed = [r[0].value for r in v['Closed trades'].iter_rows(min_row=4)]
print(json.dumps({
  'sheets': v.sheetnames, 'rets': rets, 'monthlyFormulaCells': sum(1 for row in f['Monthly'].iter_rows() for c in row if c.data_type == 'f'),
  'fK4': fm['K4'].value, 'fK4type': fm['K4'].data_type, 'fNote': fm['A1'].value,
  'inj': [[c.value, c.data_type] for c in cells],
  'diff': summ['Difference: statement value vs closing prices (EGP)'].value, 'holdNote': v['Holdings']['A1'].value,
  'fmt': {k: summ[k].number_format for k in ['Month return', 'Risk-free rate used', 'Upside capture', 'Annualized volatility', 'Tracking error (annual)', 'Max drawdown (month-end)']},
  'realLabel': [k for k in summI if str(k).startswith('Real return')], 'marksHdr': [c.value for c in v['Marks & inputs'][3]], 'marksHdrI': [c.value for c in i['Marks & inputs'][3]],
  'closed': [c for c in closed if c]}))
`;
    const Q = JSON.parse(cp.execFileSync('python3', ['-c', py, T], { encoding: 'utf8' }));
    check('Workbook: Monthly Return cells hold numbers when read with data_only=True (13 months, no formulas on the sheet)', Q.rets.length === 13 && Q.rets.every((x) => typeof x === 'number') && Q.monthlyFormulaCells === 0, Q.rets.map((x) => (x * 100).toFixed(2)).join(' '));
    check("Workbook: last sheet 'Monthly (formulas)' keeps the live formulas and the phone-preview note", Q.sheets[Q.sheets.length - 1] === 'Monthly (formulas)' && Q.fK4 === '=(J4-B4-E4)/(B4+F4)' && Q.fK4type === 'f' && /phone previews show the Monthly sheet/.test(Q.fNote), Q.sheets.join(', '));
    check('Workbook: text starting with = @ - + is stored as text, never a formula', Q.inj.every(([v, t]) => t === 's') && Q.inj[0][0] === '=HYPERLINK("http://x","y")' && Q.inj[1][0] === '@SUM(A1)', JSON.stringify(Q.inj));
    const gapX = JSON.parse(fs.readFileSync(path.join(T, 'xl.json'))).summary['Difference: statement value vs closing prices (EGP)'];
    const gapTxt = `${Math.round(Math.abs(gapX)).toLocaleString('en-US')} EGP ${gapX > 0 ? 'lower' : 'higher'}`;
    check(`Workbook: Summary shows the statement-vs-closes difference and Holdings explains it${PIN.workbookGapAug == null ? ' (pinned figure skipped: expected.json pins.workbookGapAug is private)' : ' (and it is the pinned figure)'}`, Math.abs(gapX) >= 0.5 && Math.abs(Q.diff - gapX) < 0.005 && String(Q.holdNote).includes(gapTxt) && (PIN.workbookGapAug == null || Math.abs(Q.diff - PIN.workbookGapAug) < 1), `${Q.diff}`);
    check('Workbook: unsigned figures use 0.0%, returns the signed 2-decimal format', Q.fmt['Month return'] === '+0.00%;-0.00%;0.00%' && Q.fmt['Max drawdown (month-end)'] === '+0.00%;-0.00%;0.00%' && ['Risk-free rate used', 'Upside capture', 'Annualized volatility', 'Tracking error (annual)'].every((k) => Q.fmt[k] === '0.0%'), JSON.stringify(Q.fmt));
    check("Workbook: partial real return is labelled 'through <Mon-YY>'", Q.realLabel.join() === 'Real return (after CPI, through Jul-26)', Q.realLabel.join());
    check('Workbook: Marks & inputs drops empty source columns and keeps one that has data', !Q.marksHdr.includes('CPI source') && !Q.marksHdr.includes('USD/EGP source') && Q.marksHdrI.includes('CPI source') && !Q.marksHdrI.includes('USD/EGP source'), `${Q.marksHdr.join('|')}`);
    { const W2 = PIN.trips && PIN.trips.twoTrips; const rep = Q.closed.filter((c) => / \(\d+\)$/.test(String(c))), base = (c) => String(c).replace(/ \(\d+\)$/, '');
      const ok = rep.length > 0 && rep.every((c) => rep.filter((x) => base(x) === base(c)).length >= 2) && (!W2 || rep.filter((c) => base(c) === W2.name).join() === `${W2.name} (2),${W2.name} (1)`);
      check(`Workbook: Closed trades numbers repeat trips (Name (2), Name (1))${W2 ? ' incl. the pinned name' : ''}`, ok, `${rep.length} numbered rows`); }
  } catch (e) { check('Workbook Aug-26 build and openpyxl read-back', false, String(e.stderr || e.message).slice(0, 400)); }
}

// 12. ideas round: cash benchmark, Jensen's alpha, index with dividends, trading costs, daily-linked TWR, provenance
{
  const st = { ...settings, openingValue: 1000, riskFree: 0.24 };
  const mR = (r) => Math.pow(1 + r, 1 / 12) - 1;
  // 12.1 cash benchmark: marks[M].cashRate, fallback settings.riskFree, a gap month compounds both months' rates
  const mkC = { '2026-01': { cash: 0, securities: 1020, cashRate: 0.27 }, '2026-02': { cashRate: 0.25 }, '2026-03': { cash: 0, securities: 1050, cashRate: 0.22 }, '2026-04': { cash: 0, securities: 1060 } };
  const C = PE.run({ settings: st, marks: mkC, assets: {}, tx: [] }, { type: 'Since Inception' }, { today: '2026-05-10', live: false });
  const [c1, c2, c3, c4] = C.months;
  check('Cash: Jan-26 cashRet = 1.27^(1/12) − 1 from marks cashRate, no fallback', Math.abs(c1.cashRet - mR(0.27)) < 1e-15 && c1.cashFallback === false && c1.cashRate === 0.27, `${c1.cashRet}`);
  check('Cash: gap Feb-26 has cashRet null; Mar-26 (spans 2) compounds Feb 25% and Mar 22%', c2.cashRet === null && c3.spans === 2 && Math.abs(c3.cashRet - ((1 + mR(0.25)) * (1 + mR(0.22)) - 1)) < 1e-15, `${c3.cashRet}`);
  check('Cash: Apr-26 without cashRate falls back to settings.riskFree and is flagged', Math.abs(c4.cashRet - mR(0.24)) < 1e-15 && c4.cashFallback === true, `${c4.cashRet}`);
  const expCash = (1 + mR(0.27)) * (1 + mR(0.25)) * (1 + mR(0.22)) * (1 + mR(0.24)) - 1;
  check('Cash: cashTwr chains every calendar month, aheadOfCash = twr − cashTwr, cashComplete false, pCash on rows', Math.abs(C.stats.cashTwr - expCash) < 1e-12 && Math.abs(C.stats.aheadOfCash - (C.stats.twr - expCash)) < 1e-12 && C.stats.cashComplete === false && C.stats.cashFallbackMonths.join() === '2026-04' && Math.abs(C.stats.rows[2].pCash - expCash) < 1e-12, JSON.stringify({ cashTwr: C.stats.cashTwr, ahead: C.stats.aheadOfCash }));
  const C2 = PE.run({ settings: st, marks: { ...mkC, '2026-04': { ...mkC['2026-04'], cashRate: 0.2 } }, assets: {}, tx: [] }, { type: 'Since Inception' }, { today: '2026-05-10', live: false });
  check('Cash: every month with a cashRate → cashComplete true', C2.stats.cashComplete === true && C2.stats.cashFallbackMonths.length === 0);
  // the live month uses market.rates.policy (the current CBE rate) instead of the fallback
  const C3 = PE.run({ settings: { ...st, cash: 1100 }, marks: { '2026-01': mkC['2026-01'] }, assets: {}, tx: [], market: { rates: { policy: { rate: 0.19, date: '2026-02', source: 'test' } } } }, { type: 'Since Inception' }, { today: '2026-02-10' });
  const liveRow = C3.months.find((r) => r.month === '2026-02');
  check('Cash: the live month takes market.rates.policy.rate (19%) and is not a fallback', liveRow.live && Math.abs(liveRow.cashRet - mR(0.19)) < 1e-15 && !liveRow.cashFallback && C3.stats.cashComplete === true, `${liveRow.cashRet}`);
  const mkN8 = (rate) => { const m = {}; for (let i = 0; i < 8; i++) m[PE.addMonths('2026-01', i)] = { cash: 0, securities: 1000 * (1 + 0.02 * (i + 1)) * (1 + 0.01 * (i % 2)), benchReturn: 0.01 * ((i % 3) - 1) + 0.002 * i, ...(rate != null ? { cashRate: rate } : {}) }; return m; };
  const sh0 = PE.run({ settings: st, marks: mkN8(), assets: {}, tx: [] }, { type: 'Since Inception' }, { today: '2027-01-10', live: false }).stats, sh5 = PE.run({ settings: st, marks: mkN8(0.05), assets: {}, tx: [] }, { type: 'Since Inception' }, { today: '2027-01-10', live: false }).stats;
  check('Cash: Sharpe and Sortino keep settings.riskFree (a 5% cashRate changes cashTwr only)', sh0.sharpe != null && sh0.sharpe === sh5.sharpe && sh0.sortino === sh5.sortino && sh0.cashTwr !== sh5.cashTwr, `${sh0.sharpe}`);
  // 12.2 Jensen's alpha = ((avg − rfM) − beta (avgBench − rfM)) × 12; null with fewer than 6 benchmark months
  const SJ = PE.run({ settings: st, marks: mkN8(), assets: {}, tx: [] }, { type: 'Since Inception' }, { today: '2027-01-10', live: false }).stats;
  const rets = SJ.rows.map((r) => r.ret), bs = SJ.rows.map((r) => r.bench), avg = rets.reduce((a, x) => a + x, 0) / 8, avgB = bs.reduce((a, x) => a + x, 0) / 8, rfM = mR(0.24);
  const cov = rets.reduce((a, x, i) => a + (x - avg) * (bs[i] - avgB), 0) / 7, vb = bs.reduce((a, x) => a + (x - avgB) ** 2, 0) / 7;
  check("Jensen's alpha: ((avg − rfM) − β(avgBench − rfM)) × 12", Math.abs(SJ.jensen - ((avg - rfM) - (cov / vb) * (avgB - rfM)) * 12) < 1e-12 && Math.abs(SJ.beta - cov / vb) < 1e-12, `${SJ.jensen}`);
  const SJ5 = PE.run({ settings: st, marks: Object.fromEntries(Object.entries(mkN8()).slice(0, 5)), assets: {}, tx: [] }, { type: 'Since Inception' }, { today: '2027-01-10', live: false }).stats;
  check("Jensen's alpha is null when beta is null (5 months)", SJ5.beta === null && SJ5.jensen === null);
  // 12.3 index with dividends (estimate) from data.bench.divYield
  const RB = PE.run({ settings: st, marks: mkN8(), assets: {}, tx: [], bench: { divYield: 0.05, divYieldAsOf: '2026-09-27' } }, { type: 'Since Inception' }, { today: '2027-01-10', live: false }).stats;
  check('benchDivYield passes through; benchTrEstimate = (1 + benchTwr) × 1.05^(8/12) − 1', RB.benchDivYield === 0.05 && RB.benchDivYieldAsOf === '2026-09-27' && Math.abs(RB.benchTrEstimate - ((1 + RB.benchTwr) * Math.pow(1.05, 8 / 12) - 1)) < 1e-12, `${RB.benchTrEstimate}`);
  check('Without data.bench.divYield both are null', SJ.benchDivYield === null && SJ.benchTrEstimate === null);
  // 12.4 trading costs
  const ctx = [
    { id: 'k1', d: '2026-01-05', t: 'Deposit', amt: 5000 },
    { id: 'k2', d: '2026-01-06', t: 'Buy', a: 'X', q: 100, p: 10, amt: -1002.5 },
    { id: 'k3', d: '2026-01-20', t: 'Sell', a: 'X', q: 100, p: 12, amt: 1197.004 },
    { id: 'k4', d: '2026-01-21', t: 'Buy', a: 'thndrsavings', acc: 'MF', q: 500, p: 1, amt: -501 },
    { id: 'k5', d: '2026-01-22', t: 'Buy', a: 'Y', q: 10, amt: -100 },
    { id: 'k6', d: '2026-01-23', t: 'Buy', a: 'Z', q: 10, p: 10, amt: -99.2 },
  ];
  const LC = PE.runLedger(ctx), byId = (id) => LC.find((t) => t.id === id);
  check('Costs: Buy |amt| − p×q = 2.50; Sell p×q − amt = 2.996 → 3.00 (2 dp)', byId('k2').cost === 2.5 && byId('k3').cost === 3, `${byId('k2').cost} ${byId('k3').cost}`);
  check('Costs: fund row (acc MF) and a row without a price carry no cost; a negative cost clamps to 0', byId('k4').cost === undefined && byId('k5').cost === undefined && byId('k6').cost === 0 && byId('k1').cost === undefined && Math.abs(PE.tradeCostRaw(byId('k6')) + 0.8) < 1e-9);
  const RC = PE.run({ settings: { ...st, openingValue: 0 }, marks: { '2026-01': { cash: 3000, securities: 2000 } }, assets: {}, tx: ctx }, { type: 'Since Inception' }, { today: '2026-02-10', live: false });
  const jan = RC.months[0], S = RC.stats;
  check('Costs: month tradingCost 5.50, tradedValue 1000 + 1200 + 100, costPct = 5.5 / 2300', jan.tradingCost === 5.5 && jan.tradedValue === 2300 && S.tradingCost === 5.5 && S.tradedValue === 2300 && Math.abs(S.costPct - 5.5 / 2300) < 1e-15, JSON.stringify({ tc: jan.tradingCost, tv: jan.tradedValue }));
  check('Costs: retGross adds the month\'s cost back to the month-end value (Dietz denominator), twrGross chains it', Math.abs(jan.retGross - (jan.value + 5.5 - jan.opening - jan.netFlow) / (jan.opening + jan.weightedFlow)) < 1e-15 && Math.abs(S.twrGross - jan.retGross) < 1e-15 && S.twrGross > S.twr, `${jan.ret} → ${jan.retGross}`);
  // 12.5 daily-linked TWR
  const Dd = { rows: [{ d: '2025-12-31', ret: null }, { d: '2026-01-04', ret: 0.01 }, { d: '2026-01-05', ret: -0.02 }, { d: '2026-01-31', ret: null }, { d: '2026-02-02', ret: 0.03 }, { d: '2026-03-01', ret: 0.5 }].map((r) => ({ ...r, value: 1, benchRet: 0 })) };
  const dt = PA.dailyTwr(Dd, { from: '2026-01', to: '2026-02' });
  check('dailyTwr: product of the sessions in the range (base = last session before it), same as dailyStats', Math.abs(dt.twr - (1.01 * 0.98 * 1.03 - 1)) < 1e-15 && dt.from === '2025-12-31' && dt.to === '2026-02-02' && dt.n === 3 && dt.twr === PA.dailyStats(Dd, { from: '2026-01', to: '2026-02' }).twr, JSON.stringify(dt));
  check('dailyTwr: null without a series or with no session in range', PA.dailyTwr(null, { from: '2026-01', to: '2026-01' }) === null && PA.dailyTwr(Dd, { from: '2027-01', to: '2027-02' }) === null && PA.dailyTwr === PE.dailyTwr);
  const mkD = { '2026-01': { cash: 0, securities: 1010 }, '2026-02': { cash: 0, securities: 1030 } };
  const noD = PE.run({ settings: st, marks: mkD, assets: {}, tx: [] }, { type: 'Since Inception' }, { today: '2026-03-10', live: false }).stats;
  const wD = PE.run({ settings: st, marks: mkD, assets: {}, tx: [] }, { type: 'Since Inception' }, { today: '2026-03-10', live: false, daily: Dd }).stats;
  const wDd = PE.run({ settings: { ...st, returnMethod: 'daily' }, marks: mkD, assets: {}, tx: [] }, { type: 'Since Inception' }, { today: '2026-03-10', live: false, daily: Dd }).stats;
  const nDd = PE.run({ settings: { ...st, returnMethod: 'daily' }, marks: mkD, assets: {}, tx: [] }, { type: 'Since Inception' }, { today: '2026-03-10', live: false }).stats;
  check("run(): twrDaily null without opts.daily; with it = dailyTwr; returnMethod 'dietz' by default", noD.twrDaily === null && noD.returnMethod === 'dietz' && noD.headlineTwr === noD.twr && wD.twrDaily === dt.twr && wD.returnMethod === 'dietz' && wD.headlineTwr === wD.twr);
  check("run(): settings.returnMethod 'daily' → headlineTwr = twrDaily, monthly twr unchanged; falls back to dietz with no series", wDd.returnMethod === 'daily' && wDd.headlineTwr === dt.twr && wDd.twr === noD.twr && nDd.returnMethod === 'dietz' && nDd.headlineTwr === nDd.twr);
  const RW = PE.withDaily(PE.run({ settings: st, marks: mkD, assets: {}, tx: [] }, { type: 'Since Inception' }, { today: '2026-03-10', live: false }), Dd);
  check('withDaily(R, D) attaches the same figure after the run', RW.stats.twrDaily === dt.twr && RW.stats.twrDailyN === 3);
  // 12.6 provenance
  const ptx = [
    { id: 'p1', d: '2026-01-05', t: 'Deposit', amt: 100, src: 'stmt-2026-01' }, { id: 'p2', d: '2026-01-06', t: 'Buy', a: 'X', q: 1, p: 10, amt: -10, src: 'invoice-abc' },
    { id: 'p3', d: '2026-01-07', t: 'Fee', amt: -1, src: 'manual' }, { id: 'p4', d: '2026-01-08', t: 'Rebate', amt: 1 }, { id: 'p5', d: '2026-01-09', t: 'Rebate', amt: 1, src: 'E-STATEMENT_Jan' },
    { id: 'p6', d: '2026-02-03', t: 'Fee', amt: -1 }, { id: 'p7', d: '2026-01-10', t: 'Rebate', amt: 1, src: 'statement' },
  ];
  const PV = PE.run({ settings: st, marks: { '2026-01': { cash: 0, securities: 1000, source: 'statement' }, '2026-02': { cash: 0, securities: 1000, source: 'price-estimate' } }, assets: {}, tx: ptx }, { type: 'Since Inception' }, { today: '2026-03-10', live: false }).provenance;
  check('Provenance: byMonth counts statement/invoice/typed/manual; unverified = typed+manual rows in statement months only', JSON.stringify(PV.byMonth['2026-01']) === JSON.stringify({ statement: 2, invoice: 1, typed: 2, manual: 1, total: 6 }) && PV.byMonth['2026-02'].typed === 1 && PV.unverified.join() === 'p3,p4,p5', JSON.stringify(PV));
}
// 12.7 real exports: trading costs, daily-linked TWR, engine2 identities
if (fs.existsSync(fixK) && fs.existsSync(fixY)) {
  const today = '2026-09-27';
  const loadX = (dir) => {
    const J = (f) => { const x = JSON.parse(fs.readFileSync(f)); return x.data || x; };
    const D = (...p) => path.join(dir, ...p);
    const s = J(D('portfolio', 'settings.json')), mk0 = J(D('portfolio', 'marks.json')).months, assets = J(D('portfolio', 'assets.json')).items;
    const tx = fs.readdirSync(D('ledger')).filter((f) => /^y\d{4}\.json$/.test(f)).sort().flatMap((f) => J(D('ledger', f)).rows || []);
    const history = {}; fs.readdirSync(D('history')).forEach((f) => { history[f.replace('.json', '')] = J(D('history', f)); });
    const market = J(D('market', 'latest.json')), bench = J(D('bench', 'egx30.json'));
    const pb = PA.priceBook(history), L0 = PE.runLedger(tx), mk = PA.estimateMarks(s, mk0, L0, assets, pb, today);
    const pricer = PA.makePricer(assets, L0, pb), fallback = (n) => { const p = pricer(n, today); return p ? { p: p.p, d: pb.last } : null; };
    const daily = PA.daily(s, L0, assets, pb, mk, today);
    const R = PE.run({ settings: s, marks: mk, assets, tx, market, bench }, { type: 'Since Inception' }, { today, fallback, daily });
    return { s, mk0, mk, assets, tx, pb, bench, daily, R, L0 };
  };
  for (const [who, dir] of [['Khaled', fixK], ['Yassin', fixY]]) {
    const X = loadX(dir), R = X.R, S = R.stats;
    const costed = R.ledger.filter((t) => t.cost != null), neg = R.ledger.filter((t) => { const c = PE.tradeCostRaw(t); return c != null && c < -1; });
    const big = costed.filter((t) => t.p * t.q > 1000).map((t) => t.cost / (t.p * t.q));
    check(`${who}: trading costs are small and positive (0.05–0.6% of each trade over 1,000 EGP; costPct 0.1–0.5%), none negative beyond 1 EGP`, neg.length === 0 && costed.every((t) => t.cost >= 0) && big.every((x) => x > 0.0005 && x < 0.006) && S.costPct > 0.001 && S.costPct < 0.005 && S.twrGross > S.twr,
      `${S.tradingCost.toFixed(2)} EGP = ${(S.costPct * 100).toFixed(3)}% of ${S.tradedValue.toFixed(0)}; twrGross ${(S.twrGross * 100).toFixed(2)}% vs ${(S.twr * 100).toFixed(2)}%`);
    check(`${who}: fund rows (acc MF) carry no cost`, R.ledger.filter((t) => t.acc === 'MF').every((t) => t.cost === undefined));
    check(`${who}: twrDaily = dailyStats(D, range).twr, provenance counts every row`, S.twrDaily != null && S.twrDaily === PA.dailyStats(X.daily, R.range).twr && Object.values(R.provenance.byMonth).reduce((a, b) => a + b.total, 0) === X.tx.length, `${(S.twrDaily * 100).toFixed(3)}% over ${S.twrDailyN} sessions ${S.twrDailyFrom}→${S.twrDailyTo}`);
    // attribution: every month's effects sum to R − B and the Carino-linked total to the period's active return
    const A = PA.attribution(R.months, R.range, R.ledger, X.assets, X.pb, X.bench, today);
    const worst = Math.max(...A.months.map((m) => Math.abs(m.alloc + m.sel + m.trading + m.replication - (m.R - m.B))));
    check(`${who}: attribution effects sum to R − B every month and Carino-linked to TWR − benchmark TWR (1e-9)`, worst < 1e-9 && Math.abs(A.alloc + A.sel + A.trading + A.replication - A.active) < 1e-9 && Math.abs(A.active - S.alpha) < 1e-9 && A.months.length === S.n, `worst month ${worst.toExponential(2)} · linked ${(A.alloc + A.sel + A.trading + A.replication - A.active).toExponential(2)}`);
    // price-estimate marks: holdingsAt(eom) at closes + ledger cash through eom (independent share walk × pricer)
    const pricer = PA.makePricer(X.assets, R.ledger, X.pb);
    const modelAt = (m) => {
      const e = PE.eom(m), sh = {};
      X.tx.filter((t) => t.d <= e && t.a && ['Buy', 'Sell', 'Bonus'].includes(t.t)).forEach((t) => { sh[t.a] = (sh[t.a] || 0) + (t.t === 'Sell' ? -1 : 1) * (t.q || 0); });
      const sec = Object.keys(sh).filter((n) => sh[n] > 0.5).reduce((a, n) => a + sh[n] * pricer(n, e).p, 0);
      return { sec, cash: X.tx.filter((t) => t.d <= e).reduce((a, t) => a + (t.amt || 0), 0), hAt: PA.holdingsAt(R.ledger, X.assets, X.pb, e).mv };
    };
    const est = Object.keys(X.mk0).filter((m) => X.mk0[m].source === 'price-estimate');
    const off = est.filter((m) => { const md = modelAt(m); return Math.abs(md.sec - X.mk0[m].securities) > 0.01 || Math.abs(md.hAt - md.sec) > 1e-6 || Math.abs(md.cash - X.mk0[m].cash) > 0.05; });
    check(`${who}: stored price-estimate marks = holdings × closes (to the cent) + ledger cash (within 5 piastres) — ${est.length} months`, est.length > 0 && off.length === 0, off.join(', ') || est.map((m) => PE.fmtMonth(m)).join(' '));
    // marks the model generates now (estimateMarks on provisional copies) equal holdingsAt + ledger cash exactly
    const prov = {}; Object.keys(X.mk0).forEach((m) => { prov[m] = m < '2026-09' ? { ...X.mk0[m], provisional: true, source: 'typed' } : X.mk0[m]; });
    const gen = PA.estimateMarks(X.s, prov, R.ledger, X.assets, X.pb, today), gm = Object.keys(gen).filter((m) => gen[m].source === 'price-estimate');
    const offG = gm.filter((m) => { const md = modelAt(m); return Math.abs(gen[m].securities - md.sec) > 1e-6 || Math.abs(gen[m].cash - md.cash) > 1e-6; });
    check(`${who}: estimateMarks rows (${gm.length} months) = holdingsAt(eom) × closes + ledger cash (1e-6)`, gm.length >= 13 && offG.length === 0, offG.join(', ') || 'all match');
  }
  // Excel workbook: the ideas rows and columns
  const T = path.join(SP, 'fix4', 'tmp', 'engine'), cp = require('child_process');
  try {
    fs.mkdirSync(T, { recursive: true });
    const ov = path.join(T, 'overlay-ideas'); fs.mkdirSync(ov, { recursive: true });
    const J0 = (f) => { const x = JSON.parse(fs.readFileSync(f)); return x.data || x; };
    const mO = J0(path.join(fixK, 'portfolio', 'marks.json')); Object.keys(mO.months).forEach((m) => { if (m <= '2026-08') mO.months[m].cashRate = 0.22; });
    fs.writeFileSync(path.join(ov, 'marks.json'), JSON.stringify(mO));
    cp.execFileSync(process.execPath, ['excel.js', '--data', fixK, '--month', '2026-08', '--out', path.join(T, 'xl_ideas.json')], { cwd: path.join(SP, 'tools'), stdio: 'pipe' });
    cp.execFileSync(process.execPath, ['excel.js', '--data', fixK, '--overlay', ov, '--month', '2026-08', '--out', path.join(T, 'xl_ideas_cbe.json')], { cwd: path.join(SP, 'tools'), stdio: 'pipe' });
    cp.execFileSync('python3', ['excel.py', path.join(T, 'xl_ideas.json'), path.join(T, 'ideas.xlsx')], { cwd: path.join(SP, 'tools'), stdio: 'pipe' });
    cp.execFileSync('python3', ['excel.py', path.join(T, 'xl_ideas_cbe.json'), path.join(T, 'ideas_cbe.xlsx')], { cwd: path.join(SP, 'tools'), stdio: 'pipe' });
    const py = `
import json, sys
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter as L
T = sys.argv[1]
v = load_workbook(T + '/ideas.xlsx', data_only=True); f = load_workbook(T + '/ideas.xlsx'); c = load_workbook(T + '/ideas_cbe.xlsx', data_only=True)
summ = {r[0].value: r[1].value for r in v['Summary'].iter_rows(min_row=1) if r[0].value}
summC = {r[0].value: r[1].value for r in c['Summary'].iter_rows(min_row=1) if r[0].value}
m = v['Monthly']; hdr = [x.value for x in m[3]]
fm = f['Monthly (formulas)']; fh = [x.value for x in fm[3]]
forms = sorted({(x.column_letter, str(x.value)) for row in fm.iter_rows(min_row=5, max_row=5) for x in row if x.data_type == 'f'})
col = lambda name: [m.cell(r, hdr.index(name) + 1).value for r in range(4, m.max_row + 1)]
print(json.dumps({'summ': {k: summ.get(k) for k in summ if isinstance(k, str)}, 'summC': [k for k in summC if str(k).startswith('Cash benchmark')], 'hdr': hdr, 'fh': fh, 'forms': forms,
  'letters': {L(i + 1): h for i, h in enumerate(fh)}, 'cash': col('Cash return'), 'cost': col('Trading costs'), 'marksHdr': [x.value for x in c['Marks & inputs'][3]]}))
`;
    const Q = JSON.parse(cp.execFileSync('python3', ['-c', py, T], { encoding: 'utf8' }));
    const X = JSON.parse(fs.readFileSync(path.join(T, 'xl_ideas.json')));
    const want = ["Ahead of cash", "Jensen's alpha (annual)", 'Index dividend yield (estimate)', 'Index return with dividends (estimate)', 'Trading costs (EGP)', 'Trading costs as % of value traded', 'Return before trading costs'];
    const cashKey = Object.keys(Q.summ).find((k) => k.startsWith('Cash benchmark (CBE policy rate'));
    check('Workbook: Summary has the eight ideas rows (cash, ahead of cash, Jensen, index yield and TR, costs, cost %, before costs)', cashKey && want.every((k) => k in Q.summ) && typeof Q.summ["Jensen's alpha (annual)"] === 'number' && Math.abs(Q.summ['Trading costs (EGP)'] - X.summary['Trading costs (EGP)']) < 1e-9 && Q.summ['Index return with dividends (estimate)'] === '—', cashKey);
    check("Workbook: cash row says when the settings rate stood in for the CBE rate; with cashRate on every month it is the plain label", /settings rate 24\.63% for 13 of 13 months/.test(cashKey) && Q.summC.join() === 'Cash benchmark (CBE policy rate) over the period' && Q.marksHdr.includes('CBE policy rate (annual)'), `${cashKey} | ${Q.summC.join()}`);
    const L = Q.letters;
    const lettersOk = L.B === 'Opening value' && L.C === 'Deposits' && L.D === 'Withdrawals' && L.E === 'Net flow' && L.F === 'Day-weighted flow' && L.H === 'Cash' && L.I === 'Securities' && L.J === 'Month-end value' && L.K === 'Return' && L.L === 'Benchmark' && L.M === 'Alpha' && L.N === 'Cumulative' && L.O === 'Cumulative benchmark' && L.P === 'Drawdown' && L.V === 'Cash return' && L.X === 'Trading costs';
    const formsOk = JSON.stringify(Q.forms) === JSON.stringify([['E', '=C5-D5'], ['J', '=H5+I5'], ['K', '=(J5-B5-E5)/(B5+F5)'], ['M', '=K5-L5'], ['N', '=(1+K5)*(1+N4)-1'], ['O', '=(1+L5)*(1+O4)-1'], ['P', '=(1+N5)/MAX(1,1+MAX($N$4:N5))-1']]);
    check('Workbook: Monthly gains Cash return (V) and Trading costs (X) on both sheets; every formula letter still points at its column', lettersOk && formsOk && JSON.stringify(Q.hdr) === JSON.stringify(Q.fh), JSON.stringify(Q.forms));
    const Mv = X.monthly;
    check('Workbook: Cash return and Trading costs columns hold the engine\'s monthly figures', Q.cash.length === Mv.length && Q.cash.every((x, i) => Math.abs(x - Mv[i].cashRet) < 1e-12) && Q.cost.every((x, i) => Math.abs(x - Mv[i].tradingCost) < 1e-9) && Math.abs(Q.cost.reduce((a, x) => a + x, 0) - X.summary['Trading costs (EGP)']) < 1e-6, `Aug-26 cost ${Q.cost[Q.cost.length - 1]}`);
  } catch (e) { check('Workbook ideas rows and columns', false, String(e.stderr || e.message).slice(0, 400)); }
}

console.log(fail ? `FAIL ${fail}` : 'ALL PASS');
process.exit(fail ? 1 : 0);
