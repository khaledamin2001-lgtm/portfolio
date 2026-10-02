# Portfolio Desk: an encrypted EGX portfolio tracker

https://khaledamin2001-lgtm.github.io/portfolio/

A website for tracking stock portfolios on the Egyptian Exchange (EGX) bought through the broker Thndr: holdings,
returns against the EGX30 Capped index, dividends, risk, month-end reports. It runs entirely on free services (GitHub
Pages, GitHub Actions, Firebase's free plan, cron-job.org) and every portfolio is **end-to-end encrypted**: the servers
only ever store ciphertext, and figures are decrypted in the owner's browser.

This README is the map. `src/README.md` lists every file; `src/docs/SCHEMA.md` describes the data.

## How it fits together

```
                 cron-job.org (on-time alarms, Cairo time)
                               │  "run workflow"
                               ▼
  ┌───────────────────── private repo: portfolio-engine ─────────────────────┐
  │  GitHub Actions workflows run the code from THIS repo (src/jobs/*.py):    │
  │   3:40 pm  market close  → prices (TradingView) → encrypted documents     │
  │   4:15 / 6:15 / 11 pm    → Thndr emails (Gmail IMAP) → ledger, emails     │
  │  db/  = each portfolio's documents, one encrypted file each               │
  └──────────────┬───────────────────────────────────────┬────────────────────┘
                 │ publish: encrypted bundle             │ email (Gmail SMTP)
                 ▼                                       ▼
  ┌──── this repo, served by GitHub Pages ────┐     owner / friends
  │ index.html  (built from src/)             │
  │ p/<id>/data.enc.json  encrypted portfolio │◄──── browser: unlock with key / password,
  │ m/market.enc.json     shared market data  │      decrypt, compute everything locally
  └───────────────────────────────────────────┘
                                                ┌─ Firebase (Auth + Firestore) ─┐
             friends' accounts ───────────────► │ users/{uid}/docs: encrypted   │
                                                │ friend links, shared copies   │
                                                └───────────────────────────────┘
```

There are two kinds of portfolio:

1. **Setup-key portfolios** (the owner's and Yassin's). Their documents live in the private `portfolio-engine`
   repository and are published here as `p/<id>/data.enc.json`, encrypted to the portfolio's public key
   (`p/<id>/keys.json`). A device opens it once with the setup key, then with its own password or Face ID.
2. **Accounts** (friends). Sign-up with email + password (Firebase Auth). The browser encrypts every document to the
   account's own key before it reaches Firestore. The jobs can read an account only if it opted in to email updates,
   by sealing a package to the job's key. Friends find each other by @username (`handles/{handle}`, taken
   automatically once the email is confirmed) or by email (`directory/{email}`); see `src/site/lock.js` (friends) and
   `src/cloud/firestore.rules`. Friends compare in **percentages only**: what one shares with another is a profile of
   returns by month, holdings by weight and trades as % (`engine2.js` `friendProfile`), never an amount. On the 1st of
   the month each account can get a leaderboard email ranking it and its friends on last month's return.
3. **Your rules.** Each portfolio can switch on its own limits (Holdings tab → Your limits: the most one stock and one
   sector may be of the whole portfolio); crossing one shows on the Overview and is emailed once. Early each month a
   trading report card email scores last month's sales next to the month before (`tools/report_card.js`).
4. **Before the open and on the go.** Sunday to Thursday at 9:00 Cairo a morning brief email (`jobs/run_morning.py`):
   the last session, each holding's move, ex-dividend and earnings dates this week, holdings near their levels, unusual
   volume (also a heads-up alert: 3× the 30-session average), limits and a 5% stress line. Analysis shows what an index
   drop would likely do (beta) and which holdings move together (correlation); **Today** (`?today`, or the app's
   long-press shortcut) is a one-screen view for the phone's home screen. In early January, "your year, wrapped"
   (`tools/wrapped.js`): the year's return, best and worst sale, most traded stock, and the ranking among friends.
6. **One login.** The owner's account keeps the main portfolio's key (sealed to the account's own key, `users/{uid}.mainKey`),
   so signing in with email and password on any device opens the main portfolio directly, with Friends and Admin inside it
   (`src/site/lock.js`, "one login"). The setup key is only needed once, to store it.
5. **The site is five tabs**: Home, Holdings, Returns, Trading, More (Activity, Closed trades, Reports, Statements,
   Settings, Checks). A tab with several sections shows one at a time; Home keeps the essentials, with "More numbers"
   folded away.

## What runs when (all times Cairo)

| When | What | Code |
|---|---|---|
| Sun-Thu 3:40 pm | Market close: every EGX price once for everyone, then each setup-key portfolio's update and site refresh | `src/jobs/run_shared_market.py`, `run_market.py` |
| 4:15 pm, 6:15 pm, 11 pm | Email run: the owner's Thndr inbox sync, every opted-in account's emails, Yassin's month-end report | `run_sync.py`, `run_account_mail.py`, `run_reports.py` |
| every 5 minutes | Starts the account job for a brand-new account; warns before the alarm key expires | `kick_new_accounts.py` (`.github/workflows/new-accounts.yml`) |
| every push here | The checks (tests, build, privacy guard) | `src/tests/run_all.sh` (`.github/workflows/checks.yml`) |

The workflows that run the jobs live in the private repo (its README lists them). GitHub's own timers start runs hours
late, so cron-job.org starts them on time and GitHub's timers stay as a late backup.

## Where to start reading

1. `src/engine.js`: the core maths (ledger, average cost, monthly Modified-Dietz returns, TWR, XIRR). No DOM, no I/O.
2. `src/engine2.js`: daily valuation, attribution, income, heads-up alerts.
3. `src/statement.js`: reading Thndr's PDF statements and matching them to the ledger.
4. `src/app.html` + `src/app2.js`: the page (tabs, charts, reports). `src/build.py` puts the five files together.
5. `src/site/lock.js`: everything specific to the website: unlocking, encryption, accounts, friends, editing.
6. `src/jobs/`: the scheduled jobs. Start with `jobs_common.py` (shared plumbing) and `run_market.py`.
7. `src/tools/`: the Node scripts the jobs run (`sync.js` applies Thndr emails, `history_seed.js` builds a portfolio
   from past statements, `weekly.js`, `excel.js`, `factsheet.js` make the emails and reports).

## Security model in one paragraph

Keys: each setup-key portfolio has a P-256 key pair; the private key is wrapped by its setup key (PBKDF2-SHA256,
600,000 rounds, AES-256-GCM) and, on each device, by that device's password. An account's key pair is wrapped by its
password and by a one-time recovery code. Data is sealed with ECDH P-256 → HKDF-SHA256 → AES-256-GCM. The site loads
only its own files (a strict Content-Security-Policy) and talks only to TradingView (prices), GitHub (editing) and
Firebase. Firestore rules (`src/cloud/firestore.rules`) decide who may touch which ciphertext; a friend sees a
percentages-only profile sealed to their own key. No secret is in this repository; `src/tests/check_private.py` fails the build if anything
looks like private data.

## Build and test

```
cd src && python3 build.py && cd site && python3 build_site.py ../..   # rebuild index.html (commit it with src/)
bash src/tests/run_all.sh                                                # what CI runs: syntax, tests, tools, build, privacy
node src/tests/site_smoke.js; node src/tests/site_edit.js; node src/tests/site_cloud.js   # browser tests (Playwright)
```

`src/README.md` has the details of each step and every file.
