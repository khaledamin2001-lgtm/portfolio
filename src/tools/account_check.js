#!/usr/bin/env node
/* Read-only check of one portfolio against its owner's Thndr emails (jobs/account_check.py): which emails exist, which were
   used, and whether each monthly statement's month-end agrees with the portfolio. Prints dates, kinds, counts, tickers and
   "matches / off by x%" only, never an amount.
     node account_check.js --data <export dir> --inbox <dir from imap_fetch.py, every Thndr email since 2019>
   One JSON line per email ({date, kind, verified, account, month, fullMonth, snapshot, ...}), then a summary line. */
'use strict';
const fs = require('fs'), path = require('path');
const TS = require('./statement.js');
const PE = require('./engine.js'); global.PE = PE;
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? a.concat([[x.slice(2), arr[i + 1]]]) : a), []));
const J = (f) => { const x = JSON.parse(fs.readFileSync(f)); return x && x.data && typeof x.data === 'object' && x.id !== undefined ? x.data : x; };
const opt = (f, d) => (fs.existsSync(f) ? J(f) : d);
const D = (...p) => path.join(args.data, ...p);
const pct = (a, b) => (b ? Math.round((a / b - 1) * 1000) / 10 : null);
(async () => {
  const pdfjs = require(require.resolve('pdfjs-dist/legacy/build/pdf.js', { paths: [__dirname, path.join(__dirname, 'node_modules')] }));
  const settings = opt(D('portfolio', 'settings.json'), {}), marks = (opt(D('portfolio', 'marks.json'), { months: {} }).months) || {};
  const assets = (opt(D('portfolio', 'assets.json'), { items: {} }).items) || {}, state = opt(D('sync', 'state.json'), {}) || {};
  const tx = []; if (fs.existsSync(D('ledger'))) fs.readdirSync(D('ledger')).sort().forEach((f) => ((J(D('ledger', f)).rows) || []).forEach((r) => tx.push(r)));
  const symOf = {}; Object.values(assets).forEach((a) => { if (a && a.name) symOf[a.name] = String(a.symbol || '').toUpperCase(); });
  const sharesAt = (day) => { const sh = {}; tx.forEach((t) => { if (t.d <= day && t.a && (t.t === 'Buy' || t.t === 'Sell' || t.t === 'Bonus')) { const k = symOf[t.a] || t.a; sh[k] = (sh[k] || 0) + (t.t === 'Sell' ? -1 : 1) * (t.q || 0); } }); return sh; };
  const manifest = fs.existsSync(path.join(args.inbox, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(args.inbox, 'manifest.json'))) : [];
  const sum = { emails: manifest.length, invoices: 0, statements: 0, unverified: 0, otherAccount: 0, usedBySync: 0, heldBySync: 0, notSeenBySync: 0 };
  const seen = state.seen || {};
  const day = (ms) => new Date(+ms).toISOString().slice(0, 10);
  for (const msg of manifest.sort((a, b) => (+a.date) - (+b.date))) {
    const kind = /invoice/i.test(msg.subject) ? 'invoice' : /monthly e-statement/i.test(msg.subject) ? 'monthly' : /requested e-statement/i.test(msg.subject) ? 'requested' : 'other';
    const o = { date: day(msg.date), kind, sync: seen[msg.id] ? seen[msg.id].status : 'not seen by the daily sync' };
    if (seen[msg.id]) { if (/hold/.test(seen[msg.id].status)) sum.heldBySync++; else sum.usedBySync++; } else sum.notSeenBySync++;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(args.inbox, `${msg.id}.json`))).raw;
      const auth = TS.authCheck(raw); o.verified = auth.ok; if (!auth.ok) sum.unverified++;
      const docs = []; for (const a of TS.attachments(raw)) docs.push({ filename: a.filename, lines: await TS.pdfLines(pdfjs, a.bytes) });
      const own = TS.ownerCheck(docs, settings);
      o.account = own.error ? 'refused: ' + own.error.replace(/ \(.*\)$/, '') : own.code ? 'this account (by number)' : own.learnName ? 'this account (name learned)' : 'this account (by name)';
      if (own.error) sum.otherAccount++;
      if (kind === 'invoice') { sum.invoices++; o.trades = docs.reduce((n, d) => n + ((d.lines || []).filter((l) => l === 'Invoice').length || 0), 0); }
      else if (kind !== 'other') {
        sum.statements++;
        const st = TS.parseStatement(docs);
        o.month = st.month; o.from = st.from; o.to = st.to; o.fullMonth = !!st.fullMonth; o.snapshot = !!st.snapshot; o.holdings = st.snapshot ? st.snapshot.holdings.length : null;
        const mk = st.month && marks[st.month];
        if (st.fullMonth && st.cash && mk) {
          o.cashVsPortfolio = Math.abs((mk.cash || 0) - st.cash.end) < 1 ? 'matches' : `portfolio off by ${pct(mk.cash || 0, st.cash.end)}%`;
          if (st.snapshot) { const sec = mk.securities, tot = st.snapshot.total; o.stocksVsPortfolio = sec == null ? 'no month-end value in the portfolio' : Math.abs(sec - tot) <= Math.max(1, tot * 0.002) ? 'matches' : `portfolio off by ${pct(sec, tot)}% (funds may be included on one side)`; }
          o.markSource = mk.source || (mk.provisional ? 'provisional' : 'typed');
        } else if (st.fullMonth) o.cashVsPortfolio = 'the portfolio has no month-end for this month';
        if (st.snapshot && st.to) {
          const sh = sharesAt(st.to), bad = [];
          st.snapshot.holdings.forEach((h) => { const k = String(h.ticker || '').toUpperCase(); if (Math.abs((sh[k] || 0) - (h.qty || 0)) > 0.5) bad.push(k); });
          Object.keys(sh).forEach((k) => { if (sh[k] > 0.5 && !st.snapshot.holdings.some((h) => String(h.ticker || '').toUpperCase() === k) && !/SAVINGS|THNDR/.test(k)) bad.push(k + ' (not on the statement)'); });
          o.sharesVsPortfolio = bad.length ? 'differ: ' + bad.join(', ') : 'match';
        }
      }
    } catch (e) { o.error = String(e.message || e).slice(0, 120); }
    console.log(JSON.stringify(o));
  }
  const hi = settings.historyImport || {};
  console.log(JSON.stringify({ summary: sum, portfolio: { inception: settings.inception, trackFrom: settings.trackFrom, historyImport: { status: hi.status, from: hi.from, to: hi.to, months: hi.months, gaps: hi.gaps, adjustments: hi.adjustments }, accountNumberKnown: !!(settings.account || {}).unifiedCode, holderNameKnown: !!(settings.account || {}).holder, monthsWithMarks: Object.keys(marks).sort(), ledgerRows: tx.length, bySource: tx.reduce((m, t) => { const k = t.src || 'typed'; m[k] = (m[k] || 0) + 1; return m; }, {}), lastSync: state.lastRun || null } }));
})().catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) })); process.exit(1); });
