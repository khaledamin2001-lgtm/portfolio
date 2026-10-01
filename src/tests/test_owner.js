/* TS.ownerCheck: a Thndr statement or invoice is used only when it belongs to the portfolio's account. The holder name
   people type is often the short name they go by, while Thndr prints the full legal name.
     node src/tests/test_owner.js   (exit 1 on any failure) */
'use strict';
const TS = require('../statement.js');
let fail = 0;
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail == null ? '' : ' · ' + detail)); if (!ok) fail++; };
const doc = (...lines) => [{ filename: 'a.pdf', lines }];
const stmt = doc('Unified Code 1234567 Customer Account Statement Currency EGP Test Samir Adel Friend Start Balance 28.00');   // private-scan: synthetic
const inv = doc('Invoice Test Samir Adel Friend Abdelaziz Friend Custodian: Thndr Technology Holding 29/09/2026');
const own = (docs, holder, code) => TS.ownerCheck(docs, { account: { holder, unifiedCode: code || '' } });
check('the full name as printed matches', !own(stmt, 'Test Samir Adel Friend').error);
check('the short name (first and last, in order) matches the full legal name', !own(stmt, 'Test Friend').error, own(stmt, 'Test Friend').error);
check('case and extra spaces do not matter', !own(stmt, '  test   FRIEND ').error);
check('the short name also matches an invoice header', !own(inv, 'Test Friend').error, own(inv, 'Test Friend').error);
check('a different first name is refused', !!own(stmt, 'Other Friend').error);
check('the words in the wrong order are refused', !!own(stmt, 'Friend Test').error);
check('words far apart are refused', !!own(doc('Unified Code 1234567 Test a b c d e f g h Friend'), 'Test Friend').error);   // private-scan: synthetic
check('the Unified Code, when set, decides', !own(stmt, 'Nobody Here', '1234567').error && !!own(stmt, 'Test Friend', '7654321').error);   // private-scan: synthetic
check('a refused statement names the holder Thndr printed', own(stmt, 'Other Friend').error === 'is not in the name of Other Friend (it is in the name of Test Samir Adel Friend)', own(stmt, 'Other Friend').error);
check('a refused invoice names the holder Thndr printed', /\(it is in the name of Test Samir Adel Friend Abdelaziz Friend\)$/.test(own(inv, 'Other Friend').error), own(inv, 'Other Friend').error);
check('an unknown header layout is quoted instead', /\(its header reads "Unified Code 1234567 Test a b/.test(own(doc('Unified Code 1234567 Test a b c d e f g h Friend'), 'Test Friend').error));   // private-scan: synthetic
console.log(fail ? `${fail} FAILED` : 'ALL PASS');
process.exit(fail ? 1 : 0);
