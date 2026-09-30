#!/usr/bin/env node
/* Starting point for a portfolio built from its owner's Thndr emails (the site's "Build it from my Thndr emails").
     node history_seed.js --data <export dir> --inbox <dir> --out <dir> [--now ISO]
   <inbox> is what imap_fetch.py wrote (manifest.json + <id>.json raw emails). Among the "Your monthly E-statement" emails
   whose sender is verified (TS.authCheck: Thndr, DKIM pass) and whose PDFs name this portfolio's account (TS.ownerCheck),
   the one for the EARLIEST month is the starting point: the portfolio starts on that statement's last day with exactly
   what Thndr printed then — one Buy per holding in its position snapshot (quantity, price) and the statement's closing
   cash, as opening rows (t.opening) behind one Deposit — and that month's marks come from the statement. settings get
   inception = that month, trackFrom = its last day (later emails are applied by sync.js from the next day; earlier ones
   are already in the opening rows), cash and the Thndr account code, and historyImport {status: 'done', from, at}.
   Writes, like sync.js's write/: ledger_yYYYY.json (the opening rows plus any rows of that year after the start),
   marks.json, settings.json, assets_update.json, import_<M>.json. Prints ONE JSON line: {ok, month, to, holdings, code} or
   {ok: false, error} (no usable monthly statement: nothing is written). Exit 1 on bad arguments. */
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

(async () => {
  const pdfjs = require(require.resolve('pdfjs-dist/legacy/build/pdf.js', { paths: [__dirname, path.join(__dirname, 'node_modules'), path.join(__dirname, 'pdfjs', 'node_modules')] }));
  const settings = J(D('portfolio', 'settings.json'));
  const marks = (opt(D('portfolio', 'marks.json'), { months: {} }).months) || {};
  const bench = opt(D('bench', 'egx30.json'), { members: [] });
  const macro = opt(D('market', 'macro.json'), {});
  const manifest = fs.existsSync(path.join(args.inbox, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(args.inbox, 'manifest.json'))) : [];
  const cands = []; let refused = 0;
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
      cands.push({ msg, st, own });
    } catch (e) { /* an unreadable email is simply not a starting point */ }
  }
  if (!cands.length) {
    const holder = ((settings.account || {}).holder || '').trim();
    console.log(JSON.stringify({ ok: false, error: refused ? `found ${refused} monthly statement${refused > 1 ? 's' : ''}, but not in the name "${holder}" (the name set as it appears in the Thndr app)` : 'no monthly Thndr statement in this Gmail yet' }));
    return;
  }
  cands.sort((a, b) => (a.st.month < b.st.month ? -1 : a.st.month > b.st.month ? 1 : 0));
  const { msg, st, own } = cands[0];
  const M = st.month, to = st.to, now = args.now || new Date().toISOString();
  const rid = () => Math.random().toString(36).slice(2, 10);
  const items = {}, rows = [];
  let sec = 0;
  for (const h of st.snapshot.holdings) {
    if (!(h.qty > 0) || !(h.value > 0)) continue;
    const fund = h.kind === 'fund';
    const name = fund ? (/^thndr/i.test(h.ticker) ? h.ticker.toLowerCase() : (h.name || h.ticker)) : (h.name || h.ticker);
    const price = h.price > 0 ? h.price : h.value / h.qty;
    const mem = (bench.members || []).find((x) => x.s === h.ticker);
    items[name] = fund ? { name, fund: true, sector: /saving/i.test(name) ? 'Cash & Savings' : 'Mutual Funds' } : { name, symbol: h.ticker, sector: (mem && mem.sector) || 'Unclassified' };
    const amt = r2(h.qty * price); sec += amt;
    rows.push({ id: rid(), d: to, t: 'Buy', a: name, q: h.qty, p: price, amt: -amt, acc: fund ? 'MF' : 'Main', src: 'history', opening: true, note: `Held on ${to}, from the Thndr ${lbl(M)} statement` });
  }
  const cash = r2(st.cash.end);
  rows.unshift({ id: rid(), d: to, t: 'Deposit', amt: r2(cash + sec), acc: 'Main', src: 'history', opening: true, note: `Starting value on ${to} (cash + holdings, from the Thndr ${lbl(M)} statement)` });
  const y = to.slice(0, 4), later = (opt(D('ledger', `y${y}.json`), { rows: [] }).rows || []).filter((t) => t.d > to);
  const P = prevMonth(M), num = (x) => typeof x === 'number' && isFinite(x);
  const acct = Object.assign({}, settings.account || {}, own.code ? { unifiedCode: own.code } : {});
  const s2 = Object.assign({}, settings, { inception: M, trackFrom: to, openingValue: 0, cash, cashDate: to, cashSource: `Thndr statement to ${to}`, account: acct,
    historyImport: { status: 'done', from: M, at: now } });
  if (num((macro.benchClose || {})[P])) s2.benchCloseStart = macro.benchClose[P];
  if (num((macro.fxEom || {})[P])) s2.fxStart = macro.fxEom[P];
  const W = (f, o) => fs.writeFileSync(path.join(args.out, f), JSON.stringify(o));
  fs.mkdirSync(args.out, { recursive: true });
  W(`ledger_y${y}.json`, { rows: rows.concat(later) });
  W('marks.json', { months: Object.assign({}, marks, { [M]: { cash, securities: r2(st.snapshot.total), provisional: false, source: 'statement' } }) });
  W('settings.json', s2);
  W('assets_update.json', { items });
  W(`import_${M}.json`, { month: M, messageId: msg.id, postedAt: now, added: rows.length, corrected: 0, removed: 0, marks: true, fullMonth: true, postedBy: 'history import (starting point)' });
  console.log(JSON.stringify({ ok: true, month: M, to, holdings: rows.length - 1, code: own.code || null, candidates: cands.length }));
})().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); process.exit(1); });
