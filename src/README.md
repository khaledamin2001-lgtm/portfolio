# Source of the portfolio desk pages, the live site and the scheduled jobs

Everything the tracker runs is built from this directory. The repository is public and already publishes the whole built
page (`../index.html`), so nothing here is secret — but **no data or keys ever go here** (see "Secrets" below).

## What each file is

| File | What it is |
|---|---|
| `app.html` | The desk page: markup, styles and the UI code, with four placeholders `/*ENGINE*/ /*ENGINE2*/ /*STATEMENT*/ /*APP2*/` that the build fills in. |
| `engine.js` | Pure portfolio engine: ledger average cost, monthly Modified-Dietz return chain, period stats, XIRR, positions, checks. No DOM, no network. |
| `engine2.js` | Second engine layer: price book from the daily history, daily valuation, Brinson attribution, income, trailing returns, `holdingsAt`. |
| `statement.js` | Thndr statement reader: PDF text → statement/snapshot rows → reconciliation against the ledger, and the account lock (`ownerCheck`). |
| `app2.js` | The rest of the page's UI code (tabs, reports, settings, factsheet rendering). |
| `build.py` | Builds `portfolio-desk.html` (Khaled) and `yassin-desk.html` (Yassin) from the five files above and stamps them with `<meta name="pd-build">` (12 hex of the SHA-256 over the inputs + UTC build time). |
| `tools/sync.js` | Unattended Thndr inbox sync (invoices, requested and monthly statements, marks, alerts, e-mail summary). |
| `tools/excel.js`, `tools/excel.py` | Month-end Excel workbook: `excel.js` shapes the page's figures into JSON, `excel.py` writes the `.xlsx`. |
| `tools/factsheet.js` | Renders the monthly factsheet HTML with the page's own code (headless, database replaced by an export). |
| `tools/engine.js`, `tools/engine2.js`, `tools/statement.js` | **Copies** of the three root files, because `sync.js` and `excel.js` `require('./…')` them next to themselves (the jobs run all tools from one directory). Keep them identical to the root files: `build_tooldocs.py` warns when they drift; re-copy with `cp engine.js engine2.js statement.js tools/`. |
| `tools/build_tooldocs.py` | Builds the `tools/<id>` documents each page keeps in its database (see "How the jobs get their code"). |
| `site/build_site.py` | Wraps the built desk page (read-only mode) with the lock layer into the site's `index.html`, and writes `portfolios.json`, the web manifest and the icons. |
| `site/lock.js`, `site/lock.css` | The lock screen and the crypto layer of the live site (setup key → wrapped private key, password, Face ID, data decryption, TradingView live prices). |
| `site/make_keys.py` | Generates a portfolio's key pair: `keys.json` for the repo plus the setup key and private key into a secret directory. |
| `site/rotate_keys.py` | Rekey runbook for one portfolio: new pair + setup key, re-encrypts `data.enc.json` and every published export with the new public key, swaps the files into the repo only after everything verifies (nothing committed). |
| `jobs/fetch_prices.py` | The daily market job (scanner snapshot + a 10-session daily-bar backfill). **The same file as `../tools/fetch_prices.py` at the repository root** — that is the path the routine downloads; keep the two identical (`cmp jobs/fetch_prices.py ../tools/fetch_prices.py`). |
| `tests/test.js` | Excel-parity check: engine vs the original workbook. Needs the two private fixtures `seed.json` (the ledger) and `expected.json` (the workbook's headline figures) — neither is in the repository, see Tests. |
| `tests/test_dietz.js` | Modified-Dietz, Bonus, round-trip and same-day-ordering checks. The synthetic sections always run; the sections on the real database exports run only when `KHALED_EXPORT` / `YASSIN_EXPORT` (and `EXPECTED_JSON`) point at private copies, otherwise they print `SKIP`. Real figures those sections pin come from `expected.json` → `pins`, never from the file itself. |
| `tests/test_sync.js` | **Not in the repository yet.** The Thndr sync test (invoice matcher, fund convention, Bonus shares, sender verification, account lock) still quotes real statement headers and reads private raw-email fixtures; it stays private until those are replaced by synthetic ones. |
| `tests/run_all.sh` | The one entry point for the automatic checks (syntax, public-mode tests, tools on synthetic data, builds, private-data guard) — what GitHub Actions runs on every push; see "Automatic checks". |
| `tests/fixtures/make_synthetic.js` | Writes a made-up database export ("Demo Portfolio", invented prices and amounts, real EGX tickers only) for the tool smoke tests. Deterministic. |
| `tests/crypto_roundtrip.py` | Encrypts the synthetic export with `../tools/export.py` and a file with `../tools/encrypt_file.py` to a throwaway key, and decrypts both the way `site/lock.js` does. |
| `tests/site_smoke.js` | Headless-Chromium check of the published `../index.html`: portfolio picker, setup-key screen, a wrong key refused, no console errors, no CSP violations, no request leaving the site. Never unlocks. |
| `tests/check_private.py` | Private-data guard: fails on files or text that look like private data (see "Automatic checks"). Holds patterns only, no real value. |

## Build the desk pages

    cd src
    python3 build.py            # → portfolio-desk.html, yassin-desk.html; prints both sizes and the pd-build stamp

Each page is then published as its owner's Claude artifact (Khaled's and Yassin's pages are the same file with a different
`<title>`). The stamp is visible in the page source (`<meta name="pd-build" …>`) so you can tell which build is live.

## Build the live site

    cd src/site
    python3 build_site.py <path to this repository>   # reads ../portfolio-desk.html, writes index.html, portfolios.json, manifest, icons

The site itself never holds plain data: `../tools/export.py` encrypts a page's database export into `p/<id>/data.enc.json`
with that portfolio's public key, and `../tools/publish_site.py` is the one deterministic export → encrypt → commit → push
step the scheduled jobs use.

## Run the tests

    cd src
    node tests/test_dietz.js          # PASS/FAIL lines, exit 1 on any failure; the real-export sections print SKIP
    node tests/test.js                # prints "seed.json not present …" and exits 0 unless the private fixtures are available

With the private fixtures (kept outside the repository; `tests/seed.json`, `tests/expected.json` and `private/` are
gitignored if you copy them in):

    SEED_JSON=<seed.json> EXPECTED_JSON=<expected.json> node tests/test.js        # 39 stats + MV + unrealized; exit 1 on any BAD
    KHALED_EXPORT=<export-khaled> YASSIN_EXPORT=<export-yassin> EXPECTED_JSON=<expected.json> node tests/test_dietz.js

`seed.json` is Khaled's ledger as extracted from the workbook; `expected.json` holds the workbook's headline figures
(`{stats:{twr,…}, mvTotal, unreal, sameDay:{name, realized, outcome}, pins:{rebates2026ThroughAug, workbookGapAug}}`; a missing
`pins` entry only skips that one pinned value). No real figure is written into any test file —
the public tests only carry the comparison logic. `tests/test_sync.js` is not staged yet (see the table above).

## Automatic checks (GitHub Actions)

Every push to `main` and every pull request runs `.github/workflows/checks.yml` (about 2–3 minutes). A failure puts a red ✗ on
the commit in GitHub and e-mails whoever pushed it; the Actions tab shows which step failed and why. It does **not** stop
GitHub Pages from publishing — it tells you something is broken so you can fix it. Nothing in it uses secrets or private
data. Run the same checks locally from the repository root:

    bash src/tests/run_all.sh                 # steps 1–4 and 6; or name steps: run_all.sh tools build
    node src/tests/site_smoke.js              # step 5 (needs Playwright + Chromium)

| Step | What fails it |
|---|---|
| 1. Syntax | `node --check` on every `.js` under `src/`, `py_compile` on every `.py` under `src/` and `tools/`. |
| 2. Engine tests | `tests/test_dietz.js` or `tests/test.js` failing in public mode (the private sections print `SKIP`, `test.js` exits 0 without its fixtures). |
| 3. Tools on synthetic data | `tests/fixtures/make_synthetic.js` writes a made-up export; then `tools/plan.js`, `tools/weekly.js --week-ending 2026-09-10`, `tools/excel.js` + `excel.py` (workbook read back with openpyxl), `tools/sync.js` with an empty inbox (heads-up digest runs, nothing is sent), `tools/build_tooldocs.py`, `../tools/fetch_prices.py --help` and the `export.py` / `encrypt_file.py` round trip must all exit 0 with the expected output. |
| 4. Build | the tool copies differ from the root files (`engine.js`, `engine2.js`, `statement.js`, `fetch_prices.py`); `build.py` or `site/build_site.py` fails; the site lacks the CSP meta or the `pd-build` stamp or still links Google Fonts; or the committed `../index.html` (and `portfolios.json`, manifest, icons, fonts) is not what `src/` builds today — commit the rebuilt site together with the `src/` change. |
| 5. Live site | `tests/site_smoke.js` against the repository root served by `python3 -m http.server`, desktop and phone size. |
| 6. Private-data guard | `tests/check_private.py` over every tracked file: private files (`seed.json`, `expected.json`, exports, sync folders, plain workbooks/PDFs, keys), anything under `p/<id>/` that is not encrypted, e-mail addresses outside a short allowlist, runs of 7+ digits (account codes, phone numbers), money-looking figures (`N,NNN.NN`, `NNNN.NN`, `N,NNN EGP`), a Unified Code or account-holder value, API tokens and private keys. Hits print masked. To also search for the real names and figures, keep them one per line in a file **outside** the repository and run `PRIVATE_MARKERS=<that file> python3 src/tests/check_private.py`. A deliberate synthetic value on a line can be marked `private-scan: synthetic`. |

## Secrets — never in the repository

- Setup keys, private keys (`private.pk8`) and passwords live only in the owner's secret directory (created by
  `site/make_keys.py`); the repository holds only `p/<id>/keys.json` (public key, the private key **wrapped** under the
  setup key, and the password hash).
- Database exports (`sync-*/`, `export-*/`), `seed.json`, month-end workbooks and any ledger data stay outside the repo;
  `.gitignore` in this directory blocks the usual names. The only data that is committed is encrypted (`p/*/data.enc.json`,
  `p/*/exports/*.enc.json`).
- Rekeying (lost setup key, compromised device): `python3 site/rotate_keys.py <id> <old secret dir> <new secret dir>
  <repo dir> <export dir> -` — the runbook at the top of that file is the reference; it generates the new pair, re-encrypts
  `data.enc.json` and the published exports, replaces the repo files only after they verify with the new key, and never
  commits. Then hand the new setup key to the owner out of band and have every device enter it (the owner's guide page,
  Settings → "Keys and passwords", says the same in plain words).

## How the routines fetch their code

- **Inbox sync, factsheet, Excel** (Claude Code Remote routines, fresh session each time) read their code from the
  `tools/*` documents in each page's database (`tools/engine_js`, `engine2_js`, `statement`, `sync`, `excel_js`, `excel_py`,
  `factsheet`, each `{filename, content, sha256, builtAt}`). After changing any of those files rebuild the documents and save
  them with ArtifactData "set":

      cd src
      python3 tools/build_tooldocs.py --out /tmp/tooldocs [--live <dir holding tools/<id>.json exported from the page>]

  The manifest it prints (id, filename, sha256, bytes) shows what changed against the live copies; the `sha256` inside each
  document lets a job verify what it loaded.
- **Market update** (`jobs/fetch_prices.py`) is downloaded by the routine from the repository:
  `https://raw.githubusercontent.com/khaledamin2001-lgtm/portfolio/main/tools/fetch_prices.py`, then run as
  `python3 fetch_prices.py merged_assets.json` (needs `pip install websocket-client`). It prints one JSON object; the routine
  merges each entry of `histories` into `history/<month>` with "update" and writes `market/latest`, `bench/egx30` and the
  market fields of the marks to both pages. `--no-fill` skips the backfill, `--fill N` changes its depth, `--help` explains
  the output.
