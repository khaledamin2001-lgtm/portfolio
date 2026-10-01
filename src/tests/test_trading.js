#!/usr/bin/env node
/* PA.tradingHabits (engine2.js), the sums behind Analysis → Your trading, on made-up round trips:
   per-trade figures, days held by winners and losers, the holding-period / size / month / sector groups, streaks, what each
   stock did 30 days after the sale (and the index over the same days), repeat stocks, open winners vs losers, big losses.
   node src/tests/test_trading.js      exit 0 = all checks passed */
'use strict';
const path = require('path');
const PE = require(path.join(__dirname, '..', 'engine.js')); global.PE = PE;
const PA = require(path.join(__dirname, '..', 'engine2.js'));
let fail = 0;
const check = (name, ok, detail) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail != null ? ' · ' + detail : '')); if (!ok) fail++; };
const near = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;

// made-up trips: [name, symbol, sector, firstBuy, lastSell, buyCost, total, sold]
const T = (name, symbol, sector, firstBuy, lastSell, buyCost, total, sold, trip = 1) => ({ name, symbol, sector, trip, firstBuy, lastSell, buyCost, total, roi: total / buyCost,
  sold, proceeds: buyCost + total, holdDays: PE.dayNum(lastSell) - PE.dayNum(firstBuy), outcome: total > 0 ? 'WIN' : 'LOSS' });
const trips = [
  T('Alpha', 'AAA', 'Banks', '2026-01-04', '2026-01-08', 1000, 100, 100),       // 4 days, win
  T('Beta', 'BBB', 'Banks', '2026-01-05', '2026-02-25', 2000, -300, 100),       // 51 days, loss
  T('Gamma', 'CCC', 'Telecom', '2026-02-01', '2026-02-20', 3000, 600, 100),     // 19 days, win
  T('Alpha', 'AAA', 'Banks', '2026-03-01', '2026-03-03', 4000, -50, 100, 2),    // 2 days, loss (second trip)
  T('Delta', 'DDD', 'Energy', '2026-01-10', '2026-06-01', 5000, 1500, 100),     // 142 days, win
  T('Echo', 'EEE', 'Energy', '2026-03-10', '2026-04-20', 6000, -900, 100),      // 41 days, loss
];
// sale prices from the ledger: each trip sold 100 shares at 10
const ledger = trips.map((t) => ({ t: 'Sell', a: t.name, d: t.lastSell, p: 10, q: 100, amt: 1000 }));
// price book: every symbol at 10 on the sale day, 11 thirty days later; the index 100 → 102
const days = {};
const put = (d, snap) => { (days[d.slice(0, 7)] || (days[d.slice(0, 7)] = { days: {} })).days[d] = { ...((days[d.slice(0, 7)] || {}).days || {})[d], ...snap }; };
trips.forEach((t) => {
  const d30 = new Date((PE.dayNum(t.lastSell) + 30) * 86400000).toISOString().slice(0, 10);
  put(t.lastSell, { [t.symbol]: 10, EGX30CAPPED: 100 }); put(d30, { [t.symbol]: 11, EGX30CAPPED: 102 });
});
put('2026-07-15', { EGX30CAPPED: 105 });
const pb = PA.priceBook(days);
const open = [{ name: 'Win1', openCost: 1000, unreal: 200, holdDays: 10 }, { name: 'Lose1', openCost: 1000, unreal: -100, holdDays: 40 }, { name: 'Lose2', openCost: 2000, unreal: -200, holdDays: 60 }];
const h = PA.tradingHabits(trips, { open, ledger, pb, quotes: {}, today: '2026-07-15' });

check('per trade: 6 trades, 3 won, P/L 950, 158.33 a trade', h.n === 6 && h.wins === 3 && h.losses === 3 && near(h.pl, 950) && near(h.expectancy, 950 / 6), `${h.n} ${h.wins} ${h.pl} ${h.expectancy}`);
check('average win 733.33, average loss −416.67', near(h.avgWin, 2200 / 3) && near(h.avgLoss, -1250 / 3));
check('days held: winners 55, losers 31.33 on average', near(h.holdWin, (4 + 19 + 142) / 3) && near(h.holdLoss, (51 + 2 + 41) / 3), `${h.holdWin} ${h.holdLoss}`);
const hb = Object.fromEntries(h.byHold.map((b) => [b.key, b]));
check('by holding period: up to a week 2 trades (1 won, +50), 1-4 weeks 1, 1-3 months 2 (both lost), over 3 months 1', hb.week.n === 2 && hb.week.wins === 1 && near(hb.week.pl, 50) && hb.month.n === 1 && hb.quarter.n === 2 && hb.quarter.wins === 0 && near(hb.quarter.pl, -1200) && hb.long.n === 1);
check('by size: thirds by money put in (smallest = 1000 and 2000, largest = 5000 and 6000)', h.bySize && h.bySize.length === 3 && h.bySize[0].lo === 1000 && h.bySize[0].hi === 2000 && h.bySize[2].lo === 5000 && near(h.bySize[2].pl, 600), JSON.stringify(h.bySize && h.bySize.map((b) => [b.lo, b.hi, b.pl])));
check('by sector: best first (Telecom and Energy, +600 each), Banks (−250) last', near(h.bySector[0].pl, 600) && near(h.bySector[1].pl, 600) && h.bySector[h.bySector.length - 1].sector === 'Banks' && near(h.bySector[h.bySector.length - 1].pl, -250), h.bySector.map((b) => b.sector + b.pl).join(' '));
check('by month sold: Jan, Feb, Mar, Apr, Jun in order', h.byMonth.map((m) => m.month).join() === '2026-01,2026-02,2026-03,2026-04,2026-06', h.byMonth.map((m) => m.month).join());
check('streaks by sale date (W, W, L, L, L, W): 2 wins, 3 losses in a row, now 1 win', h.streaks.win === 2 && h.streaks.loss === 3 && h.streaks.current.kind === 'win' && h.streaks.current.n === 1, JSON.stringify(h.streaks));
check('after the sale: every stock +10% 30 days on, the index +2%, the shares sold worth 100 more each', h.after.n30 === 6 && near(h.after.avg30, 0.1) && near(h.after.avgIndex30, 0.02) && near(h.after.amount30, 600) && h.after.rows[0].sold === '2026-06-01', JSON.stringify(h.after).slice(0, 160));
check('a stock traded twice is listed once with both trips', h.repeat.length === 1 && h.repeat[0].name === 'Alpha' && h.repeat[0].n === 2 && near(h.repeat[0].pl, 50));
check('open now: 1 winner held 10 days, 2 losers held 50 days on average (−10%)', h.open.winners.n === 1 && h.open.losers.n === 2 && near(h.open.losers.avgDays, 50) && near(h.open.losers.avgPct, -0.1));
check('biggest losses: the 3 losses are 100% of all losses', h.bigLosses.n === 3 && near(h.bigLosses.share, 1) && near(h.bigLosses.top, -1250));
const e = PA.tradingHabits([], { open: [], ledger: [], pb: null });
check('no closed trades: zeros and empty groups, no error', e.n === 0 && e.expectancy == null && e.bySize === null && e.after.rows.length === 0 && e.streaks.current === null);
// closes saved only up to 5 June: Delta (sold 1 June) has no 30-day close yet, so today's quote is used and marked "so far"
const early = {}; Object.keys(days).forEach((m) => { const d = Object.fromEntries(Object.entries(days[m].days).filter(([k]) => k <= '2026-06-05')); if (Object.keys(d).length) early[m] = { days: d }; });
const f = PA.tradingHabits(trips, { open: [], ledger, pb: PA.priceBook(early), quotes: { DDD: { price: 12, date: '2026-06-10' } }, today: '2026-06-10' });
const dd = f.after.rows.find((r) => r.symbol === 'DDD');
check('a sale less than 30 days ago uses today\'s price, marked as so far, and is left out of the 30-day average', dd && !dd.full30 && dd.px === 12 && dd.days === 9 && near(dd.move, 0.2) && f.after.n30 === 5, JSON.stringify(dd));
console.log(fail ? `FAIL ${fail}` : 'ALL PASS');
process.exit(fail ? 1 : 0);
