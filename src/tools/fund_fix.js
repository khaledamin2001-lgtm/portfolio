#!/usr/bin/env node
/* Fund rows checked against the Thndr statements: the ledger's mutual-fund trades that no statement or invoice has
   confirmed (src not stmt-* / invoice-*, not opening rows) are matched to the fund trades on the Thndr statements in
   <inbox> (monthly and requested, whole or part month, verified sender and account), and corrected to them.
     node fund_fix.js --data <export dir> --inbox <dir> --out <dir>
   A match: same type and fund, dates at most 6 days apart, units within 1% or amount within 2%; the closest wins, each
   statement trade is used once. On a match the row takes the statement's date, units and NAV (and its amount when it
   is 1 EGP or more off) and a note "checked against the Thndr <Mon-YY> statement". A savings-wallet trade the statement
   shows only as a cash transfer (no units printed) corrects the date and amount only (units = amount / the row's NAV).
   Nothing is removed or added: rows the statements do not show, and statement fund trades the ledger lacks, are
   listed. Writes <out>/write/ledger_yYYYY.json for each year that changed (run_sync.writes_from_plan) and <out>/report.json; prints ONE JSON line of counts. */
'use strict';
const fs = require('fs'), path = require('path');
const TS = require('./statement.js');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? a.concat([[x.slice(2), arr[i + 1]]]) : a), []));
if (!args.data || !args.inbox || !args.out) { console.log(JSON.stringify({ ok: false, error: 'usage: fund_fix.js --data DIR --inbox DIR --out DIR' })); process.exit(1); }
const J = (f) => { const x = JSON.parse(fs.readFileSync(f)); return x && x.data && typeof x.data === 'object' ? x.data : x; };
const opt = (f, d) => (fs.existsSync(f) ? J(f) : d);
const D = (...p) => path.join(args.data, ...p);
const r2 = (x) => Math.round(x * 100) / 100;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const lbl = (m) => `${MON[+m.slice(5, 7) - 1]}-${m.slice(2, 4)}`;
const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 864e5);

(async () => {
  const pdfjs = require(require.resolve('pdfjs-dist/legacy/build/pdf.js', { paths: [__dirname, path.join(__dirname, 'node_modules'), path.join(__dirname, 'pdfjs', 'node_modules')] }));
  const settings = J(D('portfolio', 'settings.json'));
  const assets = (opt(D('portfolio', 'assets.json'), { items: {} }).items) || {};
  const years = fs.readdirSync(D('ledger')).filter((f) => /^y\d{4}\.json$/.test(f)).map((f) => f.slice(1, 5)).sort();
  const ledger = {}; years.forEach((y) => { ledger[y] = (J(D('ledger', `y${y}.json`)).rows || []).map((t) => Object.assign({}, t)); });
  const tx = years.flatMap((y) => ledger[y]);
  const isFund = (t) => { const a = assets[t.a] || {}; return !!t.a && (t.acc === 'MF' || a.fund || a.symbol === 'SAVINGS' || /^thndr/i.test(t.a)); };
  const unconfirmed = tx.filter((t) => (t.t === 'Buy' || t.t === 'Sell') && isFund(t) && !t.opening && !/^(stmt|invoice)/.test(t.src || ''));

  // every fund trade on the statements (one per trade: overlapping statements print the same one), and the windows covered
  const manifest = fs.existsSync(path.join(args.inbox, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(args.inbox, 'manifest.json'))) : [];
  const trades = [], windows = []; let used = 0;
  for (const msg of manifest) {
    if (!/e-statement/i.test(msg.subject || '') || /us market/i.test(msg.subject || '')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(args.inbox, `${msg.id}.json`))).raw;
      if (!TS.authCheck(raw).ok) continue;
      const docs = [];
      for (const a of TS.attachments(raw)) docs.push({ filename: a.filename, lines: await TS.pdfLines(pdfjs, a.bytes) });
      if (TS.ownerCheck(docs, settings).error) continue;
      const st = TS.parseStatement(docs);
      if (!st.cash || !st.mf || !st.from || !st.to) continue;
      used++;
      windows.push([st.from, st.to]);
      const rc = TS.reconcile(st, [], assets, {});
      rc.fresh.filter((r) => r.acc === 'MF' && (r.t === 'Buy' || r.t === 'Sell')).forEach((r) => {
        const units = !(r.a === 'thndrsavings' && r.p === 1 && Math.abs(r.q - Math.abs(r.amt)) < 0.005);   // itemised, or only a transfer
        const k = [r.d, r.t, r.a.toLowerCase(), units ? r.q : '', r.amt].join('|');
        if (!trades.some((x) => x.k === k)) trades.push({ k, d: r.d, t: r.t, a: r.a, q: r.q, p: r.p, amt: r.amt, units, M: st.month, whole: st.fullMonth, used: false });
      });
    } catch (e) { /* an unreadable email is simply not used */ }
  }
  const covered = (d) => windows.some(([a, b]) => d >= a && d <= b);

  const corrected = [], confirmed = [], notOnStatements = [], uncovered = [];
  unconfirmed.sort((a, b) => (a.d < b.d ? -1 : 1)).forEach((t) => {
    const c = trades.filter((x) => !x.used && x.t === t.t && x.a.toLowerCase() === t.a.toLowerCase() && days(x.d, t.d) <= 6 &&
      ((x.units && Math.abs((x.q || 0) - (t.q || 0)) <= Math.max(0.01, Math.abs(t.q || 0) * 0.01)) || Math.abs(Math.abs(x.amt) - Math.abs(t.amt || 0)) <= Math.max(1, Math.abs(t.amt || 0) * 0.02)))
      .sort((a, b) => days(a.d, t.d) - days(b.d, t.d) || Math.abs(Math.abs(a.amt) - Math.abs(t.amt)) - Math.abs(Math.abs(b.amt) - Math.abs(t.amt)))[0];
    if (!c) { (covered(t.d) ? notOnStatements : uncovered).push({ d: t.d, t: t.t, a: t.a, q: t.q }); return; }
    c.used = true;
    const before = { d: t.d, q: t.q, p: t.p, amt: t.amt };
    const next = { d: c.d, amt: Math.abs(c.amt - t.amt) >= 1 ? c.amt : t.amt };
    if (c.units) { next.q = c.q; next.p = c.p; } else { next.p = t.p; next.q = t.p > 0 ? Math.round(Math.abs(next.amt) / t.p * 1e4) / 1e4 : t.q; }
    const diff = next.d !== t.d || Math.abs((next.q || 0) - (t.q || 0)) > 1e-4 || Math.abs((next.p || 0) - (t.p || 0)) > 1e-6 || Math.abs(next.amt - t.amt) > 0.005;
    const note = `checked against the Thndr ${lbl(c.M)} statement`;
    if (diff) {
      Object.assign(t, next, { note: [t.note, `corrected: ${note}`].filter(Boolean).join('; ') });
      corrected.push({ a: t.a, t: t.t, from: before, to: next, statement: c.M, unitsPrinted: c.units });
    } else {
      t.note = [t.note, note].filter(Boolean).join('; ');
      confirmed.push({ d: t.d, t: t.t, a: t.a });
    }
  });
  // fund trades the statements show that no ledger fund row (confirmed or not) accounts for
  const fundRows = tx.filter((t) => (t.t === 'Buy' || t.t === 'Sell') && isFund(t) && !t.opening);
  const missing = trades.filter((x) => !x.used && !fundRows.some((t) => t.t === x.t && t.a.toLowerCase() === x.a.toLowerCase() && days(t.d, x.d) <= 6 &&
    (Math.abs(Math.abs(t.amt || 0) - Math.abs(x.amt)) <= Math.max(1, Math.abs(x.amt) * 0.02) || (x.units && Math.abs((t.q || 0) - x.q) <= Math.max(0.01, x.q * 0.01)))))
    .map((x) => ({ d: x.d, t: x.t, a: x.a, q: x.units ? x.q : null, statement: x.M }));

  const W = path.join(args.out, 'write');
  fs.mkdirSync(W, { recursive: true });
  const changedYears = [];
  const all = years.flatMap((y) => ledger[y]);
  years.forEach((y) => {
    // a row whose corrected date moved it into another year goes to that year's document
    const into = all.filter((t) => t.d.slice(0, 4) === y);
    if (JSON.stringify(J(D('ledger', `y${y}.json`)).rows || []) !== JSON.stringify(into)) {
      changedYears.push(y);
      fs.writeFileSync(path.join(W, `ledger_y${y}.json`), JSON.stringify({ rows: into }));
    }
  });
  const report = { statementsWithFunds: used, fundTradesOnStatements: trades.length, unconfirmed: unconfirmed.length, corrected, confirmed, notOnStatements, uncovered, missing, changedYears };
  fs.writeFileSync(path.join(args.out, 'report.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ ok: true, statementsWithFunds: used, fundTradesOnStatements: trades.length, unconfirmed: unconfirmed.length, corrected: corrected.length, confirmed: confirmed.length,
    notOnStatements: notOnStatements.length, uncovered: uncovered.length, missing: missing.length, changedYears }));
})().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); process.exit(1); });
