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
      if (Math.abs(t.p / c - 1) > 0.06) off.push(`${a.symbol} ${t.d}: traded ${t.p} vs close ${c}`);
    });
    out.push({ label: 'Trade prices agree with closing prices', status: off.length ? 'warn' : 'ok', detail: off.length ? off.slice(0, 8).join('; ') + (off.length > 8 ? ` … ${off.length} rows` : '') : 'Every trade within 6% of that day\'s close' });
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
  // The heads-up items that follow from the data alone: ex-dividend within a week for a held stock, a held stock at or past
  // its target / stop, and the portfolio more than 10% below its 12-month high. o = {today, tx, assets, settings, marks,
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

  const api = { headsUp, drawdownCheck, heldStocks, priceBook, makePricer, daily, dailyStats, dailyTwr, capWeights, benchWeights, holdingsAt, estimateMarks, attribution, activeWeights, tradeChecks, tradingHabits, income, trailing, calendar, TRADING_DAYS, TRADING_NOTE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PA = api;
})(this);
