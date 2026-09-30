#!/usr/bin/env node
/* A portfolio built from its owner's Thndr monthly statements (the site's "Build it from my Thndr emails").
     node history_seed.js --data <export dir> --inbox <dir> --out <dir> [--now ISO]
   <inbox> is what imap_fetch.py wrote (manifest.json + <id>.json raw emails). Every "Your monthly E-statement" email
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
  const byMonth = {}; let refused = 0;
  for (const msg of manifest) {
    if (!/monthly e-statement/i.test(msg.subject || '')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(args.inbox, `${msg.id}.json`))).raw;
      if (!TS.authCheck(raw).ok) continue;
      const docs = [];
      for (const a of TS.attachments(raw)) docs.push({ filename: a.filename, lines: await TS.pdfLines(pdfjs, a.bytes) });
      const own = TS.ownerCheck(docs, settings);
      if (own.error) { refused++; continue; }
      const st = TS.parseStatement(docs);
      if (!st.cash || !st.fullMonth || !st.snapshot || st.cash.end == null || !st.month) continue;
      const prev = byMonth[st.month];   // the same month twice (a resent email): the later email wins
      if (!prev || (msg.date || '') > (prev.msg.date || '')) byMonth[st.month] = { msg, st, own };
    } catch (e) { /* an unreadable email is simply not used */ }
  }
  const cands = Object.keys(byMonth).sort().map((m) => byMonth[m]);
  if (!cands.length) {
    const holder = ((settings.account || {}).holder || '').trim();
    console.log(JSON.stringify({ ok: false, error: refused ? `found ${refused} monthly statement${refused > 1 ? 's' : ''}, but not in the name "${holder}" (the name set as it appears in the Thndr app)` : 'no monthly Thndr statement in this Gmail yet' }));
    return;
  }
  const now = args.now || new Date().toISOString();
  let seq = 0; const rid = () => `h${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // ---- assets: one per security, whatever it is called in a trade line or a snapshot ----
  const items = {};            // canonical name -> asset
  const alias = {};            // lower-case other name -> canonical name
  const snapTicker = {};       // lower-case snapshot name -> ticker, from every statement's snapshot
  cands.forEach(({ st }) => st.snapshot.holdings.forEach((h) => { if (h.name) snapTicker[h.name.toLowerCase()] = h.ticker; }));
  const bySymbol = (tk) => tk && Object.values(items).find((a) => (a.symbol || '').toUpperCase() === tk.toUpperCase());
  const sectorOf = (tk) => { const m = tk && (bench.members || []).find((x) => x.s === tk); return (m && m.sector) || 'Unclassified'; };
  const fundAsset = (name) => ({ name, fund: true, sector: /saving/i.test(name) ? 'Cash & Savings' : 'Mutual Funds' });
  const known = (n) => { const k = n.toLowerCase(); if (alias[k]) return alias[k]; const a = Object.values(items).find((x) => x.name.toLowerCase() === k); return a ? a.name : null; };
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
  // rename every row of asset `from` to `to` (the same security under two names)
  const merge = (rows, from, to) => {
    rows.forEach((t) => { if (t.a === from) t.a = to; });
    alias[from.toLowerCase()] = to; Object.keys(alias).forEach((k) => { if (alias[k] === from) alias[k] = to; });
    delete items[from];
  };
  const shares = (rows, d) => { const sh = {}; rows.forEach((t) => { if (t.d <= d && t.a && (t.t === 'Buy' || t.t === 'Sell' || t.t === 'Bonus')) sh[t.a] = (sh[t.a] || 0) + (t.t === 'Sell' ? -1 : 1) * (t.q || 0); }); return sh; };
  const cashTo = (rows, d) => r2(rows.filter((t) => t.d <= d).reduce((s, t) => s + (t.amt || 0), 0));
  const cashBefore = (rows, d) => r2(rows.filter((t) => t.d < d).reduce((s, t) => s + (t.amt || 0), 0));
  const isStock = (name) => { const a = items[name] || {}; return !a.fund && !a.proxy && a.symbol !== 'SAVINGS' && !isFundName(name); };
  const lastPrice = (rows, name) => { const t = rows.filter((x) => x.a === name && x.p > 0).pop(); return t ? t.p : 0; };

  // ---- the starting point: the earliest statement's snapshot and closing cash ----
  const first = cands[0], M0 = first.st.month, to0 = first.st.to;
  const rows = [];
  let sec = 0;
  for (const h of first.st.snapshot.holdings) {
    if (!(h.qty > 0) || !(h.value > 0)) continue;
    const fund = h.kind === 'fund';
    const nm = fund ? (isFundName(h.ticker) ? h.ticker.toLowerCase() : (h.name || h.ticker)) : (h.name || h.ticker);
    const name = fund ? (known(nm) || ((items[nm] = fundAsset(nm)), nm)) : (bySymbol(h.ticker) || {}).name || ((items[nm] = { name: nm, symbol: h.ticker, sector: sectorOf(h.ticker) }), nm);
    const price = h.price > 0 ? h.price : h.value / h.qty;
    const amt = r2(h.qty * price); sec += amt;
    rows.push({ id: rid(), d: to0, t: 'Buy', a: name, q: h.qty, p: price, amt: -amt, acc: fund ? 'MF' : 'Main', src: 'history', opening: true, note: `Held on ${to0}, from the Thndr ${lbl(M0)} statement` });
  }
  const holdings0 = rows.length;
  rows.unshift({ id: rid(), d: to0, t: 'Deposit', amt: r2(r2(first.st.cash.end) + sec), acc: 'Main', src: 'history', opening: true, note: `Starting value on ${to0} (cash + holdings, from the Thndr ${lbl(M0)} statement)` });
  const marks = Object.assign({}, marks0, { [M0]: { cash: r2(first.st.cash.end), securities: r2(first.st.snapshot.total), provisional: false, source: 'statement' } });
  const imports = { [M0]: { month: M0, messageId: first.msg.id, postedAt: now, added: rows.length, corrected: 0, removed: 0, marks: true, fullMonth: true, postedBy: 'history import (starting point)', reportsPending: true } };
  const gaps = []; let adjTotal = 0; const adjMonths = [];

  // ---- every later month: its rows, then the month-end matched to Thndr's figures ----
  let prevM = M0;
  for (const { msg, st } of cands.slice(1)) {
    const M = st.month, tag = `history-${M}`;
    for (let g = nextMonth(prevM); g < M; g = nextMonth(g)) gaps.push(g);
    prevM = M;
    const adds = [], adj = [];
    const push = (o, list) => { rows.push(o); list.push(o); };
    // before this month: every earlier row stands as it is (opening for the reconcile: never matched, still counted)
    const view = rows.map((t) => (t.d < st.from && !t.opening ? Object.assign({}, t, { opening: true }) : t));
    const rc = TS.reconcile(st, view, items, marks);
    // opening cash (a month with no statement before this one, or Thndr's own carry-over)
    const open = cashBefore(rows, st.from);
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
    // holdings at the month's end vs the snapshot (stocks; fund units are not always on the snapshot)
    let sh = shares(rows, st.to);
    const claimed = new Set();
    const loose = () => Object.keys(sh).filter((n) => sh[n] > 0.5 && !claimed.has(n) && isStock(n) && !(items[n] || {}).symbol);
    st.snapshot.holdings.filter((h) => h.kind !== 'fund' && h.qty > 0).forEach((h) => {
      let a = bySymbol(h.ticker) || (h.name && known(h.name) && items[known(h.name)]) || null;
      let name = a ? a.name : null;
      let have = name ? sh[name] || 0 : 0;
      if (Math.abs(have - h.qty) >= 0.5) {
        // a name-only stock (trade-line wording) that makes up exactly the difference is this security
        const c = loose().filter((n) => n !== name && Math.abs(have + sh[n] - h.qty) < 0.5);
        if (c.length === 1) {
          if (name) {
            // keep the readable name: a snapshot that printed only the ISIN gave the ticker as the name
            const keep = name.toUpperCase() === (items[name].symbol || '').toUpperCase() ? c[0] : name, drop = keep === name ? c[0] : name;
            const sym = items[name].symbol;
            merge(rows, drop, keep); items[keep] = Object.assign({}, items[keep], { name: keep, symbol: sym, sector: sectorOf(sym) });
            name = keep;
          } else { name = c[0]; items[name] = Object.assign({}, items[name], { symbol: h.ticker, sector: sectorOf(h.ticker) }); }
          sh = shares(rows, st.to); have = sh[name] || 0;
        }
      }
      if (!name) { name = resolve(h.name || h.ticker, false, h.ticker); if (!(items[name] || {}).symbol) items[name].symbol = h.ticker; }
      claimed.add(name);
      const d = r2(h.qty - have);
      if (Math.abs(d) >= 0.5) {
        const p = h.price > 0 ? h.price : h.value / h.qty;
        push({ id: rid(), d: st.to, t: d > 0 ? 'Buy' : 'Sell', a: name, q: Math.abs(d), p, amt: r2((d > 0 ? -1 : 1) * Math.abs(d) * p), acc: 'Main', src: 'history-adjust',
          note: `Adjustment: ${name} set to the ${h.qty} shares on the Thndr ${lbl(M)} snapshot (the statement's trades gave ${have})` }, adj);
      }
    });
    // stocks the ledger still holds that the snapshot does not list: sold at their last price
    Object.keys(sh).filter((n) => sh[n] > 0.5 && !claimed.has(n) && isStock(n)).forEach((n) => {
      const p = lastPrice(rows, n);
      push({ id: rid(), d: st.to, t: 'Sell', a: n, q: sh[n], p, amt: r2(sh[n] * p), acc: 'Main', src: 'history-adjust',
        note: `Adjustment: ${n} is not on the Thndr ${lbl(M)} snapshot, so its ${sh[n]} shares are taken out` }, adj);
    });
    // cash at the month's end vs the statement's closing balance
    const close = cashTo(rows, st.to), cdiff = r2(st.cash.end - close);
    if (Math.abs(cdiff) > 1) {
      push({ id: rid(), d: st.to, t: cdiff > 0 ? 'Deposit' : 'Withdrawal', amt: cdiff, acc: 'Main', src: 'history-adjust',
        note: `Adjustment: cash on ${st.to} set to the Thndr ${lbl(M)} statement's closing balance ${fmt(st.cash.end)} (the statement's rows gave ${fmt(close)}${rc.unknown.length ? `; ${rc.unknown.length} line${rc.unknown.length > 1 ? 's' : ''} not recognised` : ''})` }, adj);
    }
    if (adj.length) { adjTotal += adj.length; adjMonths.push(M); }
    const mp = rc.markProposal || {};
    marks[M] = { cash: r2(st.cash.end), securities: r2(mp.securities != null ? mp.securities : st.snapshot.total), provisional: false, source: 'statement' };
    imports[M] = { month: M, messageId: msg.id, postedAt: now, added: adds.length, corrected: 0, removed: 0, adjustments: adj.length, marks: true, fullMonth: true, postedBy: 'history import', reportsPending: true };
  }

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
  // assets the rows use (a merged name is gone); ones already in the portfolio are left as they are unless merged into
  const used = new Set(rows.map((t) => t.a).filter(Boolean));
  W('assets_update.json', { items: Object.fromEntries(Object.entries(items).filter(([n]) => used.has(n) && JSON.stringify(assets0[n]) !== JSON.stringify(items[n]))) });
  Object.keys(imports).forEach((m) => W(`import_${m}.json`, imports[m]));
  console.log(JSON.stringify({ ok: true, month: M0, to: to0, first: M0, last: ML, lastTo: toL, months: cands.length, holdings: holdings0, adjustments: adjTotal, adjustedMonths: adjMonths, gaps, code: first.own.code || null, candidates: cands.length }));
})().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); process.exit(1); });
