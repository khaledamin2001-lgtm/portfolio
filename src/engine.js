/* Portfolio engine — a line-by-line port of the workbook's ⚙️ Model tab.
   Every function is pure: data in, numbers out. Dates are 'YYYY-MM-DD', months 'YYYY-MM'. */
(function (root) {
  'use strict';
  // Bonus = corporate action: q new shares for free (amt 0); the average cost falls, nothing else moves.
  const TYPES = ['Deposit', 'Withdrawal', 'Buy', 'Sell', 'Dividend', 'Fee', 'Rebate', 'Bonus'];
  // Same-day order. Thndr prints a "Sell Same Day" before the buy it closes, so money in → buys → income → sells → money out.
  const DAY_ORDER = { Deposit: 0, Buy: 1, Bonus: 1, Dividend: 2, Rebate: 2, Fee: 2, Sell: 3, Withdrawal: 4 };
  // Sectors that hold parked cash rather than positions (same set as engine2.js); their round trips are not "trades".
  const CASH_LIKE = new Set(['Cash & Savings', 'Mutual Funds', 'Cash']);

  // ---------- date helpers ----------
  const pad = (n) => String(n).padStart(2, '0');
  const monthOf = (d) => d.slice(0, 7);
  const addMonths = (m, k) => {
    let [y, mo] = m.split('-').map(Number);
    mo += k;
    y += Math.floor((mo - 1) / 12);
    mo = ((mo - 1) % 12 + 12) % 12 + 1;
    return `${y}-${pad(mo)}`;
  };
  const eom = (m) => {
    const [y, mo] = m.split('-').map(Number);
    return `${m}-${pad(new Date(Date.UTC(y, mo, 0)).getUTCDate())}`;
  };
  const dayNum = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
  const monthsBetween = (a, b) => {
    const [ya, ma] = a.split('-').map(Number), [yb, mb] = b.split('-').map(Number);
    return (yb - ya) * 12 + (mb - ma);
  };
  const cairoToday = () => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch (e) { return new Date().toISOString().slice(0, 10); }
  };

  // ---------- stats helpers ----------
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : 0);
  const stdevS = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1));
  };
  const covS = (a, b) => {
    const ma = mean(a), mb = mean(b);
    return sum(a.map((x, i) => (x - ma) * (b[i] - mb))) / (a.length - 1);
  };
  const slope = (y, x) => covS(y, x) / (stdevS(x) ** 2);
  const correl = (a, b) => covS(a, b) / (stdevS(a) * stdevS(b));

  // Excel-compatible XIRR (actual/365, Newton with bisection fallback)
  function xirr(flows) {
    if (!flows.length) return null;
    const t0 = dayNum(flows[0].date);
    const f = (r) => sum(flows.map((c) => c.amount / Math.pow(1 + r, (dayNum(c.date) - t0) / 365)));
    const df = (r) => sum(flows.map((c) => { const t = (dayNum(c.date) - t0) / 365; return -t * c.amount / Math.pow(1 + r, t + 1); }));
    let r = 0.1;
    for (let i = 0; i < 100; i++) {
      const v = f(r), d = df(r);
      if (!isFinite(v) || !isFinite(d) || d === 0) break;
      const nr = r - v / d;
      if (Math.abs(nr - r) < 1e-10) return nr > -1 ? nr : null;
      r = nr <= -1 ? (r - 1) / 2 : nr;
    }
    let lo = -0.9999, hi = 100;
    if (f(lo) * f(hi) > 0) return null;
    for (let i = 0; i < 300; i++) {
      const mid = (lo + hi) / 2;
      if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  // ---------- ledger: average-cost engine (🗂️ Data helper columns K–P) ----------
  // Date, then type priority (DAY_ORDER), then original position — stable inside a priority.
  // opts.sameDay: 'type' (default) | 'ledger' (legacy: original row order inside a day, as the workbook had it).
  function sortLedger(tx, opts) {
    const byType = !(opts && opts.sameDay === 'ledger');
    const pr = (t) => (byType ? (DAY_ORDER[t.t] != null ? DAY_ORDER[t.t] : 2) : 0);
    return tx.map((t, i) => ({ ...t, _i: i })).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : pr(a) - pr(b) || a._i - b._i));
  }
  // A sell larger than the shares held is flagged r.oversold = q − held. Tolerance: 0.5 sh or 1% of the shares held; for fund
  // rows (MF account or a savings fund) 1% of the larger of shares held and units ever bought, because the savings fund's sells
  // run ~0.2% over its buys as interest accrues in extra units, and its small interest-only sells land after full redemption.
  function runLedger(tx, opts) {
    const run = {};
    return sortLedger(tx, opts).map((t) => {
      const r = { ...t, basis: 0 };
      if (!t.a || (t.t !== 'Buy' && t.t !== 'Sell' && t.t !== 'Bonus')) return r;
      const s = run[t.a] || (run[t.a] = { sh: 0, cost: 0, bought: 0 });
      if (t.t === 'Buy') { s.sh += t.q || 0; s.bought += t.q || 0; s.cost += Math.abs(t.amt || 0); }
      else if (t.t === 'Bonus') { s.sh += t.q || 0; s.bought += t.q || 0; }
      else {
        const q = t.q || 0;
        const fundish = t.acc === 'MF' || /saving/i.test(t.a);
        if (q > s.sh + Math.max(0.5, 0.01 * (fundish ? Math.max(s.sh, s.bought) : s.sh))) r.oversold = q - s.sh;
        r.basis = s.sh > 0 ? (s.cost / s.sh) * q : 0;
        s.sh -= q; s.cost -= r.basis;
      }
      return r;
    });
  }

  // ---------- prices ----------
  // Latest of manual (asset.price/priceDate) and automatic (market.quotes[symbol]) wins; ties go to automatic.
  function effectivePrice(asset, market, settings) {
    if (!asset) return null;
    const man = asset.price > 0 ? { price: asset.price, date: asset.priceDate || settings.priceDate || null, source: 'manual' } : null;
    const q = market && market.quotes && asset.symbol ? market.quotes[asset.symbol] : null;
    const auto = q && q.price > 0 ? { price: q.price, date: q.date || null, source: 'auto', chg: q.chg } : null;
    if (auto && man) return (man.date || '') > (auto.date || '') ? man : auto;
    return auto || man;
  }

  // ---------- positions engine (⚙️ Model §C) ----------
  function positions(ledger, assets, market, settings, today, period, fallback) {
    const byName = {};
    (assets || []).forEach((a) => { byName[a.name] = a; });
    const order = [];
    const P = {};
    ledger.forEach((t) => {
      if ((t.t === 'Buy' || t.t === 'Bonus') && t.a && !P[t.a]) { P[t.a] = { name: t.a, firstBuy: t.d, lastSell: null, bought: 0, bonus: 0, sold: 0, buyCost: 0, proceeds: 0, soldBasis: 0, divs: 0 }; order.push(t.a); }
    });
    ledger.forEach((t) => {
      const p = P[t.a];
      if (t.t === 'Buy' && p) { p.bought += t.q || 0; p.buyCost += Math.abs(t.amt || 0); }
      if (t.t === 'Bonus' && p) { p.bonus += t.q || 0; }
      if (t.t === 'Sell' && p) { p.sold += t.q || 0; p.proceeds += t.amt || 0; p.soldBasis += t.basis; if (!p.lastSell || t.d > p.lastSell) p.lastSell = t.d; }
    });
    const thr = settings.openThreshold ?? 0.5;
    const rows = order.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })).map((name) => {
      const p = P[name], a = byName[name] || {};
      const sym = a.symbol || '';
      p.divs = sum(ledger.filter((t) => t.t === 'Dividend' && t.a && (t.a === name || (sym && t.a === sym))).map((t) => t.amt || 0));
      const open = p.bought + p.bonus - p.sold;
      const isOpen = open > thr;
      let px = isOpen ? effectivePrice(a, market, settings) : null;
      if (isOpen && !px && fallback) { const f = fallback(name); if (f) px = { price: f.p, date: f.d, source: 'model' }; }
      const openCost = isOpen ? p.buyCost - p.soldBasis : 0;
      const mv = isOpen && px ? open * px.price : null;
      const unreal = isOpen ? (mv != null ? mv - openCost : null) : 0;
      const realized = p.proceeds - p.soldBasis;
      const total = realized + (unreal || 0) + p.divs;
      const holdEnd = isOpen ? today : (p.lastSell || p.firstBuy);
      const closedInPeriod = !isOpen && p.lastSell && period && p.lastSell >= `${period.from}-01` && p.lastSell <= eom(period.to);
      const stop = +a.stop || 0, target = +a.target || 0;
      return {
        name, symbol: sym, sector: a.sector || 'Unclassified', firstBuy: p.firstBuy, lastSell: p.lastSell,
        bought: p.bought, bonus: p.bonus, sold: p.sold, open, status: isOpen ? 'Open' : 'Closed',
        buyCost: p.buyCost, proceeds: p.proceeds, soldBasis: p.soldBasis, openCost, divs: p.divs, realized,
        price: px ? px.price : null, priceDate: px ? px.date : null, priceSource: px ? px.source : null, chg: px && px.source === 'auto' ? px.chg : null,
        avgCost: isOpen && open ? openCost / open : null,
        mv, unreal, total, roi: p.buyCost > 0 ? total / p.buyCost : 0,
        holdDays: dayNum(holdEnd) - dayNum(p.firstBuy),
        outcome: !isOpen && p.sold > 0 ? (total > 0 ? 'WIN' : 'LOSS') : '',
        shareGap: !isOpen ? Math.round(open) : 0,
        closedInPeriod: !!closedInPeriod,
        stop, target,
        riskToStop: isOpen && stop > 0 && px && px.price > stop ? open * (px.price - stop) : 0,
      };
    });
    const openRows = rows.filter((r) => r.status === 'Open');
    const mvTotal = sum(openRows.map((r) => r.mv || 0));
    openRows.forEach((r) => { r.weight = mvTotal ? (r.mv || 0) / mvTotal : 0; });
    const trips = roundTrips(ledger, byName, thr, period);
    const tripCount = {}; trips.forEach((t) => { tripCount[t.name] = (tripCount[t.name] || 0) + 1; });
    rows.forEach((r) => { r.trips = tripCount[r.name] || 0; });
    return { rows, open: openRows, mvTotal, trips };
  }

  // Closed round trips: a trip starts at the first Buy/Bonus while the position is flat (open ≤ threshold) and ends at the Sell
  // that brings it back to flat. A stock bought, sold out and bought again later is two trips (pos.rows keeps one row per name).
  // Dividends dated inside [firstBuy, lastSell] belong to that trip; one paid while the position is flat (Thndr pays days
  // to months after the ex-date, often after the shares were sold) goes to the trip that closed most recently before it,
  // while one paid while shares are held stays with the open position. A Sell with no open trip (the savings fund's
  // interest-only sells after full redemption) is folded into that asset's previous trip. Newest first (by lastSell).
  function roundTrips(ledger, byName, thr, period) {
    const trips = [], cur = {}, held = {}, last = {};
    const symOf = {}; Object.keys(byName).forEach((n) => { if (byName[n].symbol) symOf[byName[n].symbol] = n; });
    const finish = (tr) => {
      tr.realized = tr.proceeds - tr.soldBasis; tr.total = tr.realized + tr.divs;
      tr.roi = tr.buyCost > 0 ? tr.total / tr.buyCost : 0;
      tr.outcome = tr.total > 0 ? 'WIN' : 'LOSS';
      tr.holdDays = dayNum(tr.lastSell) - dayNum(tr.firstBuy);
      tr.closedInPeriod = !!(period && tr.lastSell >= `${period.from}-01` && tr.lastSell <= eom(period.to));
    };
    ledger.forEach((t) => {
      if (!t.a || (t.t !== 'Buy' && t.t !== 'Sell' && t.t !== 'Bonus' && t.t !== 'Dividend')) return;
      const name = t.t === 'Dividend' && !byName[t.a] && symOf[t.a] ? symOf[t.a] : t.a, a = byName[name] || {};
      const h = held[name] || 0;
      if (t.t === 'Dividend') {
        const tr = cur[name] || (h <= thr ? last[name] : null);
        if (tr) { tr.divs += t.amt || 0; if (tr !== cur[name]) finish(tr); }
      } else if (t.t === 'Buy' || t.t === 'Bonus') {
        if (!cur[name] && h <= thr) cur[name] = { name, symbol: a.symbol || '', sector: a.sector || 'Unclassified', trip: (last[name] ? last[name].trip : 0) + 1, firstBuy: t.d, lastSell: null, bought: 0, bonus: 0, sold: 0, buyCost: 0, proceeds: 0, soldBasis: 0, divs: 0 };
        const tr = cur[name];
        if (tr) { if (t.t === 'Buy') { tr.bought += t.q || 0; tr.buyCost += Math.abs(t.amt || 0); } else tr.bonus += t.q || 0; }
        held[name] = h + (t.q || 0);
      } else {
        held[name] = h - (t.q || 0);
        let tr = cur[name];
        if (!tr) { tr = last[name]; if (!tr) return; } // orphan sell → previous trip
        tr.sold += t.q || 0; tr.proceeds += t.amt || 0; tr.soldBasis += t.basis || 0;
        if (!tr.lastSell || t.d > tr.lastSell) tr.lastSell = t.d;
        if (tr === cur[name]) { if (held[name] <= thr) { finish(tr); trips.push(tr); last[name] = tr; delete cur[name]; } }
        else finish(tr);
      }
    });
    return trips.sort((x, y) => (x.lastSell < y.lastSell ? 1 : x.lastSell > y.lastSell ? -1 : y.trip - x.trip));
  }

  // ---------- monthly engine (⚙️ Model §A) ----------
  // marks: {"YYYY-MM": {cash, securities, benchReturn, benchClose, usdegp, cpi, provisional, note}}
  // live (optional): {month, cash, securities, benchClose, prevBenchClose, usdegp} replaces a provisional/missing current-month row.
  // opts.flowTiming: 'dietz' (default) — Modified Dietz, each flow weighted by the fraction of the month it was invested
  //                  (start-of-day: a deposit on the 1st counts fully, on the 16th of a 31-day month 16/31);
  //                  'start' — the workbook's legacy formula, every flow assumed on day 1. row.retSimple always keeps the legacy figure.
  // Gaps: a month with no value keeps has=false, ret=null and is marked gap=true (spans=0). The next month WITH a value
  // measures its return over the whole span since the last valued month: opening = that month's value, flows and activity
  // (deposits, withdrawals, netFlow, weightedFlow, dividends, buys, sells, trades) summed over every month of the span,
  // Modified Dietz weights over the span's total calendar days, benchmark/FX/CPI compounded over the span; row.spans = months
  // covered (1 normally), row.spanFrom = first month of the span. A gap row keeps its own month's activity for display only —
  // it is never in a period's rows, so nothing double-counts.
  function monthly(settings, marks, ledger, live, opts) {
    const dietz = !(opts && opts.flowTiming === 'start');
    const out = [];
    const inc = settings.inception;
    const keys = Object.keys(marks || {}).filter((k) => k >= inc).sort();
    let last = keys.length ? keys[keys.length - 1] : inc;
    if (live && live.month > last) last = live.month;
    const n = monthsBetween(inc, last) + 1;
    let prev = null; // the last VALUED row (or null before the first one)
    for (let i = 0; i < n; i++) {
      const m = addMonths(inc, i);
      let mk = { ...(marks[m] || {}) };
      let isLive = false;
      if (live && live.month === m && (!marks[m] || marks[m].provisional || marks[m].cash == null)) {
        mk = { ...mk, cash: live.cash, securities: live.securities, provisional: true };
        if (live.benchClose) mk.benchClose = live.benchClose;
        if (live.usdegp) mk.usdegp = live.usdegp;
        isLive = true;
      }
      const has = typeof mk.cash === 'number' && typeof mk.securities === 'number';
      // the span this row's return covers: this month alone, or everything since the last valued month
      const spanFrom = has ? (prev ? addMonths(prev.month, 1) : inc) : m;
      const spans = has ? monthsBetween(spanFrom, m) + 1 : 0;
      const from = `${spanFrom}-01`, to = eom(m);
      const inM = ledger.filter((t) => t.d >= from && t.d <= to);
      const s = (type) => sum(inM.filter((t) => t.t === type).map((t) => t.amt || 0));
      const deposits = Math.abs(s('Deposit')), withdrawals = Math.abs(s('Withdrawal'));
      // day-weighted net flow (Modified Dietz): w = (D − dayIndex + 1) / D over the span's D calendar days (one month normally)
      const D = dayNum(to) - dayNum(from) + 1;
      const weightedFlow = sum(inM.filter((t) => t.t === 'Deposit' || t.t === 'Withdrawal').map((t) => ((D - (dayNum(t.d) - dayNum(from) + 1) + 1) / D) * (t.amt || 0)));
      const row = {
        month: m, has, gap: !has, spans, spanFrom, cash: mk.cash, securities: mk.securities, value: has ? mk.cash + mk.securities : null,
        deposits, withdrawals, netFlow: deposits - withdrawals, weightedFlow, dividends: s('Dividend'),
        buys: Math.abs(s('Buy')), sells: s('Sell'), trades: inM.filter((t) => t.t === 'Buy' || t.t === 'Sell').length,
        provisional: !!mk.provisional, live: isLive, note: mk.note || '',
        source: mk.source || (has ? 'typed' : null), estimate: !!mk.estimate,
        benchClose: mk.benchClose ?? null, usdegp: typeof mk.usdegp === 'number' ? mk.usdegp : null, cpi: typeof mk.cpi === 'number' ? mk.cpi : null,
      };
      row.opening = prev ? prev.value : settings.openingValue;
      row.retSimple = has && row.opening != null && row.opening + row.netFlow > 0 ? row.value / (row.opening + row.netFlow) - 1 : null;
      row.ret = dietz && has && row.opening != null && row.opening + weightedFlow > 0 ? (row.value - row.opening - row.netFlow) / (row.opening + weightedFlow) : row.retSimple;
      // the marks of the months inside the span (typed benchmark % and CPI are compounded across them)
      const spanMarks = spans > 1 ? Array.from({ length: spans }, (_, k) => (marks && marks[addMonths(spanFrom, k)]) || {}) : [mk];
      const compound = (key) => (spanMarks.every((x) => typeof x[key] === 'number') ? spanMarks.reduce((a, x) => a * (1 + x[key]), 1) - 1 : null);
      // benchmark: closes win over typed %, as in the workbook; over a span the ratio is to the last valued month's close
      const prevClose = isLive && live.prevBenchClose && spans === 1 ? live.prevBenchClose : (prev ? prev.benchClose : settings.benchCloseStart || null);
      if (!has) row.bench = null;
      else if (row.benchClose && prevClose) row.bench = row.benchClose / prevClose - 1;
      else row.bench = spans > 1 ? compound('benchReturn') : typeof mk.benchReturn === 'number' ? mk.benchReturn : null;
      if (isLive && live.prevBenchClose && !(prev && prev.benchClose)) row.prevBenchClose = live.prevBenchClose;
      row.alpha = row.ret != null && row.bench != null ? row.ret - row.bench : null;
      const prevFx = prev ? prev.usdegp : settings.fxStart;
      row.fxFactor = has && row.usdegp && prevFx ? prevFx / row.usdegp : null;
      row.usdRet = row.fxFactor != null && row.ret != null ? (1 + row.ret) * row.fxFactor - 1 : null;
      row.cpiSpan = has ? compound('cpi') : null; // == cpi for a one-month row; null if any month of the span has no CPI
      row.realRet = row.ret != null && row.cpiSpan != null ? (1 + row.ret) / (1 + row.cpiSpan) - 1 : null;
      out.push(row);
      if (has) prev = row;
    }
    return out;
  }

  // ---------- period engine (⚙️ Model §B, §D) ----------
  const PERIOD_TYPES = ['Month', 'Quarter', 'YTD', 'Year', 'Last 12 Months', 'Since Inception', 'Custom'];
  function periodRange(sel, settings, months) {
    const withData = months.filter((r) => r.has);
    const lastData = withData.length ? withData[withData.length - 1].month : settings.inception;
    const asOf = sel.asOf && sel.asOf <= lastData ? sel.asOf : lastData;
    const y = asOf.slice(0, 4), mo = +asOf.slice(5, 7);
    let rawFrom, rawTo = asOf;
    switch (sel.type) {
      case 'Month': rawFrom = asOf; break;
      case 'Quarter': rawFrom = `${y}-${pad(Math.floor((mo - 1) / 3) * 3 + 1)}`; rawTo = addMonths(rawFrom, 2); break;
      case 'Year': rawFrom = `${y}-01`; rawTo = `${y}-12`; break;
      case 'YTD': rawFrom = `${y}-01`; break;
      case 'Last 12 Months': rawFrom = addMonths(asOf, -11); break;
      case 'Custom': rawFrom = sel.from || settings.inception; rawTo = sel.to || asOf; break;
      default: rawFrom = settings.inception;
    }
    const from = rawFrom > settings.inception ? rawFrom : settings.inception;
    let to = rawTo;
    if (lastData < to) to = lastData;
    if (sel.type !== 'Custom' && asOf < to) to = asOf;
    return { from, to, asOf, lastData, valid: from <= to };
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtMonth = (m) => `${MON[+m.slice(5, 7) - 1]}-${m.slice(2, 4)}`;

  // opts.closedTrades: 'trip' (default) — closed-trade stats per round trip (pos.trips), cash-like sectors excluded;
  //                    'name' — legacy: one row per stock name (pos.rows), as the workbook counted them.
  // Months with no value are not in S.rows: their return is inside the next valued month (row.spans > 1). n counts the
  // available returns (vol, Sharpe, beta, hit rates); monthsElapsed counts the calendar months of the range (annualization).
  function periodStats(months, range, ledger, settings, pos, opts) {
    const inRange = months.filter((r) => r.month >= range.from && r.month <= range.to);
    const P = inRange.filter((r) => r.has && r.ret != null);
    const n = P.length;
    const S = { n, label: n ? fmtMonth(range.from) + (range.from === range.to ? '' : ' to ' + fmtMonth(range.to)) : 'No data for selection' };
    if (!n) return S;
    S.monthsElapsed = monthsBetween(range.from, range.to) + 1;
    S.gaps = inRange.filter((r) => r.gap).map((r) => r.month);
    const first = P[0], last = P[n - 1];
    let cf = 1, cb = 1, cu = 1, cc = 1, peak = 1;
    P.forEach((r) => {
      cf *= 1 + r.ret; cb *= 1 + (r.bench ?? 0); cu *= 1 + (r.usdRet ?? 0); cc *= 1 + (r.cpiSpan ?? 0);
      r.pCum = cf - 1; r.pBench = cb - 1;
      peak = Math.max(peak, cf); r.dd = cf / peak - 1;
    });
    S.rows = P;
    S.opening = first.opening; S.closing = last.value;
    S.deposits = sum(P.map((r) => r.deposits)); S.withdrawals = sum(P.map((r) => r.withdrawals));
    S.netFlows = S.deposits - S.withdrawals; S.netGain = S.closing - S.opening - S.netFlows;
    S.dividends = sum(P.map((r) => r.dividends)); S.buys = sum(P.map((r) => r.buys)); S.sells = sum(P.map((r) => r.sells)); S.trades = sum(P.map((r) => r.trades));
    S.twr = cf - 1; S.benchTwr = cb - 1; S.alpha = S.twr - S.benchTwr;
    S.benchComplete = P.every((r) => r.bench != null);
    const rets = P.map((r) => r.ret);
    S.posMonths = rets.filter((x) => x > 0).length; S.pctPos = S.posMonths / n;
    const best = P.reduce((a, r) => (r.ret > a.ret ? r : a)), worst = P.reduce((a, r) => (r.ret < a.ret ? r : a));
    S.best = { month: best.month, ret: best.ret }; S.worst = { month: worst.month, ret: worst.ret };
    S.avg = mean(rets); S.vol = n > 1 ? stdevS(rets) : 0;
    S.risk = n < 2 ? 'n/a' : S.vol < settings.volLow ? 'Low' : S.vol < settings.volHigh ? 'Moderate' : 'High';
    S.annualized = S.monthsElapsed >= 12 ? Math.pow(1 + S.twr, 12 / S.monthsElapsed) - 1 : null;
    const rfM = Math.pow(1 + settings.riskFree, 1 / 12) - 1;
    S.sharpe = n >= 3 && S.vol ? ((S.avg - rfM) / S.vol) * Math.sqrt(12) : null;
    const bp = P.filter((r) => r.bench != null);
    S.beta = bp.length >= 3 ? slope(bp.map((r) => r.ret), bp.map((r) => r.bench)) : null;
    S.correl = bp.length >= 3 ? correl(bp.map((r) => r.ret), bp.map((r) => r.bench)) : null;
    S.trackingError = bp.length >= 3 ? stdevS(bp.map((r) => r.alpha)) * Math.sqrt(12) : null;
    S.beat = bp.filter((r) => r.alpha > 0).length; S.pctBeat = S.beat / n;
    const mdd = P.reduce((a, r) => (r.dd < a.dd ? r : a));
    S.maxDD = Math.min(0, mdd.dd); S.maxDDMonth = S.maxDD < 0 ? mdd.month : null;
    // USD & real
    const before = months.filter((r) => r.has && r.month < range.from); // FX at the start = the last valued month before the range
    S.fxStart = before.length ? before[before.length - 1].usdegp : settings.fxStart;
    S.fxEnd = last.usdegp;
    S.usdComplete = !!S.fxStart && P.every((r) => r.usdRet != null);
    S.usdTwr = S.usdComplete ? cu - 1 : null;
    S.egpVsUsd = S.fxStart && S.fxEnd ? S.fxStart / S.fxEnd - 1 : null;
    S.cpiComplete = P.every((r) => r.cpiSpan != null);
    S.inflation = S.cpiComplete ? cc - 1 : null;
    S.realTwr = S.cpiComplete ? (1 + S.twr) / (1 + S.inflation) - 1 : null;
    // when the latest months have no CPI yet, report the real return through the last month that does
    let k = 0; while (k < n && P[k].cpiSpan != null) k++;
    if (!S.cpiComplete && k > 0) {
      const Q = P.slice(0, k);
      const tw = Q.reduce((a, r) => a * (1 + r.ret), 1) - 1, inf = Q.reduce((a, r) => a * (1 + r.cpiSpan), 1) - 1;
      S.realThrough = Q[k - 1].month; S.realTwrPartial = (1 + tw) / (1 + inf) - 1; S.inflationPartial = inf;
    } else { S.realThrough = S.cpiComplete ? last.month : null; S.realTwrPartial = null; S.inflationPartial = null; }
    // downside risk and capture ratios (monthly, CFA-style definitions)
    const dd2 = rets.map((x) => Math.min(0, x - rfM) ** 2);
    S.downsideDev = n > 1 ? Math.sqrt(sum(dd2) / n) : 0;
    S.sortino = n >= 3 && S.downsideDev ? ((S.avg - rfM) / S.downsideDev) * Math.sqrt(12) : null;
    S.calmar = S.annualized != null && S.maxDD < 0 ? S.annualized / -S.maxDD : null;
    const upM = bp.filter((r) => r.bench > 0), dnM = bp.filter((r) => r.bench < 0);
    const chainK = (rows, key) => rows.reduce((a, r) => a * (1 + r[key]), 1) - 1;
    S.upCapture = upM.length ? chainK(upM, 'ret') / chainK(upM, 'bench') : null;
    S.downCapture = dnM.length ? chainK(dnM, 'ret') / chainK(dnM, 'bench') : null;
    S.upMonths = upM.length; S.downMonths = dnM.length;
    // Money-weighted
    const d0 = eom(addMonths(range.from, -1)), d1 = eom(range.to);
    const flows = [{ date: d0, amount: -S.opening }];
    ledger.forEach((t) => {
      if ((t.t === 'Deposit' || t.t === 'Withdrawal') && t.d > d0 && t.d <= d1) flows.push({ date: t.d, amount: -(t.amt || 0) });
    });
    flows.push({ date: d1, amount: S.closing });
    S.xirr = xirr(flows);
    S.mwrPeriod = S.xirr != null ? Math.pow(1 + S.xirr, (dayNum(d1) - dayNum(d0)) / 365) - 1 : null;
    // realized trading P/L (sells in window minus their average-cost basis)
    const inW = ledger.filter((t) => t.t === 'Sell' && t.d >= `${range.from}-01` && t.d <= d1);
    S.realized = sum(inW.map((t) => t.amt || 0)) - sum(inW.map((t) => t.basis));
    // closed-trade stats: per round trip (default), leaving out cash-like funds — parking money in the savings fund is not a trade
    const byName = !!(opts && opts.closedTrades === 'name');
    const closedAll = byName ? pos.rows.filter((r) => r.closedInPeriod) : (pos.trips || []).filter((r) => r.closedInPeriod);
    const closed = byName ? closedAll : closedAll.filter((r) => !CASH_LIKE.has(r.sector));
    S.closedTrades = byName ? 'name' : 'trip'; S.closedCashLike = closedAll.length - closed.length;
    const wins = closed.filter((r) => r.total > 0), losses = closed.filter((r) => r.total <= 0);
    S.closed = closed; S.closedCount = closed.length; S.wins = wins.length; S.losses = losses.length;
    S.winRate = closed.length ? wins.length / closed.length : 0;
    S.closedPL = sum(closed.map((r) => r.total));
    S.avgWin = wins.length ? sum(wins.map((r) => r.total)) / wins.length : 0;
    S.avgLoss = losses.length ? sum(losses.map((r) => r.total)) / losses.length : 0;
    const gl = Math.abs(sum(losses.map((r) => r.total)));
    S.profitFactor = gl ? sum(wins.map((r) => r.total)) / gl : null;
    S.avgHold = closed.length ? mean(closed.map((r) => r.holdDays)) : 0;
    S.bestTrade = closed.length ? Math.max(...closed.map((r) => r.total)) : 0;
    S.worstTrade = closed.length ? Math.min(...closed.map((r) => r.total)) : 0;
    return S;
  }

  function sectors(pos) {
    const m = {};
    pos.open.forEach((r) => { m[r.sector] = (m[r.sector] || 0) + (r.mv || 0); });
    const tot = sum(Object.values(m));
    return Object.entries(m).map(([sector, mv]) => ({ sector, mv, weight: tot ? mv / tot : 0 })).sort((a, b) => b.mv - a.mv);
  }

  function concentration(pos, settings) {
    const mvs = pos.open.map((r) => r.mv || 0).sort((a, b) => b - a);
    const sec = sectors(pos);
    const largest = pos.open.slice().sort((a, b) => (b.mv || 0) - (a.mv || 0))[0];
    return {
      openCount: pos.open.length, sectorCount: sec.length,
      largestWeight: pos.mvTotal ? (mvs[0] || 0) / pos.mvTotal : 0, largest: largest ? largest.symbol || largest.name : '',
      top3: pos.mvTotal ? sum(mvs.slice(0, 3)) / pos.mvTotal : 0,
      largestSector: sec[0] ? sec[0] : null,
      withStop: pos.open.filter((r) => r.stop > 0).length,
      lossIfStops: sum(pos.open.map((r) => r.riskToStop)),
      // Herfindahl–Hirschman index on position weights; 1/HHI = effective number of positions
      hhi: sum(pos.open.map((r) => r.weight ** 2)),
    };
  }

  function checks(ctx) {
    const { tx, months, range, pos, settings, today, ledgerCash } = ctx;
    const out = [];
    const add = (label, status, detail) => out.push({ label, status, detail });
    add('Period selection is valid', range.valid && months.some((r) => r.has) ? 'ok' : 'error', range.valid ? `${fmtMonth(range.from)} → ${fmtMonth(range.to)}` : 'From is after To');
    const bad = tx.filter((t) => !TYPES.includes(t.t));
    add('Transaction types are all recognised', bad.length ? 'error' : 'ok', bad.length ? `${bad.length} rows with unknown type` : `${tx.length} transactions`);
    const gaps = months.filter((r) => !r.has);
    add('Monthly marks have no gaps', gaps.length ? 'error' : 'ok', gaps.length ? `Missing: ${gaps.map((r) => fmtMonth(r.month)).join(', ')}` : `${months.length} months through ${fmtMonth(months[months.length - 1].month)}`);
    const closedM = months.filter((r) => !r.live);
    const est = closedM.filter((r) => r.has && (r.estimate || r.source === 'price-estimate'));
    const noVal = closedM.filter((r) => !r.has);
    const prov = closedM.filter((r) => r.has && r.provisional && !r.estimate && r.source !== 'price-estimate');
    add('Closed months confirmed by Thndr statements', noVal.length ? 'error' : est.length || prov.length ? 'warn' : 'ok',
      noVal.length ? `No value: ${noVal.map((r) => fmtMonth(r.month)).join(', ')}` : est.length || prov.length ? [est.length ? `estimated from closing prices: ${est.map((r) => fmtMonth(r.month)).join(', ')}` : '', prov.length ? `provisional: ${prov.map((r) => fmtMonth(r.month)).join(', ')}` : ''].filter(Boolean).join(' · ') : 'All closed months from statements');
    const over = ctx.ledger ? ctx.ledger.filter((t) => t.oversold) : [];
    add('Sells never exceed shares held', over.length ? 'error' : 'ok', over.length ? over.slice(0, 6).map((t) => `${t.a} ${t.d}: sold ${fmtNum(t.q)}, held ${fmtNum(t.q - t.oversold)}`).join('; ') + (over.length > 6 ? ` … ${over.length} rows` : '') : 'Every sell covered by shares held');
    const seen = {}, dups = [];
    tx.forEach((t) => { if (t.id != null) { if (seen[t.id] && !dups.includes(t.id)) dups.push(t.id); seen[t.id] = true; } });
    add('Ledger ids are unique', dups.length ? 'error' : 'ok', dups.length ? `Duplicate ids: ${dups.slice(0, 8).join(', ')}` : `${Object.keys(seen).length} ids`);
    // end-of-day balances (a same-day sale may fund a buy, so the intra-day order does not matter)
    let bal = 0, neg = null;
    const sorted = sortLedger(tx, { sameDay: ctx.sameDay });
    for (let i = 0; i < sorted.length && !neg; i++) { bal += sorted[i].amt || 0; if ((i + 1 === sorted.length || sorted[i + 1].d !== sorted[i].d) && bal < -1) neg = { d: sorted[i].d, bal }; }
    add('Ledger cash never negative', neg ? 'warn' : 'ok', neg ? `First below zero on ${neg.d}: ${fmtNum(neg.bal)} EGP at end of day` : 'End-of-day cash balance never below zero');
    const benchMissing = months.filter((r) => r.has && r.bench == null);
    add('Benchmark return present every month', benchMissing.length ? 'warn' : 'ok', benchMissing.length ? `Missing: ${benchMissing.map((r) => fmtMonth(r.month)).join(', ')}` : 'EGX30 Capped complete');
    const gap = pos.rows.filter((r) => r.shareGap !== 0);
    add('Closed stocks with leftover shares', gap.length ? 'warn' : 'ok', gap.length ? gap.map((r) => `${r.symbol || r.name} (${r.shareGap})`).join(', ') : 'None');
    const stale = pos.open.filter((r) => !r.priceDate || dayNum(today) - dayNum(r.priceDate) > settings.staleDays);
    const missing = pos.open.filter((r) => r.price == null);
    add(`Prices updated within ${settings.staleDays} days`, missing.length ? 'error' : stale.length ? 'warn' : 'ok', missing.length ? `No price: ${missing.map((r) => r.name).join(', ')}` : stale.length ? `Stale: ${stale.map((r) => r.symbol || r.name).join(', ')}` : `${pos.open.length} held positions priced`);
    const diff = settings.cash - ledgerCash;
    // only a Thndr statement can confirm the ledger; a figure copied from a workbook or typed by hand is labelled as such
    const fromStatement = /statement/i.test(settings.cashSource || '');
    add('Broker cash reconciles to ledger', Math.abs(diff) < 1 && fromStatement ? 'ok' : 'warn', `Broker ${fmtNum(settings.cash)} vs ledger ${fmtNum(ledgerCash)}${settings.cashDate ? ` on ${settings.cashDate}` : ''} (diff ${fmtNum(diff)} EGP)${fromStatement ? ` · broker figure from ${settings.cashSource}` : ` · the broker figure is not from a Thndr statement (${settings.cashSource || 'no source'}), so this check cannot confirm the ledger`}`);
    return out;
  }
  const fmtNum = (x) => (x == null ? '—' : x.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 }));

  // One call that runs the whole model. opts: {today, live, fallback, flowTiming: 'dietz' | 'start', sameDay: 'type' | 'ledger', closedTrades: 'trip' | 'name'}
  function run(data, sel, opts) {
    opts = opts || {};
    const today = opts.today || cairoToday();
    const settings = data.settings;
    const tx = data.tx || [];
    const ledger = runLedger(tx, { sameDay: opts.sameDay });
    const assets = Object.values(data.assets || {});
    const market = data.market || null;
    const ledgerCash = sum(tx.map((t) => t.amt || 0));
    // broker cash is a dated reading (from the latest statement): compare it with the ledger on that date,
    // and roll it forward with whatever the ledger books afterwards to get today's cash
    const cashDate = settings.cashDate || null;
    const ledgerCashAt = cashDate ? sum(tx.filter((t) => t.d <= cashDate).map((t) => t.amt || 0)) : ledgerCash;
    const liveCash = settings.cash == null ? ledgerCash : settings.cash + (cashDate ? sum(tx.filter((t) => t.d > cashDate).map((t) => t.amt || 0)) : 0);
    // provisional live month
    let live = null;
    const curMonth = monthOf(today);
    const pre = positions(ledger, assets, market, settings, today, null, opts.fallback);
    if (opts.live !== false && curMonth >= settings.inception) {
      const ix = market && market.index && market.index.EGX30CAPPED;
      const mk = (data.marks || {})[curMonth];
      if (!mk || mk.provisional) {
        live = {
          month: curMonth, cash: liveCash, securities: pre.mvTotal,
          benchClose: ix && ix.date && monthOf(ix.date) === curMonth ? ix.close : null,
          prevBenchClose: ix && ix.date && monthOf(ix.date) === curMonth ? ix.prevMonthClose : null,
          usdegp: market && market.fx && market.fx.USDEGP ? market.fx.USDEGP.price : null,
        };
      }
    }
    const months = monthly(settings, data.marks || {}, ledger, live, { flowTiming: opts.flowTiming });
    const range = periodRange(sel, settings, months);
    const pos = positions(ledger, assets, market, settings, today, range, opts.fallback);
    const stats = periodStats(months, range, ledger, settings, pos, { closedTrades: opts.closedTrades });
    return {
      today, settings, ledger, months, range, pos, stats, ledgerCash, ledgerCashAt, liveCash, live, flowTiming: opts.flowTiming || 'dietz', sameDay: opts.sameDay || 'type', closedTrades: opts.closedTrades || 'trip',
      sectors: sectors(pos), conc: concentration(pos, settings),
      checks: checks({ tx, ledger, months, range, pos, settings, today, ledgerCash: ledgerCashAt, sameDay: opts.sameDay }),
    };
  }

  const api = { run, runLedger, positions, monthly, periodRange, periodStats, sectors, xirr, eom, addMonths, monthsBetween, fmtMonth, monthOf, dayNum, cairoToday, effectivePrice, TYPES, PERIOD_TYPES, DAY_ORDER, CASH_LIKE, sortLedger };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PE = api;
})(this);
