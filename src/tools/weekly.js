#!/usr/bin/env node
/* Weekly portfolio email: one EGX week of P/L for one portfolio, from a plain export folder (<coll>/<doc>.json), with the page's own engine.
     node weekly.js --data <export dir> [--overlay <plan dir>/write] [--week-ending YYYY-MM-DD] --out <email.html>
                    [--text <email.txt>] [--json <summary.json>] [--today YYYY-MM-DD]
   Week: the EGX sessions (Sun–Thu, Africa/Cairo) from the session after the previous week's last close through the
   week-ending date (default: the latest session day in the price history on or before today in Cairo). A Friday or
   Saturday week-ending means the Sun–Thu just before it. --today overrides the Cairo date (tests).
   P/L is counted exactly as the page's Daily P/L calendar (app2.js plShares / plMoves / plA):
     session P/L = value at its close − value at the previous close − deposits + withdrawals booked in between,
     values from PA.daily (ledger holdings × closing prices + ledger cash); a stock's contribution over the week =
     shares after × price after − shares before × price before + its own cash rows in between (PA.makePricer).
   Returns are daily-linked (Π(1 + session return) − 1); EGX30 Capped the same over the same sessions.
   Overlay files (a sync plan's write/ dir) replace the export's documents: ledger_yYYYY.json, marks.json, settings.json,
   assets_update.json (merged into assets), sync_state.json (sync/state, for the heads-up list); others are ignored.
   Prints ONE JSON line: {ok, subject, weekEnding, from, to, pnl, ret, bench, value, out, ...}. A week with no session that
   has closing prices prints {ok:false, error, ...} and exits 2; bad arguments exit 1. Sends nothing, writes only the
   files it is given. */
'use strict';
const fs = require('fs'), path = require('path');
const PE = require('./engine.js'), PA = require('./engine2.js');

const SITE_URL = 'https://khaledamin2001-lgtm.github.io/portfolio/';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const J = (f) => { const x = JSON.parse(fs.readFileSync(f)); return x.data || x; };
const opt = (f, d) => (fs.existsSync(f) ? J(f) : d);
const addDays = (d, k) => new Date(Date.parse(d + 'T00:00:00Z') + k * 864e5).toISOString().slice(0, 10);
const wday = (d) => new Date(d + 'T12:00:00Z').getUTCDay();
const dayLbl = (d) => `${+d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]}`;
const dayLblY = (d) => `${dayLbl(d)} ${d.slice(0, 4)}`;

// ---------- data ----------
function load(dir, overlay) {
  const D = (...p) => path.join(dir, ...p);
  if (!fs.existsSync(D('portfolio', 'settings.json'))) throw new Error(`${dir} is not an export directory (portfolio/settings.json missing)`);
  let settings = J(D('portfolio', 'settings.json')), marks = opt(D('portfolio', 'marks.json'), { months: {} }).months || {};
  let assets = opt(D('portfolio', 'assets.json'), { items: {} }).items || {};
  const ledgerDocs = {};
  if (fs.existsSync(D('ledger'))) fs.readdirSync(D('ledger')).filter((f) => /^y\d{4}\.json$/.test(f)).forEach((f) => { ledgerDocs[f.slice(1, 5)] = J(D('ledger', f)).rows || []; });
  const history = {};
  if (fs.existsSync(D('history'))) fs.readdirSync(D('history')).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).forEach((f) => { history[f.slice(0, 7)] = J(D('history', f)); });
  const market = opt(D('market', 'latest.json'), null), bench = opt(D('bench', 'egx30.json'), null);
  let state = opt(D('sync', 'state.json'), null);
  if (overlay && fs.existsSync(overlay)) for (const f of fs.readdirSync(overlay)) {
    let m; const v = () => J(path.join(overlay, f));
    if ((m = f.match(/^ledger_y(\d{4})\.json$/))) ledgerDocs[m[1]] = v().rows || [];
    else if (f === 'marks.json') marks = v().months || {};
    else if (f === 'settings.json') settings = v();
    else if (f === 'assets_update.json') assets = { ...assets, ...(v().items || {}) };
    else if (f === 'sync_state.json') state = v();
  }
  const tx = Object.keys(ledgerDocs).sort().flatMap((y) => ledgerDocs[y]);
  return { settings, marks, assets, tx, history, market, bench, state };
}

// ---------- the page's Daily P/L definitions (app2.js), without the page state ----------
function plShares(led, upTo) { const sh = {}; led.forEach((t) => { if (t.d <= upTo && t.a && (t.t === 'Buy' || t.t === 'Sell' || t.t === 'Bonus')) sh[t.a] = (sh[t.a] || 0) + (t.t === 'Sell' ? -1 : 1) * (t.q || 0); }); return sh; }
// value change of each asset between two closes, plus its own cash rows in between (plMoves, closes only)
function plMoves(ledger, assets, pb, from, to) {
  const price = PA.makePricer(assets, ledger, pb), led = PE.sortLedger(ledger);
  const sh0 = plShares(led, from), sh1 = plShares(led, to), out = {}; let other = 0, flow = 0; const unpriced = [];
  led.forEach((t) => { if (t.d > from && t.d <= to) { if (t.t === 'Deposit' || t.t === 'Withdrawal') { flow += t.amt || 0; return; } if (t.a) (out[t.a] || (out[t.a] = { cash: 0 })).cash += t.amt || 0; else other += t.amt || 0; } });
  new Set([...Object.keys(sh0), ...Object.keys(sh1), ...Object.keys(out)]).forEach((n) => {
    const a = sh0[n] || 0, b = sh1[n] || 0, o = out[n] || (out[n] = { cash: 0 });
    const p0 = a > 0.5 ? (price(n, from) || {}).p : null, p1 = b > 0.5 ? (price(n, to) || {}).p : null;
    if ((a > 0.5 && p0 == null) || (b > 0.5 && p1 == null)) { unpriced.push(n); o.v = o.cash; return; }
    o.v = (b > 0.5 ? b * p1 : 0) - (a > 0.5 ? a * p0 : 0) + o.cash; o.chg = (a > 0.5 && b > 0.5 && p0 > 0) ? p1 / p0 - 1 : null; o.held = a > 0.5 || b > 0.5; o.sh0 = a; o.sh1 = b;
  });
  return { items: Object.entries(out).map(([name, o]) => ({ name, symbol: (assets[name] || {}).symbol || '', v: o.v || 0, chg: o.chg ?? null, traded: Math.abs(o.cash) > 0.005, held: !!o.held, sh0: o.sh0 || 0, sh1: o.sh1 || 0 })), other, flow, unpriced, price };
}
// one row per session after the first (plA without the live row: the email is about closes only)
function plRows(D) {
  const rows = [];
  if (!D || D.rows.length < 2) return rows;
  D.rows.forEach((r, k) => { if (!k) return; const p = D.rows[k - 1]; rows.push({ d: r.d, prev: p.d, value: r.value, prevValue: p.value, flow: r.flow, pnl: r.value - p.value - r.flow, ret: r.ret, benchRet: r.benchRet }); });
  return rows;
}
const link = (rows) => rows.reduce((a, r) => a * (1 + (r.ret || 0)), 1) - 1;
const linkBench = (rows) => (rows.length && rows.every((r) => r.benchRet != null) ? rows.reduce((a, r) => a * (1 + r.benchRet), 1) - 1 : null);
const period = (rows) => (rows.length ? { from: rows[0].prev, to: rows[rows.length - 1].d, sessions: rows.length, pnl: rows.reduce((a, r) => a + r.pnl, 0), ret: link(rows), bench: linkBench(rows), valueStart: rows[0].prevValue, valueEnd: rows[rows.length - 1].value, flows: rows.reduce((a, r) => a + r.flow, 0) } : null);

// ---------- the week ----------
class NoSessions extends Error {}
function build(data, o) {
  o = o || {};
  const today = o.today || PE.cairoToday();
  const { settings, assets, tx, marks } = data;
  const pb = PA.priceBook(data.history || {});
  const ledger = PE.runLedger(tx);
  const D = pb.days.length ? PA.daily(settings, ledger, assets, pb, marks, today) : null;
  const rows = plRows(D);
  const W = o.weekEnding || pb.lastDayOnOrBefore(today);
  if (!W) throw new NoSessions(`no session day in the price history on or before ${today}`);
  const sun = addDays(W, -wday(W)), thu = addDays(sun, 4);
  const wrows = rows.filter((r) => r.d >= sun && r.d <= W);
  if (!wrows.length) { const e = new NoSessions(`no EGX session with closing prices between ${sun} and ${W}`); e.info = { weekEnding: W, weekFrom: sun, weekTo: W < thu ? W : thu, priceHistory: { first: pb.first, last: pb.last } }; throw e; }
  const week = period(wrows), from = week.from, to = week.to;
  const byDay = new Map(wrows.map((r) => [r.d, r]));
  const dayKeys = [...new Set([0, 1, 2, 3, 4].map((k) => addDays(sun, k)).concat(wrows.map((r) => r.d)))].sort();
  const days = dayKeys.map((d) => {
    const r = byDay.get(d);
    if (r) return { d, weekday: WD3[wday(d)], status: 'session', pnl: r.pnl, ret: r.ret, value: r.value, prevValue: r.prevValue, flow: r.flow, benchRet: r.benchRet };
    return { d, weekday: WD3[wday(d)], status: d > W || d > (pb.last || '') ? 'pending' : 'closed' };
  });
  const mtd = period(rows.filter((r) => r.d.slice(0, 7) === to.slice(0, 7) && r.d <= to));
  const ytd = period(rows.filter((r) => r.d.slice(0, 4) === to.slice(0, 4) && r.d <= to));

  // what moved it: stocks and funds (held, traded or a known asset) vs everything else (fees, rebates, unnamed rows)
  const mv = plMoves(ledger, assets, pb, from, to);
  const known = new Set(Object.values(assets).map((a) => a.name));
  const tradedNames = new Set(ledger.filter((t) => t.d > from && t.d <= to && t.a && (t.t === 'Buy' || t.t === 'Sell' || t.t === 'Bonus')).map((t) => t.a));
  const stocks = [], rest = [];
  mv.items.forEach((x) => {
    const isHolding = x.held || known.has(x.name) || tradedNames.has(x.name);
    if (!isHolding) { rest.push(x); return; }
    // price change over the week from market prices only (close, or gold-indexed proxy); a fund carried at its last
    // traded NAV has no market price move to show, even though its P/L (x.v) is counted exactly as on the page
    const p0 = mv.price(x.name, from), p1 = mv.price(x.name, to), mkt = (p) => p && (p.src === 'close' || p.src === 'proxy');
    stocks.push({ ...x, chg: mkt(p0) && mkt(p1) && p0.p > 0 ? p1.p / p0.p - 1 : null, chgHeld: x.chg != null });
  });
  const gainers = stocks.filter((x) => x.v >= 0.005).sort((a, b) => b.v - a.v).slice(0, 5);
  const losers = stocks.filter((x) => x.v <= -0.005).sort((a, b) => a.v - b.v).slice(0, 5);
  const shown = new Set([...gainers, ...losers]);
  const otherStocks = stocks.filter((x) => !shown.has(x));
  const other = otherStocks.reduce((a, x) => a + x.v, 0) + rest.reduce((a, x) => a + x.v, 0) + mv.other;
  const strip = (x) => ({ name: x.name, symbol: x.symbol, pnl: x.v, chg: x.chg, heldAllWeek: x.chgHeld, traded: x.traded, sharesBefore: x.sh0, sharesAfter: x.sh1 });

  // trades, income and flows booked in the week's window (same window as the P/L)
  const inWin = ledger.filter((t) => t.d > from && t.d <= to);
  const byName = {}; Object.values(assets).forEach((a) => { byName[a.name] = a; });
  const trades = inWin.filter((t) => t.t === 'Buy' || t.t === 'Sell').map((t) => ({ date: t.d, side: t.t, name: t.a || '', symbol: (byName[t.a] || {}).symbol || '', fund: t.acc === 'MF' || !!(byName[t.a] || {}).fund, shares: t.q ?? null, price: t.p ?? null, amount: t.amt || 0, cost: t.cost ?? null }));
  const income = inWin.filter((t) => t.t === 'Dividend' || t.t === 'Rebate' || t.t === 'Fee').map((t) => ({ date: t.d, type: t.t, name: t.a || '', symbol: (byName[t.a] || {}).symbol || '', amount: t.amt || 0 }));
  const deposits = inWin.filter((t) => t.t === 'Deposit').reduce((a, t) => a + (t.amt || 0), 0);
  const withdrawals = inWin.filter((t) => t.t === 'Withdrawal').reduce((a, t) => a + (t.amt || 0), 0);
  const headsUp = ((data.state && data.state.digest && data.state.digest.items) || []).filter((it) => it && it.text).map((it) => ({ kind: it.kind || '', key: it.key || '', text: String(it.text) }));

  const name = settings.name || 'Portfolio';
  const subject = `${name} · week to ${dayLbl(to)} · ${signed(week.pnl)} EGP (${pctS(week.ret)})`;
  return {
    ok: true, subject, name, portfolioId: settings.portfolioId || null, generated: today,
    weekEnding: W, weekFrom: sun, from, to,
    week: { ...week, deposits, withdrawals, netFlows: week.flows },
    days, mtd, ytd,
    movers: { gainers: gainers.map(strip), losers: losers.map(strip), other, otherCount: otherStocks.filter((x) => x.held || Math.abs(x.v) >= 0.005).length, unpriced: mv.unpriced, total: gainers.concat(losers).reduce((a, x) => a + x.v, 0) + other },
    trades, tradingCost: trades.reduce((a, t) => a + (t.cost || 0), 0), income, incomeTotal: income.reduce((a, t) => a + t.amount, 0),
    headsUp, siteUrl: SITE_URL,
  };
}

// ---------- formatting ----------
const nf = (dp) => new Intl.NumberFormat('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const MINUS = '−';
const money = (x, dp = 0) => (x == null || !isFinite(x) ? '—' : (x < 0 && Math.abs(x) >= 0.5 * 10 ** -dp ? MINUS : '') + nf(dp).format(Math.abs(x)));
function signed(x, dp = 0) { if (x == null || !isFinite(x)) return '—'; if (Math.abs(x) < 0.5 * 10 ** -dp) return nf(dp).format(0); return (x < 0 ? MINUS : '+') + nf(dp).format(Math.abs(x)); }
function pctS(x, dp = 2) { if (x == null || !isFinite(x)) return '—'; const v = x * 100; if (Math.abs(v) < 0.5 * 10 ** -dp) return nf(dp).format(0) + '%'; return (v < 0 ? MINUS : '+') + nf(dp).format(Math.abs(v)) + '%'; }
const qty = (x) => (x == null ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(x));
const px = (x) => (x == null ? '—' : new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(x));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stockLbl = (x) => (x.symbol ? `${x.symbol} · ${x.name}` : x.name);

// email palette: the site's (app.html :root, light) and every other email's (jobs/mail_html.py); mid-tone greens / reds that stay
// readable when Gmail's apps invert the page for dark mode
const C = { page: '#F2F2F7', card: '#FFFFFF', ink: '#1D1D1F', ink2: '#424245', mute: '#6E6E73', line: '#E5E5EA', soft: '#F5F5F7', pos: '#1A7F37', neg: '#D70015', posBg: '#E4F5E9', negBg: '#FDE9EB', accent: '#0071E3' };
const tone = (x, eps = 0.5) => (x == null || Math.abs(x) < eps ? C.ink : x > 0 ? C.pos : C.neg);
const toneR = (x) => (x == null || Math.abs(x) < 0.00005 ? C.ink : x > 0 ? C.pos : C.neg);
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function renderHTML(s) {
  const w = s.week;
  const td = (html, st = '') => `<td style="padding:8px 8px;border-top:1px solid ${C.line};font-size:14px;line-height:20px;color:${C.ink};${st}">${html}</td>`;
  const th = (html, st = '') => `<th style="padding:6px 8px;font-size:11px;line-height:16px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${C.mute};text-align:left;${st}">${html}</th>`;
  const num = 'text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums';
  const h2 = (t, sub) => `<tr><td class="wk-px" style="padding:22px 24px 8px"><div style="font-size:16px;line-height:22px;font-weight:700;color:${C.ink}">${t}</div>${sub ? `<div style="font-size:12px;line-height:18px;color:${C.mute}">${sub}</div>` : ''}</td></tr>`;
  const block = (inner) => `<tr><td class="wk-px" style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">${inner}</table></td></tr>`;
  const stockCell = (x) => `<span style="font-weight:700;color:${C.ink}">${esc(x.symbol || x.name)}</span>${x.symbol ? `<br><span style="font-size:12px;line-height:16px;color:${C.mute}">${esc(x.name)}${x.traded ? ' · traded' : ''}</span>` : x.traded ? `<br><span style="font-size:12px;color:${C.mute}">traded</span>` : ''}`;
  const moverRows = (list) => list.map((x) => `<tr>${td(stockCell(x))}${td(`<span style="color:${toneR(x.chg)}">${pctS(x.chg)}</span>`, num)}${td(`<span style="color:${tone(x.pnl)};font-weight:600">${signed(x.pnl)}</span>`, num)}</tr>`).join('');
  const kpi = (label, value, sub) => `<td valign="top" style="padding:12px 14px;background:${C.soft};border-radius:12px"><div style="font-size:11px;line-height:16px;letter-spacing:.04em;text-transform:uppercase;color:${C.mute}">${label}</div><div style="font-size:17px;line-height:24px;font-weight:700;color:${C.ink};white-space:nowrap">${value}</div>${sub ? `<div style="font-size:12px;line-height:16px;color:${C.mute}">${sub}</div>` : ''}</td>`;
  const flowTxt = Math.abs(w.netFlows) >= 0.5 ? `${w.netFlows > 0 ? 'Net deposits' : 'Net withdrawals'} ${money(Math.abs(w.netFlows))} EGP${w.deposits && w.withdrawals ? ` (in ${money(w.deposits)}, out ${money(-w.withdrawals)})` : ''}` : 'No deposits or withdrawals';
  const alpha = w.bench != null ? w.ret - w.bench : null;
  const sessionsTxt = `${w.sessions} session${w.sessions === 1 ? '' : 's'}, ${dayLbl(s.days.find((d) => d.status === 'session').d)}–${dayLbl(s.to)} · previous close ${dayLbl(s.from)}`;

  // day row: Sun..Thu, one cell each
  const dayCells = s.days.map((d) => {
    const head = `<div style="font-size:11px;line-height:15px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${C.mute}">${d.weekday}</div><div style="font-size:12px;line-height:16px;color:${C.mute}">${dayLbl(d.d)}</div>`;
    if (d.status !== 'session') return `<td width="20%" valign="top" style="padding:8px 2px;text-align:center;background:${C.soft};border:1px solid ${C.card};border-radius:12px">${head}<div style="font-size:13px;line-height:20px;color:${C.mute};padding-top:4px">${d.status === 'closed' ? 'Closed' : '—'}</div><div style="font-size:12px;line-height:16px">&nbsp;</div></td>`;
    const bg = Math.abs(d.pnl) < 0.5 ? C.soft : d.pnl > 0 ? C.posBg : C.negBg;
    return `<td width="20%" valign="top" style="padding:8px 2px;text-align:center;background:${bg};border:1px solid ${C.card};border-radius:12px">${head}<div class="wk-day" style="font-size:14px;line-height:20px;font-weight:700;color:${tone(d.pnl)};padding-top:4px;white-space:nowrap">${signed(d.pnl)}</div><div style="font-size:12px;line-height:16px;color:${toneR(d.ret)};white-space:nowrap">${pctS(d.ret)}</div>${Math.abs(d.flow) >= 0.5 ? `<div style="font-size:11px;line-height:14px;color:${C.mute}">${d.flow > 0 ? 'dep' : 'wdr'} ${money(Math.abs(d.flow))}</div>` : ''}</td>`;
  }).join('');

  const perRow = (label, p) => (p ? `<tr>${td(`${label}<br><span style="font-size:12px;color:${C.mute}">since ${dayLbl(p.from)} close · ${p.sessions} session${p.sessions === 1 ? '' : 's'}</span>`)}${td(`<span style="color:${toneR(p.ret)};font-weight:600">${pctS(p.ret)}</span>`, num)}${td(`<span style="color:${toneR(p.bench)}">${pctS(p.bench)}</span>`, num)}${td(`<span style="color:${tone(p.pnl)}">${signed(p.pnl)}</span>`, num)}</tr>` : '');

  const M = s.movers;
  const moversHtml = (M.gainers.length || M.losers.length)
    ? block(`<tr>${th('Stock')}${th('Price, week', 'text-align:right')}${th('P/L (EGP)', 'text-align:right')}</tr>
      ${M.gainers.length ? `<tr><td colspan="3" style="padding:12px 10px 4px;font-size:12px;font-weight:700;color:${C.pos}">Top gainers</td></tr>${moverRows(M.gainers)}` : ''}
      ${M.losers.length ? `<tr><td colspan="3" style="padding:12px 10px 4px;font-size:12px;font-weight:700;color:${C.neg}">Top losers</td></tr>${moverRows(M.losers)}` : ''}
      <tr>${td(`<span style="color:${C.ink2}">Everything else</span><br><span style="font-size:12px;color:${C.mute}">${M.otherCount ? `${M.otherCount} other holding${M.otherCount === 1 ? '' : 's'}, ` : ''}fees, rebates and other cash</span>`)}${td('—', num + `;color:${C.mute}`)}${td(`<span style="color:${tone(M.other)}">${signed(M.other)}</span>`, num)}</tr>
      <tr>${td('<b>Week P/L</b>', 'border-top:2px solid ' + C.ink)}${td('', 'border-top:2px solid ' + C.ink)}${td(`<b style="color:${tone(w.pnl)}">${signed(w.pnl)}</b>`, num + ';border-top:2px solid ' + C.ink)}</tr>`)
      + (M.unpriced.length ? `<tr><td class="wk-px" style="padding:6px 24px 0;font-size:12px;color:${C.mute}">No price for ${esc(M.unpriced.join(', '))}; its cash rows are counted, its price move is not.</td></tr>` : '')
    : `<tr><td class="wk-px" style="padding:0 24px;font-size:14px;color:${C.mute}">Nothing you held changed in value this week.</td></tr>`;

  const tradesHtml = s.trades.length
    ? block(`<tr>${th('Date')}${th('Trade')}${th('Shares × price', 'text-align:right')}${th('Amount (EGP)', 'text-align:right')}</tr>
      ${s.trades.map((t) => `<tr>${td(`<span style="white-space:nowrap">${dayLbl(t.date)}</span>`, 'padding-right:4px')}${td(`<span style="font-weight:700;color:${t.side === 'Buy' ? C.accent : C.ink}">${t.side}</span> ${esc(t.symbol || t.name)}${t.symbol ? `<br><span style="font-size:12px;color:${C.mute}">${esc(t.name)}</span>` : ''}`)}${td(`<span style="white-space:nowrap">${qty(t.shares)} ×</span> <span style="white-space:nowrap">${px(t.price)}</span>${t.cost != null ? `<br><span style="font-size:12px;color:${C.mute};white-space:nowrap">cost ${money(t.cost, 2)}</span>` : ''}`, 'text-align:right;font-variant-numeric:tabular-nums')}${td(signed(t.amount, 2), num)}</tr>`).join('')}
      <tr><td colspan="4" style="padding:8px 10px;border-top:2px solid ${C.ink};font-size:14px;line-height:20px;color:${C.ink}"><b>${s.trades.length} trade${s.trades.length === 1 ? '' : 's'}</b> · trading costs <b>${money(s.tradingCost, 2)} EGP</b></td></tr>`)
      + `<tr><td class="wk-px" style="padding:6px 24px 0;font-size:12px;line-height:17px;color:${C.mute}">Amount is the cash that moved (buys negative). Trading costs are commission and exchange fees on stock trades (amount vs shares × price); fund trades carry none.</td></tr>`
    : `<tr><td class="wk-px" style="padding:0 24px;font-size:14px;color:${C.mute}">No trades this week.</td></tr>`;

  const incomeHtml = s.income.length
    ? block(`<tr>${th('Date')}${th('Type')}${th('Amount (EGP)', 'text-align:right')}</tr>
      ${s.income.map((t) => `<tr>${td(`<span style="white-space:nowrap">${dayLbl(t.date)}</span>`)}${td(`${t.type}${t.name ? ` · ${esc(t.symbol || t.name)}` : ''}`)}${td(`<span style="color:${tone(t.amount, 0.005)}">${signed(t.amount, 2)}</span>`, num)}</tr>`).join('')}
      <tr>${td('<b>Net</b>', 'border-top:2px solid ' + C.ink)}${td('', 'border-top:2px solid ' + C.ink)}${td(`<b style="color:${tone(s.incomeTotal, 0.005)}">${signed(s.incomeTotal, 2)}</b>`, num + ';border-top:2px solid ' + C.ink)}</tr>`)
    : `<tr><td class="wk-px" style="padding:0 24px;font-size:14px;color:${C.mute}">No dividends, rebates or fees this week.</td></tr>`;

  const headsHtml = s.headsUp.length
    ? h2('Heads-up') + `<tr><td class="wk-px" style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;background:#FFF7E6;border-left:4px solid #B7791F">${s.headsUp.map((it) => `<tr><td style="padding:8px 12px;font-size:14px;line-height:20px;color:${C.ink}">${esc(it.text)}</td></tr>`).join('')}</table></td></tr>`
    : '';

  const pre = `Week P/L ${signed(w.pnl)} EGP (${pctS(w.ret)}) · EGX30 Capped ${pctS(w.bench)} · value ${money(w.valueEnd)} EGP`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style>@media only screen and (max-width:480px){.wk-outer{padding:8px 0!important}.wk-px{padding-left:14px!important;padding-right:14px!important}.wk-kpi{padding-left:8px!important;padding-right:8px!important}.wk-days{padding-left:6px!important;padding-right:6px!important}.wk-day{font-size:13px!important}}</style><title>${esc(s.subject)}</title></head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page}">${esc(pre)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};width:100%"><tr><td class="wk-outer" align="center" style="padding:16px 8px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:${C.card};border:1px solid ${C.line};border-radius:18px;border-collapse:separate;font-family:${FONT};color:${C.ink}" data-testid="weekly-email">
<tr><td class="wk-px" style="padding:24px 24px 4px;border-bottom:1px solid ${C.line};border-radius:18px 18px 0 0">
  <div style="font-size:12px;line-height:16px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${C.accent}">${esc(s.name)}</div>
  <div style="font-size:24px;line-height:30px;font-weight:700;letter-spacing:-.02em;color:${C.ink}">Week to ${dayLblY(s.to)}</div>
  <div style="font-size:12px;line-height:18px;color:${C.mute};padding-bottom:12px">${sessionsTxt} · EGX closing prices</div>
</td></tr>
<tr><td class="wk-px" style="padding:18px 24px 6px" data-testid="weekly-headline">
  <div style="font-size:12px;line-height:16px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${C.mute}">Profit / loss this week</div>
  <div style="font-size:32px;line-height:40px;font-weight:800;color:${tone(w.pnl)};white-space:nowrap">${signed(w.pnl)} <span style="font-size:15px;font-weight:600;color:${C.mute}">EGP</span></div>
  <div style="font-size:15px;line-height:22px;color:${C.ink2}"><b style="color:${toneR(w.ret)}">${pctS(w.ret)}</b> this week · EGX30 Capped <b style="color:${toneR(w.bench)}">${pctS(w.bench)}</b>${alpha != null ? ` · <span style="white-space:nowrap">${alpha >= 0 ? 'ahead' : 'behind'} by ${nf(2).format(Math.abs(alpha) * 100)} pts</span>` : ''}</div>
</td></tr>
<tr><td class="wk-kpi" style="padding:10px 18px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="6" border="0" style="width:100%;border-collapse:separate"><tr>
  ${kpi(`Value at close ${dayLbl(s.to)}`, `${money(w.valueEnd)} <span style="font-size:12px;font-weight:600;color:${C.mute}">EGP</span>`, `week began at ${money(w.valueStart)}`)}
  ${kpi('Deposits / withdrawals', Math.abs(w.netFlows) >= 0.5 ? `${signed(w.netFlows)} <span style="font-size:12px;font-weight:600;color:${C.mute}">EGP</span>` : 'None', Math.abs(w.netFlows) >= 0.5 ? 'not counted as P/L' : 'this week')}
</tr></table></td></tr>
${h2('Day by day', 'P/L at each session close, EGP and %')}
<tr><td class="wk-days" style="padding:0 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;table-layout:fixed" data-testid="weekly-days"><tr>${dayCells}</tr></table></td></tr>
${h2('Month and year to date', 'Daily-linked returns, same sessions for the index')}
${block(`<tr>${th('Period')}${th('Portfolio', 'text-align:right')}${th('EGX30 Capped', 'text-align:right')}${th('P/L (EGP)', 'text-align:right')}</tr>${perRow('This week', w)}${perRow(`${MON[+s.to.slice(5, 7) - 1]} to date`, s.mtd)}${perRow(`${s.to.slice(0, 4)} to date`, s.ytd)}`)}
${h2('What moved it', `Each holding's value change over the week, including its own buys, sells and dividends`)}
${moversHtml}
${h2('Trades this week')}
${tradesHtml}
${h2('Dividends, rebates and fees')}
${incomeHtml}
${headsHtml}
<tr><td class="wk-px" style="padding:24px 24px 20px"><div style="border-top:1px solid ${C.line};padding-top:14px;font-size:13px;line-height:20px;color:${C.ink2}">Open the Daily P/L calendar: <a href="${esc(s.siteUrl)}" style="color:${C.accent};font-weight:600">${esc(s.siteUrl)}</a> → Performance → Daily P/L</div>
  <div style="padding-top:8px;font-size:12px;line-height:18px;color:${C.mute}">How P/L is counted: each session's P/L is the portfolio's value at that close (holdings × EGX closing prices + cash, from the ledger) minus its value at the previous close, minus deposits plus withdrawals booked in between, so money moved in or out is never a gain or loss. The week's % links the daily returns. Funds without a market quote are carried at their last traded NAV. ${esc(flowTxt)} this week.</div></td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function renderText(s) {
  const w = s.week, L = [];
  const pad = (a, n) => String(a).padEnd(n), lpad = (a, n) => String(a).padStart(n);
  L.push(`${s.name} — week to ${dayLblY(s.to)}`, '');
  L.push(`Profit / loss this week: ${signed(w.pnl)} EGP (${pctS(w.ret)})`);
  L.push(`EGX30 Capped: ${pctS(w.bench)}${w.bench != null ? ` (${w.ret - w.bench >= 0 ? 'ahead' : 'behind'} by ${nf(2).format(Math.abs(w.ret - w.bench) * 100)} pts)` : ''}`);
  L.push(`Value at close ${dayLbl(s.to)}: ${money(w.valueEnd)} EGP (week began at ${money(w.valueStart)}, close of ${dayLbl(s.from)})`);
  L.push(Math.abs(w.netFlows) >= 0.5 ? `${w.netFlows > 0 ? 'Net deposits' : 'Net withdrawals'}: ${money(Math.abs(w.netFlows))} EGP (not counted as P/L)` : 'Deposits / withdrawals: none this week');
  L.push('', 'DAY BY DAY');
  s.days.forEach((d) => L.push(d.status === 'session' ? `  ${d.weekday} ${pad(dayLbl(d.d), 7)} ${lpad(signed(d.pnl), 10)} EGP  ${lpad(pctS(d.ret), 8)}${Math.abs(d.flow) >= 0.5 ? `  (${d.flow > 0 ? 'deposit' : 'withdrawal'} ${money(Math.abs(d.flow))})` : ''}` : `  ${d.weekday} ${pad(dayLbl(d.d), 7)} ${lpad(d.status === 'closed' ? 'Closed' : '—', 10)}`));
  L.push('', 'MONTH AND YEAR TO DATE (daily-linked)');
  const per = (label, p) => p && L.push(`  ${pad(label, 13)} portfolio ${lpad(pctS(p.ret), 8)} · EGX30 Capped ${lpad(pctS(p.bench), 8)} · P/L ${signed(p.pnl)} EGP`);
  per('This week', w); per(`${MON[+s.to.slice(5, 7) - 1]} to date`, s.mtd); per(`${s.to.slice(0, 4)} to date`, s.ytd);
  L.push('', 'WHAT MOVED IT (P/L over the week, EGP; price change over the week)');
  const M = s.movers;
  const mrow = (x) => L.push(`  ${pad(stockLbl(x).slice(0, 40), 40)} ${lpad(pctS(x.chg), 8)} ${lpad(signed(x.pnl), 10)}${x.traded ? '  (traded)' : ''}`);
  if (M.gainers.length) { L.push('  Top gainers'); M.gainers.forEach(mrow); }
  if (M.losers.length) { L.push('  Top losers'); M.losers.forEach(mrow); }
  L.push(`  ${pad(`Everything else${M.otherCount ? ` (${M.otherCount} other holdings, fees, rebates)` : ' (fees, rebates, other cash)'}`, 49)} ${lpad(signed(M.other), 10)}`);
  L.push(`  ${pad('Week P/L', 49)} ${lpad(signed(w.pnl), 10)}`);
  if (M.unpriced.length) L.push(`  No price for ${M.unpriced.join(', ')}; its price move is left out.`);
  L.push('', 'TRADES THIS WEEK');
  if (!s.trades.length) L.push('  None.');
  s.trades.forEach((t) => L.push(`  ${WD3[wday(t.date)]} ${pad(dayLbl(t.date), 7)} ${pad(t.side, 4)} ${pad((t.symbol ? `${t.symbol} (${t.name})` : t.name).slice(0, 36), 36)} ${qty(t.shares)} × ${px(t.price)} = ${signed(t.amount, 2)} EGP${t.cost != null ? ` (cost ${money(t.cost, 2)})` : ''}`));
  if (s.trades.length) L.push(`  Trading costs: ${money(s.tradingCost, 2)} EGP`);
  L.push('', 'DIVIDENDS, REBATES AND FEES');
  if (!s.income.length) L.push('  None.');
  s.income.forEach((t) => L.push(`  ${pad(dayLbl(t.date), 7)} ${pad(t.type, 8)} ${pad((t.symbol || t.name).slice(0, 36), 36)} ${lpad(signed(t.amount, 2), 12)} EGP`));
  if (s.income.length) L.push(`  Net: ${signed(s.incomeTotal, 2)} EGP`);
  if (s.headsUp.length) { L.push('', 'HEADS-UP'); s.headsUp.forEach((it) => L.push(`  - ${it.text}`)); }
  L.push('', `Open the Daily P/L calendar: ${s.siteUrl} → Performance → Daily P/L`);
  L.push("How P/L is counted: each session's P/L is the value at that close (holdings × EGX closing prices + cash, from the ledger) minus the previous close's value, minus deposits plus withdrawals booked in between. The week's % links the daily returns.");
  return L.join('\n') + '\n';
}

// JSON summary: money to the piaster, returns to 1e-8
function forJson(s) {
  const r = (k, v) => (typeof v === 'number' ? (/^(ret|bench|chg)$/.test(k) ? Math.round(v * 1e8) / 1e8 : Math.round(v * 100) / 100) : v);
  const keepRaw = new Set(['shares', 'price', 'sharesBefore', 'sharesAfter', 'sessions', 'otherCount']);
  return JSON.parse(JSON.stringify(s, (k, v) => (keepRaw.has(k) ? v : r(k, v))));
}

function main() {
  const argv = process.argv.slice(2), args = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2), v = argv[i + 1]; args[k] = v != null && !v.startsWith('--') ? (i++, v) : true; }
  const fail = (code, o) => { console.log(JSON.stringify({ ok: false, ...o })); process.exit(code); };
  if (typeof args.data !== 'string') fail(1, { error: 'give --data <export folder>' });
  if (typeof args.out !== 'string') fail(1, { error: 'give --out <email.html>' });
  for (const k of ['week-ending', 'today']) if (args[k] != null && !(typeof args[k] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args[k]) && !isNaN(Date.parse(args[k])))) fail(1, { error: `--${k} must be YYYY-MM-DD` });
  let s;
  try { s = build(load(args.data, typeof args.overlay === 'string' ? args.overlay : null), { weekEnding: args['week-ending'], today: args.today }); }
  catch (e) { if (e instanceof NoSessions) fail(2, { error: e.message, ...(e.info || {}) }); fail(1, { error: e.message || String(e) }); }
  const html = renderHTML(s);
  fs.writeFileSync(args.out, html);
  if (typeof args.text === 'string') fs.writeFileSync(args.text, renderText(s));
  if (typeof args.json === 'string') fs.writeFileSync(args.json, JSON.stringify(forJson(s), null, 1));
  const w = s.week;
  console.log(JSON.stringify(forJson({ ok: true, subject: s.subject, weekEnding: s.weekEnding, from: s.from, to: s.to, sessions: w.sessions, pnl: w.pnl, ret: w.ret, bench: w.bench, value: w.valueEnd, netFlows: w.netFlows, trades: s.trades.length, headsUp: s.headsUp.length, out: args.out, bytes: html.length, text: args.text || null, json: args.json || null })));
}
if (require.main === module) main();
module.exports = { load, build, renderHTML, renderText, forJson, plShares, plMoves, plRows, NoSessions };
