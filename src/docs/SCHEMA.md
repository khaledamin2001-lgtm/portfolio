# Data schema

Each portfolio page (a Claude artifact) keeps its own document database. The live site holds an encrypted copy of the same
documents (`p/<id>/data.enc.json`). Money is EGP; returns and rates are fractions (0.05 = 5%); dates are `YYYY-MM-DD`
(Cairo), months `YYYY-MM`.

Who writes each document: **page** = the owner typing on the Claude page; **sync** = the Thndr inbox sync
(`tools/sync.js`, Khaled only); **market** = the 3:10 PM market job (`tools/fetch_prices.py`); **Claude** = a one-off fix.

| Document | Shape | Written by |
|---|---|---|
| `portfolio/settings` | `{ name, portfolioId ('khaled'\|'yassin'), inception (month), openingValue, cash, cashDate, cashSource, account: { holder, unifiedCode }, riskFree, fxStart, benchCloseStart, openThreshold, staleDays, volLow, volHigh, priceDate, factsheetEmail, returnMethod ('dietz' default \| 'daily': which return the headline tile shows) }` | page, sync (cash, cashDate, cashSource, account.unifiedCode on the first statement) |
| `portfolio/marks` | `{ months: { 'YYYY-MM': { cash, securities, source ('statement'\|'price-estimate'\|'reconstructed'\|'typed'), provisional, estimateNote, benchClose, benchReturn, cpi, cpiSource, usdegp, usdegpSource, cashRate (annual CBE policy rate in force that month), cashRateSource, typedCash, typedSecurities, note } } }` | sync (cash, securities, source), market (benchClose, cpi, usdegp, cashRate only; never overwrites), page |
| `portfolio/assets` | `{ items: { <name>: { name, symbol, sector, fund, proxy, price, priceDate, target, stop, watch, note, thesis, reviewOn } } }` — `fund`: a Thndr mutual fund booked in units at NAV; `proxy`: a price series that moves the last NAV (gold → GOLD24K); `watch`: an EGX30 member never traded, or a symbol added to the watchlist; `note` / `thesis` free text; `reviewOn` a date after which Holdings shows "review due" | page, sync (new stocks), market (watch entries) |
| `ledger/yYYYY` | `{ rows: [ { id, d, t, a, q, p, amt, acc, src, note } ] }` — `t` ∈ Deposit, Withdrawal, Buy, Sell, Bonus, Dividend, Fee, Rebate; `a` asset name; `q` shares or fund units; `p` price or NAV; `amt` signed cash (buys, withdrawals, fees negative; Bonus 0); `acc` 'Main' or 'MF' (fund account) | page, sync |
| `imports/YYYY-MM` | `{ month, messageId, postedAt, postedBy, added, corrected, removed, marks, fullMonth, reportsPending, reports: { factsheetSentAt, workbooksPublishedAt } }` — `fullMonth` true only for a whole-calendar-month statement with a positions snapshot | sync, page |
| `sync/state` | `{ lastRun, seen: { <gmail id>: { subject, date, kind, status, at } }, alerts: { <month>: <date> }, toolSha: { sync, statement, engine, engine2, at }, digest: { at, items: [ { kind ('exdiv'\|'target'\|'stop'\|'drawdown'\|'statement'), key, text } ] }, alertsSent: { <key>: <date> }, heartbeat: { sync } }` — `digest` is the heads-up list; `alertsSent` makes each item email once | sync (page: "Retry held emails" deletes held entries) |
| `market/latest` | `{ asOf, source, quotes: { <SYM>: { price, chg, date, prevMonthClose, name, dy, exDate, divUp, exRecent, divRecent, pe, pb, roe, mcap, hi52, lo52 } }, index: { EGX30CAPPED: { close, chg, date, prevMonthClose }, … }, fx: { USDEGP }, gold: { XAUUSD, gram24kEgp }, missing: [SYM], rates: { policy: { rate, date (month), source } } }` — `roe` and `dy` in percent; `mcap` in EGP | market (the site overrides it in memory with live prices) |
| `history/YYYY-MM` | `{ month, days: { 'YYYY-MM-DD': { <SYM>: close, EGX30CAPPED, EGX30, EGX70EWI, EGX100EWI, USDEGP, GOLD24K } } }` — unadjusted closes (bonus issues are NOT back-adjusted; the ledger holds real share counts) | market |
| `bench/egx30` | `{ members: [ { s, name, sector, floatShares, totalShares } ], capWeight, asOf, divYield, divYieldAsOf, index, source, actions: [ { s, date, ratio, kind, label } ], actionsSource }` — `actions`: corporate actions (ratio = new shares ÷ old shares) — `divYield`: estimated annual dividend yield of the capped index (member weight × dividend yield) | market (members, asOf, divYield), Claude (actions) |
| `p/<id>/exports/index.json` (site only) | `[ { month, name, file (the encrypted .xlsx), pdf (the encrypted PDF factsheet, optional), publishedAt } ]`, newest month first | sync |
| `tools/<id>` | `{ filename, content, sha256, builtAt }` — the scripts the jobs download and run | Claude (`tools/build_tooldocs.py`) |

Rules the code relies on:
- The two portfolios never share documents; each job writes only to the page named in its prompt.
- A month's return is Modified Dietz from `marks[M]` (or an estimate from ledger × closes when the statement is missing), chain-linked.
- Within one day the ledger is ordered Deposit, Buy/Bonus, Dividend/Rebate/Fee, Sell, Withdrawal.
- On the live site `p/<id>/data.fingerprint` is the sha256 of the published documents; the publish step skips a portfolio whose documents have not changed.
- Trading costs are not stored: the engine derives each stock trade's cost as |amount| − price × shares (buys) or price × shares − amount (sells).
