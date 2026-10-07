#!/usr/bin/env node
/* The model checks (Settings → Checks) that tell a real problem from how Thndr books things, on made-up data:
   - cash dipping below zero inside a month (a purchase booked before the money that paid for it) is fine; a month that
     ENDS below zero is a warning;
   - an estimated closed month is fine when its full statement was posted without a holdings list, or when it ended only
     days ago (the monthly statement is still to come); otherwise a warning;
   - a trade price is compared with the day's range (previous close to close), so a trade on a big-move day passes, a
     typo does not, and a statement's price on a stock's first day of trading stands;
   - rows typed by hand in a statement month: a fund row checked against a statement's fund page, or a savings / money-market
     fund row in a month whose cash matches the statement, counts as confirmed; any other typed row does not.
   node src/tests/test_checks.js      exit 0 = all checks passed */
'use strict';
const path = require('path');
const PE = require(path.join(__dirname, '..', 'engine.js')); global.PE = PE;
const PA = require(path.join(__dirname, '..', 'engine2.js'));
let fail = 0;
const check = (name, ok, detail) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail != null ? ' · ' + detail : '')); if (!ok) fail++; };
const settings = { inception: '2026-01', openingValue: 0, riskFree: 0.2, volLow: 0.03, volHigh: 0.08, staleDays: 7, openThreshold: 0.5, fxStart: 50 };
const run = (tx, marks, today, assets) => PE.run({ settings, marks, assets: assets || {}, tx }, { type: 'Since Inception' }, { today, live: false });
const find = (R, label) => R.checks.find((c) => c.label === label) || {};

// ---- cash below zero ----
const dip = [{ id: 'a', d: '2026-01-05', t: 'Deposit', amt: 1000, src: 'stmt-2026-01' }, { id: 'b', d: '2026-01-10', t: 'Fee', amt: -1200, src: 'stmt-2026-01' }, { id: 'c', d: '2026-01-12', t: 'Deposit', amt: 500, src: 'stmt-2026-01' }];
const marks1 = { '2026-01': { cash: 300, securities: 0, source: 'statement' } };
let c = find(run(dip, marks1, '2026-02-10'), 'Ledger cash never negative');
check('a dip below zero inside a month that ends above zero is fine, and says so', c.status === 'ok' && /dips below zero inside a month on 1 day/.test(c.detail), c.detail);
c = find(run(dip.slice(0, 2), { '2026-01': { cash: -200, securities: 0, source: 'statement' } }, '2026-02-10'), 'Ledger cash never negative');
check('a month that ends below zero is a warning (a deposit or sale is probably missing)', c.status === 'warn' && /Jan-26 ends below zero/.test(c.detail), c.detail);

// ---- estimated closed months ----
const est = { cash: 300, securities: 0, source: 'price-estimate', estimate: true, provisional: true };
c = find(run(dip.map((t) => ({ ...t, src: 'stmt-partial-2026-01-31' })), { '2026-01': est }, '2026-06-10'), 'Closed months confirmed by Thndr statements');
check('an estimated month whose full statement had no holdings list is fine', c.status === 'ok' && /cash from the statement, holdings at closing prices/.test(c.detail), c.detail);
c = find(run(dip.map((t) => ({ ...t, src: 'stmt-partial-2026-01-20' })), { '2026-01': est }, '2026-02-10'), 'Closed months confirmed by Thndr statements');
check('an estimated month that ended 10 days ago waits for the monthly statement (fine)', c.status === 'ok' && /until Thndr's monthly statement arrives/.test(c.detail), c.detail);
c = find(run(dip.map((t) => ({ ...t, src: 'stmt-partial-2026-01-20' })), { '2026-01': est }, '2026-04-10'), 'Closed months confirmed by Thndr statements');
check('an estimated month with no statement long after it ended is a warning', c.status === 'warn' && /no statement posted: Jan-26/.test(c.detail), c.detail);

// ---- trade prices against the day's range ----
const assets = { Acme: { name: 'Acme', symbol: 'ACME', sector: 'Banks' }, Newco: { name: 'Newco', symbol: 'NEWC', sector: 'Banks' } };
const pb = PA.priceBook({ '2026-03': { days: { '2026-03-01': { ACME: 50, EGX30CAPPED: 1 }, '2026-03-02': { ACME: 60, NEWC: 9.66, EGX30CAPPED: 1 } } } });
const tc = (rows) => PA.tradeChecks(rows, assets, pb, []).find((x) => x.label === 'Trade prices agree with closing prices');
c = tc([{ d: '2026-03-02', t: 'Buy', a: 'Acme', p: 55.6, q: 1, src: 'stmt-2026-03' }]);
check('a trade inside a +20% day (previous close 50, close 60) passes', c.status === 'ok', c.detail);
c = tc([{ d: '2026-03-02', t: 'Buy', a: 'Acme', p: 70, q: 1 }]);
check('a typed price well outside the day\'s range is flagged', c.status === 'warn' && /ACME 2026-03-02: traded 70 vs previous close 50, close 60/.test(c.detail), c.detail);
c = tc([{ d: '2026-03-02', t: 'Buy', a: 'Newco', p: 8.61, q: 1, src: 'stmt-2026-03' }]);
check('a statement price on the stock\'s first day of trading (an IPO allotment) stands', c.status === 'ok', c.detail);
c = tc([{ d: '2026-03-02', t: 'Buy', a: 'Newco', p: 8.61, q: 1 }]);
check('the same price typed by hand is still checked against the close', c.status === 'warn', c.detail);

// ---- rows typed by hand in a statement month ----
const fa = { Saver: { name: 'Saver', sector: 'Cash & Savings', fund: true }, Acme: assets.Acme, Mm: { name: 'Mm', sector: 'Mutual Funds', fund: true } };
const rows = [
  { id: 'd', d: '2026-02-01', t: 'Deposit', amt: 1000, src: 'stmt-2026-02' },
  { id: 'f1', d: '2026-02-03', t: 'Buy', a: 'Saver', q: 500, p: 1, amt: -500 },
  { id: 'f2', d: '2026-02-05', t: 'Sell', a: 'Saver', q: 500, p: 1, amt: 500 },
  { id: 'm1', d: '2026-02-06', t: 'Buy', a: 'Mm', q: 10, p: 10, amt: -100, note: 'checked against the Thndr Feb-26 statement' },
  { id: 's1', d: '2026-02-07', t: 'Buy', a: 'Acme', q: 1, p: 50, amt: -50 },
];
let R = run(rows, { '2026-02': { cash: 850, securities: 150, source: 'statement' } }, '2026-03-10', fa);
check('typed: a savings-fund row in a month whose cash matches the statement and a fund row checked against a statement are confirmed; a typed stock row is not', JSON.stringify(R.provenance.unverified) === '["s1"]', JSON.stringify(R.provenance.unverified));
R = run(rows, { '2026-02': { cash: 900, securities: 150, source: 'statement' } }, '2026-03-10', fa);
check('when the month\'s cash does not match the statement, the savings-fund rows are not confirmed either', JSON.stringify(R.provenance.unverified) === '["f1","f2","s1"]', JSON.stringify(R.provenance.unverified));
// ---- corporate actions: only free shares need a Bonus row; a detected one says it is unconfirmed ----
{
  const held = [{ id: 'b', d: '2026-03-01', t: 'Buy', a: 'Acme', q: 100, p: 50, amt: -5000, acc: 'Main' }];
  const bc = (kind) => PA.tradeChecks(held, assets, pb, [{ s: 'ACME', date: '2026-03-02', ratio: 1.5, kind }]).find((x) => x.label === 'Bonus shares booked');
  check('a bonus with no Bonus row is a warning', bc('bonus').status === 'warn' && /bonus of about 50 shares/.test(bc('bonus').detail), bc('bonus').detail);
  check('a rights issue needs no Bonus row', bc('rights').status === 'ok', bc('rights').detail);
  check('a detected action is a warning that says it is not confirmed', bc('detected').status === 'warn' && /not confirmed yet/.test(bc('detected').detail), bc('detected').detail);
}

// a bonus issue's ex-day: the quote's change is per share against the pre-bonus close; the holding's day change is not
{
  const led = [{ id: 'b', d: '2026-09-10', t: 'Buy', a: 'Dev Co', q: 1000, p: 8, amt: -8000, acc: 'Main' },
    { id: 'x', d: '2026-10-07', t: 'Bonus', a: 'Dev Co', q: 2228, amt: 0, acc: 'Main' }];
  const pos = (date, chg) => PE.positions(led, [{ name: 'Dev Co', symbol: 'DEV' }], { quotes: { DEV: { price: 12, date, chg } } }, {}, date, null).open[0];
  let r = pos('2026-10-07', (12 / 38.84 - 1) * 100);
  const pl = r.mv - r.mv / (1 + r.chg / 100);
  check('bonus ex-day: the day change compares today\'s shares × price with yesterday\'s shares × close', Math.abs(pl - (3228 * 12 - 1000 * 38.84)) < 0.01, `${r.chg} ${pl}`);
  r = pos('2026-10-08', 1.5);
  check('the day after: the quote\'s own change again', r.chg === 1.5);
}
console.log(fail ? `FAIL ${fail}` : 'ALL PASS');
process.exit(fail ? 1 : 0);
