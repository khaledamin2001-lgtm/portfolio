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
// why the sync held a statement: the same applyStatement on the portfolio as it stands now, amounts masked to '#'
const mask = (x) => String(x).split(/(\b\d{4}-\d{2}-\d{2}\b)/).map((p, i) => (i % 2 ? p : p.replace(/-?\d[\d,]*(\.\d+)?/g, '#'))).join('');
function replayHold(st, msg) {
  try {
    const SY = require('./sync.js'), C = (x) => JSON.parse(JSON.stringify(x));
    const L = (...p) => (fs.existsSync(D(...p)) ? J(D(...p)) : null);
    const imports = fs.existsSync(D('imports')) ? Object.fromEntries(fs.readdirSync(D('imports')).map((f) => [f.replace('.json', ''), J(D('imports', f))])) : {};
    const tx = []; fs.readdirSync(D('ledger')).sort().forEach((f) => ((J(D('ledger', f)).rows) || []).forEach((r) => tx.push(r)));
    SY._reset(C(tx), C((L('portfolio', 'assets.json') || {}).items || {}), C(L('portfolio', 'settings.json') || {}),
      { marks: C((L('portfolio', 'marks.json') || {}).months || {}), imports, bench: L('bench', 'egx30.json') || { members: [] }, market: L('market', 'latest.json') });
    const entry = { changes: [], reasons: [], notes: [], unchanged: 0 };
    const status = SY.applyStatement(st, entry, msg);
    return { replayStatus: status, reasons: entry.reasons.map(mask), proposed: (entry.proposed || []).map(mask) };
  } catch (e) { return { replayError: mask(e.message || e).slice(0, 160) }; }
}
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
        if (seen[msg.id] && /hold/.test(seen[msg.id].status)) o.holdReasons = replayHold(st, msg);
        o.month = st.month; o.from = st.from; o.to = st.to; o.fullMonth = !!st.fullMonth; o.snapshot = !!st.snapshot; o.holdings = st.snapshot ? st.snapshot.holdings.length : null;
        const mk = st.month && marks[st.month];
        if (st.fullMonth && st.cash && mk) {
          o.cashVsPortfolio = Math.abs((mk.cash || 0) - st.cash.end) < 1 ? 'matches' : `portfolio off by ${pct(mk.cash || 0, st.cash.end)}%`;
          if (st.snapshot) { const sec = mk.securities, tot = st.snapshot.total; o.stocksVsPortfolio = sec == null ? 'no month-end value in the portfolio' : Math.abs(sec - tot) <= Math.max(1, tot * 0.002) ? 'matches' : `portfolio off by ${pct(sec, tot)}% (funds may be included on one side)`; }
          o.markSource = mk.source || (mk.provisional ? 'provisional' : 'typed');
        } else if (st.fullMonth) o.cashVsPortfolio = 'the portfolio has no month-end for this month';
        if (st.snapshot && st.to) {
          // the portfolio's count under the holding's ticker, else under its name (a Thndr fund is kept under its name)
          const sh0 = sharesAt(st.to), sh = {}, used = new Set(), bad = [];
          Object.entries(sh0).forEach(([k, q]) => { const u = k.toUpperCase(); sh[u] = (sh[u] || 0) + q; });
          st.snapshot.holdings.forEach((h) => {
            const k = String(h.ticker || '').toUpperCase(), n = String(h.name || '').toUpperCase(), key = k in sh ? k : n && n in sh ? n : k;
            used.add(key); if (Math.abs((sh[key] || 0) - (h.qty || 0)) > 0.5) bad.push(k);
          });
          Object.keys(sh).forEach((k) => { if (sh[k] > 0.5 && !used.has(k) && !/SAVINGS|THNDR/.test(k)) bad.push(k + ' (not on the statement)'); });
          o.sharesVsPortfolio = bad.length ? 'differ: ' + bad.join(', ') : 'match';
          if (bad.length) {   // what each side calls the differing holdings (names, tickers, kinds; whether the quantities are the same)
            const ledgerQ = Object.values(sh);
            o.detail = { statement: st.snapshot.holdings.map((h) => ({ ticker: h.ticker, name: h.name || h.isin || '', kind: h.kind, sameQtyInPortfolioUnderAnotherName: ledgerQ.some((q) => Math.abs(q - (h.qty || 0)) < 0.5) })),
              portfolio: Object.values(assets).filter((x) => x && bad.some((b) => b.startsWith(x.name.toUpperCase()) || (x.symbol && b.startsWith(String(x.symbol).toUpperCase())))).map((x) => ({ name: x.name, symbol: x.symbol || '', fund: !!x.fund, sector: x.sector || '',
                rows: tx.filter((t) => t.a === x.name && t.d <= st.to).map((t) => `${t.d} ${t.t} ${t.acc || ''} ${t.src || ''}`.trim()) })) };
          }
        }
      }
    } catch (e) { o.error = String(e.message || e).slice(0, 120); }
    console.log(JSON.stringify(o));
  }
  const hi = settings.historyImport || {};
  console.log(JSON.stringify({ summary: sum, portfolio: { inception: settings.inception, trackFrom: settings.trackFrom, historyImport: { status: hi.status, from: hi.from, to: hi.to, months: hi.months, gaps: hi.gaps, adjustments: hi.adjustments }, stocksWithoutTicker: Object.values(assets).filter((a) => a && !a.fund && !a.symbol && !a.watch && !/^thndr/i.test(a.name || '')).length, accountNumberKnown: !!(settings.account || {}).unifiedCode, holderNameKnown: !!(settings.account || {}).holder, monthsWithMarks: Object.keys(marks).sort(), ledgerRows: tx.length, bySource: tx.reduce((m, t) => { const k = t.src || 'typed'; m[k] = (m[k] || 0) + 1; return m; }, {}), lastSync: state.lastRun || null } }));
})().catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) })); process.exit(1); });
