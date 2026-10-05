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
  │   3:40 pm  market close  → every EGX price (TradingView) → shared data    │
  │   4:15 / 6:15 / 11 pm    → each opted-in account: its Thndr emails        │
  │                            (its own Gmail), its alerts and reports        │
  │  shared/ = the public market data (plain JSON); no portfolio lives here   │
  └──────────────┬───────────────────────────────────────┬────────────────────┘
                 │ publish: sealed to the members key     │ email (Portfolio Desk mailbox)
                 ▼                                       ▼
  ┌──── this repo, served by GitHub Pages ────┐     each account's own address
  │ index.html  (built from src/)             │
  │ m/market.enc.json     shared market data  │◄──── browser: sign in, unlock with the
  │ a/<hash>/exports/     month-end files     │      password or Face ID, decrypt and
  │ keys/mail.json        the jobs' mail key  │      compute everything locally
  └───────────────────────────────────────────┘
                                                ┌─ Firebase (Auth + Firestore) ─┐
             every portfolio ─────────────────► │ users/{uid}/docs: encrypted   │
                                                │ friend links, shared copies   │
                                                └───────────────────────────────┘
```

1. **One place for every portfolio: accounts.** Sign-up with email + password (Firebase Auth), the site owner's own
   portfolio included. The browser encrypts every document to the account's own key before it reaches Firestore. The
   jobs can read an account only if it opted in (email updates or Thndr emails), by sealing a package to the mail key
   (`keys/mail.json`). An account that connects its Gmail gets its Thndr invoices and statements added three times a
   day ("Check now" starts a check at once); "Build it from my Thndr emails" builds a new portfolio from its past
   statements.
2. **Friends.** Friends find each other by @username (`handles/{handle}`, taken automatically once the email is
   confirmed) or by email (`directory/{email}`); see `src/site/lock.js` (friends) and `src/cloud/firestore.rules`.
   Friends compare in **percentages only**: what one shares with another is a profile of returns by month, holdings by
   weight and trades as % (`engine2.js` `friendProfile`), never an amount. On the 1st of the month each account can get
   a leaderboard email ranking it and its friends on last month's return.
3. **Your rules.** Each portfolio can switch on its own limits (Holdings tab → Your limits: the most one stock and one
   sector may be of the whole portfolio); crossing one shows on the Overview and is emailed once. Early each month a
   trading report card email scores last month's sales next to the month before (`tools/report_card.js`).
4. **Before the open, after the close and on the go.** Sunday to Thursday at 9:00 Cairo a morning brief email and at
   4:30 pm an after-close recap (`jobs/run_morning.py`): the session, each holding's move, ex-dividend and earnings dates,
   holdings near their levels, unusual volume (also a heads-up alert: 3× the 30-session average), limits and (mornings)
   a 5% stress line. Analysis shows what an index drop would likely do (beta) and which holdings move together
   (correlation); **Today** (`?today`, or the app's long-press shortcut) is a one-screen view for the phone's home
   screen. In early January, "your year, wrapped" (`tools/wrapped.js`): the year's return, best and worst sale, most
   traded stock, and the ranking among friends.
5. **The site is five tabs**: Home, Holdings, Returns, Trading, More (Activity, Closed trades, Reports, Statements,
   Settings, Checks). A tab with several sections shows one at a time; Home keeps the essentials, with "More numbers"
   folded away.

## What runs when (all times Cairo)

| When | What | Code |
|---|---|---|
| Sun-Thu 3:40 pm | Market close: every EGX price, the index and macro figures, once for everyone | `src/jobs/run_shared_market.py` |
| 4:15 pm, 6:15 pm, 11 pm | Email run: the gate, then every opted-in account (its Thndr emails, heads-up, weekly summary, month-end report, friends) | `email_gate.py`, `run_account_mail.py` |
| every 5 minutes | Starts the account job for a brand-new account or a "Check now"; warns before the alarm key expires; Sun-Thu at 9:00 the morning brief and at 4:30 pm the after-close recap | `kick_new_accounts.py` (`.github/workflows/new-accounts.yml`), `run_morning.py` |
| every push here | The checks (tests, build, privacy guard) | `src/tests/run_all.sh` (`.github/workflows/checks.yml`) |

The workflows that run the jobs live in the private repo (its README lists them). GitHub's own timers start runs hours
late, so cron-job.org starts them on time and GitHub's timers stay as a late backup.

## Where to start reading

1. `src/engine.js`: the core maths (ledger, average cost, monthly Modified-Dietz returns, TWR, XIRR). No DOM, no I/O.
2. `src/engine2.js`: daily valuation, attribution, income, heads-up alerts.
3. `src/statement.js`: reading Thndr's PDF statements and matching them to the ledger.
4. `src/app.html` + `src/app2.js`: the page (tabs, charts, reports). `src/build.py` puts the five files together.
5. `src/site/lock.js`: everything specific to the website: accounts, unlocking, encryption, saving, friends.
6. `src/jobs/`: the scheduled jobs. Start with `jobs_common.py` (shared plumbing) and `run_account_mail.py`.
7. `src/tools/`: the Node scripts the jobs run (`sync.js` applies Thndr emails, `history_seed.js` builds a portfolio
   from past statements, `weekly.js`, `excel.js`, `factsheet.js` make the emails and reports). `read_account.js` is
   for an account owner, not the jobs: with their own email and password it prints their portfolio as JSON (holdings,
   value, returns, trades), read only, for their own assistant.

## Security model in one paragraph

Keys: each account has a P-256 key pair; the private key is wrapped by its password (PBKDF2-SHA256, AES-256-GCM) and
by a one-time recovery code (600,000 rounds), and on each device by that password again (or the passkey's PRF output for
Face ID). The jobs' mail key is wrapped by a setup key held only as a secret of the private repo. Data is sealed with
ECDH P-256 → HKDF-SHA256 → AES-256-GCM. The site loads only its own files (a strict Content-Security-Policy) and talks
only to TradingView (prices) and Firebase. Firestore rules (`src/cloud/firestore.rules`) decide who may touch which ciphertext; a friend sees a
percentages-only profile sealed to their own key. No secret is in this repository; `src/tests/check_private.py` fails the build if anything
looks like private data.

## Build and test

```
cd src && python3 build.py && cd site && python3 build_site.py ../..   # rebuild index.html (commit it with src/)
bash src/tests/run_all.sh                                                # what CI runs: syntax, tests, tools, build, privacy
node src/tests/site_smoke.js .; node src/tests/site_cloud.js   # browser tests (Playwright)
```

`src/README.md` has the details of each step and every file.
