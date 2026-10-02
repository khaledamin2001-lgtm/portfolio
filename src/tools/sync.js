#!/usr/bin/env node
/* Thndr inbox sync: applies every new Thndr email to the portfolio ledger, oldest first.
     node sync.js --data <plain export folder: <coll>/<doc>.json> --inbox <dir> --out <plan dir> [--today YYYY-MM-DD]
   <inbox>/manifest.json lists [{id, subject, date}]; <inbox>/<id>.json is the Gmail get_message RAW result.
   - "Your Thndr Invoice": each trade is added, or the matching ledger row corrected to the invoice. A ledger row
     matches an invoice block only when it has the SAME date, type and asset and (stocks) the same quantity or a
     close amount, (funds) a close amount; every row is matched at most once per run, so two equal lots on
     different days, or two equal lots on the same day, stay two rows. A stock's ISIN on the invoice gives its ticker
     (market/latest quotes carry TradingView's isin), so a new stock is priced at once; one stored without a ticker
     is healed from its ISIN or from an invoice read again (summary.healed).
   - "Your requested E-statement" (any period): the statement wins for the dates it covers: missing rows added,
     mis-booked rows corrected, rows not on it removed (except on its last day, which may still be settling),
     kickbacks trued up, and broker cash set to its closing balance.
   - "Your monthly E-statement" (full month + positions snapshot): the same, for the whole month, plus the
     month-end marks. The month is final afterwards.
   - A statement only changes rows dated in months that are still open: a month is closed once it has a full-month
     import (imports/<M>.fullMonth) or a non-provisional month-end mark from a statement ('statement' or
     'reconstructed'). Differences in closed months (a requested statement spanning several months) are left
     alone and listed in the email as "left unchanged in closed <Mon-YY>: …"; they do not hold the statement.
   - Mutual-fund rows (acc 'MF'): an invoice and a statement amount less than 1 EGP apart are the same trade, not a
     correction; the existing amount is kept. (If keeping those piasters would leave the ledger's cash more than
     0.50 EGP off a statement's closing balance, that statement corrects them after all, so the drift never grows
     into a cash hold.)
   - Requested (part-month) statements true up kickbacks against the ledger's rebates in their window, not counting
     an earlier true-up in that window; that earlier true-up is replaced (re-dated and re-amounted), never doubled.
   Nothing is written for a statement unless the corrected ledger re-reconciles cleanly: no differences left,
   cash equal to the statement's closing balance, and (monthly) every share count equal to the snapshot.
   Fund convention: a mutual-fund trade (thndrgold, thndrsavings, thndrmonthlysavings, ...) is booked exactly as
   Thndr prints it — q = Thndr units, p = NAV per unit, amt = the cash that moved (fees included). There is no
   gram or ounce bookkeeping anywhere in this file or in statement.js: a gold-fund invoice for N units at NAV P
   becomes q N, p P, whatever the ledger row typed by hand looked like. (Pricing of fund units
   and the conversion of old gram-denominated rows live in the engine, not here.)
   Bonus shares: a statement line "Bonus Shares - <stock> (<n> @ 0 EGP)" (or Stock Dividend / Free Shares /
   منحة) becomes a ledger row { t: 'Bonus', q: n, amt: 0 } — no cash moves, the share count goes up.
   Sender: before anything is parsed the email must come from *.thndr.app AND carry a DKIM pass for that domain
   in the receiving host's Authentication-Results (TS.authCheck); otherwise it is held and nothing from it is used.
   An invoice email is all-or-nothing: if any of its blocks cannot be read, nothing from that email is written.
   Output: <out>/write/* (documents to write) and <out>/summary.json (what changed, what needs attention).
   summary.monthlyPending lists the full months whose factsheet email / workbooks are still owed (imports/<M>.reports
   is stamped by the job); sync_state.json carries toolSha = sha256 (12 hex) of the tool files that ran.
   summary.alert is null, or — when a month's monthly statement newly became overdue (once per month, from the 10th
   of the next month; state.alerts[M]) — every month still missing one, e.g. ['2026-06', '2026-09'] (missingStatements).
   The email subject starts with settings.name and links the site.
   Heads-up digest (digest()): after the emails, from the data dir as it stands after this run — (exdiv) a held stock
   whose market/latest quote goes ex-dividend within 7 days; (target/stop) a held stock whose latest price is at or past
   its asset target (≥) or stop (≤); (limit) a stock or sector above the portfolio's own limit (settings.limits, when
   switched on; 'limit:stock:COMI:20'); (drawdown) the portfolio's return index (deposits and withdrawals excluded) more
   than 10% below its highest daily (else month-end) point of the last 12 months, the live month valued with
   ./engine.js + ./engine2.js; (statement) every month in missingStatements(). Each item has a stable key
   ('exdiv:COMI:2026-10-02', 'target:COMI:125', 'drawdown:2026-03-15:10', 'statement:2026-08'). sync/state.digest =
   {at, items} (every current item), state.alertsSent = {key: date} (emailed once): a new exdiv/target/stop/drawdown
   item makes the email notify with a "Heads-up" section at the top of its text; statement items keep their own
   "Monthly statements still missing" line (state.alerts) and are stamped in alertsSent when that line goes out.
   state.heartbeat.sync = this run's time. A digest check that fails (e.g. no engine) is skipped and listed in
   summary.digest.errors; it never stops the sync.
   Tracking start (settings.trackFrom, 'YYYY-MM-DD'; set for accounts made on the site): the opening rows typed at
   sign-up (t.opening) stand for everything up to and including that day. Invoice trades dated on or before it are
   skipped (already in the opening holdings); a statement ending on or before it is skipped; a statement that starts on
   or before it is used from the next day only (its opening balance is not compared). Opening rows are never matched,
   corrected or removed by a statement; they count in its holdings and cash checks. */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const TS = require('./statement.js');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? a.concat([[x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]]) : a), []));
const J = (f) => { const x = JSON.parse(fs.readFileSync(f)); return x.data || x; };
const opt = (f, d) => (fs.existsSync(f) ? J(f) : d);
const D = (...p) => path.join(args.data, ...p);
const num = (s) => parseFloat(String(s).replace(/,/g, ''));
const r2 = (x) => Math.round(x * 100) / 100;
const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 864e5);
const newId = () => Math.random().toString(36).slice(2, 10);
const today = args.today || new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
const fmt = (x) => (x == null ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; };
const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
// 'Sep-26' on every Node/ICU (en-GB ICU data prints 'Sept'), so the label is built from a fixed list
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const lbl = (m) => `${MONTH_NAMES[+m.slice(5, 7) - 1]}-${m.slice(2, 4)}`;
// the page each portfolio's summary email links to (settings.portfolioId)
const SITE_URL = 'https://khaledamin2001-lgtm.github.io/portfolio/';

// ---------- current state ----------
// Loaded from --data by run(); tests inject their own through _reset().
let tx = [], marks = {}, assets = {}, settings = {}, imports = {}, bench = { members: [] }, state = { seen: {}, alerts: {} }, market = null, history = {};
const freshChanged = () => ({ ledgerYears: new Set(), marks: false, settings: false, newAssets: {}, imports: {} });
let changed = freshChanged();
const log = [];
// ledger rows already matched to (or created by) an invoice block earlier in this run: a second invoice for an
// equal lot must never be folded into the same row
const consumed = new Set();
function loadState() {
  const ledgerYears = fs.readdirSync(D('ledger')).filter((f) => /^y\d{4}\.json$/.test(f)).map((f) => f.slice(1, 5));
  tx = ledgerYears.flatMap((y) => J(D('ledger', `y${y}.json`)).rows || []);
  marks = J(D('portfolio', 'marks.json')).months;
  assets = J(D('portfolio', 'assets.json')).items;
  settings = J(D('portfolio', 'settings.json'));
  imports = fs.existsSync(D('imports')) ? Object.fromEntries(fs.readdirSync(D('imports')).map((f) => [f.replace('.json', ''), J(D('imports', f))])) : {};
  bench = opt(D('bench', 'egx30.json'), { members: [] });
  state = opt(D('sync', 'state.json'), { seen: {}, alerts: {} });
  state.seen = state.seen || {}; state.alerts = state.alerts || {};
  market = opt(D('market', 'latest.json'), null);
  history = fs.existsSync(D('history')) ? Object.fromEntries(fs.readdirSync(D('history')).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).map((f) => [f.slice(0, 7), J(D('history', f))])) : {};
  changed = freshChanged(); log.length = 0; consumed.clear();
}
function _reset(txRows, assetsObj, settingsObj, extra) {
  tx = txRows || []; assets = assetsObj || {}; settings = settingsObj || {};
  marks = (extra && extra.marks) || {}; imports = (extra && extra.imports) || {}; bench = (extra && extra.bench) || { members: [] };
  market = (extra && extra.market) || null; history = (extra && extra.history) || {};
  state = { seen: {}, alerts: {} }; changed = freshChanged(); log.length = 0; consumed.clear();
}

// ---------- names ----------
function resolveName(n) {
  const k = n.toLowerCase();
  const a = Object.values(assets).find((x) => x.name.toLowerCase() === k || (x.symbol || '').toLowerCase() === k);
  if (a) return { name: a.name, known: true };
  const t = tx.find((x) => (x.a || '').toLowerCase() === k);
  if (t) return { name: t.a, known: true };
  return { name: n, known: false };
}
// an invoice's ISIN (EGS…) -> the listed ticker, from market/latest (TradingView's isin column), with its sector
function isinTicker(code) {
  if (!code || !/^EG[A-Z0-9]{10}$/i.test(code) || !market || !market.quotes) return null;
  const hit = Object.entries(market.quotes).filter(([, q]) => q && String(q.isin || '').toUpperCase() === code.toUpperCase());
  if (hit.length !== 1) return null;
  const [s, q] = hit[0], m = bench.members.find((x) => x.s === s);
  return { s, sector: (m && m.sector) || q.sector || 'Unclassified' };
}
// a stock stored without a ticker (first seen on an invoice before ISINs were looked up): its ticker from the ISIN
// (asset.isin, or the code on one of its invoices), so it is priced at once instead of after the next monthly statement
function healTicker(name, code, why) {
  const a = assets[name];
  if (!a || a.fund || a.symbol || name.startsWith('thndr')) return null;
  const tk = isinTicker(code || a.isin);
  if (!tk || Object.values(assets).some((x) => x !== a && (x.symbol || '').toUpperCase() === tk.s)) return null;
  const upd = { ...a, symbol: tk.s, isin: (code || a.isin).toUpperCase(), sector: a.sector && a.sector !== 'Unclassified' ? a.sector : tk.sector };
  assets[name] = upd; changed.newAssets[name] = upd;
  return `ticker ${tk.s} recorded for "${name}" (${why}), so it is priced from now on`;
}
const cashTo = (rows, d) => r2(rows.filter((t) => t.d <= d).reduce((s, t) => s + (t.amt || 0), 0));
const cashBefore = (rows, d) => r2(rows.filter((t) => t.d < d).reduce((s, t) => s + (t.amt || 0), 0));
const touch = (d) => changed.ledgerYears.add(d.slice(0, 4));
const desc = (t) => `${t.d} ${t.t}${t.a ? ' ' + t.a : ''}${t.q != null ? ' ' + t.q : ''} ${fmt(t.amt)}`;

// ---------- invoices ----------
function parseInvoices(lines) {
  const out = []; let cur = null, sec = [], mode = null;
  for (const l of lines) {
    let m;
    if (l === 'Invoice') { if (cur) out.push(cur); cur = {}; sec = []; mode = null; continue; }
    if (!cur) continue;
    if (!cur.d && (m = l.match(/^(\d{2})\/(\d{2})\/(\d{4})$/))) { cur.d = `${m[3]}-${m[2]}-${m[1]}`; continue; }
    if (/^Security Name/.test(l)) { mode = 'sec'; continue; }
    if (/^Transaction No\./.test(l)) {
      mode = 'tx';
      const s = sec.join(' ');
      if ((m = s.match(/^(.*?)\s*\b(EG[A-Z0-9]{10}|thndr[a-z]+)\s+(buy|sell)\s+[\d.,]+\s*EGP\s*(.*)$/i))) {
        cur.name = `${m[1]} ${m[4]}`.replace(/\s+/g, ' ').trim(); cur.code = m[2]; cur.type = m[3][0].toUpperCase() + m[3].slice(1).toLowerCase();
        cur.fund = /^thndr/i.test(m[2]);
      }
      continue;
    }
    if (mode === 'sec') { sec.push(l); continue; }
    if (/^Total Quantity/.test(l)) { mode = 'tot'; continue; }
    if (mode === 'tot') { if ((m = l.match(/^([\d,.]+)\s+[\d,.]+\s*EGP\s+([\d,.]+)\s*EGP$/))) { cur.qty = num(m[1]); cur.gross = num(m[2]); } mode = null; continue; }
    if ((m = l.match(/^Total Fees ([\d,.]+) EGP/))) cur.fees = num(m[1]);
    if ((m = l.match(/^Grand Total ([\d,.]+) EGP/))) cur.total = num(m[1]);
  }
  if (cur) out.push(cur);
  return out;
}
// One invoice block against the ledger. A hit needs the same date, type and asset, must not have been used by an
// earlier block this run, and (stock) the same quantity or a close amount / (fund) a close amount; among several
// candidates the closest amount wins. On a hit q, p and amt are always taken from the invoice (funds in Thndr
// units at NAV, see the header); otherwise the trade is added.
function applyInvoice(v, entry) {
  if (!v.d || !v.type || !v.qty || v.total == null) { entry.reasons.push(`could not read an invoice block (${v.name || 'unknown security'})`); return; }
  if (settings.trackFrom && v.d <= settings.trackFrom) { entry.unchanged++; entry.notes.push(`${v.d} ${v.type} ${v.name || v.code}: before tracking started (${settings.trackFrom}), already in the starting holdings`); return; }
  // a stock: the asset already listed under the invoice ISIN's ticker, else the one with its name
  const fund = v.fund, tk = fund ? null : isinTicker(v.code), byTk = tk && Object.values(assets).find((x) => (x.symbol || '').toUpperCase() === tk.s);
  const name = fund ? v.code.toLowerCase() : byTk ? byTk.name : resolveName(v.name).name;
  const known = fund || !!byTk || resolveName(v.name).known;
  const fixed = !fund && known && !byTk && healTicker(name, v.code, `from its invoice ${v.d}`);
  if (fixed) entry.notes.push(fixed);
  const row = { d: v.d, t: v.type, a: name, q: v.qty, p: +(v.gross / v.qty).toFixed(fund ? 6 : 4), amt: r2(v.type === 'Buy' ? -v.total : v.total), acc: fund ? 'MF' : 'Main' };
  const tol = Math.max(1, Math.abs(row.amt) * 0.015);
  const amtDiff = (t) => Math.abs((t.amt || 0) - row.amt);
  const hit = tx.filter((t) => !consumed.has(t.id) && t.d === row.d && t.t === row.t && (t.a || '').toLowerCase() === row.a.toLowerCase() &&
    ((!fund && Math.abs((t.q || 0) - row.q) < 0.01) || amtDiff(t) <= tol))
    .sort((a, b) => amtDiff(a) - amtDiff(b))[0];
  if (hit) {
    consumed.add(hit.id); // by id: applyStatement replaces the row objects with copies, the ids survive
    // a fund amount less than 1 EGP off (invoice total vs the statement's cash transfer) is the same trade: keep it
    const keepAmt = (fund || hit.acc === 'MF') && Math.abs((hit.amt || 0) - row.amt) < 1;
    const before = desc(hit), diff = (!keepAmt && Math.abs((hit.amt || 0) - row.amt) > 0.005) || Math.abs((hit.q || 0) - row.q) > 0.005 || Math.abs((hit.p || 0) - row.p) > 0.00005;
    if (!diff) { entry.unchanged++; return; }
    if (!keepAmt) hit.amt = row.amt;
    hit.q = row.q; hit.p = row.p;
    hit.note = [hit.note, `corrected per Thndr invoice ${v.d}`].filter(Boolean).join('; '); touch(hit.d);
    entry.changes.push(`corrected ${before} → ${desc(hit)}`);
    return;
  }
  const add = { id: newId(), ...row, src: `invoice-${v.d}` };
  tx.push(add); consumed.add(add.id); touch(add.d); entry.changes.push(`added ${desc(add)}`);
  if (!known && !changed.newAssets[name]) {
    const isin = /^EG[A-Z0-9]{10}$/i.test(v.code || '') ? v.code.toUpperCase() : undefined;
    changed.newAssets[name] = tk ? { name, symbol: tk.s, isin, sector: tk.sector } : { name, isin, sector: 'Unclassified' }; assets[name] = changed.newAssets[name];
    entry.notes.push(tk ? `new stock "${name}" (${tk.s})` : `new stock "${name}" has no ticker yet; it is filled in from the next monthly statement snapshot`);
  }
}
// One invoice EMAIL, all-or-nothing: its blocks are applied to a working copy of the ledger, assets and pending
// writes; if any block cannot be read (entry.reasons non-empty) the copy is discarded — nothing from that email is
// written, the email is held, and what would have changed is kept in entry.proposed. On success the copy is kept.
function applyInvoiceEmail(blocks, entry) {
  const keep = { tx, assets, changed, consumed: new Set(consumed) };
  tx = tx.map((t) => ({ ...t })); assets = { ...assets };
  changed = { ledgerYears: new Set(changed.ledgerYears), marks: changed.marks, settings: changed.settings, newAssets: { ...changed.newAssets }, imports: { ...changed.imports } };
  if (!blocks.length) entry.reasons.push('no invoice found in the PDF');
  try { blocks.forEach((v) => applyInvoice(v, entry)); }
  catch (e) { entry.reasons.push('could not process an invoice block: ' + (e.message || e)); }
  if (entry.reasons.length) {
    tx = keep.tx; assets = keep.assets; changed = keep.changed; consumed.clear(); keep.consumed.forEach((id) => consumed.add(id));
    if (entry.changes.length) entry.proposed = entry.changes;
    entry.changes = []; entry.notes = []; entry.unchanged = 0;
    entry.reasons.push('nothing from this invoice email was applied (all its trades are written together or not at all)');
    return 'hold';
  }
  return entry.changes.length ? 'applied' : 'unchanged';
}

// ---------- statements ----------
function applyStatement(st, entry, msg) {
  if (!st.cash) { entry.reasons.push('no account statement among the PDFs'); return 'hold'; }
  const tf = settings.trackFrom, st2 = TS.fromTrackStart(st, tf);
  if (!st2) { entry.period = `${st.from} to ${st.to}`; entry.notes.push(`covers only days up to ${tf}, when tracking started (already in the starting holdings); nothing to do`); return 'skip'; }
  if (st2 !== st) { entry.notes.push(`only the days from ${st2.from} were used: the holdings and cash entered when tracking started (${tf}) already cover the days before`); st = st2; }
  const M = st.month, final = !!(st.fullMonth && st.snapshot);
  entry.period = `${st.from} to ${st.to}`; entry.final = final;
  if (imports[M] && imports[M].fullMonth) { entry.notes.push(`${lbl(M)} is already final from its monthly statement; nothing to do`); return 'skip'; }
  if (!final && marks[M] && !marks[M].provisional) { entry.notes.push(`${lbl(M)} is already closed; a part-month statement cannot change it`); return 'skip'; }
  const rc = TS.reconcile(st, tx, assets, marks);
  if (rc.unknown.length) entry.reasons.push(`${rc.unknown.length} statement lines not recognised: ${rc.unknown.map((u) => u.desc || u.raw).join(' | ')}`);
  const open = cashBefore(tx, st.from);
  if (st.cash.start != null && Math.abs(open - st.cash.start) > 1) entry.reasons.push(`opening cash ${fmt(st.cash.start)} on ${st.from} differs from the ledger's ${fmt(open)}: an earlier month needs its statement first`);
  if (entry.reasons.length) return 'hold';

  // Months that are already closed are never changed by a statement that merely spans them (a requested statement
  // over several months): closed = a full-month import, or a non-provisional month-end mark taken from a statement
  // ('statement' / 'reconstructed'). The month a monthly statement is closing is always open to it.
  const closedMonth = (m) => !(final && m === M) && !!((imports[m] && imports[m].fullMonth) || (marks[m] && !marks[m].provisional && (marks[m].source === 'statement' || marks[m].source === 'reconstructed')));
  const closedOf = (...ds) => ds.filter(Boolean).map((d) => d.slice(0, 7)).find(closedMonth) || null;
  const tag = final ? `stmt-${M}` : `stmt-partial-${st.to}`;
  const removable = (t) => (final || t.d < st.to) && !(t.acc === 'MF' && !st.mf);
  const isTrueUp = (t) => t.t === 'Rebate' && /^Commission kickbacks true-up/.test(t.note || '') && t.d >= st.from && t.d <= st.to && !closedOf(t.d);
  // build the corrected ledger; strictFunds = false keeps fund amounts that are less than 1 EGP off the statement
  const build = (strictFunds) => {
    let next = tx.map((t) => ({ ...t }));
    const byId = new Map(next.map((t) => [t.id, t]));
    const ops = [], removed = [], frozen = {}, keptFunds = [], addAssets = {};
    const freeze = (m, s) => (frozen[m] = frozen[m] || []).push(s);
    const twin = (t) => byId.get(t.id) || next.find((x) => x.d === t.d && x.t === t.t && x.amt === t.amt && x.a === t.a);
    rc.matched.forEach(({ stmt, ledger }) => {
      const t = twin(ledger); if (!t) return;
      const main = stmt.acc === 'Main' && (stmt.t === 'Buy' || stmt.t === 'Sell');
      const bonus = stmt.t === 'Bonus'; // no cash, no price: only the share count is compared
      const keepAmt = !strictFunds && (stmt.acc === 'MF' || t.acc === 'MF') && Math.abs(t.amt - stmt.amt) < 1;
      const diff = t.d !== stmt.d || (!keepAmt && Math.abs(t.amt - stmt.amt) > 0.005) || (main && (t.q !== stmt.q || Math.abs((t.p || 0) - (stmt.p || 0)) > 0.00005)) || (bonus && Math.abs((t.q || 0) - (stmt.q || 0)) > 0.005);
      const cm = closedOf(t.d, stmt.d);
      if (keepAmt && !cm && Math.abs(t.amt - stmt.amt) > 0.005) keptFunds.push(t);
      if (!diff) return;
      if (cm) { freeze(cm, `${desc(t)} (the statement has ${desc(stmt)})`); return; }
      const before = desc(t);
      t.d = stmt.d; if (!keepAmt) t.amt = stmt.amt; if (main) { t.q = stmt.q; t.p = stmt.p; } if (bonus) t.q = stmt.q;
      t.note = [t.note, 'corrected per Thndr statement'].filter(Boolean).join('; ');
      ops.push(`corrected ${before} → ${desc(t)}`);
    });
    rc.conflicts.forEach(({ stmt, ledger }) => {
      if (stmt.acc === 'MF' && !st.mf) return; // no fund statement in this email: the fund name on the transfer is a guess, keep the ledger's
      const t = twin(ledger); if (!t) return;
      const cm = closedOf(t.d, stmt.d); if (cm) { freeze(cm, `booked differently: ${desc(t)} (the statement has ${desc(stmt)})`); return; }
      const before = desc(t);
      Object.assign(t, { d: stmt.d, t: stmt.t, a: stmt.a, q: stmt.q, p: stmt.p, amt: stmt.amt, acc: stmt.acc, src: tag, note: 'rebooked per Thndr statement' });
      ops.push(`rebooked ${before} → ${desc(t)}`);
    });
    rc.ledgerOnly.filter(removable).forEach((l) => {
      const t = twin(l); if (!t) return;
      const cm = closedOf(t.d); if (cm) { freeze(cm, `not on the statement: ${desc(t)}`); return; }
      next = next.filter((x) => x !== t); removed.push(t); ops.push(`removed ${desc(t)} (not on the statement)`);
    });
    rc.fresh.forEach((r) => {
      if (r.acc === 'MF' && !st.mf && r.t !== 'Rebate') return;
      const cm = closedOf(r.d); if (cm) { freeze(cm, `missing ${desc(r)}`); return; }
      const o = { id: newId(), d: r.d, t: r.t, amt: r.amt, acc: r.acc || 'Main', src: tag };
      if (r.a) o.a = r.a; if (r.q != null) o.q = r.q; if (r.p != null) o.p = r.p; if (r.note) o.note = r.note;
      next.push(o); ops.push(`added ${desc(o)}`);
      if (r.newAsset && !assets[r.a] && !addAssets[r.a]) {
        const tk = r.newAsset.ticker; const m = tk && bench.members.find((x) => x.s === tk);
        addAssets[r.a] = r.acc === 'MF' ? { name: r.a, fund: true, sector: /saving/i.test(r.a) ? 'Cash & Savings' : 'Mutual Funds' } : { name: r.a, symbol: tk || undefined, sector: m ? m.sector : 'Unclassified' };
      }
    });
    // kickbacks paid so far (the monthly statement's true-up is already in rc.fresh): compared with the ledger's rebates
    // in the window NOT counting an earlier true-up there (two overlapping requested statements), which is replaced
    if (!final) {
      const earlier = next.filter(isTrueUp).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
      const reb = r2(next.filter((t) => t.t === 'Rebate' && t.d >= st.from && t.d <= st.to && !isTrueUp(t)).reduce((s, t) => s + t.amt, 0));
      const up = r2(rc.kick - reb);
      const note = `Commission kickbacks true-up to ${st.to} (statement ${fmt(rc.kick)} vs ledger ${fmt(reb)})`;
      const keep = earlier.pop();
      earlier.forEach((t) => { next = next.filter((x) => x !== t); removed.push(t); ops.push(`removed ${desc(t)} (an earlier kickbacks true-up, now part of the one to ${st.to})`); });
      if (keep && Math.abs(up) < 0.05) { next = next.filter((x) => x !== keep); removed.push(keep); ops.push(`removed ${desc(keep)} (kickbacks true-up no longer needed)`); }
      else if (keep) {
        if (Math.abs(keep.amt - up) > 0.005 || keep.d !== st.to) { const before = desc(keep); Object.assign(keep, { d: st.to, amt: up, src: tag, note }); ops.push(`replaced kickbacks true-up ${before} → ${desc(keep)}`); }
      } else if (Math.abs(up) >= 0.05) { const o = { id: newId(), d: st.to, t: 'Rebate', amt: up, acc: 'Main', src: tag, note }; next.push(o); ops.push(`added ${desc(o)}`); }
    }
    return { next, ops, removed, frozen, keptFunds, addAssets };
  };
  let b = build(false);
  // kept fund piasters must never add up to a cash hold: past 0.50 EGP off the closing balance they are corrected after all
  if (b.keptFunds.length && st.cash.end != null && Math.abs(cashTo(b.next, st.to) - st.cash.end) > 0.5) b = build(true);
  const { next, ops, removed, frozen, addAssets } = b;
  Object.keys(frozen).sort().forEach((m) => entry.notes.push(`left unchanged in closed ${lbl(m)}: ${frozen[m].join('; ')}`));
  // verify: the corrected ledger must re-reconcile cleanly
  const assets2 = { ...assets, ...addAssets };
  const rc2 = TS.reconcile(st, next, assets2, marks);
  // a symbol-less stock (first seen on an invoice) that the snapshot lists under its ticker: record the ticker on the
  // existing asset, keeping the ledger name, so the next month prices it and the statement no longer holds
  const aliasAssets = {};
  (rc2.aliases || []).forEach((al) => {
    const m = bench.members.find((x) => x.s === al.ticker), cur = addAssets[al.name] || assets[al.name] || { name: al.name };
    const upd = { ...cur, name: al.name, symbol: al.ticker, sector: m ? m.sector : cur.sector || 'Unclassified' };
    if (addAssets[al.name]) addAssets[al.name] = upd; else aliasAssets[al.name] = upd;
    ops.push(`ticker ${al.ticker} recorded for "${al.name}" (the snapshot lists it as ${al.snapshotName || al.ticker})`);
  });
  const left = [];
  rc2.fresh.filter((r) => !(r.acc === 'MF' && !st.mf) && !closedOf(r.d)).forEach((r) => left.push(`still missing ${desc(r)}`));
  rc2.conflicts.filter((c) => !(c.stmt.acc === 'MF' && !st.mf) && !closedOf(c.ledger.d, c.stmt.d)).forEach((c) => left.push(`still booked differently: ${desc(c.ledger)}`));
  rc2.ledgerOnly.filter((t) => removable(t) && !closedOf(t.d)).forEach((t) => left.push(`still not on the statement: ${desc(t)}`));
  const close = cashTo(next, st.to);
  if (st.cash.end != null && Math.abs(close - st.cash.end) > 1) left.push(`ledger cash on ${st.to} would be ${fmt(close)} but the statement closes at ${fmt(st.cash.end)}`);
  if (final) (rc2.holdings || []).filter((h) => h.ok === false).forEach((h) => left.push(`holdings differ: ${h.ticker} statement ${h.statementQty} vs ledger ${h.ledgerQty}${h.bonusHint ? ' — ' + h.bonusHint : ''}`));
  if (Object.values(addAssets).some((a) => !a.fund && !a.symbol)) left.push(`new stock without a ticker on the snapshot: ${Object.values(addAssets).filter((a) => !a.fund && !a.symbol).map((a) => a.name).join(', ')}`);
  if (left.length) { entry.reasons.push(...left); entry.proposed = ops; return 'hold'; }

  // apply
  if (ops.length) {
    const key = (rows, y) => JSON.stringify(rows.filter((t) => t.d.slice(0, 4) === y).map((t) => [t.id, t.d, t.t, t.a, t.q, t.p, t.amt, t.acc]).sort());
    new Set(tx.concat(next).map((t) => t.d.slice(0, 4))).forEach((y) => { if (key(tx, y) !== key(next, y)) changed.ledgerYears.add(y); });
  }
  tx = next; Object.assign(assets, addAssets, aliasAssets); Object.assign(changed.newAssets, addAssets, aliasAssets);
  entry.changes.push(...ops); entry.removedRows = removed;
  let cashMoved = false;
  if (st.cash.end != null && (!settings.cashDate || st.to >= settings.cashDate)) {
    if (settings.cash !== st.cash.end || settings.cashDate !== st.to) { cashMoved = true; entry.changes.push(`cash at Thndr: ${fmt(st.cash.end)} EGP on ${st.to}${settings.cash === st.cash.end ? ' (unchanged)' : settings.cash == null ? '' : ` (was ${fmt(settings.cash)} EGP${settings.cashDate ? ' on ' + settings.cashDate : ''})`}`); }
    settings = { ...settings, cash: st.cash.end, cashDate: st.to, cashSource: `Thndr statement to ${st.to}` }; changed.settings = true;
  }
  if (final) {
    const mp = rc2.markProposal, prev = marks[M] || {};
    const mark = { ...prev, cash: mp.cash, securities: mp.securities, provisional: false, source: 'statement' };
    delete mark.note;
    if (prev.cash != null && prev.source !== 'statement' && prev.source !== 'reconstructed') { mark.typedCash = prev.cash; mark.typedSecurities = prev.securities; }
    marks = { ...marks, [M]: mark }; changed.marks = true;
    entry.changes.push(`${lbl(M)} month-end taken from the statement: cash ${fmt(mp.cash)} EGP, shares and funds ${fmt(mp.securities)} EGP${prev.securities != null && Math.abs(prev.securities - mp.securities) >= 0.005 ? ` (was ${fmt(prev.securities)} EGP)` : ''}`);
    changed.imports[M] = { month: M, messageId: msg.id, postedAt: new Date().toISOString(), added: ops.filter((o) => o.startsWith('added')).length, corrected: ops.filter((o) => !o.startsWith('added') && !o.startsWith('removed') && !o.startsWith('ticker ')).length,
      removed: removed.length, removedRows: removed, replaced: 0, marks: true, fullMonth: true, postedBy: 'automatic inbox sync', reportsPending: true };
    imports[M] = changed.imports[M];
    entry.monthly = M;
  }
  // applied = the ledger changed, broker cash moved, or a month was posted (a clean monthly statement whose only work is
  // the month-end mark is still a posted month); re-stamping identical broker cash alone is 'unchanged'
  return ops.length || cashMoved || final ? 'applied' : 'unchanged';
}

// ---------- run ----------
const healed = [], heldStatements = [];
const needsTicker = () => Object.values(assets).some((a) => a && !a.fund && !a.symbol && !a.watch && !/^thndr/i.test(a.name || ''));
async function healFromInvoice(pdfjs, msg) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(args.inbox, `${msg.id}.json`))).raw;
    if (!TS.authCheck(raw).ok) return;
    const docs = [];
    for (const a of TS.attachments(raw)) docs.push({ filename: a.filename, lines: await TS.pdfLines(pdfjs, a.bytes) });
    if (TS.ownerCheck(docs, settings).error) return;
    docs.flatMap((d) => parseInvoices(d.lines)).filter((v) => !v.fund && v.name).forEach((v) => {
      const r = healTicker(resolveName(v.name).name, v.code, `from its invoice ${v.d}`); if (r) healed.push(r);
    });
  } catch (e) { /* a seen invoice that cannot be read again changes nothing */ }
}
async function run() {
  const pdfjs = require(require.resolve('pdfjs-dist/legacy/build/pdf.js', { paths: [__dirname, path.join(__dirname, 'node_modules'), path.join(__dirname, 'pdfjs', 'node_modules')] }));
  loadState();
  const out = args.out; fs.rmSync(path.join(out, 'write'), { recursive: true, force: true }); fs.mkdirSync(path.join(out, 'write'), { recursive: true });
  const manifest = fs.existsSync(path.join(args.inbox, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(args.inbox, 'manifest.json'))) : [];
  manifest.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // stocks stored without a ticker: from the ISIN kept on the asset, else from the code on an invoice already read
  // (the job re-fetches seen invoices while such a stock is left, see imap_fetch.skip_ids)
  Object.keys(assets).forEach((n) => { const r = healTicker(n, null, 'from its ISIN'); if (r) healed.push(r); });
  for (const msg of manifest) {
    // a statement held by an earlier run is tried again (the job re-fetches it, imap_fetch.skip_ids): what it waited for
    // may have arrived since. Still held, it is not reported again.
    const prev = state.seen[msg.id], retry = !!(prev && prev.status === 'hold' && prev.kind && prev.kind !== 'invoice');
    if (prev && !retry) { if (prev.kind === 'invoice' && needsTicker()) await healFromInvoice(pdfjs, msg); continue; }
    const kind = /invoice/i.test(msg.subject) ? 'invoice' : /monthly e-statement/i.test(msg.subject) ? 'monthly' : /requested e-statement/i.test(msg.subject) ? 'requested' : null;
    const entry = { id: msg.id, subject: msg.subject, date: msg.date, kind, status: 'ignored', changes: [], reasons: [], notes: [], unchanged: 0, ...(retry ? { retry: true } : {}) };
    log.push(entry);
    if (kind) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(args.inbox, `${msg.id}.json`))).raw;
        // sender verification comes first: nothing is parsed from an email that is not provably Thndr's
        const auth = TS.authCheck(raw);
        entry.sender = { from: auth.from, dkim: auth.dkim, spf: auth.spf, ok: auth.ok };
        if (!auth.ok) throw Object.assign(new Error(`sender not verified: From ${auth.from || '(none)'}, DKIM ${auth.dkim} — nothing from it was used`), { held: true });
        const att = TS.attachments(raw);
        const docs = [];
        for (const a of att) docs.push({ filename: a.filename, lines: await TS.pdfLines(pdfjs, a.bytes) });
        // account lock: only this portfolio's own Thndr documents are ever applied
        const own = TS.ownerCheck(docs, settings);
        if (own.error) {
          entry.status = 'hold'; entry.reasons.push(`refused: this ${kind === 'invoice' ? 'invoice' : 'statement'} ${own.error}; nothing from it was used`);
        } else if (own.code && !(settings.account || {}).unifiedCode) {
          settings = { ...settings, account: { ...(settings.account || {}), unifiedCode: own.code, ...(own.name && !(settings.account || {}).holder ? { holder: own.name } : {}) } }; changed.settings = true;
          entry.notes.push(`Thndr account ${own.code} recorded for this portfolio from its first statement`);
        } else if (own.name && !((settings.account || {}).holder || '').trim() && (own.learnName || (own.code && own.code === (settings.account || {}).unifiedCode))) {
          // the holder's name, so invoices (which print no account number) can be checked: from a statement of this account,
          // or from the first invoice when none told it yet
          settings = { ...settings, account: { ...(settings.account || {}), holder: own.name } }; changed.settings = true;
          entry.notes.push(`Thndr account holder "${own.name}" recorded for this portfolio`);
        }
        if (own.error) { /* held above */ } else if (kind === 'invoice') {
          entry.status = applyInvoiceEmail(docs.flatMap((d) => parseInvoices(d.lines)), entry);
        } else {
          const st = TS.parseStatement(docs);
          entry.status = applyStatement(st, entry, msg);
          if (entry.status === 'hold') heldStatements.push({ st, entry, msg });
        }
      } catch (e) { entry.status = 'hold'; entry.reasons.push((e.held ? '' : 'could not process: ') + (e.message || e)); }
    }
    state.seen[msg.id] = { subject: msg.subject, date: msg.date, kind, status: entry.status, at: new Date().toISOString() };
  }
  // statements that arrive together come in email order, not period order (two requested statements, the later period
  // first): a held one is tried again after the others, until a round applies none
  for (let progress = true; progress;) {
    progress = false;
    for (const h of heldStatements.filter((x) => x.entry.status === 'hold')) {
      const e = { ...h.entry, changes: [], reasons: [], notes: [], unchanged: 0 }; delete e.proposed;
      const status = applyStatement(h.st, e, h.msg);
      if (status === 'hold') continue;
      Object.assign(h.entry, e, { status }); delete h.entry.proposed;
      state.seen[h.msg.id] = { ...state.seen[h.msg.id], status };
      progress = true;
    }
  }
  // missing monthly statement alert: raised once per month (state.alerts[M]), listing every month still missing
  const missing = missingStatements(today, settings, imports, marks);
  let alert = null;
  if (missing.some((m) => !state.alerts[m])) { alert = missing; missing.forEach((m) => { if (!state.alerts[m]) state.alerts[m] = today; }); }
  // heads-up digest: every current item goes to state.digest; items never emailed before go into this email
  const dg = digest({ today, missing });
  const sent = state.alertsSent = pruneSent(state.alertsSent || {}, today);
  const heads = dg.items.filter((it) => it.kind !== 'statement' && !sent[it.key]);
  heads.forEach((it) => { sent[it.key] = today; });
  dg.items.filter((it) => it.kind === 'statement' && !sent[it.key] && state.alerts[it.key.slice(10)]).forEach((it) => { sent[it.key] = state.alerts[it.key.slice(10)]; });
  state.digest = { at: new Date().toISOString(), items: dg.items };
  state.heartbeat = { ...(state.heartbeat || {}), sync: state.digest.at };
  state.lastRun = new Date().toISOString();
  state.toolSha = toolSha();

  // write plan
  const W = (f, o) => fs.writeFileSync(path.join(out, 'write', f), JSON.stringify(o));
  const byYear = {}; tx.forEach((t) => (byYear[t.d.slice(0, 4)] = byYear[t.d.slice(0, 4)] || []).push(t));
  [...changed.ledgerYears].forEach((y) => W(`ledger_y${y}.json`, { rows: (byYear[y] || []).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0)) }));
  if (changed.marks) W('marks.json', { months: marks });
  if (changed.settings) W('settings.json', settings);
  if (Object.keys(changed.newAssets).length) W('assets_update.json', { items: changed.newAssets });
  Object.entries(changed.imports).forEach(([m, o]) => W(`import_${m}.json`, o));
  W('sync_state.json', state);

  const processed = log.filter((e) => e.kind);
  const holds = processed.filter((e) => e.status === 'hold' && !e.retry);
  const applied = processed.filter((e) => e.status === 'applied');
  const lines = [];
  if (heads.length) lines.push('Heads-up:', ...heads.map((it) => '  • ' + it.text), '');
  applied.forEach((e) => { lines.push(`${e.subject}${e.period ? ` (${e.period})` : ''}:`); e.changes.forEach((c) => lines.push('  • ' + c)); e.notes.forEach((c) => lines.push('  • ' + c)); });
  holds.forEach((e) => { lines.push(`NEEDS REVIEW — ${e.subject}${e.period ? ` (${e.period})` : ''}: nothing from this email was saved.`); e.reasons.forEach((c) => lines.push('  • ' + c)); if (e.proposed && e.proposed.length) { lines.push('  Proposed changes that were not applied:'); e.proposed.forEach((c) => lines.push('    – ' + c)); } });
  if (alert) lines.push(`Monthly statement${alert.length > 1 ? 's' : ''} still missing: ${alert.map(lbl).join(', ')} (checked on ${today}).`);
  const monthlyPosted = applied.filter((e) => e.monthly).map((e) => e.monthly);
  const who = settings.name || 'Portfolio';
  const summary = {
    today, status: holds.length ? 'hold' : applied.length ? 'changed' : 'nochange',
    processed: processed.length, applied: applied.length, held: holds.length, ignored: log.length - processed.length,
    monthlyPosted, monthlyPending: monthlyPending(imports, monthlyPosted), alert, toolSha: state.toolSha,
    writes: fs.readdirSync(path.join(out, 'write')),
    email: applied.length || holds.length || alert || heads.length ? {
      subject: holds.length ? `${who}: ${holds.length} Thndr email${holds.length > 1 ? 's' : ''} need${holds.length > 1 ? '' : 's'} your review` : applied.some((e) => e.monthly) ? `${who}: ${applied.filter((e) => e.monthly).map((e) => lbl(e.monthly)).join(', ')} statement posted` : alert && !applied.length ? `${who}: ${alert.map(lbl).join(', ')} Thndr statement${alert.length > 1 ? 's have' : ' has'} not arrived` : applied.length ? `${who}: updated from Thndr` : `${who}: heads-up — ${heads.length > 1 ? `${heads.length} things to look at` : heads[0].text.split(' (')[0].split(';')[0]}`,
      text: lines.join('\n').replace(/\n+$/, '') + '\n\n' + SITE_URL,
      notify: holds.length > 0 || !!alert || heads.length > 0 || applied.some((e) => e.monthly || e.kind !== 'invoice'),
      // the same content in pieces, for the HTML email (src/jobs/emails.py sync_email)
      parts: {
        name: who, url: SITE_URL, heads: heads.map((it) => it.text),
        applied: applied.map((e) => ({ title: e.subject, period: e.period || null, monthly: e.monthly ? lbl(e.monthly) : null, items: e.changes.concat(e.notes) })),
        held: holds.map((e) => ({ title: e.subject, period: e.period || null, reasons: e.reasons, proposed: e.proposed || [] })),
        missing: alert ? alert.map(lbl) : [], checked: today,
      },
    } : null,
    healed,
    digest: { items: dg.items, emailed: heads.map((it) => it.key), drawdown: dg.drawdown, errors: dg.errors },
    log: log.map(({ removedRows, ...e }) => e),
  };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify({ status: summary.status, processed: summary.processed, applied: summary.applied, held: summary.held, monthlyPosted: summary.monthlyPosted, monthlyPending: summary.monthlyPending, alert, headsUp: heads.map((it) => it.key), writes: summary.writes, toolSha: summary.toolSha }));
}
// Full months whose month-end reports are still owed: the job stamps imports/<M>.reports.factsheetSentAt and
// .workbooksPublishedAt after sending / publishing; a month posted on or after 2026-09-28 (when the stamp was
// introduced) without both stamps is pending, and so is every month posted by this run.
const REPORTS_TRACKED_FROM = '2026-09-28';
function monthlyPending(imp, posted) {
  const out = new Set(posted || []);
  Object.entries(imp || {}).forEach(([m, o]) => {
    if (!o || !o.fullMonth || !(o.postedAt >= REPORTS_TRACKED_FROM)) return;
    const r = o.reports || {};
    if (!r.factsheetSentAt || !r.workbooksPublishedAt) out.add(m);
  });
  return [...out].sort();
}
// Months from settings.inception to last month with no monthly statement: no full-month import and a month-end mark
// that is not from a statement ('statement' / 'reconstructed'). Last month counts only from the 10th. A month marked
// 'price-estimate' before the first statement ever posted (no import dated before it) is not missing: those months
// (Khaled's Aug–Nov 2025) have no holdings statements by design.
function missingStatements(todayStr, set, imp, mk) {
  const last = prevMonth(todayStr.slice(0, 7)), first = Object.keys(imp || {}).sort()[0], out = [];
  if (!set || !/^\d{4}-\d{2}$/.test(String(set.inception || '').slice(0, 7))) return out;
  for (let m = set.inception.slice(0, 7); m <= last; m = nextMonth(m)) {
    if (m === last && +todayStr.slice(8) < 10) continue;
    if (imp && imp[m] && imp[m].fullMonth) continue;
    const src = mk && mk[m] && mk[m].source;
    if (src === 'statement' || src === 'reconstructed') continue;
    if (src === 'price-estimate' && !(first && first < m)) continue;
    out.push(m);
  }
  return out;
}
// ---------- heads-up digest ----------
const addDays = (d, k) => new Date(Date.parse(d + 'T00:00:00Z') + k * 864e5).toISOString().slice(0, 10);
const dayLbl = (d) => `${+d.slice(8, 10)} ${MONTH_NAMES[+d.slice(5, 7) - 1]}`;
// alertsSent keys older than 400 days can never come back (their dates / 12-month peaks are long gone)
const pruneSent = (o, t) => Object.fromEntries(Object.entries(o).filter(([, d]) => !(typeof d === 'string' && d < addDays(t, -400))));
// The checks themselves (ex-dividend, target / stop, drawdown) live in engine2.js (PA.headsUp), shared with the page,
// which computes the same list live; this job adds the overdue monthly statements.
const drawdownCheck = (o) => require(path.join(__dirname, 'engine2.js')).drawdownCheck(o);
// The heads-up list for this portfolio. ctx overrides the module state (tests); every check is independent.
function digest(ctx) {
  const o = { today, tx, assets, settings, marks, market, history, missing: [], ...(ctx || {}) };
  const r = require(path.join(__dirname, 'engine2.js')).headsUp(o);
  (o.missing || []).forEach((m) => r.items.push({ kind: 'statement', key: `statement:${m}`, text: `Monthly statement for ${lbl(m)} has not arrived` }));
  return r;
}
// sha256 (first 12 hex) of the tool files that ran, so every write records which code produced it
function toolSha() {
  const sha = (f) => { const p = path.join(__dirname, f); return fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12) : null; };
  return { sync: sha('sync.js'), statement: sha('statement.js'), engine: sha('engine.js'), engine2: sha('engine2.js'), at: new Date().toISOString() };
}
if (require.main === module) run().catch((e) => { console.error(e); process.exit(1); });
module.exports = { parseInvoices, applyInvoice, applyInvoiceEmail, applyStatement, monthlyPending, missingStatements, digest, drawdownCheck, lbl, toolSha, run, _state: () => ({ tx, assets, changed, settings, marks, log }), _reset };
