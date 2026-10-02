# src/: everything the site and the jobs run

Every file the tracker runs is built from this folder. The repository is public, so nothing here is secret, and **no
data or keys ever go here** (see "Secrets" at the end). The root `README.md` explains how the parts fit together; this
file lists every file and how to build and test.

## The page (the app people see)

| File | What it is |
|---|---|
| `app.html` | The page: markup, styles and the UI code (tabs, charts, settings, editing). Four placeholders `/*ENGINE*/ /*ENGINE2*/ /*STATEMENT*/ /*APP2*/` are filled in by `build.py`. It reads its data through `window.pdHost.use('db')`, which the site layer provides. |
| `app2.js` | The rest of the UI: analytics pages (Your trading, What the numbers say, What if), attribution, income, the factsheet (also used headless by `tools/factsheet.js` through `window.pdFactsheet`), statement upload and review. |
| `engine.js` | The core maths, no DOM and no network: the ledger with average cost, the monthly Modified-Dietz return chain, period statistics, XIRR, positions, data checks. |
| `engine2.js` | The second layer: the price book from the daily history, daily valuation, Brinson attribution, income, trailing returns, `holdingsAt`, heads-up alerts, trading habits (`tradingHabits`, for Analysis → Your trading). |
| `statement.js` | Thndr PDF statements: PDF text → statement rows and the positions snapshot → matching against the ledger (`reconcile`), plus the account lock (`ownerCheck`: only a portfolio's own Thndr account is ever applied). |
| `build.py` | Builds `portfolio-desk.html` and `yassin-desk.html` (the same page, different title) from the five files above, stamped `<meta name="pd-build" content="<12 hex> <UTC time>">`. They are build outputs (gitignored). |
| `docs/SCHEMA.md` | The data: every document, its shape and who writes it. |

## The site layer (`site/`)

| File | What it is |
|---|---|
| `site/build_site.py` | Wraps the built page into the live site: the root `index.html` (the page + `lock.js` + `lock.css`, self-hosted fonts, the Content-Security-Policy), `portfolios.json`, the web manifest, icons, `vendor/` and `sw.js`. Run it after any change under `src/` and commit the outputs. |
| `site/lock.js` | Everything specific to the website: the lock screen, keys and encryption (setup key, device password, Face ID / fingerprint), loading and decrypting the data, editing from the site (GitHub API), accounts (Firebase Auth + Firestore), friends (@usernames or email), their percentages profiles and activity feed, the admin screen, email-update settings, live prices from TradingView, the offline copy. Each section starts with a comment saying what it does. |
| `site/lock.css` | Styles for the lock screen and the site's own bars and screens. |
| `site/store.js` | The site editor's write rules, the JavaScript twin of `jobs/store.py` (merge, markers, all-or-nothing batch), pinned by `jobs/merge_vectors.json`. |
| `site/make_keys.py` | Makes a portfolio's key pair: `keys.json` for the repo, and the setup key and private key into a secret folder (never committed). |
| `site/rotate_keys.py` | Re-keying runbook for one portfolio (lost setup key, compromised device): new keys, re-encrypt everything, swap in only after it verifies. |
| `site/pwa/` | The installable app: `sw.js` (the service worker: an offline copy of the site's files and of the encrypted data) and the icons (`make_icons.py` draws them). |
| `site/fonts/`, `site/vendor/` | Self-hosted fonts (`fonts.json` lists each face) and pdf.js 3.11.174 (reads statement PDFs in the browser). |
| `cloud/firestore.rules` | Firestore security rules for accounts: who may read or write which encrypted document. Paste into the Firebase console to publish (the owner's email goes in place of `owner@example.com`). |

## The scheduled jobs (`jobs/`, Python)

Run by the workflows in the private `portfolio-engine` repository as `python3 src/jobs/<job>.py --engine <its checkout>
--code <this checkout>`. Each file's docstring explains its steps in detail.

| File | What it is |
|---|---|
| `jobs_common.py` | Shared plumbing: `Ctx` (config, keys, today in Cairo, decrypting a portfolio into a temp folder), the time gate, engine commits, `jobs.json`, failure reporting, log masking. Read this first. |
| `store.py` | The encrypted document store in the engine repo: one encrypted file per document, all-or-nothing writes pinned to the versions read. |
| `run_market.py` | The daily market update for one portfolio: prices (`fetch_prices.py`), history, index, macro fields, then a site refresh and the "market updated" email. |
| `run_shared_market.py` | The whole EGX market once a day for every account, published sealed to the members' key as `m/market.enc.json`. |
| `run_sync.py` | The owner's Thndr inbox sync: new emails from Gmail (`imap_fetch.py`) → `tools/sync.js` → one write → the inbox email, the weekly summary, the month-end report, a site refresh. |
| `run_morning.py` | The morning brief before the EGX opens (engine `morning.yml`, started Sun-Thu at 9:00 Cairo by `kick_new_accounts.py`): the owner's main portfolio and the accounts that ticked it, each to its own address, once a day. |
| `run_account_mail.py` | Every opted-in site account: its Thndr emails from its own Gmail, "Build it from my Thndr emails", heads-up alerts, the weekly summary, the month-end report, friend requests, friends' percentages profiles, the monthly friends leaderboard and trading report card (1st to 10th, once a month each), new sign-ups for the owner. Each email goes to that account's own address only. |
| `run_reports.py` | Month-end reports for a portfolio without an inbox sync (Yassin's). |
| `publish.py` | Encrypts a portfolio's documents (`../tools/export.py`) and pushes them to this repo's `p/<id>/`. |
| `fetch_prices.py` | Prices from TradingView's public scanner plus a short daily-bar backfill. |
| `imap_fetch.py` | Reads Thndr emails from Gmail over IMAP, read-only, into an inbox folder. |
| `emails.py` | Every email's content (market, inbox, month-end, reminders, failures, the friends' emails). |
| `mail_html.py` | The one email design (card, title, number tiles, notes, button) and its plain-text twin. |
| `mail_send.py` | Sends through Gmail SMTP, only ever to the portfolio's own address; also the workflows' last-resort failure email. |
| `account_alerts.js` | The heads-up items for an account (Node, uses `engine2.js`). |
| `kick_new_accounts.py` | The every-5-minutes watcher (`.github/workflows/new-accounts.yml`): starts the account job for a brand-new account; warns before the on-time alarm key expires. |
| `alarm_key.py` | The "alarm key expires soon" email. |
| `email_samples.py` | One sample of every email, from made-up data, to the owner (engine workflow "Email samples"). |
| `history_check.py` | Read-only check of "Build it from my Thndr emails" on the owner's real emails. |
| `merge_vectors.json` | Test vectors for the store's write rules, shared by `store.py` and `site/store.js`. |

## The Node tools (`tools/`)

Run by the jobs on a plain export folder (one `<collection>/<doc>.json` file per document, as `jobs_common.Ctx`
materializes it).

| File | What it is |
|---|---|
| `tools/sync.js` | Applies Thndr emails (invoices, requested and monthly statements) to the ledger; prints the writes to make and the inbox email. Holds a statement for review unless the month reconciles exactly. |
| `tools/history_seed.js` | "Build it from my Thndr emails": a whole portfolio from the monthly statements since 2019. |
| `tools/weekly.js` | The Thursday weekly summary email (HTML + text). |
| `tools/wrapped.js` | The yearly wrap-up (`engine2.js` `yearWrapped`): the year's return vs the index, best and worst month and sale, most traded stock, longest hold, dividends. Emailed in early January by `run_account_mail.py`, ranked among friends. |
| `tools/brief.js` | The morning brief (`engine2.js` `morningBrief`): the last session, each holding's move, ex-dividend and earnings dates this week, holdings near their target or stop, unusual volume, limits, a 5% index drop. Emailed by `jobs/run_morning.py`. |
| `tools/report_card.js` | The monthly trading report card (`engine2.js` `reportCard`): last month's sales (part sales too), win rate, days held, best and worst sale, return vs the index, limits, tips. Emailed by `run_sync.py` (the owner) and `run_account_mail.py` (accounts). |
| `tools/profile.js` | A portfolio's percentages profile for its friends (`engine2.js` `friendProfile`: returns by month, holdings by weight, trades as %, no amounts); the account job shares it. |
| `tools/excel.js` + `tools/excel.py` | The month-end Excel workbook (`excel.js` shapes the figures, `excel.py` writes the `.xlsx`). |
| `tools/factsheet.js` | Renders the monthly factsheet with the page's own code, headless (Playwright): HTML, PDF and the headline figures. |
| `tools/plan.js` | Today's dates in Cairo for the jobs (weekday, last month, Gmail search start). |
| `tools/engine.js`, `tools/engine2.js`, `tools/statement.js` | **Copies** of the files in `src/` (the tools `require('./…')` them from their own folder, and the jobs copy `tools/` on its own). Keep them identical: `cp engine.js engine2.js statement.js tools/` after a change; the build check fails when they differ. |

`../tools/export.py` and `../tools/encrypt_file.py` (repository root) encrypt a portfolio's documents and a report file
with only the public key; `jobs/publish.py` and `jobs/run_sync.py` call them.

## Tests (`tests/`)

| File | What it checks |
|---|---|
| `tests/run_all.sh` | The one entry point (what GitHub Actions runs on every push): syntax, unit tests, tools on synthetic data, the builds, the private-data guard. |
| `tests/test_dietz.js` | Modified Dietz, bonus shares, round trips, same-day ordering. Sections on the real data run only with private exports (`KHALED_EXPORT`, `YASSIN_EXPORT`, `EXPECTED_JSON`), otherwise `SKIP`. |
| `tests/test.js` | Excel parity against the original workbook; needs two private fixtures, otherwise exits 0. |
| `tests/test_statement.js` | Statement reading and matching (the right ledger row, quiet months). |
| `tests/test_brief.js` | Unusual volume (`volumeSpikes`), the risk model (`riskModel`: beta, correlation, stress test, worst day) on a history with known answers, and the morning brief. |
| `tests/test_limits.js` | Your limits (`settings.limits`, `engine2.js` `limitCheck`): weights of the whole portfolio with cash, cash-like funds left out, the heads-up items and their keys. |
| `tests/test_report_card.js` | The report card: every sale counted, cash-like funds left out, holding days, the month next to the one before, the tips. |
| `tests/test_profile.js` | The friends' profile: only percentages (no amounts, share counts or prices), weights add up, returns equal the engine's, trades in order. |
| `tests/test_trading.js` | The sums behind Analysis → Your trading (`engine2.js` `tradingHabits`): per trade, days held, groups, streaks, after the sale. |
| `tests/test_checks.js` | The model checks that tell a real problem from how Thndr books things: cash dips, estimated months, trade prices on big-move days, typed fund rows. |
| `tests/test_owner.js` | The account lock: a statement is used only for its own holder / Thndr account; a new account's first statement sets it. |
| `tests/test_jobs.py` | The jobs' rules: market patches, sync writes, the time gate, recipients, unsent emails, the watcher, the alarm key. |
| `tests/test_account_mail.py` | The account job end to end with a fake Firebase and mailer: alerts, weekly, Gmail import, history import, reports, friends' profiles, the leaderboard, impostor links. `DUMP_EMAILS=<dir>` writes every email out. |
| `tests/test_history_seed.py` | Building a portfolio from statements: gaps, names vs tickers, funds, an empty start, two Thndr accounts. |
| `tests/test_store.py`, `tests/js_compat.mjs`, `tests/test_site_store.js` | The store's encryption and write rules, in Python and in the browser's JavaScript. |
| `tests/crypto_roundtrip.py` | Encrypt with `export.py` / `encrypt_file.py`, decrypt the way `lock.js` does. |
| `tests/site_smoke.js`, `tests/site_edit.js`, `tests/site_cloud.js` | Browser tests (Playwright): the locked site, editing, accounts and friends against a fake Firebase. No console errors, no CSP violations, no request leaving the site. |
| `tests/check_private.py` | The private-data guard: fails on anything that looks like real data or a secret. A deliberate made-up value on a line can be marked `private-scan: synthetic`. |
| `tests/fixtures/` | `make_synthetic.js` (a made-up "Demo Portfolio"), `make_statement_pdf.py` (made-up Thndr statement PDFs). |

## Build and test

From the repository root:

    cd src && python3 build.py && cd site && python3 build_site.py ../..   # then commit index.html, sw.js etc. with the src/ change
    bash src/tests/run_all.sh            # all automatic checks (needs node 20+, python 3.11+ with openpyxl, pillow, cryptography)
    node src/tests/site_smoke.js         # and site_edit.js, site_cloud.js: the browser tests (need Playwright + Chromium)

`run_all.sh` installs pdf.js into a temp folder unless `PDFJS_NODE_MODULES` points at a `node_modules` that has it.
A failing check puts a red ✗ on the commit in GitHub; it does not stop GitHub Pages from publishing.

## Secrets: never in the repository

- Setup keys, private keys and passwords live only with the owner (`site/make_keys.py` writes them to a secret folder).
  The repository holds only `p/<id>/keys.json`: the public key and the private key **wrapped** under the setup key.
- Database exports, `seed.json` / `expected.json`, plain workbooks and PDFs stay outside the repository; `.gitignore`
  blocks the usual names and `tests/check_private.py` fails the build on anything that looks like them. The only data
  committed is encrypted (`p/*/data.enc.json`, `p/*/exports/*.enc.json`, `m/market.enc.json`).
- The jobs' secrets (setup keys, Gmail app password, site token) are GitHub Actions secrets in the private repository.
