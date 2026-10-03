/* Thndr statement reading and matching (src/statement.js, via src/tools/sync.js), on made-up figures:
     1. a statement row is matched to the right ledger row: one inside the statement's own dates first, and never a row
        an earlier statement already posted (a 29 Aug deposit is not September's 2 Sep deposit of the same amount);
     2. the brokerage cash statement and the mutual-fund statement are told apart in a quiet month (no deposits, trades
        or transfers to score them by), whatever order the PDFs come in.
     node src/tests/test_statement.js   (exit 1 on any failure) */
'use strict';
const S = require('../tools/sync.js'), TS = require('../statement.js');
let fail = 0;
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail == null ? '' : ' · ' + detail)); if (!ok) fail++; };

// 1. September's statement: a 10,000 deposit on 2 Sep; the ledger already has August's 10,000 deposit of 29 Aug (posted)
const sept = (ledgerHasIt) => {
  const tx = [{ id: 'a', d: '2026-07-01', t: 'Deposit', amt: 50000, acc: 'Main' },
    { id: 'b', d: '2026-08-29', t: 'Deposit', amt: 10000, acc: 'Main', src: 'stmt-2026-08' }]
    .concat(ledgerHasIt ? [{ id: 'c', d: '2026-09-02', t: 'Deposit', amt: 10000, acc: 'Main' }] : []);
  S._reset(tx, {}, { account: { holder: 'x' } }, { marks: { '2026-08': { cash: 60000, securities: 0, provisional: false, source: 'statement' } }, imports: { '2026-08': { fullMonth: true } } });   // private-scan: synthetic
  const st = { from: '2026-09-01', to: '2026-09-30', month: '2026-09', fullMonth: true, mf: null, snapshot: { holdings: [], total: 0 },
    cash: { start: 60000, end: 70000, rows: [{ date: '2026-09-02', desc: 'Deposit', value: 10000, balance: 70000, raw: '2/9/2026 Deposit 10,000.00 70,000.00' }] } };   // private-scan: synthetic
  const entry = { changes: [], reasons: [], notes: [], unchanged: 0 };
  return { status: S.applyStatement(st, entry, { id: 'm1' }), entry, tx: S._state().tx };
};
let r = sept(false);
check('a deposit the ledger lacks is added, not matched to the previous month\'s posted deposit of the same amount',
  r.status === 'applied' && r.entry.changes.some((c) => /added .*2026-09-02 Deposit 10,000\.00/.test(c)) && !r.entry.reasons.length, JSON.stringify(r.entry));
r = sept(true);
check('a deposit the ledger already has is matched to it (the August one is left alone, nothing removed)',
  r.status === 'applied' && !r.entry.changes.some((c) => /^(added|removed)/.test(c)) && r.tx.some((t) => t.id === 'b') && r.tx.some((t) => t.id === 'c'), JSON.stringify(r.entry));

// 2. a quiet month: both statements have only a header, no rows
const hdr = (title, start, end) => ['Thndr Securities Brokerage', title, 'Client Name Test Friend Unified Code 1234567', 'From 1/9/2026 To 30/9/2026', `Start Balance ${start}`, 'Date Description Value Balance', `End Balance ${end}`];   // private-scan: synthetic
const mf = { filename: 'mf-statement.pdf', lines: hdr('Mutual Funds Account Statement', '0.00', '0.00') };
const cash = { filename: 'account-statement.pdf', lines: hdr('Account Statement', '12,345.67', '12,345.67') };   // private-scan: synthetic
for (const [label, order] of [['cash first', [cash, mf]], ['fund statement first', [mf, cash]]]) {
  const st = TS.parseStatement(order);
  check(`a quiet month, ${label}: the cash account is the brokerage statement`, st.cash && st.cash.end === 12345.67 && st.mf && st.mf.end === 0, JSON.stringify([st.cash && st.cash.end, st.mf && st.mf.end]));   // private-scan: synthetic
}

// 3. invoices: the ISIN gives the ticker (market/latest quotes carry TradingView's isin), no wait for the next statement
{
  const market = { quotes: { COMI: { price: 100, isin: 'EGS60121C018', sector: 'Financial Services' }, ISPH: { price: 3, isin: 'EGS512O1C012' } } };
  const bench = { members: [{ s: 'COMI', sector: 'Banks' }] };
  const inv = (name, code) => ({ d: '2026-09-30', type: 'Buy', name, code, qty: 10, gross: 1000, total: 1002, fund: false });
  const E = () => ({ changes: [], reasons: [], notes: [], unchanged: 0 });
  S._reset([], {}, {}, { market, bench });
  let e = E(); S.applyInvoice(inv('Commercial International Bank (Egypt)', 'EGS60121C018'), e);
  let a = S._state().assets['Commercial International Bank (Egypt)'];
  check('a new stock from an invoice gets its ticker and sector from the ISIN', a && a.symbol === 'COMI' && a.isin === 'EGS60121C018' && a.sector === 'Banks' && /\(COMI\)/.test(e.notes.join()), JSON.stringify([a, e.notes]));
  S._reset([], { CIB: { name: 'CIB', symbol: 'COMI', sector: 'Banks' } }, {}, { market, bench });
  e = E(); S.applyInvoice(inv('Commercial International Bank (Egypt)', 'EGS60121C018'), e);
  check('an invoice for a stock already held under its ticker books to that asset (no duplicate)', S._state().tx[0].a === 'CIB' && Object.keys(S._state().assets).length === 1, JSON.stringify(S._state()));
  S._reset([], {}, {}, { market, bench });
  e = E(); S.applyInvoice(inv('Unknown Co', 'EGS00000X000'), e);
  a = S._state().assets['Unknown Co'];
  check('an ISIN not in the market data: the stock waits for the statement, its ISIN kept', a && !a.symbol && a.isin === 'EGS00000X000' && /no ticker yet/.test(e.notes.join()), JSON.stringify(a));
  S._reset([{ id: 'x', d: '2026-09-29', t: 'Buy', a: 'Ibn sina pharma', q: 5, amt: -20, acc: 'Main' }], { 'Ibn sina pharma': { name: 'Ibn sina pharma', sector: 'Unclassified' } }, {}, { market, bench });
  e = E(); S.applyInvoice(inv('Ibn sina pharma', 'EGS512O1C012'), e);
  a = S._state().assets['Ibn sina pharma'];
  check('a stock stored without a ticker is healed by its next invoice', a.symbol === 'ISPH' && S._state().changed.newAssets['Ibn sina pharma'].symbol === 'ISPH' && /ticker ISPH recorded/.test(e.notes.join()), JSON.stringify([a, e.notes]));
}

// 4. money emails: top-ups, withdrawals, dividends, custody fees (synthetic amounts)
{
  const raw = (subject, body, enc) => Buffer.from(`From: Thndr <no-reply@mail.thndr.app>\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: ${enc}\r\n\r\n${body}\r\n--b1--\r\n`).toString('base64url');
  const qp = 'Hey Test,\r\n\r\nYour top up request of EGP\r\n12,345.0 has been added to your Th=\r\nndr wallet =E2=9A=A1.';
  check('email body: quoted-printable text/plain is read', /top up request of EGP 12,345\.0 has been added to your Thndr wallet ⚡/.test(TS.bodyText(raw('Your top-up request has been accepted', qp, 'quoted-printable'))), TS.bodyText(raw('x', qp, 'quoted-printable')));
  check('money kinds by subject', TS.moneyKind('Your top-up request has been accepted ') === 'topup' && TS.moneyKind('Your withdrawal has been processed ') === 'withdrawal'
    && TS.moneyKind('Cash Dividends Added') === 'dividend' && TS.moneyKind('Your annual custody fees ') === 'custody' && TS.moneyKind('Withdrawal request submitted ') === null && TS.moneyKind('You are eligible for TMGH cash dividends') === null);
  const E = () => ({ changes: [], reasons: [], notes: [], unchanged: 0 });
  const assets = { 'TMG Holding': { name: 'TMG Holding', symbol: 'TMGH' } };
  const marks = { '2026-08': { source: 'statement', provisional: false } }, imports = { '2026-08': { fullMonth: true } };
  S._reset([{ id: 'd1', d: '2026-09-29', t: 'Deposit', amt: 5000, acc: 'Main' }], assets, {}, { marks, imports });   // private-scan: synthetic
  let e = E(), st = S.applyMoneyEmail('topup', TS.parseMoneyEmail('topup', 'top up request of EGP 5,000.0 has been added'), '2026-09-29', e);
  check('a top-up the ledger already has (same day, same amount) is not added again', st === 'unchanged' && S._state().tx.length === 1, JSON.stringify([st, e]));
  e = E(); st = S.applyMoneyEmail('topup', TS.parseMoneyEmail('topup', 'top up request of EGP 5,000.0 has been added'), '2026-09-30', e);
  check('a second top-up of the same amount is a new deposit', st === 'applied' && S._state().tx.filter((t) => t.t === 'Deposit').length === 2, JSON.stringify(e));
  e = E(); st = S.applyMoneyEmail('withdrawal', TS.parseMoneyEmail('withdrawal', 'Requested Amount: EGP 1,002.50 Withdrawal Fees: EGP 2.5 Transferred Amount: EGP 1,000.00'), '2026-09-15', e);   // private-scan: synthetic
  const w = S._state().tx.filter((t) => t.src === 'email-2026-09-15');
  check('a withdrawal is the transferred amount plus its bank fee, as the statement books it', st === 'applied' && w.some((t) => t.t === 'Withdrawal' && t.amt === -1000) && w.some((t) => t.t === 'Fee' && t.a === 'Bank Fees' && t.amt === -2.5), JSON.stringify(w));
  e = E(); st = S.applyMoneyEmail('dividend', TS.parseMoneyEmail('dividend', 'You received EGP 317.64 from TMGH in your wallet.'), '2026-09-20', e);
  check('a dividend is booked on the stock held under that ticker', st === 'applied' && S._state().tx.some((t) => t.t === 'Dividend' && t.a === 'TMG Holding' && t.amt === 317.64), JSON.stringify(e));
  e = E(); st = S.applyMoneyEmail('custody', TS.parseMoneyEmail('custody', 'custody fee of EGP 165.23 has been deducted'), '2026-08-22', e);
  check('nothing is added to a month its monthly statement closed', st === 'skip' && !S._state().tx.some((t) => t.d === '2026-08-22'), JSON.stringify(e));
  e = E(); st = S.applyMoneyEmail('topup', TS.parseMoneyEmail('topup', 'top up request of USD 100.0 has been added'), '2026-09-21', e);
  check('a USD top-up is left alone', st === 'skip' && /USD/.test(e.notes.join()), JSON.stringify(e));
  S._reset([], {}, { trackFrom: '2026-09-10' }, {});
  e = E(); st = S.applyMoneyEmail('topup', TS.parseMoneyEmail('topup', 'top up request of EGP 100.0 has'), '2026-09-10', e);
  check('nothing on or before tracking started', st === 'skip' && !S._state().tx.length, JSON.stringify(e));
  e = E(); st = S.applyMoneyEmail('topup', TS.parseMoneyEmail('topup', 'a changed wording'), '2026-09-11', e);
  check('an email whose wording changed is held, not guessed', st === 'hold' && e.reasons.length === 1, JSON.stringify(e));
  S._reset([], {}, {}, { marks, imports });
  e = { changes: [], reasons: [], notes: [], unchanged: 0 }; S.applyInvoice({ d: '2026-08-10', type: 'Buy', name: 'X', code: 'EGS00000X000', qty: 1, gross: 10, total: 10.1, fund: false }, e);
  check('an invoice in a closed month changes nothing', !S._state().tx.length && /already final/.test(e.notes.join()), JSON.stringify(e));
}
console.log(fail ? `${fail} FAILED` : 'ALL PASS');
process.exit(fail ? 1 : 0);
