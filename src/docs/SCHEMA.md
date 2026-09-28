# Data schema

Each portfolio page (a Claude artifact) keeps its own document database. The live site holds an encrypted copy of the same
documents (`p/<id>/data.enc.json`). Money is EGP; returns and rates are fractions (0.05 = 5%); dates are `YYYY-MM-DD`
(Cairo), months `YYYY-MM`.

Who writes each document: **page** = the owner typing on the Claude page; **sync** = the Thndr inbox sync
(`tools/sync.js`, Khaled only); **market** = the 3:10 PM market job (`tools/fetch_prices.py`); **Claude** = a one-off fix.

| Document | Shape | Written by |
|---|---|---|
| `portfolio/settings` | `{ name, portfolioId ('khaled'\|'yassin'), inception (month), openingValue, cash, cashDate, cashSource, account: { holder, unifiedCode }, riskFree, fxStart, benchCloseStart, openThreshold, staleDays, volLow, volHigh, priceDate, factsheetEmail }` | page, sync (cash, cashDate, cashSource, account.unifiedCode on the first statement) |
| `portfolio/marks` | `{ months: { 'YYYY-MM': { cash, securities, source ('statement'\|'price-estimate'\|'reconstructed'\|'typed'), provisional, estimateNote, benchClose, benchReturn, cpi, cpiSource, usdegp, usdegpSource, typedCash, typedSecurities, note } } }` | sync (cash, securities, source), market (benchClose, cpi, usdegp only; never overwrites), page |
| `portfolio/assets` | `{ items: { <name>: { name, symbol, sector, fund, proxy, price, priceDate, target, stop, watch } } }` — `fund`: a Thndr mutual fund booked in units at NAV; `proxy`: a price series that moves the last NAV (gold → GOLD24K); `watch`: an EGX30 member never traded | page, sync (new stocks), market (watch entries) |
| `ledger/yYYYY` | `{ rows: [ { id, d, t, a, q, p, amt, acc, src, note } ] }` — `t` ∈ Deposit, Withdrawal, Buy, Sell, Bonus, Dividend, Fee, Rebate; `a` asset name; `q` shares or fund units; `p` price or NAV; `amt` signed cash (buys, withdrawals, fees negative; Bonus 0); `acc` 'Main' or 'MF' (fund account) | page, sync |
| `imports/YYYY-MM` | `{ month, messageId, postedAt, postedBy, added, corrected, removed, marks, fullMonth, reportsPending, reports: { factsheetSentAt, workbooksPublishedAt } }` — `fullMonth` true only for a whole-calendar-month statement with a positions snapshot | sync, page |
| `sync/state` | `{ lastRun, seen: { <gmail id>: { subject, date, kind, status, at } }, alerts: { <month>: <date> }, toolSha: { sync, statement, engine, engine2, at } }` | sync (page: "Retry held emails" deletes held entries) |
| `market/latest` | `{ asOf, source, quotes: { <SYM>: { price, chg, date, prevMonthClose, name, dy, exDate, divUp, exRecent, divRecent } }, index: { EGX30CAPPED: { close, chg, date, prevMonthClose }, … }, fx: { USDEGP }, gold: { XAUUSD, gram24kEgp }, missing: [SYM] }` | market (the site overrides it in memory with live prices) |
| `history/YYYY-MM` | `{ month, days: { 'YYYY-MM-DD': { <SYM>: close, EGX30CAPPED, EGX30, EGX70EWI, EGX100EWI, USDEGP, GOLD24K } } }` — unadjusted closes (bonus issues are NOT back-adjusted; the ledger holds real share counts) | market |
| `bench/egx30` | `{ members: [ { s, name, sector, floatShares, totalShares } ], capWeight, asOf, index, source, actions: [ { s, date, ratio, kind, label } ], actionsSource }` — `actions`: corporate actions (ratio = new shares ÷ old shares) | market (members, asOf), Claude (actions) |
| `tools/<id>` | `{ filename, content, sha256, builtAt }` — the scripts the jobs download and run | Claude (`tools/build_tooldocs.py`) |

Rules the code relies on:
- The two portfolios never share documents; each job writes only to the page named in its prompt.
- A month's return is Modified Dietz from `marks[M]` (or an estimate from ledger × closes when the statement is missing), chain-linked.
- Within one day the ledger is ordered Deposit, Buy/Bonus, Dividend/Rebate/Fee, Sell, Withdrawal.
- On the live site `p/<id>/data.fingerprint` is the sha256 of the published documents; the publish step skips a portfolio whose documents have not changed.
