#!/usr/bin/env node
/* engine2.js limitCheck and the 'limit' heads-up items (settings.limits = {on, stock, sector}): each portfolio's own most
   per stock and per sector, of the whole portfolio with cash; cash-like funds never count as a stock or a sector; off or
   empty means no item. Run on the synthetic portfolio (fixtures/make_synthetic.js) through jobs/account_alerts.js, the
   path the account emails take (the owner's inbox job and the page call the same PA.headsUp).
   node src/tests/test_limits.js      exit 0 = all checks passed */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const PE = require(path.join(__dirname, '..', 'engine.js')); global.PE = PE;
const PA = require(path.join(__dirname, '..', 'engine2.js'));
let fail = 0;
const check = (name, ok, detail) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail != null ? ' · ' + detail : '')); if (!ok) fail++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-'));
cp.execFileSync('node', [path.join(__dirname, 'fixtures', 'make_synthetic.js'), dir], { stdio: 'ignore' });
const sp = path.join(dir, 'portfolio', 'settings.json'), raw = JSON.parse(fs.readFileSync(sp));
const setLimits = (limits) => { const x = JSON.parse(JSON.stringify(raw)); (x.data && x.id !== undefined ? x.data : x).limits = limits; fs.writeFileSync(sp, JSON.stringify(x)); };
const alerts = () => JSON.parse(cp.execFileSync('node', [path.join(__dirname, '..', 'jobs', 'account_alerts.js'), '--data', dir, '--today', '2026-09-24']).toString().trim().split('\n').pop());
const lim = (r) => r.items.filter((i) => i.kind === 'limit');

const docs = {};
for (const c of fs.readdirSync(dir)) { const cd = path.join(dir, c); if (!fs.statSync(cd).isDirectory()) continue; for (const f of fs.readdirSync(cd)) { const x = JSON.parse(fs.readFileSync(path.join(cd, f))); docs[c + '/' + f.slice(0, -5)] = x.data !== undefined && x.id !== undefined ? x.data : x; } }
const R = PA.portfolioRun(docs, null, { today: '2026-09-24' }).R;
check('off (or missing): no check at all', PA.limitCheck(R, null) === null && PA.limitCheck(R, { on: false, stock: 0.01 }) === null);
const lc = PA.limitCheck(R, { on: true, stock: 0.2, sector: 0.3 });
const cash = Math.max(0, R.liveCash), sumW = lc.stocks.reduce((a, x) => a + x.w, 0);
check('weights are of the whole portfolio, cash included (stocks + cash-like funds + cash = 100%)', Math.abs(lc.total - (R.pos.mvTotal + cash)) < 1e-6 && sumW < 1 && sumW > 0.3, sumW.toFixed(4));
check('cash-like funds are never a stock or a sector', lc.stocks.every((x) => !['Cash & Savings', 'Mutual Funds', 'Cash'].includes(x.sec)) && lc.sectors.every((x) => !['Cash & Savings', 'Mutual Funds', 'Cash'].includes(x.sec)));
check('a sector is the sum of its stocks; both lists largest first', lc.sectors.every((s) => Math.abs(s.w - lc.stocks.filter((x) => x.sec === s.sec).reduce((a, x) => a + x.w, 0)) < 1e-9)
  && lc.stocks.every((x, i) => i === 0 || x.w <= lc.stocks[i - 1].w) && lc.sectors.every((x, i) => i === 0 || x.w <= lc.sectors[i - 1].w));
check('over: exactly the stocks above 20% and the sectors above 30%', JSON.stringify(lc.over.filter((x) => x.kind === 'stock').map((x) => x.n)) === JSON.stringify(lc.stocks.filter((x) => x.w > 0.2).map((x) => x.n))
  && JSON.stringify(lc.over.filter((x) => x.kind === 'sector').map((x) => x.n)) === JSON.stringify(lc.sectors.filter((x) => x.w > 0.3).map((x) => x.sec)) && lc.over.length >= 1, JSON.stringify(lc.over.map((x) => [x.n, +x.w.toFixed(3)])));
const top = lc.stocks[0];
check('a limit right at the largest weight is not crossed; just under it is', !PA.limitCheck(R, { on: true, stock: top.w }).over.length && PA.limitCheck(R, { on: true, stock: top.w - 0.001 }).over.length === 1);
check('an empty limit is no limit', PA.limitCheck(R, { on: true, stock: null, sector: 0.99 }).over.length === 0 && PA.limitCheck(R, { on: true, stock: '', sector: 0 }).over.length === 0);

setLimits({ on: true, stock: 0.2, sector: 0.3 });
const a1 = alerts(), l1 = lim(a1);
check('account alerts: one "limit" item per crossing, with a stable key and plain words', a1.ok && l1.length === lc.over.length
  && l1.every((i) => /^limit:(stock|sector):[^:]+:(20|30)$/.test(i.key) && /of your portfolio, over your (20|30)% limit for one (stock|sector)$/.test(i.text)), JSON.stringify(l1));
check('the item says the stock by its symbol and the sector by name', l1.some((i) => i.text.startsWith((top.s || top.n) + ' is ')) && (!lc.over.some((x) => x.kind === 'sector') || l1.some((i) => /^The .+ sector is /.test(i.text))));
setLimits({ on: true, stock: 0.25, sector: 0.3 });
check('a changed limit is a new key (so it is emailed again)', lim(alerts()).filter((i) => i.key.startsWith('limit:stock')).every((i) => i.key.endsWith(':25')));
setLimits({ on: false, stock: 0.01, sector: 0.01 });
check('switched off: no limit item', lim(alerts()).length === 0);
setLimits(undefined);
check('never set: no limit item, the other heads-up items unchanged', lim(alerts()).length === 0 && alerts().items.length === a1.items.length - l1.length);
fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? `FAIL ${fail}` : 'ALL PASS');
process.exit(fail ? 1 : 0);
