#!/usr/bin/env node
/* A portfolio built from its owner's Thndr monthly statements (the site's "Build it from my Thndr emails").
     node history_seed.js --data <export dir> --inbox <dir> --out <dir> [--now ISO]
   <inbox> is what imap_fetch.py wrote (manifest.json + <id>.json raw emails). Every "Your monthly E-statement" email
   (and "Your requested E-statement" that covers a whole month: one asked for in the Thndr app for a missing month)
   whose sender is verified (TS.authCheck: Thndr, DKIM pass), whose PDFs name this portfolio's account (TS.ownerCheck) and
   that covers a whole month with a position snapshot is used, one per month, oldest first. The statements are the
   source of truth:
   - the EARLIEST is the starting point: the portfolio starts on its last day with exactly what Thndr printed then — one
     Buy per holding in its position snapshot (quantity, price) and its closing cash, as opening rows (t.opening) behind
     one Deposit;
   - every LATER month adds every row of its statement (deposits, withdrawals, trades, fund trades, dividends, fees,
     kickbacks; TS.reconcile classifies them), then compares with what Thndr printed at the month's end. Share counts
     that still differ from the snapshot are set to it with a Buy / Sell at the snapshot price, and cash that still
     differs from the statement's closing cash with a Deposit / Withdrawal, each dated that last day and labelled
     "adjustment" (src 'history-adjust'), so every month ends exactly where Thndr says; a month with no statement shows
     up as a gap and the next statement's opening cash is matched the same way on its first day;
   - the same stock under two names (the trade lines' wording vs the snapshot's) is one asset: names are tied to tickers
     from every snapshot, and a name-only stock whose shares make up exactly the snapshot's difference is merged in.
   Each month's mark comes from its statement (cash, securities; source 'statement') and gets an import_<M>.json.
   settings: inception = first month, trackFrom = the LAST statement's last day (sync.js applies the emails after it),
   cash / cashDate from that statement, the Thndr account code, historyImport {status: 'done', from, to, months, ...}.
   Writes, like sync.js's write/: ledger_yYYYY.json (each year touched, plus the rows already there after the last
   statement), marks.json, settings.json, assets_update.json, import_<M>.json. Prints ONE JSON line:
   {ok, month, to, first, last, months, holdings, adjustments, gaps, code, candidates} (month / to = the starting point,
   last / lastTo = the latest statement) or {ok: false, error} (no usable monthly statement: nothing is written). */
'use strict';
const fs = require('fs'), path = require('path');
const TS = require('./statement.js');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? a.concat([[x.slice(2), arr[i + 1]]]) : a), []));
if (!args.data || !args.inbox || !args.out) { console.log(JSON.stringify({ ok: false, error: 'usage: history_seed.js --data DIR --inbox DIR --out DIR' })); process.exit(1); }
const J = (f) => { const x = JSON.parse(fs.readFileSync(f)); return x && x.data && typeof x.data === 'object' ? x.data : x; };
const opt = (f, d) => (fs.existsSync(f) ? J(f) : d);
const D = (...p) => path.join(args.data, ...p);
const r2 = (x) => Math.round(x * 100) / 100;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const lbl = (m) => `${MON[+m.slice(5, 7) - 1]}-${m.slice(2, 4)}`;
const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; };
const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
const fmt = (x) => (x < 0 ? '-' : '') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isFundName = (n) => /^thndr/i.test(n || '');

(async () => {
  const pdfjs = require(require.resolve('pdfjs-dist/legacy/build/pdf.js', { paths: [__dirname, path.join(__dirname, 'node_modules'), path.join(__dirname, 'pdfjs', 'node_modules')] }));
  const settings = J(D('portfolio', 'settings.json'));
  const marks0 = (opt(D('portfolio', 'marks.json'), { months: {} }).months) || {};
  const assets0 = (opt(D('portfolio', 'assets.json'), { items: {} }).items) || {};
  const bench = opt(D('bench', 'egx30.json'), { members: [] });
  const macro = opt(D('market', 'macro.json'), {});
  const manifest = fs.existsSync(path.join(args.inbox, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(args.inbox, 'manifest.json'))) : [];
  const byMonth = {}; let refused = 0; const skipped = [];
  for (const msg of manifest) {
    if (!/(monthly|requested) e-statement/i.test(msg.subject || '') || /us market/i.test(msg.subject || '')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(args.inbox, `${msg.id}.json`))).raw;
      if (!TS.authCheck(raw).ok) continue;
      const docs = [];
      for (const a of TS.attachments(raw)) docs.push({ filename: a.filename, lines: await TS.pdfLines(pdfjs, a.bytes) });
      const own = TS.ownerCheck(docs, settings);
      if (own.error) { refused++; skipped.push({ date: msg.date, why: 'another account' }); continue; }
      const st = TS.parseStatement(docs);
      const why = !st.cash ? 'no account statement' : !st.month ? 'no period' : !st.fullMonth ? `not a whole month (${st.from} to ${st.to})` : !st.snapshot ? 'no position snapshot' : st.cash.end == null ? 'no closing balance' : null;
      if (why) { skipped.push({ month: st.month || null, why }); continue; }
      // the same month twice (a resent email, or one requested in the app): Thndr's monthly one wins, then the later
      const prev = byMonth[st.month], rank = (x) => [/monthly/i.test(x.msg.subject || '') ? 1 : 0, +x.msg.date || 0];
      const better = !prev || (() => { const a = rank({ msg }), b = rank(prev); return a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1]; })();
      if (prev) skipped.push({ month: st.month, why: 'the same month twice (one of them is used)' });
      if (better) byMonth[st.month] = { msg, st, own };
    } catch (e) { skipped.push({ date: msg.date, why: 'unreadable: ' + String((e && e.message) || e).slice(0, 80) }); }
  }
  const cands = Object.keys(byMonth).sort().map((m) => byMonth[m]);
  if (!cands.length) {
    const holder = ((settings.account || {}).holder || '').trim();
    console.log(JSON.stringify({ ok: false, error: refused ? `found ${refused} monthly statement${refused > 1 ? 's' : ''}, but not in the name "${holder}" (the name set as it appears in the Thndr app)` : 'no monthly Thndr statement in this Gmail yet' }));
    return;
  }
  const now = args.now || new Date().toISOString();
  let seq = 0; const rid = () => `h${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // ---- market data: each ticker's company name and daily closes, to tie a trade line's wording to its ticker ----
  const latest = opt(D('market', 'latest.json'), {});
  const quoteNames = {};
  Object.entries(latest.quotes || {}).forEach(([t, q]) => { if (q && q.name) quoteNames[t] = q.name; });
  (bench.members || []).forEach((m) => { if (m.s && m.name && !quoteNames[m.s]) quoteNames[m.s] = m.name; });
  const closes = {};
  if (fs.existsSync(D('history'))) fs.readdirSync(D('history')).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).forEach((f) => Object.assign(closes, J(D('history', f)).days || {}));
  const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
  const closeNear = (tk, d) => { for (const k of [0, -1, 1, -2, 2, -3, 3, -4, 4]) { const x = (closes[addDays(d, k)] || {})[tk]; if (x > 0) return x; } return null; };
  // true: a trade at price p on day d fits the ticker's close then (within 12%); false: it does not; null: no close known
  const priceFits = (tk, d, p) => { if (!(p > 0) || !d) return null; const c = closeNear(tk, d); return c ? Math.abs(p / c - 1) <= 0.12 : null; };
  const STOP = new Set(['co', 'company', 'the', 'and', 'for', 'of', 'sae', 's', 'a', 'e', 'plc', 'ltd', 'inc', 'corp', 'sa', 'egypt']);
  const tokens = (n) => String(n || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t && !STOP.has(t));
  const lev = (a, b) => { const m = a.length, n = b.length; let p = Array.from({ length: n + 1 }, (_, j) => j); for (let i = 1; i <= m; i++) { const c = [i]; for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; } return p[n]; };
  const tokEq = (a, b) => a === b || (Math.min(a.length, b.length) >= 3 && lev(a, b) <= (Math.max(a.length, b.length) >= 7 ? 2 : 1)) || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
  // share of the trade line's words found in the company name ("Abu Qir Fertilizers" in "Abou Kir Fertilizers & Chemical Industries Co.")
  const nameScore = (thndr, market) => {
    const A = tokens(thndr), B = tokens(market); if (!A.length || !B.length) return 0;
    const B2 = B.concat(B.slice(1).map((b, i) => B[i] + b));
    let hit = 0;
    for (let i = 0; i < A.length; i++) {
      if (B2.some((b) => tokEq(A[i], b))) { hit++; continue; }
      if (i + 1 < A.length && B.some((b) => tokEq(A[i] + A[i + 1], b))) { hit += 2; i++; }
    }
    return hit / A.length;
  };
  // the ticker a name-only stock is, from its trades: the company name must fit and no trade price may contradict it
  const identify = (name, trades) => {
    const c = [];
    Object.keys(quoteNames).forEach((tk) => {
      const sc = nameScore(name, quoteNames[tk]); if (sc < 0.75) return;
      const fits = trades.map((t) => priceFits(tk, t.d, t.p));
      if (fits.includes(false)) return;
      c.push({ tk, sc, priced: fits.includes(true) });
    });
    if (!c.length) return null;
    const best = Math.max(...c.map((x) => x.sc)), top = c.filter((x) => x.sc >= best - 1e-9);
    if (top.length === 1 && (top[0].priced || best >= 0.999)) return top[0].tk;
    const priced = top.filter((x) => x.priced);
    return priced.length === 1 ? priced[0].tk : null;
  };

  // ---- one build of the portfolio; openFunds = fund units held before the first statement that it never printed ----
  const build = (openFunds) => {
    const items = {};            // canonical name -> asset
    const alias = {};            // lower-case other name -> canonical name
    const snapTicker = {};       // lower-case snapshot name -> ticker, from every statement's snapshot
    cands.forEach(({ st }) => st.snapshot.holdings.forEach((h) => { if (h.name) snapTicker[h.name.toLowerCase()] = h.ticker; }));
    const bySymbol = (tk) => tk && Object.values(items).find((a) => (a.symbol || '').toUpperCase() === tk.toUpperCase());
    const sectorOf = (tk) => { const m = tk && (bench.members || []).find((x) => x.s === tk); return (m && m.sector) || 'Unclassified'; };
    const fundAsset = (name) => ({ name, fund: true, sector: /saving/i.test(name) ? 'Cash & Savings' : 'Mutual Funds' });
    const known = (n) => { const k = n.toLowerCase(); if (alias[k]) return alias[k]; const a = Object.values(items).find((x) => x.name.toLowerCase() === k); return a ? a.name : null; };
    const rows = [];
    // the asset a row's name belongs to (made when new); fund = the MF account or a thndr* fund code
    const resolve = (raw, fund, tickerHint) => {
      const n = fund && isFundName(raw) ? raw.toLowerCase() : raw;
      const hit = known(n); if (hit) return hit;
      if (fund) { items[n] = fundAsset(n); return n; }
      const tk = tickerHint || snapTicker[n.toLowerCase()] || null;
      const same = bySymbol(tk);
      if (same) { alias[n.toLowerCase()] = same.name; return same.name; }
      items[n] = { name: n, symbol: tk || undefined, sector: sectorOf(tk) };
      return n;
    };
    const fundName = (h) => { const t = h.ticker || ''; if (/^savings$/i.test(t)) return 'thndrsavings'; return isFundName(t) ? t.toLowerCase() : (h.name || t); };
    const merge = (from, to) => {
      rows.forEach((t) => { if (t.a === from) t.a = to; });
      alias[from.toLowerCase()] = to; Object.keys(alias).forEach((k) => { if (alias[k] === from) alias[k] = to; });
      delete items[from];
    };
    // `named` (a name-only stock) is the security `sym` has: one asset, the readable name, the ticker
    const unify = (sym, named) => {
      const tk = items[sym].symbol, keep = sym.toUpperCase() === (tk || '').toUpperCase() ? named : sym, drop = keep === sym ? named : sym;
      merge(drop, keep); items[keep] = Object.assign({}, items[keep], { name: keep, symbol: tk, sector: sectorOf(tk) });
      return keep;
    };
    const setSymbol = (n, tk) => { items[n] = Object.assign({}, items[n], { symbol: tk, sector: sectorOf(tk) }); };
    const tradesOf = (n) => rows.filter((t) => t.a === n && (t.t === 'Buy' || t.t === 'Sell') && t.p > 0 && t.src !== 'history-adjust').map((t) => ({ d: t.d, p: t.p }));
    // tie every name-only stock to its ticker where the company names and prices say which
    const tieNames = () => Object.keys(items).filter((n) => items[n] && isStock(n) && !items[n].symbol).forEach((n) => {
      const tk = identify(n, tradesOf(n)); if (!tk) return;
      const a = bySymbol(tk);
      if (a && a.name !== n) unify(a.name, n); else if (!a) setSymbol(n, tk);
    });
    // among name-only stocks whose shares would fit, the one that is `tk`: the only one, or the only one whose name / prices say so
    const pick = (c, tk) => {
      if (c.length <= 1) return c[0] || null;
      const ok = c.filter((n) => nameScore(n, quoteNames[tk] || '') >= 0.5 || tradesOf(n).some((t) => priceFits(tk, t.d, t.p) === true));
      return ok.length === 1 ? ok[0] : null;
    };
    const shares = (d) => { const sh = {}; rows.forEach((t) => { if (t.d <= d && t.a && (t.t === 'Buy' || t.t === 'Sell' || t.t === 'Bonus')) sh[t.a] = (sh[t.a] || 0) + (t.t === 'Sell' ? -1 : 1) * (t.q || 0); }); return sh; };
    const cashTo = (d) => r2(rows.filter((t) => t.d <= d).reduce((s, t) => s + (t.amt || 0), 0));
    const cashBefore = (d) => r2(rows.filter((t) => t.d < d).reduce((s, t) => s + (t.amt || 0), 0));
    const isFund = (name) => { const a = items[name] || {}; return !!(a.fund || a.proxy || a.symbol === 'SAVINGS' || isFundName(name) || rows.some((t) => t.a === name && t.acc === 'MF')); };
    const isStock = (name) => !isFund(name);
    const lastPrice = (name) => { const t = rows.filter((x) => x.a === name && x.p > 0).pop(); return t ? t.p : 0; };

    // ---- the starting point: the earliest statement's snapshot and closing cash, plus fund units it did not print ----
    const first = cands[0], M0 = first.st.month, to0 = first.st.to;
    let sec = 0, fundsOpen = 0;
    for (const h of first.st.snapshot.holdings) {
      if (!(h.qty > 0) || !(h.value > 0)) continue;
      const fund = h.kind === 'fund';
      const nm = fund ? fundName(h) : (h.name || h.ticker);
      const name = fund ? (known(nm) || ((items[nm] = fundAsset(nm)), nm)) : (bySymbol(h.ticker) || {}).name || ((items[nm] = { name: nm, symbol: h.ticker, sector: sectorOf(h.ticker) }), nm);
      const price = h.price > 0 ? h.price : h.value / h.qty;
      const amt = r2(h.qty * price); sec += amt;
      rows.push({ id: rid(), d: to0, t: 'Buy', a: name, q: h.qty, p: price, amt: -amt, acc: fund ? 'MF' : 'Main', src: 'history', opening: true, note: `Held on ${to0}, from the Thndr ${lbl(M0)} statement` });
    }
    Object.entries(openFunds).forEach(([n, f]) => {
      if (!items[n]) items[n] = fundAsset(n);
      const amt = r2(f.q * f.p); sec += amt; fundsOpen += amt;
      rows.push({ id: rid(), d: to0, t: 'Buy', a: n, q: f.q, p: f.p, amt: -amt, acc: 'MF', src: 'history', opening: true,
        note: `Held on ${to0}: the ${lbl(M0)} statement does not list fund units; later fund statements sell these`, });
    });
    const holdings0 = rows.length;
    rows.unshift({ id: rid(), d: to0, t: 'Deposit', amt: r2(r2(first.st.cash.end) + sec), acc: 'Main', src: 'history', opening: true, note: `Starting value on ${to0} (cash + holdings, from the Thndr ${lbl(M0)} statement)` });
    const snapFunds0 = first.st.snapshot.holdings.some((h) => h.kind === 'fund');
    const marks = Object.assign({}, marks0, { [M0]: { cash: r2(first.st.cash.end), securities: r2(first.st.snapshot.total + (snapFunds0 ? 0 : fundsOpen)), provisional: false, source: 'statement' } });
    const imports = { [M0]: { month: M0, messageId: first.msg.id, postedAt: now, added: rows.length, corrected: 0, removed: 0, marks: true, fullMonth: true, postedBy: 'history import (starting point)', reportsPending: true } };
    const gaps = []; let adjTotal = 0; const adjMonths = [];
    // fund units that went below zero before a snapshot first listed funds: held from the start (pass 2 adds them)
    const fundLow = {}; let fundsSeen = snapFunds0;
    const trackFunds = (upTo) => {
      if (fundsSeen) return;
      const u = {}, px = {};
      rows.filter((t) => t.d <= upTo && t.src !== 'history-adjust' && t.a && isFund(t.a) && (t.t === 'Buy' || t.t === 'Sell')).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0)).forEach((t) => {
        if (!px[t.a] && t.p > 0) px[t.a] = t.p;
        u[t.a] = (u[t.a] || 0) + (t.t === 'Sell' ? -1 : 1) * (t.q || 0);
        if (u[t.a] < -0.5 && (!fundLow[t.a] || -u[t.a] > fundLow[t.a].q)) fundLow[t.a] = { q: r2(-u[t.a]), p: px[t.a] || t.p || 1 };
      });
    };

    // ---- every later month: its rows, then the month-end matched to Thndr's figures ----
    let prevM = M0;
    for (const { msg, st } of cands.slice(1)) {
      const M = st.month, tag = `history-${M}`;
      for (let g = nextMonth(prevM); g < M; g = nextMonth(g)) gaps.push(g);
      prevM = M;
      const adds = [], adj = [];
      const push = (o, list) => { rows.push(o); list.push(o); };
      const adjust = (t, a, q, p, why) => push({ id: rid(), d: st.to, t, a, q, p, amt: r2((t === 'Buy' ? -1 : 1) * q * p), acc: isFund(a) ? 'MF' : 'Main', src: 'history-adjust', note: `Adjustment: ${why}` }, adj);
      // before this month: every earlier row stands as it is (opening for the reconcile: never matched, still counted)
      const view = rows.map((t) => (t.d < st.from && !t.opening ? Object.assign({}, t, { opening: true }) : t));
      const rc = TS.reconcile(st, view, items, marks);
      // opening cash (a month with no statement before this one, or Thndr's own carry-over)
      const open = cashBefore(st.from);
      if (st.cash.start != null && Math.abs(open - st.cash.start) > 1) {
        const diff = r2(st.cash.start - open);
        push({ id: rid(), d: st.from, t: diff > 0 ? 'Deposit' : 'Withdrawal', amt: diff, acc: 'Main', src: 'history-adjust',
          note: `Adjustment: cash on ${st.from} set to the Thndr ${lbl(M)} statement's opening balance ${fmt(st.cash.start)}${gaps.length && gaps[gaps.length - 1] === prevMonth(M) ? ' (no statement for the month before)' : ''}` }, adj);
      }
      rc.fresh.concat(rc.conflicts.map((c) => c.stmt)).forEach((r) => {
        const o = { id: rid(), d: r.d, t: r.t, amt: r.amt, acc: r.acc || 'Main', src: tag };
        if (r.a) o.a = (r.t === 'Buy' || r.t === 'Sell' || r.t === 'Bonus') ? resolve(r.a, r.acc === 'MF', r.newAsset && r.newAsset.ticker) : r.a;
        if (r.q != null) o.q = r.q; if (r.p != null) o.p = r.p; if (r.note) o.note = r.note;
        push(o, adds);
      });
      tieNames();
      const snapFunds = st.snapshot.holdings.some((h) => h.kind === 'fund');
      trackFunds(snapFunds ? addDays(st.to, -1) : st.to);
      // stocks at the month's end vs the snapshot
      let sh = shares(st.to);
      const target = {}, tprice = {};
      const loose = () => Object.keys(sh).filter((n) => Math.abs(sh[n]) >= 0.5 && items[n] && isStock(n) && !items[n].symbol && !(n in target));
      st.snapshot.holdings.filter((h) => h.kind !== 'fund' && h.qty > 0).forEach((h) => {
        const a = bySymbol(h.ticker) || (h.name && known(h.name) && items[known(h.name)]) || null;
        let name = a ? a.name : null, have = name ? sh[name] || 0 : 0;
        if (Math.abs(have - h.qty) >= 0.5) {
          // a name-only stock (trade-line wording) that makes up exactly the difference is this security
          const c = pick(loose().filter((n) => n !== name && Math.abs(have + sh[n] - h.qty) < 0.5), h.ticker);
          if (c) { if (name) name = unify(name, c); else { name = c; setSymbol(c, h.ticker); } sh = shares(st.to); }
        }
        if (!name) { name = resolve(h.name || h.ticker, false, h.ticker); if (!items[name].symbol) setSymbol(name, h.ticker); }
        target[name] = (target[name] || 0) + h.qty; tprice[name] = h.price > 0 ? h.price : h.value / h.qty;
      });
      // a ticker stock the snapshot no longer lists, and a name-only stock whose shares cancel it (sold under its name)
      Object.keys(sh).forEach((s) => {
        if (!items[s] || !items[s].symbol || s in target || !isStock(s) || Math.abs(sh[s] || 0) < 0.5) return;
        const c = pick(loose().filter((n) => n !== s && Math.abs(sh[s] + sh[n]) < 0.5), items[s].symbol);
        if (c) { unify(s, c); sh = shares(st.to); }
      });
      Object.keys(target).forEach((n) => {
        const have = sh[n] || 0, d = r2(target[n] - have);
        if (Math.abs(d) >= 0.5) adjust(d > 0 ? 'Buy' : 'Sell', n, Math.abs(d), tprice[n], `${n} set to the ${target[n]} shares on the Thndr ${lbl(M)} snapshot (the statement's trades gave ${r2(have)})`);
      });
      Object.keys(sh).filter((n) => !(n in target) && Math.abs(sh[n]) >= 0.5 && isStock(n)).forEach((n) => {
        adjust(sh[n] > 0 ? 'Sell' : 'Buy', n, r2(Math.abs(sh[n])), lastPrice(n), `${n} is not on the Thndr ${lbl(M)} snapshot, so its ${r2(sh[n])} shares are set to none`);
      });
      // fund units, when the snapshot lists them
      if (snapFunds) {
        fundsSeen = true;
        const fsh = shares(st.to), seen = new Set();
        st.snapshot.holdings.filter((h) => h.kind === 'fund' && h.qty > 0).forEach((h) => {
          const nm = fundName(h), name = known(nm) || (h.name && known(h.name)) || ((items[nm] = fundAsset(nm)), nm);
          seen.add(name);
          const have = fsh[name] || 0, d = r2(h.qty - have), p = h.price > 0 ? h.price : h.value / h.qty;
          if (Math.abs(d) >= 0.5) adjust(d > 0 ? 'Buy' : 'Sell', name, Math.abs(d), p, `${name} set to the ${h.qty} units on the Thndr ${lbl(M)} snapshot (the statements gave ${r2(have)})`);
        });
        Object.keys(fsh).filter((n) => !seen.has(n) && isFund(n) && Math.abs(fsh[n]) >= 0.5).forEach((n) => {
          adjust(fsh[n] > 0 ? 'Sell' : 'Buy', n, r2(Math.abs(fsh[n])), lastPrice(n) || 1, `${n} is not on the Thndr ${lbl(M)} snapshot, so its ${r2(fsh[n])} units are set to none`);
        });
      }
      // cash at the month's end vs the statement's closing balance
      const close = cashTo(st.to), cdiff = r2(st.cash.end - close);
      if (Math.abs(cdiff) > 1) {
        push({ id: rid(), d: st.to, t: cdiff > 0 ? 'Deposit' : 'Withdrawal', amt: cdiff, acc: 'Main', src: 'history-adjust',
          note: `Adjustment: cash on ${st.to} set to the Thndr ${lbl(M)} statement's closing balance ${fmt(st.cash.end)} (the statement's rows gave ${fmt(close)}${rc.unknown.length ? `; ${rc.unknown.length} line${rc.unknown.length > 1 ? 's' : ''} not recognised` : ''})` }, adj);
      }
      if (adj.length) { adjTotal += adj.length; adjMonths.push(M); }
      const mp = rc.markProposal || {};
      marks[M] = { cash: r2(st.cash.end), securities: r2(mp.securities != null ? mp.securities : st.snapshot.total), provisional: false, source: 'statement' };
      imports[M] = { month: M, messageId: msg.id, postedAt: now, added: adds.length, corrected: 0, removed: 0, adjustments: adj.length, marks: true, fullMonth: true, postedBy: 'history import', reportsPending: true };
    }
    trackFunds(cands[cands.length - 1].st.to);
    return { items, rows, marks, imports, gaps, adjTotal, adjMonths, fundLow, holdings0, first };
  };

  let B = build({});
  const need = Object.fromEntries(Object.entries(B.fundLow).filter(([, f]) => f.q >= 0.5));
  if (Object.keys(need).length) B = build(need);
  const { items, rows, marks, imports, gaps, adjTotal, adjMonths, holdings0, first } = B;
  const M0 = first.st.month, to0 = first.st.to;

  // ---- write ----
  const last = cands[cands.length - 1], ML = last.st.month, toL = last.st.to;
  const acct = Object.assign({}, settings.account || {}, first.own.code ? { unifiedCode: first.own.code } : {});
  const P = prevMonth(M0), num = (x) => typeof x === 'number' && isFinite(x);
  const s2 = Object.assign({}, settings, { inception: M0, trackFrom: toL, openingValue: 0, cash: r2(last.st.cash.end), cashDate: toL, cashSource: `Thndr statement to ${toL}`, account: acct,
    historyImport: { status: 'done', from: M0, to: ML, months: cands.length, adjustments: adjTotal, adjustedMonths: adjMonths, gaps, at: now } });
  if (num((macro.benchClose || {})[P])) s2.benchCloseStart = macro.benchClose[P];
  if (num((macro.fxEom || {})[P])) s2.fxStart = macro.fxEom[P];
  const W = (f, o) => fs.writeFileSync(path.join(args.out, f), JSON.stringify(o));
  fs.mkdirSync(args.out, { recursive: true });
  // rows already in the ledger after the last statement are kept (a portfolio re-built later); earlier ones are replaced
  const years = new Set(rows.map((t) => t.d.slice(0, 4)));
  (fs.existsSync(D('ledger')) ? fs.readdirSync(D('ledger')) : []).filter((f) => /^y\d{4}\.json$/.test(f)).forEach((f) => { if ((J(D('ledger', f)).rows || []).length) years.add(f.slice(1, 5)); });
  const later = [...years].flatMap((y) => (opt(D('ledger', `y${y}.json`), { rows: [] }).rows || []).filter((t) => t.d > toL));
  const all = rows.concat(later);
  [...years].sort().forEach((y) => W(`ledger_y${y}.json`, { rows: all.filter((t) => t.d.slice(0, 4) === y) }));
  W('marks.json', { months: marks });
  W('settings.json', s2);
  // assets the rows use (a merged name is gone); ones already in the portfolio are left as they are unless changed
  const used = new Set(rows.map((t) => t.a).filter(Boolean));
  W('assets_update.json', { items: Object.fromEntries(Object.entries(items).filter(([n]) => used.has(n) && JSON.stringify(assets0[n]) !== JSON.stringify(items[n]))) });
  Object.keys(imports).forEach((m) => W(`import_${m}.json`, imports[m]));
  console.log(JSON.stringify({ ok: true, month: M0, to: to0, first: M0, last: ML, lastTo: toL, months: cands.length, holdings: holdings0, adjustments: adjTotal, adjustedMonths: adjMonths, gaps, code: first.own.code || null, candidates: cands.length, skipped,
    openingFunds: Object.keys(need), fundsOnSnapshot: cands.filter((c) => c.st.snapshot.holdings.some((h) => h.kind === 'fund')).map((c) => c.st.month), fundStatement: cands.filter((c) => c.st.mf).map((c) => c.st.month) }));
})().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); process.exit(1); });
