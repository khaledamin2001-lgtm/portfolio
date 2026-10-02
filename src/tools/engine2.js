/* Analytics layer on top of the Model port: daily valuation, sector attribution, income, factsheet.
   Everything here is derived from the ledger, the month-end marks and stored daily closes. */
(function (root) {
  'use strict';
  const PE = root.PE || (typeof require !== 'undefined' ? require('./engine.js') : null);
  const { eom, addMonths, dayNum, monthOf } = PE;
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : 0);
  const stdevS = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1)); };
  const TRADING_DAYS = 250; // EGX sessions per year, used to annualize daily volatility
  const CASH_LIKE = new Set(['Cash & Savings', 'Mutual Funds', 'Cash']);

  // ---------- price book: carry-forward closes from history/<YYYY-MM> docs ----------
  function priceBook(history) {
    const series = {}; // sym -> [[date, close], ...]
    const days = [];
    Object.keys(history || {}).sort().forEach((m) => {
      const d = (history[m] && history[m].days) || {};
      Object.keys(d).sort().forEach((day) => {
        const snap = d[day];
        if (snap.EGX30CAPPED != null) days.push(day);
        Object.keys(snap).forEach((s) => { if (snap[s] != null) (series[s] || (series[s] = [])).push([day, snap[s]]); });
      });
    });
    Object.values(series).forEach((a) => a.sort((x, y) => (x[0] < y[0] ? -1 : 1)));
    const at = (sym, date) => {
      const a = series[sym]; if (!a || !a.length || a[0][0] > date) return null;
      let lo = 0, hi = a.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (a[mid][0] <= date) lo = mid; else hi = mid - 1; }
      return a[lo][1];
    };
    const lastDayOnOrBefore = (date) => { let r = null; for (let i = days.length - 1; i >= 0; i--) if (days[i] <= date) { r = days[i]; break; } return r; };
    return { days: [...new Set(days)].sort(), at, has: (s) => !!series[s], lastDayOnOrBefore, first: days[0] || null, last: days[days.length - 1] || null };
  }

  // Price of one asset on a date: market close > gold-indexed last trade > last traded NAV (funds) > par 1 for the savings fund only
  // when it has never traded.
  function makePricer(assets, ledger, pb) {
    const byName = {}; Object.values(assets || {}).forEach((a) => { byName[a.name] = a; });
    const trades = {}; // name -> [[date, price]]
    PE.sortLedger(ledger).forEach((t) => { if ((t.t === 'Buy' || t.t === 'Sell') && t.a && t.p > 0) (trades[t.a] || (trades[t.a] = [])).push([t.d, t.p]); });
    const lastTrade = (name, date) => { const a = trades[name]; if (!a) return null; let r = null; for (const x of a) { if (x[0] <= date) r = x; else break; } return r; };
    return function price(name, date) {
      const a = byName[name] || {};
      if (a.symbol && a.symbol !== 'SAVINGS' && pb.has(a.symbol)) { const c = pb.at(a.symbol, date); if (c != null) return { p: c, src: 'close' }; }
      const lt = lastTrade(name, date);
      if (a.proxy && lt && pb.has(a.proxy)) { const now = pb.at(a.proxy, date), then = pb.at(a.proxy, lt[0]); if (now && then) return { p: lt[1] * now / then, src: 'proxy' }; }
      if (lt) return { p: lt[1], src: 'trade' };
      if (a.symbol === 'SAVINGS' || name === 'thndrsavings') return { p: 1, src: 'par' };
      return null;
    };
  }

  // ---------- daily valuation ----------
  // Value_d = Σ shares_d × price_d + ledger cash_d. Flows are deposits − withdrawals since the prior session.
  function daily(settings, ledger, assets, pb, marks, today) {
    if (!pb.days.length) return null;
    const price = makePricer(assets, ledger, pb);
    const start = pb.lastDayOnOrBefore(eom(addMonths(settings.inception, -1))) || pb.days[0];
    const days = pb.days.filter((d) => d >= start && d <= today);
    const tx = PE.sortLedger(ledger);
    const sh = {}; let cash = 0, i = 0, prevV = null;
    const rows = [];
    let unpriced = new Set();
    days.forEach((d) => {
      let flow = 0;
      while (i < tx.length && tx[i].d <= d) {
        const t = tx[i++]; cash += t.amt || 0;
        if (t.t === 'Deposit' || t.t === 'Withdrawal') flow += t.amt || 0;
        if (t.a && (t.t === 'Buy' || t.t === 'Sell' || t.t === 'Bonus')) sh[t.a] = (sh[t.a] || 0) + (t.t === 'Sell' ? -1 : 1) * (t.q || 0);
      }
      let mv = 0, px = 0;
      Object.keys(sh).forEach((n) => { if (sh[n] > 0.5) { const p = price(n, d); if (p) { mv += sh[n] * p.p; if (p.src !== 'close' && p.src !== 'par') px += sh[n] * p.p; } else unpriced.add(n); } });
      const v = mv + cash;
      const ret = prevV != null && prevV + flow > 0 ? v / (prevV + flow) - 1 : null;
      rows.push({ d, value: v, mv, cash, flow, ret, bench: pb.at('EGX30CAPPED', d), estimated: px });
      prevV = v;
    });
    rows.forEach((r, k) => { r.benchRet = k ? r.bench / rows[k - 1].bench - 1 : null; });
    // reconcile each month-end against the statement marks
    const recon = Object.keys(marks || {}).sort().filter((m) => m >= settings.inception && marks[m].cash != null && !marks[m].provisional).map((m) => {
      const d = [...rows].reverse().find((r) => r.d <= eom(m));
      const mk = marks[m].cash + marks[m].securities;
      return d ? { month: m, day: d.d, model: d.value, marks: mk, diff: d.value - mk, pct: (d.value - mk) / mk } : null;
    }).filter(Boolean);
    return { rows, recon, unpriced: [...unpriced] };
  }

  function dailyStats(D, range) {
    if (!D) return null;
    const lo = `${range.from}-01`, hi = eom(range.to);
    const base = [...D.rows].reverse().find((r) => r.d < lo);
    const rows = D.rows.filter((r) => r.d >= lo && r.d <= hi && r.ret != null);
    if (!rows.length) return null;
    let cf = 1, cb = 1, peak = 1, peakD = base ? base.d : rows[0].d, maxDD = 0, ddPeak = null, ddTrough = null;
    const out = rows.map((r) => {
      cf *= 1 + r.ret; cb *= 1 + (r.benchRet || 0);
      if (cf > peak) { peak = cf; peakD = r.d; }
      const dd = cf / peak - 1;
      if (dd < maxDD) { maxDD = dd; ddPeak = peakD; ddTrough = r.d; }
      return { d: r.d, cum: cf - 1, bcum: cb - 1, dd, value: r.value, ret: r.ret };
    });
    let recovered = null;
    if (ddTrough) { const pk = out.find((r) => r.d === ddTrough); const need = out.filter((r) => r.d > ddTrough).find((r) => r.dd >= -1e-9); recovered = need ? need.d : null; }
    const rets = rows.map((r) => r.ret), brets = rows.map((r) => r.benchRet || 0);
    const best = rows.reduce((a, r) => (r.ret > a.ret ? r : a)), worst = rows.reduce((a, r) => (r.ret < a.ret ? r : a));
    return {
      rows: out, n: rows.length, twr: cf - 1, bench: cb - 1, maxDD, ddPeak, ddTrough, recovered,
      volAnn: stdevS(rets) * Math.sqrt(TRADING_DAYS), benchVolAnn: stdevS(brets) * Math.sqrt(TRADING_DAYS),
      best: { d: best.d, r: best.ret }, worst: { d: worst.d, r: worst.ret }, upDays: rets.filter((x) => x > 0).length / rets.length,
      downsideDevAnn: Math.sqrt(sum(rets.map((x) => Math.min(0, x) ** 2)) / rets.length) * Math.sqrt(TRADING_DAYS),
    };
  }

  // ---------- benchmark replication (EGX30 Capped) ----------
  function capWeights(ws, cap) {
    let w = ws.slice(); const n = w.length; if (!n) return w;
    if (cap * n < 1) cap = 1 / n;
    for (let iter = 0; iter < 50; iter++) {
      const over = w.map((x) => x > cap + 1e-12);
      if (!over.some(Boolean)) break;
      const excess = sum(w.map((x, i) => (over[i] ? x - cap : 0)));
      const freeTot = sum(w.map((x, i) => (over[i] ? 0 : x)));
      w = w.map((x, i) => (over[i] ? cap : x + (freeTot ? excess * x / freeTot : 0)));
    }
    return w;
  }
  function benchWeights(bench, pb, date) {
    if (!bench || !bench.members) return null;
    const mem = bench.members.map((m) => ({ ...m, p: pb.at(m.s, date) })).filter((m) => m.p && m.floatShares);
    const tot = sum(mem.map((m) => m.p * m.floatShares));
    const w = capWeights(mem.map((m) => (m.p * m.floatShares) / tot), bench.capWeight || 0.15);
    return mem.map((m, i) => ({ ...m, w: w[i] }));
  }

  // ---------- holdings snapshot on a date (for factsheets and attribution) ----------
  function holdingsAt(ledger, assets, pb, date) {
    const price = makePricer(assets, ledger, pb);
    const sh = {}, cost = {};
    let cash = 0;
    PE.sortLedger(ledger).forEach((t) => {
      if (t.d > date) return;
      cash += t.amt || 0;
      if (!t.a || (t.t !== 'Buy' && t.t !== 'Sell' && t.t !== 'Bonus')) return;
      const s = sh[t.a] || 0, c = cost[t.a] || 0;
      if (t.t === 'Buy') { sh[t.a] = s + (t.q || 0); cost[t.a] = c + Math.abs(t.amt || 0); }
      else if (t.t === 'Bonus') { sh[t.a] = s + (t.q || 0); cost[t.a] = c; }
      else { const b = s > 0 ? (c / s) * (t.q || 0) : 0; sh[t.a] = s - (t.q || 0); cost[t.a] = c - b; }
    });
    const byName = {}; Object.values(assets || {}).forEach((a) => { byName[a.name] = a; });
    const rows = Object.keys(sh).filter((n) => sh[n] > 0.5).map((n) => {
      const p = price(n, date); const a = byName[n] || {};
      return { name: n, symbol: a.symbol || '', sector: a.sector || 'Unclassified', shares: sh[n], cost: cost[n], price: p ? p.p : null, src: p ? p.src : null, mv: p ? sh[n] * p.p : null };
    });
    return { rows, cash, mv: sum(rows.map((r) => r.mv || 0)) };
  }

  // ---------- month-close estimates ----------
  // For every closed month (inception … the month before today's) whose mark is missing, provisional or has no cash, build a
  // row from the ledger and the price book: cash = ledger cash through month-end, securities = holdingsAt(month-end).mv.
  // Rows from statements, reconstructed rows and non-provisional typed rows are never touched. Returns a NEW marks object.
  function estimateMarks(settings, marks, ledger, assets, pb, today) {
    const out = { ...(marks || {}) };
    if (!settings || !settings.inception || !pb || !pb.days || !pb.days.length) return out;
    const lastM = addMonths(monthOf(today || PE.cairoToday()), -1);
    const tx = PE.sortLedger(ledger);
    for (let m = settings.inception; m <= lastM; m = addMonths(m, 1)) {
      const mk = marks && marks[m];
      if (mk && !mk.provisional && mk.cash != null) continue;
      if (mk && (mk.source === 'statement' || mk.source === 'reconstructed')) continue;
      const end = eom(m), lastDay = pb.lastDayOnOrBefore(end);
      if (!lastDay || lastDay < `${m}-01`) continue;
      const cash = sum(tx.filter((t) => t.d <= end).map((t) => t.amt || 0));
      const securities = holdingsAt(ledger, assets, pb, end).mv;
      const row = { ...(mk || {}), cash, securities, provisional: true, estimate: true, source: 'price-estimate',
        estimateNote: `Estimated from closing prices on ${lastDay}; replaced when the Thndr statement is posted` };
      if (typeof row.benchClose !== 'number') { const b = pb.at('EGX30CAPPED', lastDay); if (typeof b === 'number') row.benchClose = b; else delete row.benchClose; }
      if (typeof row.usdegp !== 'number') { const fx = pb.at('USDEGP', lastDay); if (typeof fx === 'number') row.usdegp = fx; else delete row.usdegp; }
      if (mk && typeof mk.cash === 'number' && mk.cash !== cash) row.typedCash = mk.cash;
      if (mk && typeof mk.securities === 'number' && mk.securities !== securities) row.typedSecurities = mk.securities;
      out[m] = row;
    }
    return out;
  }

  // ---------- Brinson-Fachler sector attribution, Carino-linked ----------
  // Monthly: holdings at the prior month-end, buy-and-hold over the month. A row that spans a gap (spans > 1, the months before
  // it have no value) is measured from the month-end before its spanFrom, so R, B, Rh and Bs all cover the same span.
  //   allocation_s = (wp − wb)(rb − B*)     selection_s = wp(rp − rb)   (interaction included in selection)
  //   trading      = R − R_h  (effect of trades during the month)     replication = B* − B (model vs real index)
  // Sectors absent from the index use rb = B* (neutral); cash-like sectors use rb = 0 so idle cash shows as allocation.
  // bench.actions (optional): [{s, date, ratio}] — corporate actions; ratio = new shares ÷ old shares, so a member's
  // unadjusted price drops by 1/ratio from `date` and its return over [d0, d1] is p1 × Π ratio(d0 < date ≤ d1) / p0 − 1.
  // `trading` is R − Rh: everything the buy-and-hold sector returns do not explain (they are price-only)
  const TRADING_NOTE = 'Trading and other: buys and sells during the month, plus dividends, rebates and fees (sector returns are price-only)';
  const actionFactor = (actions, s, d0, d1) => (actions || []).reduce((f, a) => (a.s === s && a.date > d0 && a.date <= d1 && a.ratio > 0 ? f * a.ratio : f), 1);
  function attribution(months, range, ledger, assets, pb, bench, today) {
    if (!pb.days.length || !bench) return null;
    const P = months.filter((r) => r.has && r.month >= range.from && r.month <= range.to && r.ret != null && r.bench != null);
    const acts = bench.actions || [];
    const out = [];
    P.forEach((r) => {
      const base = eom(addMonths(r.spans > 1 && r.spanFrom ? r.spanFrom : r.month, -1));
      const d0 = pb.lastDayOnOrBefore(base);
      const d1 = pb.lastDayOnOrBefore(r.live ? today : eom(r.month));
      if (!d0 || !d1 || d1 <= d0) return;
      const price = makePricer(assets, ledger, pb);
      const H = holdingsAt(ledger, assets, pb, base);
      const cashW = Math.max(0, H.cash);
      // A month that starts from nothing (the inception month, funded during the month) is kept, not dropped — skipping it
      // would leave the Carino chain one month short of the period's TWR. It is treated as 100% cash at 0%: no stock
      // weights, Rh = 0, trading = R (all of the return came from trades made during the month), allocation = −B* (out of
      // the market while the index moved) and selection = 0, so the month's effects still add up to R − B. startValue = 0.
      const total = Math.max(0, H.mv + cashW);
      const sec = {};
      const addP = (s, w, ret) => { const x = sec[s] || (sec[s] = { wp: 0, wr: 0, wb: 0, wbr: 0 }); x.wp += w; x.wr += w * ret; };
      if (total > 0) {
        H.rows.forEach((h) => { if (!h.mv) return; const p1 = price(h.name, d1); const ret = p1 && h.price ? p1.p / h.price - 1 : 0; addP(h.sector, h.mv / total, ret); });
        if (cashW) addP('Cash & Savings', cashW / total, 0);
      } else addP('Cash & Savings', 1, 0);
      const bw = benchWeights(bench, pb, d0) || [];
      bw.forEach((m) => { const p1 = pb.at(m.s, d1); const ret = p1 ? p1 * actionFactor(acts, m.s, d0, d1) / m.p - 1 : 0; const x = sec[m.sector] || (sec[m.sector] = { wp: 0, wr: 0, wb: 0, wbr: 0 }); x.wb += m.w; x.wbr += m.w * ret; });
      const Bs = sum(Object.values(sec).map((x) => x.wbr));
      const Rh = sum(Object.values(sec).map((x) => x.wr));
      const rows = Object.entries(sec).map(([s, x]) => {
        const rp = x.wp ? x.wr / x.wp : null;
        const rb = x.wb ? x.wbr / x.wb : CASH_LIKE.has(s) ? 0 : Bs;
        const alloc = (x.wp - x.wb) * (rb - Bs);
        const sel = x.wp ? x.wp * (rp - rb) : 0;
        return { sector: s, wp: x.wp, wb: x.wb, rp, rb: x.wb ? rb : null, alloc, sel };
      });
      out.push({ month: r.month, spans: r.spans || 1, spanFrom: r.spanFrom || r.month, live: !!r.live, d0, d1, R: r.ret, B: r.bench, Rh, Bs, trading: r.ret - Rh, replication: Bs - r.bench, sectors: rows,
        alloc: sum(rows.map((x) => x.alloc)), sel: sum(rows.map((x) => x.sel)), startValue: total, marksOpening: r.opening });
    });
    if (!out.length) return null;
    // Carino linking so the effects add up to the period's TWR − benchmark TWR
    const R = out.reduce((a, m) => a * (1 + m.R), 1) - 1, B = out.reduce((a, m) => a * (1 + m.B), 1) - 1;
    const k = (r, b) => (Math.abs(r - b) < 1e-12 ? 1 / (1 + r) : (Math.log(1 + r) - Math.log(1 + b)) / (r - b));
    const K = k(R, B);
    out.forEach((m) => { m.f = k(m.R, m.B) / K; });
    const L = (fn) => sum(out.map((m) => fn(m) * m.f));
    const sectors = {};
    out.forEach((m) => m.sectors.forEach((s) => {
      const x = sectors[s.sector] || (sectors[s.sector] = { sector: s.sector, wp: 0, wb: 0, alloc: 0, sel: 0, rp: 1, rb: 1, nP: 0, nB: 0 });
      x.wp += s.wp / out.length; x.wb += s.wb / out.length; x.alloc += s.alloc * m.f; x.sel += s.sel * m.f;
      if (s.rp != null && s.wp > 0) { x.rp *= 1 + s.rp; x.nP++; }
      if (s.rb != null) { x.rb *= 1 + s.rb; x.nB++; }
    }));
    const secRows = Object.values(sectors).map((x) => ({ ...x, rp: x.nP ? x.rp - 1 : null, rb: x.nB ? x.rb - 1 : null, total: x.alloc + x.sel })).sort((a, b) => b.total - a.total);
    return {
      months: out, R, B, active: R - B,
      alloc: L((m) => m.alloc), sel: L((m) => m.sel), trading: L((m) => m.trading), replication: L((m) => m.replication), tradingNote: TRADING_NOTE,
      sectors: secRows,
      trackingCheck: Math.sqrt(mean(out.map((m) => m.replication ** 2))),
    };
  }

  // Current active sector weights vs the replicated index (latest session).
  function activeWeights(pos, bench, pb, cash) {
    const d = pb.last; if (!d || !bench) return null;
    const bw = benchWeights(bench, pb, d) || [];
    const wb = {}; bw.forEach((m) => { wb[m.sector] = (wb[m.sector] || 0) + m.w; });
    const tot = pos.mvTotal + Math.max(0, cash);
    const wp = {}; pos.open.forEach((r) => { wp[r.sector] = (wp[r.sector] || 0) + (r.mv || 0) / tot; });
    if (cash > 0) wp['Cash & Savings'] = (wp['Cash & Savings'] || 0) + cash / tot;
    const secs = [...new Set([...Object.keys(wb), ...Object.keys(wp)])];
    return { date: d, rows: secs.map((s) => ({ sector: s, wp: wp[s] || 0, wb: wb[s] || 0, active: (wp[s] || 0) - (wb[s] || 0) })).sort((a, b) => b.active - a.active), members: bw.sort((a, b) => b.w - a.w) };
  }

  // ---------- trade-price sanity and corporate actions ----------
  // 'Trade prices agree with closing prices': Buy/Sell rows of quoted stocks whose price is more than 6% off that day's close.
  // 'Bonus shares booked': every action where the owner held the stock the day before, but no Bonus row within 7 days of it.
  function tradeChecks(ledger, assets, pb, actions) {
    const out = [];
    const byName = {}; Object.values(assets || {}).forEach((a) => { byName[a.name] = a; });
    const quoted = (a) => a && a.symbol && a.symbol !== 'SAVINGS' && !a.fund && !a.proxy && pb && pb.has(a.symbol);
    const off = [];
    if (pb && pb.days && pb.days.length) ledger.forEach((t) => {
      if ((t.t !== 'Buy' && t.t !== 'Sell') || !t.a || !(t.p > 0)) return;
      const a = byName[t.a]; if (!quoted(a)) return;
      const c = pb.at(a.symbol, t.d); if (!(c > 0)) return;
      // the day's range is at least the previous close to the close: on a day the stock jumps, a trade at the open is far
      // from the close but right. With no earlier close (its first day of trading, an IPO allotment) a statement's price stands.
      const prev = pb.at(a.symbol, new Date((dayNum(t.d) - 1) * 86400000).toISOString().slice(0, 10));
      if (!(prev > 0) && /^(stmt|invoice)-/.test(t.src || '')) return;
      const lo = prev > 0 ? Math.min(prev, c) : c, hi = prev > 0 ? Math.max(prev, c) : c;
      if (t.p < lo * 0.94 || t.p > hi * 1.06) off.push(`${a.symbol} ${t.d}: traded ${t.p} vs ${prev > 0 ? `previous close ${prev}, close ${c}` : `close ${c}`}`);
    });
    out.push({ label: 'Trade prices agree with closing prices', status: off.length ? 'warn' : 'ok', detail: off.length ? off.slice(0, 8).join('; ') + (off.length > 8 ? ` … ${off.length} rows` : '') : 'Every trade within 6% of that day\'s range (previous close to close)' });
    const missing = [];
    (actions || []).forEach((ac) => {
      if (!ac || !ac.s || !ac.date || !(ac.ratio > 1)) return;
      const names = Object.values(assets || {}).filter((a) => a.symbol === ac.s).map((a) => a.name); if (!names.length) return;
      const before = new Date(Date.UTC(+ac.date.slice(0, 4), +ac.date.slice(5, 7) - 1, +ac.date.slice(8, 10) - 1)).toISOString().slice(0, 10);
      const H = holdingsAt(ledger, assets, pb, before);
      const held = sum(H.rows.filter((r) => names.includes(r.name)).map((r) => r.shares));
      if (!(held > 0.5)) return;
      const lo = dayNum(ac.date) - 7, hi = dayNum(ac.date) + 7;
      const booked = ledger.some((t) => t.t === 'Bonus' && names.includes(t.a) && dayNum(t.d) >= lo && dayNum(t.d) <= hi);
      if (!booked) missing.push(`${ac.s}: bonus of about ${Math.round(held * (ac.ratio - 1))} shares on ${ac.date} (ratio ${ac.ratio}) has no Bonus row — check the statement`);
    });
    out.push({ label: 'Bonus shares booked', status: missing.length ? 'warn' : 'ok', detail: missing.length ? missing.join('; ') : 'No corporate actions missing' });
    return out;
  }

  // ---------- income ----------
  function income(ledger, assets, pos, market, today) {
    const byName = {}, bySym = {};
    Object.values(assets || {}).forEach((a) => { byName[a.name] = a; if (a.symbol) bySym[a.symbol] = a; });
    const resolve = (n) => (byName[n] ? n : bySym[n] ? bySym[n].name : n);
    const years = {};
    const perAsset = {};
    const since12 = `${addMonths(monthOf(today), -11)}-01`;
    ledger.forEach((t) => {
      if (!['Dividend', 'Rebate', 'Fee'].includes(t.t)) return;
      const y = t.d.slice(0, 4), m = +t.d.slice(5, 7);
      const Y = years[y] || (years[y] = { year: y, div: Array(12).fill(0), reb: Array(12).fill(0), fee: Array(12).fill(0) });
      const k = t.t === 'Dividend' ? 'div' : t.t === 'Rebate' ? 'reb' : 'fee';
      Y[k][m - 1] += t.amt || 0;
      if (t.t === 'Dividend' && t.a) {
        const n = resolve(t.a);
        const x = perAsset[n] || (perAsset[n] = { name: n, symbol: (byName[n] || {}).symbol || '', total: 0, ttm: 0, count: 0, last: null, payments: [] });
        x.total += t.amt || 0; x.count++; x.payments.push({ d: t.d, amt: t.amt });
        if (!x.last || t.d > x.last) x.last = t.d;
        if (t.d >= since12) x.ttm += t.amt || 0;
      }
    });
    const yearRows = Object.values(years).sort((a, b) => (a.year < b.year ? -1 : 1)).map((Y) => ({ ...Y, divT: sum(Y.div), rebT: sum(Y.reb), feeT: sum(Y.fee), net: sum(Y.div) + sum(Y.reb) + sum(Y.fee) }));
    const q = (market && market.quotes) || {};
    const holdings = pos.open.filter((r) => r.symbol && r.symbol !== 'SAVINGS').map((r) => {
      const pa = perAsset[r.name] || { total: 0, ttm: 0, count: 0, last: null };
      const dy = q[r.symbol] && q[r.symbol].dy != null ? q[r.symbol].dy / 100 : null;
      return { name: r.name, symbol: r.symbol, mv: r.mv, openCost: r.openCost, received: pa.total, ttm: pa.ttm, last: pa.last,
        yoc: r.openCost ? pa.ttm / r.openCost : null, dy, estIncome: dy != null && r.mv ? dy * r.mv : null };
    }).sort((a, b) => (b.estIncome || 0) - (a.estIncome || 0));
    const est = holdings.filter((h) => h.estIncome != null);
    return {
      years: yearRows, perAsset: Object.values(perAsset).sort((a, b) => b.total - a.total), holdings,
      totals: { div: sum(yearRows.map((y) => y.divT)), reb: sum(yearRows.map((y) => y.rebT)), fee: sum(yearRows.map((y) => y.feeT)) },
      ttmDiv: sum(Object.values(perAsset).map((x) => x.ttm)),
      estAnnual: sum(est.map((h) => h.estIncome)), estCoverage: pos.mvTotal ? sum(est.map((h) => h.mv || 0)) / pos.mvTotal : 0,
    };
  }

  // ---------- factsheet: trailing returns and the calendar grid ----------
  // Windows are calendar months ending at asOf: '3M' = the rows whose month lies in [asOf − 2 months, asOf]. A row that spans a
  // gap counts when its spanFrom is inside the window too; one that starts before the window makes the result null (its return
  // cannot be split), as does a window the rows do not fully cover (before inception, or ending in an unvalued month).
  // n = calendar months covered. YTD starts at January or inception, whichever is later.
  function trailing(months, asOf) {
    const rows = months.filter((r) => r.has && r.ret != null && r.month <= asOf);
    const chain = (list, k) => list.reduce((a, r) => a * (1 + (r[k] ?? 0)), 1) - 1;
    const inc = months.length ? months[0].month : asOf;
    const y = asOf.slice(0, 4);
    const res = [['1M', addMonths(asOf, 0)], ['3M', addMonths(asOf, -2)], ['6M', addMonths(asOf, -5)], ['YTD', `${y}-01` > inc ? `${y}-01` : inc], ['1Y', addMonths(asOf, -11)], ['Since inception', inc]];
    return res.map(([label, from]) => {
      const l = rows.filter((r) => r.month >= from);
      const len = PE.monthsBetween(from, asOf) + 1;
      const covered = sum(l.map((r) => r.spans || 1));
      if (!l.length || l.some((r) => (r.spanFrom || r.month) < from) || covered !== len) return { label, p: null, b: null, a: null, ann: null, n: 0, from };
      const p = chain(l, 'ret'), b = l.every((r) => r.bench != null) ? chain(l, 'bench') : null;
      const ann = label === 'Since inception' && len >= 12 ? { p: Math.pow(1 + p, 12 / len) - 1, b: b != null ? Math.pow(1 + b, 12 / len) - 1 : null } : null;
      return { label, p, b, a: b != null ? p - b : null, ann, n: len, from };
    });
  }
  function calendar(months, asOf) {
    const rows = months.filter((r) => r.has && r.ret != null && r.month <= asOf);
    const years = {};
    rows.forEach((r) => { const y = r.month.slice(0, 4); (years[y] || (years[y] = { year: y, m: Array(12).fill(null), b: Array(12).fill(null) })); years[y].m[+r.month.slice(5, 7) - 1] = r.ret; years[y].b[+r.month.slice(5, 7) - 1] = r.bench; });
    return Object.values(years).sort((a, b) => (a.year < b.year ? -1 : 1)).map((Y) => ({ ...Y,
      ytd: Y.m.reduce((a, x) => (x == null ? a : a * (1 + x)), 1) - 1,
      bytd: Y.b.every((x, i) => x != null || Y.m[i] == null) ? Y.b.reduce((a, x) => (x == null ? a : a * (1 + x)), 1) - 1 : null }));
  }

  // Daily-linked TWR over a range ({twr, from, to, n}); the same chain as dailyStats(D, range).twr. Lives in engine.js (run() uses it).
  const dailyTwr = PE.dailyTwr;

  // ---------- heads-up list (shared by the inbox job, tools/sync.js digest(), and the page, which computes it live) ----------
  const EXDIV_DAYS = 7, DRAWDOWN = 0.10;
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hFmt = (x) => (x == null ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const addDays = (d, k) => new Date(Date.parse(d + 'T00:00:00Z') + k * 864e5).toISOString().slice(0, 10);
  const dayLbl = (d) => `${+d.slice(8, 10)} ${MONTH_NAMES[+d.slice(5, 7) - 1]}`;
  const dayLblY = (d) => `${dayLbl(d)} ${d.slice(0, 4)}`;
  const pctTxt = (x) => `${(x * 100).toFixed(1)}%`;
  // shares held today per stock (funds and cash-like rows excluded), by ledger name
  function heldStocks(rows, items) {
    const sh = {};
    rows.forEach((t) => { if (!t.a || t.acc === 'MF' || !(t.t === 'Buy' || t.t === 'Sell' || t.t === 'Bonus')) return; sh[t.a] = (sh[t.a] || 0) + (t.t === 'Sell' ? -1 : 1) * (t.q || 0); });
    const byName = {}; Object.values(items || {}).forEach((a) => { if (a && a.name) byName[a.name] = a; });
    return Object.entries(sh).filter(([, q]) => q > 0.5).map(([name, q]) => ({ name, q, asset: byName[name] || {} }))
      .filter((h) => !h.asset.fund && h.asset.symbol).map((h) => ({ ...h, sym: h.asset.symbol.toUpperCase() }));
  }
  // Portfolio return index over the last 12 months (daily from history when there is any, else month-end), with the live
  // value (engine R.live: broker cash + positions at the latest prices) as the last point. Flow-adjusted, so a withdrawal
  // is never mistaken for a loss. Returns { dd, peak: {d, idx}, now: {d, value}, points, basis } or null (also when there is
  // no market/latest: without today's prices there is no live value to compare).
  function drawdownCheck(o) {
    if (!o.settings || !o.settings.inception || !o.market || !o.market.quotes) return null;
    const pb = priceBook(o.history || {});
    const pricer = makePricer(o.assets, PE.runLedger(o.tx), pb);
    const fallback = (name) => { const p = pricer(name, o.today); return p ? { p: p.p, d: pb.last } : null; };
    const R = PE.run({ settings: o.settings, marks: o.marks, assets: o.assets, tx: o.tx, market: o.market }, { type: 'Since Inception' }, { today: o.today, fallback });
    const from = addDays(o.today, -365), pts = [];
    const Dly = pb.days.length ? daily(o.settings, R.ledger, o.assets, pb, o.marks, o.today) : null;
    const drows = Dly ? Dly.rows.filter((r) => r.d >= from && r.d <= o.today) : [];
    let basis = 'daily';
    if (drows.length) drows.forEach((r, i) => pts.push({ d: r.d, value: r.value, idx: i === 0 ? 1 : pts[i - 1].idx * (1 + (r.ret == null ? 0 : r.ret)) }));
    else {
      basis = 'month-end';
      R.months.filter((r) => r.has && PE.eom(r.month) >= from && r.month < PE.monthOf(o.today)).forEach((r, i) => pts.push({ d: PE.eom(r.month), value: r.value, idx: i === 0 ? 1 : pts[i - 1].idx * (1 + (r.ret == null ? 0 : r.ret)) }));
    }
    if (R.live && pts.length) {
      const last = pts[pts.length - 1], V = R.live.cash + R.live.securities;
      const flow = o.tx.filter((t) => (t.t === 'Deposit' || t.t === 'Withdrawal') && t.d > last.d && t.d <= o.today).reduce((s, t) => s + (t.amt || 0), 0);
      if (last.d < o.today && last.value + flow > 0) pts.push({ d: o.today, value: V, idx: last.idx * V / (last.value + flow), live: true });
    }
    if (pts.length < 2) return null;
    const peak = pts.reduce((a, p) => (p.idx > a.idx ? p : a)), now = pts[pts.length - 1];
    return { dd: now.idx / peak.idx - 1, peak: { d: peak.d, idx: peak.idx }, now: { d: now.d, value: now.value, live: !!now.live }, points: pts.length, basis };
  }
  // ---------- unusual volume ----------
  // Held and watch-list stocks (assets with watch: true) whose latest session (market/latest quote: vol, avgVol = the
  // 30-session average, date within the last 4 days) traded VOL_X times the average or more, biggest first.
  const VOL_X = 3;
  const volTxt = (x) => (x >= 999500 ? `${(x / 1e6).toFixed(1)}M` : x >= 999.5 ? `${Math.round(x / 1e3)}K` : String(Math.round(x)));
  function volumeSpikes(tx, assets, quotes, today) {
    const syms = new Map();
    heldStocks(tx, assets).forEach((h) => syms.set(h.sym, true));
    Object.values(assets || {}).forEach((a) => { if (a && a.watch === true && a.symbol && !syms.has(String(a.symbol).toUpperCase())) syms.set(String(a.symbol).toUpperCase(), false); });
    const out = [];
    syms.forEach((held, s) => {
      const q = (quotes || {})[s];
      if (!q || !(q.vol > 0) || !(q.avgVol > 0) || !q.date || q.date < addDays(today, -4) || q.date > today) return;
      const x = q.vol / q.avgVol;
      if (x >= VOL_X) out.push({ s, held, d: q.date, x, vol: q.vol, avg: q.avgVol, chg: q.chg || 0 });
    });
    return out.sort((a, b) => b.x - a.x);
  }

  // ---------- how the holdings move: correlation, beta and a stress test ----------
  // From the daily closes (history) of the last `days` EGX sessions: each holding's daily returns (its own symbol, or its
  // proxy, e.g. a gold fund on GOLD24K; cash-like funds count as cash), its beta to the EGX30 Capped, the correlation of
  // every pair, the portfolio's beta (weights of the whole portfolio with cash; a holding without enough prices counts
  // as not moving), what an index drop of 5 / 10 / 20% would likely do, and a replay of the index's worst day in the window
  // on today's holdings. R: a PE.run result (pos.open, liveCash). Returns null without history.
  //   {days, from, to, total, beta, holdings: [{s, n, sec, w, beta, corrIdx, vol, obs}], corr: {syms, m}, pairs: [{a, b, c}]
  //    (every pair, most alike first), avgCorr, stress: [{x, port, egp, rows: [{s, move, egp}]}], worst: {d, idx, port}}
  function riskModel(R, assets, history, o) {
    o = o || {};
    const N = o.days || 120, MIN = 30;
    const snap = {}; Object.keys(history || {}).forEach((m) => Object.assign(snap, (history[m] && history[m].days) || {}));
    const days = Object.keys(snap).filter((d) => snap[d] && snap[d].EGX30CAPPED != null && (!o.today || d <= o.today)).sort().slice(-(N + 1));
    if (days.length < MIN + 1) return null;
    const rets = (key) => days.slice(1).map((d, i) => { const a = snap[days[i]][key], b = snap[d][key]; return a > 0 && b > 0 ? b / a - 1 : null; });
    const idx = rets('EGX30CAPPED');
    const byName = {}; Object.values(assets || {}).forEach((a) => { if (a && a.name) byName[a.name] = a; });
    const cash = Math.max(0, R.liveCash != null ? R.liveCash : (R.settings && R.settings.cash) || 0), total = (R.pos.mvTotal || 0) + cash;
    const pairStats = (x, y) => {
      const xs = [], ys = []; x.forEach((v, i) => { if (v != null && y[i] != null) { xs.push(v); ys.push(y[i]); } });
      if (xs.length < MIN) return null;
      const mx = mean(xs), my = mean(ys);
      let sxy = 0, sxx = 0, syy = 0; xs.forEach((v, i) => { sxy += (v - mx) * (ys[i] - my); sxx += (v - mx) ** 2; syy += (ys[i] - my) ** 2; });
      return { n: xs.length, cov: sxy / (xs.length - 1), vx: sxx / (xs.length - 1), vy: syy / (xs.length - 1), c: sxx && syy ? sxy / Math.sqrt(sxx * syy) : null };
    };
    const hold = (total > 0 ? R.pos.open : []).filter((p) => (p.mv || 0) > 0 && !CASH_LIKE.has(p.sector)).map((p) => {
      const a = byName[p.name] || {}, sym = (p.symbol || a.symbol || '').toUpperCase();
      const key = sym && snap[days[days.length - 1]] && Object.prototype.hasOwnProperty.call(snap[days[days.length - 1]], sym) ? sym : a.proxy && days.some((d) => snap[d][a.proxy] != null) ? a.proxy : sym;
      const r = key ? rets(key) : days.slice(1).map(() => null);
      const st = pairStats(r, idx), own = r.filter((v) => v != null);
      return { s: sym || p.name, n: p.name, sec: p.sector || 'Unclassified', w: p.mv / total, r, obs: own.length,
        beta: st && st.vy ? st.cov / st.vy : null, corrIdx: st ? st.c : null, vol: own.length >= MIN ? Math.sqrt(own.reduce((s2, v) => s2 + (v - mean(own)) ** 2, 0) / (own.length - 1)) * Math.sqrt(250) : null };
    }).sort((a, b) => b.w - a.w);
    const beta = sum(hold.map((h) => h.w * (h.beta || 0)));
    const m = hold.map((a) => hold.map((b) => (a === b ? 1 : (pairStats(a.r, b.r) || {}).c ?? null)));
    const pairs = [];
    hold.forEach((a, i) => hold.forEach((b, j) => { if (j > i && m[i][j] != null) pairs.push({ a: a.s, b: b.s, c: m[i][j] }); }));
    pairs.sort((x, y) => y.c - x.c);
    const off = []; m.forEach((row, i) => row.forEach((c, j) => { if (j > i && c != null) off.push(c); }));
    const stress = [-0.05, -0.1, -0.2].map((x) => {
      const rows = hold.map((h) => ({ s: h.s, move: (h.beta || 0) * x, egp: h.w * total * (h.beta || 0) * x }));
      return { x, port: beta * x, egp: total * beta * x, rows };
    });
    let wi = -1; idx.forEach((v, i) => { if (v != null && (wi < 0 || v < idx[wi])) wi = i; });
    const worst = wi >= 0 ? { d: days[wi + 1], idx: idx[wi], port: sum(hold.map((h) => h.w * (h.r[wi] || 0))) } : null;
    return { days: days.length - 1, from: days[0], to: days[days.length - 1], total, beta, avgCorr: off.length ? mean(off) : null,
      holdings: hold.map(({ r, ...h }) => h), corr: { syms: hold.map((h) => h.s), m }, pairs, stress, worst };
  }

  // ---------- the morning brief (the email before the EGX opens, Sun-Thu) ----------
  // From the latest close (market/latest): the portfolio's last session (value, P/L, the index), every holding's move,
  // what is coming in the next 7 days for held and watch-list stocks (ex-dividend, earnings), holdings near (within 5%)
  // or past their target / stop, unusual volume, your limits, and what a 5% index drop would likely do. run: portfolioRun.
  function morningBrief(run, o) {
    o = o || {};
    const R = run.R, today = o.today || run.today, mk = run.data.market || {}, quotes = mk.quotes || {};
    const byName = {}; Object.values(run.data.assets || {}).forEach((a) => { if (a && a.name) byName[a.name] = a; });
    const open = R.pos.open.filter((p) => (p.mv || 0) > 0);
    const cash = Math.max(0, R.liveCash != null ? R.liveCash : R.settings.cash || 0), value = R.pos.mvTotal + cash;
    const ix = (mk.index || {}).EGX30CAPPED || {};
    const session = ix.date || Object.values(quotes).reduce((d, q) => (q && q.date && q.date > d ? q.date : d), '') || null;
    const movers = open.filter((p) => !CASH_LIKE.has(p.sector) && p.chg != null).map((p) => {
      const q = quotes[(p.symbol || '').toUpperCase()] || {};
      const fresh = !session || !q.date || q.date >= session;
      return { s: p.symbol || p.name, n: p.name, chg: fresh ? p.chg / 100 : 0, pl: fresh ? p.mv - p.mv / (1 + p.chg / 100) : 0, w: value ? p.mv / value : 0, fresh };
    }).sort((a, b) => b.chg - a.chg);
    const pl = sum(movers.map((x) => x.pl));
    const upcoming = [], until = addDays(today, 7);
    const seen = new Set();
    const consider = (sym, held) => {
      if (!sym || seen.has(sym)) return; seen.add(sym);
      const q = quotes[sym]; if (!q) return;
      if (q.exDate && q.exDate >= today && q.exDate <= until) upcoming.push({ kind: 'exdiv', s: sym, d: q.exDate, held, divUp: q.divUp != null ? q.divUp : null });
      if (q.earn && q.earn >= today && q.earn <= until) upcoming.push({ kind: 'earnings', s: sym, d: q.earn, held });
    };
    heldStocks(run.data.tx || [], run.data.assets).forEach((h) => consider(h.sym, true));
    Object.values(run.data.assets || {}).forEach((a) => { if (a && a.watch === true && a.symbol) consider(String(a.symbol).toUpperCase(), false); });
    upcoming.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    const levels = [];
    open.forEach((p) => {
      const a = byName[p.name] || {}, px = p.price, s = p.symbol || p.name;
      if (!(px > 0)) return;
      const tg = Number(a.target), sp = Number(a.stop);
      if (a.target != null && a.target !== '' && tg > 0 && tg / px - 1 <= 0.05) levels.push({ kind: 'target', s, price: px, level: tg, gap: tg / px - 1 });
      if (a.stop != null && a.stop !== '' && sp > 0 && 1 - sp / px <= 0.05) levels.push({ kind: 'stop', s, price: px, level: sp, gap: sp / px - 1 });
    });
    let risk = null; try { risk = riskModel(R, run.data.assets, o.history || run.data.history || {}, { today }); } catch (e) { risk = null; }
    const lim = limitCheck(R, R.settings.limits);
    return { today, session, value, pl, ret: value - pl > 0 ? pl / (value - pl) : null, index: ix.chg != null ? ix.chg / 100 : null, indexClose: ix.close != null ? ix.close : null,
      movers, upcoming, levels, volume: volumeSpikes(run.data.tx || [], run.data.assets, quotes, today), limits: lim ? lim.over : null,
      stress: risk ? { beta: risk.beta, drop5: risk.stress[0].port, egp5: risk.stress[0].egp } : null };
  }

  // ---------- your limits (settings.limits) ----------
  // limits = {on, stock, sector}: the most one stock and one sector may be of the WHOLE portfolio (holdings at the latest
  // prices + cash; cash-like funds count as cash, never as a stock or a sector), as fractions (0.2 = 20%); a missing or
  // empty one is no limit. R: a PE.run result. Returns null when off, else {stock, sector, total, stocks: [{n, s, sec, w}],
  // sectors: [{sec, w}] (largest first), over: [{kind 'stock' | 'sector', n, s, w, limit}]}.
  function limitCheck(R, limits) {
    const L = limits || {};
    if (!L.on) return null;
    const lim = (x) => (typeof x === 'number' && isFinite(x) && x > 0 ? x : null);
    const cash = Math.max(0, R.liveCash != null ? R.liveCash : (R.settings && R.settings.cash) || 0), total = (R.pos.mvTotal || 0) + cash;
    const stocks = total > 0 ? R.pos.open.filter((p) => (p.mv || 0) > 0 && !CASH_LIKE.has(p.sector))
      .map((p) => ({ n: p.name, s: p.symbol || '', sec: p.sector || 'Unclassified', w: p.mv / total })).sort((a, b) => b.w - a.w) : [];
    const m = {}; stocks.forEach((x) => { m[x.sec] = (m[x.sec] || 0) + x.w; });
    const sectors = Object.keys(m).map((sec) => ({ sec, w: m[sec] })).sort((a, b) => b.w - a.w);
    const out = { stock: lim(L.stock), sector: lim(L.sector), total, stocks, sectors, over: [] };
    if (out.stock) stocks.filter((x) => x.w > out.stock + 1e-9).forEach((x) => out.over.push({ kind: 'stock', n: x.n, s: x.s, w: x.w, limit: out.stock }));
    if (out.sector) sectors.filter((x) => x.w > out.sector + 1e-9).forEach((x) => out.over.push({ kind: 'sector', n: x.sec, s: '', w: x.w, limit: out.sector }));
    return out;
  }
  // a limit crossed, as a heads-up line (the page, the owner's inbox email and the accounts' alerts use the same words)
  const limitText = (x) => `${x.kind === 'stock' ? (x.s || x.n) : `The ${x.n} sector`} is ${pctTxt(x.w)} of your portfolio, over your ${+(x.limit * 100).toFixed(1)}% limit for one ${x.kind}`;

  // The heads-up items that follow from the data alone: ex-dividend within a week for a held stock, a held stock at or past
  // its target / stop, a stock or sector over the portfolio's own limit (settings.limits, limitCheck), and the portfolio more than
  // 10% below its 12-month high. o = {today, tx, assets, settings, marks,
  // market, history}. Every check is independent; one that fails is listed in errors. (The inbox job adds overdue statements.)
  function headsUp(o) {
    const items = [], errors = [];
    let drawdown = null;
    const quotes = (o.market && o.market.quotes) || {};
    let held = [];
    try { held = heldStocks(o.tx || [], o.assets); } catch (e) { errors.push('holdings: ' + (e.message || e)); }
    held.forEach((h) => {
      const q = quotes[h.sym]; if (!q) return;
      if (q.exDate && q.exDate >= o.today && q.exDate <= addDays(o.today, EXDIV_DAYS))
        items.push({ kind: 'exdiv', key: `exdiv:${h.sym}:${q.exDate}`, text: `Ex-dividend on ${dayLbl(q.exDate)}: ${h.sym} ${q.divUp != null ? `${hFmt(q.divUp)} EGP a share` : '(amount not published yet)'}` });
      const px = Number(q.price), tg = Number(h.asset.target), sp = Number(h.asset.stop);
      if (!(px > 0)) return;
      if (h.asset.target != null && h.asset.target !== '' && tg > 0 && px >= tg) items.push({ kind: 'target', key: `target:${h.sym}:${tg}`, text: `${h.sym} reached its target: ${hFmt(px)} vs target ${hFmt(tg)}` });
      if (h.asset.stop != null && h.asset.stop !== '' && sp > 0 && px <= sp) items.push({ kind: 'stop', key: `stop:${h.sym}:${sp}`, text: `${h.sym} is at or below its stop: ${hFmt(px)} vs stop ${hFmt(sp)}` });
    });
    // unusual volume: a held or watch-list stock whose last session traded VOL_X times its 30-session average or more
    try {
      volumeSpikes(o.tx || [], o.assets, quotes, o.today).forEach((v) => items.push({ kind: 'volume', key: `volume:${v.s}:${v.d}`,
        text: `${v.s}${v.held ? '' : ' (watch list)'} traded ${v.x.toFixed(1)}× its usual volume on ${dayLbl(v.d)}: ${volTxt(v.vol)} shares vs ${volTxt(v.avg)} a day, ${v.chg >= 0 ? '+' : '−'}${Math.abs(v.chg).toFixed(1)}% that day` }));
    } catch (e) { errors.push('volume: ' + (e.message || e)); }
    try {
      const L = o.settings && o.settings.limits;
      if (L && L.on && o.settings.inception) {
        const pb = priceBook(o.history || {});
        const pricer = makePricer(o.assets, PE.runLedger(o.tx || []), pb);
        const fallback = (name) => { const p = pricer(name, o.today); return p ? { p: p.p, d: pb.last } : null; };
        const R = PE.run({ settings: o.settings, marks: o.marks, assets: o.assets, tx: o.tx || [], market: o.market }, { type: 'Since Inception' }, { today: o.today, fallback });
        limitCheck(R, L).over.forEach((x) => items.push({ kind: 'limit', key: `limit:${x.kind}:${x.s || x.n}:${Math.round(x.limit * 1000) / 10}`, text: limitText(x) }));
      }
    } catch (e) { errors.push('limits: ' + (e.message || e)); }
    try {
      drawdown = drawdownCheck(o);
      if (drawdown && drawdown.dd < -DRAWDOWN) {
        const band = Math.floor(-drawdown.dd * 10) * 10;
        items.push({ kind: 'drawdown', key: `drawdown:${drawdown.peak.d}:${band}`, text: `Portfolio down ${pctTxt(-drawdown.dd)} from its 12-month high on ${dayLblY(drawdown.peak.d)} (returns only, deposits and withdrawals left out); value now ${hFmt(drawdown.now.value)} EGP` });
      }
    } catch (e) { errors.push('drawdown: ' + (e.message || e)); }
    return { items, drawdown, errors };
  }

  // ---------- trading habits (Analysis → Your trading) ----------
  // How the trades went, by habit. trips: the engine's closed round trips of the period (pos.trips, cash-like funds already
  // left out by the caller). o: { open (pos.open, cash-like left out), ledger (for the sale prices), pb (price book), quotes
  // (market.quotes, today's prices), today }. Returns plain numbers, no text: the page writes the sentences.
  //   per trade: n, wins, losses, winRate, pl, expectancy (P/L per trade), avgWin, avgLoss, holdWin / holdLoss (days)
  //   byHold / bySector / bySize (thirds by money put in, from 6 trades) / byMonth (month sold): n, wins, winRate, pl, avgRoi
  //   streaks: longest run of wins and of losses, and the current run (by sale date)
  //   after: each sold stock 30 days after the sale (or up to today when 30 days have not passed): your average sale price,
  //          the price then, the move, and what the shares you sold gained or lost since (amount); avg30 / amount30 over
  //          the trips with the full 30 days; indexMove / avgIndex30: EGX30 Capped over the same days
  //   repeat: stocks traded more than once in the period; open: open positions split into winners and losers
  //   bigLosses: the 3 biggest losses and their share of all losses
  const HOLD_BUCKETS = [['week', 'Up to a week', 0, 7], ['month', '1 to 4 weeks', 8, 30], ['quarter', '1 to 3 months', 31, 90], ['long', 'Over 3 months', 91, Infinity]];
  function tradingHabits(trips, o) {
    o = o || {};
    trips = (trips || []).filter((t) => t && t.lastSell);
    const group = (list) => {
      const w = list.filter((t) => t.total > 0);
      return { n: list.length, wins: w.length, winRate: list.length ? w.length / list.length : null, pl: sum(list.map((t) => t.total)),
        avgRoi: list.length ? mean(list.map((t) => t.roi)) : null };
    };
    const wins = trips.filter((t) => t.total > 0), losses = trips.filter((t) => t.total <= 0);
    const out = { ...group(trips), losses: losses.length,
      expectancy: trips.length ? sum(trips.map((t) => t.total)) / trips.length : null,
      avgWin: wins.length ? mean(wins.map((t) => t.total)) : null, avgLoss: losses.length ? mean(losses.map((t) => t.total)) : null,
      holdWin: wins.length ? mean(wins.map((t) => t.holdDays)) : null, holdLoss: losses.length ? mean(losses.map((t) => t.holdDays)) : null };
    out.byHold = HOLD_BUCKETS.map(([key, label, lo, hi]) => ({ key, label, lo, hi, ...group(trips.filter((t) => t.holdDays >= lo && t.holdDays <= hi)) }));
    const by = (keyOf) => { const m = {}; trips.forEach((t) => { (m[keyOf(t)] || (m[keyOf(t)] = [])).push(t); }); return m; };
    const sec = by((t) => t.sector || 'Unclassified');
    out.bySector = Object.keys(sec).map((k) => ({ sector: k, ...group(sec[k]) })).sort((a, b) => b.pl - a.pl);
    out.bySize = null;
    if (trips.length >= 6) {
      const sorted = trips.slice().sort((a, b) => a.buyCost - b.buyCost), n = sorted.length, c1 = Math.floor(n / 3), c2 = Math.floor((2 * n) / 3);
      out.bySize = [['Smallest third', sorted.slice(0, c1)], ['Middle third', sorted.slice(c1, c2)], ['Largest third', sorted.slice(c2)]]
        .map(([label, l]) => ({ label, lo: l[0].buyCost, hi: l[l.length - 1].buyCost, ...group(l) }));
    }
    const mon = by((t) => monthOf(t.lastSell));
    out.byMonth = Object.keys(mon).sort().map((m) => ({ month: m, ...group(mon[m]) }));
    // streaks, oldest sale first
    const chrono = trips.slice().sort((a, b) => (a.lastSell < b.lastSell ? -1 : a.lastSell > b.lastSell ? 1 : a.trip - b.trip));
    let run = 0, kind = null, best = { win: 0, loss: 0 };
    chrono.forEach((t) => { const k = t.total > 0 ? 'win' : 'loss'; run = k === kind ? run + 1 : 1; kind = k; if (run > best[k]) best[k] = run; });
    out.streaks = { win: best.win, loss: best.loss, current: kind ? { kind, n: run } : null };
    // after the sale
    const pb = o.pb, quotes = o.quotes || {}, ledger = o.ledger || [], today = o.today || PE.cairoToday();
    const dayStr = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
    out.after = { rows: [], avg30: null, avgIndex30: null, n30: 0, amount30: null };
    trips.forEach((t) => {
      if (!t.symbol || !(t.sold > 0)) return;
      const sells = ledger.filter((x) => x.t === 'Sell' && x.a === t.name && x.d >= t.firstBuy && x.d <= t.lastSell && x.p > 0 && x.q > 0);
      const q = sum(sells.map((x) => x.q)), sellPx = q ? sum(sells.map((x) => x.p * x.q)) / q : t.proceeds / t.sold;
      const d30 = dayStr(dayNum(t.lastSell) + 30), full = !!(pb && pb.last && d30 <= pb.last);
      let px = null, pxDate = null;
      if (full) { px = pb.at(t.symbol, d30); pxDate = pb.lastDayOnOrBefore(d30); }
      else { const qt = quotes[t.symbol]; if (qt && qt.price > 0) { px = qt.price; pxDate = qt.date || today; } else if (pb && pb.last) { px = pb.at(t.symbol, pb.last); pxDate = pb.last; } }
      if (!(px > 0) || !(sellPx > 0)) return;
      // the index over the same days, so a market-wide move is not read as a good or bad exit
      const i0 = pb && pb.at('EGX30CAPPED', t.lastSell), i1 = pb && (full ? pb.at('EGX30CAPPED', d30) : pb.at('EGX30CAPPED', pb.last));
      out.after.rows.push({ name: t.name, symbol: t.symbol, sold: t.lastSell, sellPx, px, pxDate, full30: full,
        days: Math.max(0, dayNum(pxDate || today) - dayNum(t.lastSell)), move: px / sellPx - 1, amount: (px - sellPx) * t.sold, outcome: t.outcome,
        indexMove: i0 > 0 && i1 > 0 ? i1 / i0 - 1 : null });
    });
    out.after.rows.sort((a, b) => (a.sold < b.sold ? 1 : a.sold > b.sold ? -1 : 0));
    const f30 = out.after.rows.filter((r) => r.full30);
    out.after.n30 = f30.length;
    if (f30.length) {
      out.after.avg30 = mean(f30.map((r) => r.move)); out.after.amount30 = sum(f30.map((r) => r.amount));
      const wi = f30.filter((r) => r.indexMove != null);
      out.after.avgIndex30 = wi.length === f30.length ? mean(wi.map((r) => r.indexMove)) : null;
    }
    // stocks traded more than once
    const nm = by((t) => t.name);
    out.repeat = Object.keys(nm).filter((k) => nm[k].length > 1).map((k) => ({ name: k, symbol: nm[k][0].symbol, ...group(nm[k]) })).sort((a, b) => b.n - a.n || b.pl - a.pl);
    // open positions now
    const open = (o.open || []).filter((r) => r.openCost > 0), side = (l) => ({ n: l.length, avgDays: l.length ? mean(l.map((r) => r.holdDays || 0)) : null,
      avgPct: l.length ? mean(l.map((r) => r.unreal / r.openCost)) : null, amount: sum(l.map((r) => r.unreal || 0)) });
    out.open = { winners: side(open.filter((r) => r.unreal > 0)), losers: side(open.filter((r) => r.unreal <= 0)) };
    // the biggest losses
    const lossAmts = losses.map((t) => t.total).filter((x) => x < 0).sort((a, b) => a - b), allLoss = sum(lossAmts);
    out.bigLosses = lossAmts.length ? { n: Math.min(3, lossAmts.length), top: sum(lossAmts.slice(0, 3)), share: allLoss ? sum(lossAmts.slice(0, 3)) / allLoss : null, count: lossAmts.length } : null;
    return out;
  }

  // ---------- one portfolio from its documents, and the percentages profile friends see ----------
  // docs: {"coll/doc": data}, a portfolio's documents plus market/latest, history/<YYYY-MM> and bench/egx30. Runs the
  // engine the way the page does: closed months without a statement estimated from closing prices, the daily series,
  // a held stock without a quote priced from the price book. o: {today, market (a fresher market/latest: the site's live
  // prices)}. Returns {R, data, today} or null when there is no portfolio yet. Used by the site (lock.js) and
  // tools/profile.js (the job), so a friend sees the same figures from either.
  function portfolioRun(docs, sel, o) {
    o = o || {};
    const st0 = docs && docs['portfolio/settings'];
    if (!st0 || !st0.inception) return null;
    const tx = Object.keys(docs).filter((k) => k.startsWith('ledger/')).sort().flatMap((k) => (docs[k] && docs[k].rows) || []);
    const assets = (docs['portfolio/assets'] || {}).items || {}, marks0 = (docs['portfolio/marks'] || {}).months || {};
    const history = {}; Object.keys(docs).forEach((k) => { if (k.startsWith('history/')) history[k.slice(8)] = docs[k]; });
    const today = o.today || PE.cairoToday(), led = PE.runLedger(tx), pb = priceBook(history), pricer = makePricer(assets, led, pb);
    const fallback = (name) => { const p = pricer(name, today); return p ? { p: p.p, d: pb.last } : null; };
    let D = null; try { D = daily(st0, led, assets, pb, marks0, today); } catch (e) { D = null; }
    let marks = marks0; try { if (Object.keys(history).length) marks = estimateMarks(st0, marks0, led, assets, pb, today); } catch (e) { marks = marks0; }
    const data = { settings: st0, marks, assets, tx, market: o.market || docs['market/latest'] || null, bench: docs['bench/egx30'] || null, history };
    return { R: PE.run(data, sel || { type: 'Since Inception' }, { fallback, daily: D || undefined, today }), data, today };
  }

  // Every sale of a stock (a part sale too; cash-like funds left out): its result over the average cost of the shares sold
  // (the ledger's basis) and its days held from the buy that opened the position. [{d, s, n, kind, pl, roi, days}]
  function salesOf(R, assets) {
    const sectorOf = {}, symOf = {}; Object.values(assets || {}).forEach((a) => { if (a && a.name) { sectorOf[a.name] = a.sector; symOf[a.name] = a.symbol || ''; } });
    const thr = typeof R.settings.openThreshold === 'number' ? R.settings.openThreshold : 0.5;
    const held = {}, opened = {}, sales = [];
    PE.sortLedger(R.ledger).forEach((t) => {
      if (!t.a || (t.t !== 'Buy' && t.t !== 'Sell' && t.t !== 'Bonus')) return;
      const h = held[t.a] || 0, q = t.q || 0;
      if (t.t !== 'Sell') { if (h <= thr) opened[t.a] = t.d; held[t.a] = h + q; return; }
      held[t.a] = h - q;
      if (CASH_LIKE.has(sectorOf[t.a]) || !(t.basis > 0)) return;
      const pl = (t.amt || 0) - t.basis;
      sales.push({ d: t.d, s: symOf[t.a] || '', n: t.a, kind: held[t.a] <= thr ? 'closed' : 'trimmed', pl, roi: pl / t.basis, days: opened[t.a] ? dayNum(t.d) - dayNum(opened[t.a]) : null });
    });
    return sales;
  }

  // The yearly wrap-up (the email in early January): year Y in review. run: an all-time portfolioRun.
  //   {year, ret, bench, months: [{m, r, b}], best / worst month, posMonths, sales: {n, wins, winRate, pl, best, worst},
  //    mostTraded: {s, n, trades}, longest: {s, n, days, open}, buys, dividends, deposits, withdrawals, start, end}
  // ret / bench compound the year's months (time-weighted: deposits and withdrawals do not count as gains).
  function yearWrapped(run, Y) {
    const R = run.R, y = String(Y);
    const sectorOf = {}, symOf = {}; Object.values(run.data.assets || {}).forEach((a) => { if (a && a.name) { sectorOf[a.name] = a.sector; symOf[a.name] = a.symbol || ''; } });
    const months = R.months.filter((r) => r.has && r.ret != null && r.month.slice(0, 4) === y).map((r) => ({ m: r.month, r: r.ret, b: r.bench, value: r.value, live: !!r.live }));
    const comp = (k) => (months.length && months.every((x) => x[k] != null) ? months.reduce((a, x) => a * (1 + x[k]), 1) - 1 : null);
    const byR = months.slice().sort((a, b) => b.r - a.r);
    const sales = salesOf(R, run.data.assets).filter((x) => x.d.slice(0, 4) === y), wins = sales.filter((x) => x.pl > 0);
    // best and worst by return, among sales of a real size (at least 0.5% of the average month-end value): a few shares
    // left over are not "the worst trade of the year"
    const avgV = months.length ? mean(months.map((x) => x.value || 0)) : 0, sized = sales.filter((x) => !avgV || Math.abs(x.pl / x.roi) >= 0.005 * avgV);
    const bySale = (sized.length ? sized : sales).slice().sort((a, b) => b.roi - a.roi);
    const rows = R.ledger.filter((t) => t.d && t.d.slice(0, 4) === y);
    const count = {}; rows.forEach((t) => { if (t.a && (t.t === 'Buy' || t.t === 'Sell') && !CASH_LIKE.has(sectorOf[t.a])) count[t.a] = (count[t.a] || 0) + 1; });
    const top = Object.keys(count).sort((a, b) => count[b] - count[a] || (a < b ? -1 : 1))[0];
    // the longest hold: a sale in the year, or a position still open at the year's end (counted to 31 Dec, or to today)
    const end = `${y}-12-31` < (run.today || '') ? `${y}-12-31` : run.today;
    let longest = null;
    sales.forEach((x) => { if (x.days != null && (!longest || x.days > longest.days)) longest = { s: x.s, n: x.n, days: x.days, open: false }; });
    const thr = typeof R.settings.openThreshold === 'number' ? R.settings.openThreshold : 0.5, held = {}, opened = {};
    PE.sortLedger(R.ledger).forEach((t) => { if (!t.a || t.d > end || (t.t !== 'Buy' && t.t !== 'Sell' && t.t !== 'Bonus')) return; const h = held[t.a] || 0;
      if (t.t !== 'Sell' && h <= thr) opened[t.a] = t.d; held[t.a] = h + (t.t === 'Sell' ? -1 : 1) * (t.q || 0); });
    Object.keys(held).forEach((n) => { if (held[n] > thr && opened[n] && !CASH_LIKE.has(sectorOf[n])) { const d = dayNum(end) - dayNum(opened[n]); if (!longest || d > longest.days) longest = { s: symOf[n] || '', n, days: d, open: true }; } });
    const prevDec = R.months.find((r) => r.month === `${Number(y) - 1}-12` && r.has);
    return { year: Number(y), ret: comp('r'), bench: comp('b'), months: months.map(({ m, r, b, live }) => ({ m, r, b, live })), partial: months.length < 12 || months.some((x) => x.live),
      best: byR[0] ? { m: byR[0].m, r: byR[0].r } : null, worst: byR.length > 1 ? { m: byR[byR.length - 1].m, r: byR[byR.length - 1].r } : null,
      posMonths: months.filter((x) => x.r > 0).length,
      sales: { n: sales.length, wins: wins.length, winRate: sales.length ? wins.length / sales.length : null, pl: sum(sales.map((x) => x.pl)), best: bySale[0] || null, worst: bySale.length > 1 ? bySale[bySale.length - 1] : null },
      mostTraded: top ? { s: symOf[top] || '', n: top, trades: count[top] } : null, longest,
      buys: rows.filter((t) => t.t === 'Buy' && !CASH_LIKE.has(sectorOf[t.a])).length,
      dividends: sum(rows.filter((t) => t.t === 'Dividend').map((t) => t.amt || 0)),
      deposits: sum(rows.filter((t) => t.t === 'Deposit').map((t) => t.amt || 0)), withdrawals: -sum(rows.filter((t) => t.t === 'Withdrawal').map((t) => t.amt || 0)),
      start: prevDec ? prevDec.value : null, end: months.length ? months[months.length - 1].value : null };
  }

  // The monthly trading report card (the email on the 1st): how month M went next to the month before. run: an all-time
  // portfolioRun. Every sale counts (a part sale too), cash-like funds left out: its result is the money it brought in
  // over the average cost of the shares sold (the ledger's basis), its holding days from the buy that opened the position.
  // Returns {month, prevMonth, ret, bench, prevRet, prevBench, provisional, cur, prev, best, worst, activity, limits, tips}:
  //   cur / prev  {n, wins, losses, winRate, avgRoi, pl, avgHold, holdWin, holdLoss, avgWin, avgLoss} (null: no sale)
  //   best/worst  {d, s, n, kind 'closed' | 'trimmed', roi, pl, days} the month's best and worst sale by return on cost
  //   activity    {buys, sells, deposits, withdrawals} rows in the month (deposits / withdrawals as positive EGP)
  //   limits      limitCheck now (null when the portfolio has no limits switched on)
  //   tips        plain sentences from the numbers (holding losers longer than winners, small wins and big losses, ...)
  function reportCard(run, M) {
    const R = run.R, prevMonth = PE.monthOf(addDays(M + '-01', -1));
    const sectorOf = {}, symOf = {}; Object.values(run.data.assets || {}).forEach((a) => { if (a && a.name) { sectorOf[a.name] = a.sector; symOf[a.name] = a.symbol || ''; } });
    const sales = salesOf(R, run.data.assets);
    const stats = (m) => {
      const list = sales.filter((x) => x.d.slice(0, 7) === m);
      if (!list.length) return null;
      const w = list.filter((x) => x.pl > 0), l = list.filter((x) => x.pl <= 0), days = (a) => { const d = a.filter((x) => x.days != null); return d.length ? mean(d.map((x) => x.days)) : null; };
      return { n: list.length, wins: w.length, losses: l.length, winRate: w.length / list.length, avgRoi: mean(list.map((x) => x.roi)), pl: sum(list.map((x) => x.pl)),
        avgHold: days(list), holdWin: days(w), holdLoss: days(l), avgWin: w.length ? mean(w.map((x) => x.pl)) : null, avgLoss: l.length ? mean(l.map((x) => x.pl)) : null, list };
    };
    const cur = stats(M), prev = stats(prevMonth);
    const byRoi = cur ? cur.list.slice().sort((a, b) => b.roi - a.roi) : [];
    const best = byRoi[0] || null, worst = byRoi.length > 1 ? byRoi[byRoi.length - 1] : null;
    const rows = R.ledger.filter((t) => t.d && t.d.slice(0, 7) === M);
    const activity = { buys: rows.filter((t) => t.t === 'Buy' && !CASH_LIKE.has(sectorOf[t.a])).length, sells: rows.filter((t) => t.t === 'Sell' && !CASH_LIKE.has(sectorOf[t.a])).length,
      deposits: sum(rows.filter((t) => t.t === 'Deposit').map((t) => t.amt || 0)), withdrawals: -sum(rows.filter((t) => t.t === 'Withdrawal').map((t) => t.amt || 0)) };
    const mo = (m) => R.months.find((r) => r.month === m && r.has) || null;
    const m0 = mo(M), m1 = mo(prevMonth);
    const tips = [], pc = (x) => `${Math.round(x * 1000) / 10}%`;
    if (!cur) tips.push('You sold nothing this month, so there is no trade to score: the month\'s return came from holding.');
    if (cur && cur.wins && cur.losses && cur.holdLoss != null && cur.holdWin != null && cur.holdLoss > cur.holdWin * 1.5 && cur.holdLoss - cur.holdWin >= 5)
      tips.push(`You held the losing sales ${Math.round(cur.holdLoss)} days on average and the winners ${Math.round(cur.holdWin)}: the losers were kept longer than the winners.`);
    if (cur && cur.wins && cur.losses && cur.winRate >= 0.5 && Math.abs(cur.avgLoss) > cur.avgWin * 1.5)
      tips.push('Most sales made money, but the average loss was much bigger than the average win: a stop loss caps the losers.');
    if (cur && cur.n >= 3 && cur.winRate < 0.4) tips.push(`Only ${cur.wins} of your ${cur.n} sales made money this month.`);
    const sp = (x) => (x > 0 ? '+' : x < 0 ? '−' : '') + pc(Math.abs(x));
    if (m0 && m0.ret != null && m0.bench != null && m0.ret < m0.bench - 0.01) tips.push(`The index did better this month: the EGX30 Capped ${sp(m0.bench)}, the portfolio ${sp(m0.ret)}.`);
    if (m0 && m0.ret != null && m0.bench != null && m0.ret > m0.bench + 0.01) tips.push(`You beat the index this month: the portfolio ${sp(m0.ret)}, the EGX30 Capped ${sp(m0.bench)}.`);
    const lim = limitCheck(R, R.settings.limits);
    if (lim && lim.over.length) tips.push(`${lim.over.length} of your limits ${lim.over.length > 1 ? 'are' : 'is'} crossed right now: ${lim.over.map((x) => (x.kind === 'stock' ? x.s || x.n : x.n) + ' ' + pc(x.w)).join(', ')}.`);
    const strip = (x) => (x ? (({ list, ...r }) => r)(x) : null);
    return { month: M, prevMonth, ret: m0 ? m0.ret : null, bench: m0 ? m0.bench : null, prevRet: m1 ? m1.ret : null, prevBench: m1 ? m1.bench : null,
      provisional: !!(m0 && (m0.provisional || m0.live || m0.estimate)), cur: strip(cur), prev: strip(prev), best, worst, activity, limits: lim, tips };
  }

  // What friends see of a portfolio: PERCENTAGES ONLY, never an amount (no EGP, no share counts, no prices), so the copy
  // sealed to a friend cannot reveal how much money is in it. From an all-time portfolioRun:
  //   months   [{m, r, b, live}] each month's time-weighted return and the index's: any period is compounded from these
  //            (profilePeriod), so friends compare over the same period the page shows
  //   holdings [{s, n, sec, w, ret, chg, days}] symbol, name, sector, weight in the portfolio, return on cost, today's
  //            move, days held; sectors [{sec, w}]; cashW the cash weight
  //   trades   [{d, side 'buy' | 'sell', kind 'new' | 'added' | 'trimmed' | 'closed', s, n, ret}] the latest 40, newest
  //            first; ret is a sale's result on its cost (a closed round trip: the whole trip, dividends included).
  //            Cash-like funds (parking money in the savings fund) are not trades.
  //   stats    {closed, winRate, avgHold, best, worst, maxDD} closed round trips and the deepest month-end drawdown
  function friendProfile(run, info) {
    const R = run.R, rnd = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1e5) / 1e5);
    const sectorOf = {}, symOf = {};
    Object.values(run.data.assets || {}).forEach((a) => { if (a && a.name) { sectorOf[a.name] = a.sector; symOf[a.name] = a.symbol || ''; } });
    const months = R.months.filter((r) => r.has && r.ret != null).map((r) => ({ m: r.month, r: rnd(r.ret), b: rnd(r.bench), live: !!r.live }));
    const cash = Math.max(0, R.liveCash != null ? R.liveCash : R.settings.cash || 0), tot = R.pos.mvTotal + cash;
    const holdings = R.pos.open.filter((p) => (p.mv || 0) > 0).map((p) => ({ s: p.symbol || '', n: p.name, sec: p.sector || 'Unclassified',
      w: rnd(tot ? p.mv / tot : 0), ret: rnd(p.openCost ? p.unreal / p.openCost : null), chg: rnd(p.chg != null ? p.chg / 100 : null), days: p.holdDays })).sort((a, b) => b.w - a.w);
    const sec = {}; holdings.forEach((h) => { sec[h.sec] = (sec[h.sec] || 0) + h.w; });
    const sectors = Object.keys(sec).map((k) => ({ sec: k, w: rnd(sec[k]) })).sort((a, b) => b.w - a.w);
    const thr = typeof R.settings.openThreshold === 'number' ? R.settings.openThreshold : 0.5;
    const tripAt = {}; (R.pos.trips || []).forEach((t) => { tripAt[t.name + '|' + t.lastSell] = t; });
    const held = {}, opened = {}, ev = [];
    PE.sortLedger(R.ledger).forEach((t) => {
      if (!t.a || (t.t !== 'Buy' && t.t !== 'Sell' && t.t !== 'Bonus')) return;
      const h = held[t.a] || 0, q = t.q || 0, fund = CASH_LIKE.has(sectorOf[t.a]);
      if (t.t !== 'Sell') { if (h <= thr) opened[t.a] = t.d; held[t.a] = h + q; if (t.t === 'Buy' && !fund) ev.push({ d: t.d, side: 'buy', kind: h > thr ? 'added' : 'new', s: symOf[t.a] || '', n: t.a }); return; }
      held[t.a] = h - q;
      if (fund) return;
      const closed = held[t.a] <= thr, trip = closed ? tripAt[t.a + '|' + t.d] : null;
      const ret = trip ? trip.roi : t.basis ? ((t.amt || 0) - t.basis) / t.basis : null;
      ev.push({ d: t.d, side: 'sell', kind: closed ? 'closed' : 'trimmed', s: symOf[t.a] || '', n: t.a, ret: rnd(ret) });
    });
    // days held: from the buy that opened the current position (a stock sold out and bought back starts again)
    holdings.forEach((h) => { if (opened[h.n] && run.today) h.days = Math.max(0, dayNum(run.today) - dayNum(opened[h.n])); });
    const trips = (R.pos.trips || []).filter((t) => !CASH_LIKE.has(t.sector));
    const wins = trips.filter((t) => t.total > 0);
    const stats = { closed: trips.length, winRate: rnd(trips.length ? wins.length / trips.length : null), avgHold: trips.length ? Math.round(mean(trips.map((t) => t.holdDays))) : null,
      best: rnd(trips.length ? Math.max(...trips.map((t) => t.roi)) : null), worst: rnd(trips.length ? Math.min(...trips.map((t) => t.roi)) : null), maxDD: rnd(R.stats && R.stats.maxDD) };
    const mk = run.data.market || {};
    return Object.assign({ v: 2, name: R.settings.name || '', inception: R.settings.inception, asOf: mk.asOf || run.today, bench: 'EGX30 Capped',
      months, holdings, sectors, cashW: rnd(tot ? cash / tot : 0), trades: ev.slice(-40).reverse(), stats }, info || {});
  }
  // a profile's return over a period of the page's selector ({type, asOf, from, to}): {r, b, from, to}, the months
  // compounded (b null when a month has no index return); null when the period has no month
  function profilePeriod(p, sel) {
    if (!p || !p.months || !p.months.length) return null;
    const rows = p.months.map((x) => ({ month: x.m, has: true }));
    const rg = PE.periodRange(sel || { type: 'Since Inception' }, { inception: p.inception && p.inception <= p.months[0].m ? p.inception : p.months[0].m }, rows);
    const P = rg.valid ? p.months.filter((x) => x.m >= rg.from && x.m <= rg.to) : [];
    if (!P.length) return null;
    let r = 1, b = 1, bOk = true;
    P.forEach((x) => { r *= 1 + x.r; if (x.b == null) bOk = false; else b *= 1 + x.b; });
    return { r: r - 1, b: bOk ? b - 1 : null, from: rg.from, to: rg.to };
  }

  const api = { headsUp, drawdownCheck, limitCheck, limitText, reportCard, salesOf, yearWrapped, volumeSpikes, riskModel, morningBrief, heldStocks, priceBook, makePricer, daily, dailyStats, dailyTwr, capWeights, benchWeights, holdingsAt, estimateMarks, attribution, activeWeights, tradeChecks, tradingHabits, portfolioRun, friendProfile, profilePeriod, income, trailing, calendar, TRADING_DAYS, TRADING_NOTE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PA = api;
})(this);
