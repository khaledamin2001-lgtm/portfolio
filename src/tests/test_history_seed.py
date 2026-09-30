#!/usr/bin/env python3
"""src/tools/history_seed.js on synthetic Thndr monthly statements (src/tests/fixtures/make_statement_pdf.py):

  Jun-26  the starting point; its snapshot prints the stock's ISIN, not its name (the asset is named by its ticker)
  Jul-26  no statement (a gap)
  Aug-26  opens with more cash than Jun-26 closed with; buys the same stock under its trade-line NAME: one asset (the
          readable name, the snapshot's ticker), no share adjustment, one labelled cash adjustment on Aug 1
  Sep-26  (a REQUESTED statement, e.g. asked for in the app) buys another stock; the snapshot no longer lists the first:
          its shares are taken out and the cash matched
and a second portfolio, with the shared market data (company names, daily closes):
  Jan-26  the starting point: two stocks of 1 share each under their ISINs, and fund units the snapshot does not list
  Feb-26  both stocks sold under their company names (the same share count: the names and prices tell them apart) and
          the fund sold (its statement): the stocks are tied to their tickers and the fund units are held from the start,
          so no adjustment at all
and a third, whose first statement (requested, no snapshot) comes before the first one with a snapshot:
  Apr-26  from nothing (opening cash 0): used, because its rows lead exactly to May-26's snapshot; its month-end is valued
          at the month's last closes
  and the same with a May-26 snapshot the rows do not reach: Apr-26 is not used, the portfolio starts at May-26

    python3 src/tests/test_history_seed.py <tools dir with history_seed.js, statement.js and node_modules/pdfjs-dist>
exit 0 = all pass."""
import os, sys, json, base64, shutil, tempfile, subprocess
from email.message import EmailMessage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.abspath(sys.argv[1])
fails = 0


def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"\n     {detail}"))
    fails += 0 if ok else 1


def statement(tmp, month, *extra, subject="Your monthly E-statement"):
    d = os.path.join(tmp, "pdf-" + month)
    subprocess.run([sys.executable, os.path.join(ROOT, "tests", "fixtures", "make_statement_pdf.py"), d, "--month", month, *extra], check=True, capture_output=True)
    m = EmailMessage()
    m["Authentication-Results"] = "mx.google.com; dkim=pass header.i=@thndr.app header.s=s1 header.b=x; spf=pass smtp.mailfrom=system.thndr.app"
    m["From"] = "Thndr <no-reply@system.thndr.app>"
    m["To"] = "someone@example.com"
    m["Subject"] = subject
    m.set_content("Your monthly statement is attached.")
    for f in sorted(os.listdir(d)):
        m.add_attachment(open(os.path.join(d, f), "rb").read(), maintype="application", subtype="pdf", filename=f)
    return base64.urlsafe_b64encode(m.as_bytes()).decode()


def run_seed(tmp, mails, market=None):
    inbox = os.path.join(tmp, "inbox"); os.makedirs(inbox)
    man = []
    for i, (date, raw) in mails.items():
        json.dump({"id": i, "raw": raw, "internalDate": date}, open(os.path.join(inbox, i + ".json"), "w"))
        man.append({"id": i, "subject": "Your requested E-statement - Sep 2026" if i == "m-sep" else "Your monthly E-statement", "date": date})
    json.dump(man, open(os.path.join(inbox, "manifest.json"), "w"))
    data = os.path.join(tmp, "data")
    os.makedirs(os.path.join(data, "portfolio"))
    json.dump({"data": {"name": "Seed Test", "inception": "2026-09", "cash": 0, "account": {"holder": "Test Friend", "unifiedCode": ""}, "historyImport": {"status": "pending"}}},   # private-scan: synthetic
              open(os.path.join(data, "portfolio", "settings.json"), "w"))
    for f, v in (market or {}).items():
        os.makedirs(os.path.dirname(os.path.join(data, f)), exist_ok=True)
        json.dump(v, open(os.path.join(data, f), "w"))
    out = os.path.join(tmp, "out")
    r = subprocess.run(["node", os.path.join(TOOLS, "history_seed.js"), "--data", data, "--inbox", inbox, "--out", out, "--now", "2026-09-30T12:00:00Z"], capture_output=True, text=True, timeout=300)
    res = json.loads(r.stdout.strip().splitlines()[-1])
    L = lambda f: json.load(open(os.path.join(out, f)))
    rows = [t for f in sorted(os.listdir(out)) if f.startswith("ledger_") for t in L(f)["rows"]]
    return res, rows, L("assets_update.json")["items"], L("marks.json")["months"], L("settings.json"), out


def main():
    tmp = tempfile.mkdtemp(prefix="hseed-")
    try:
        isin = "EGS60121C018"   # private-scan: synthetic
        mails = {
            "m-jun": ("1780000000000", statement(tmp, "2026-06", "--snapname", isin)),   # private-scan: synthetic
            "m-aug": ("1785000000000", statement(tmp, "2026-08", "--start", "9500", "--deposit", "1000", "--qty", "5", "--price", "90", "--close", "91", "--hold", "15", "--snapname", isin)),   # private-scan: synthetic
            "m-sep": ("1788000000000", statement(tmp, "2026-09", "--start", "10050", "--deposit", "500", "--symbol", "HRHO", "--company", "EFG Holding", "--qty", "30", "--price", "20", "--close", "21", subject="Your requested E-statement - Sep 2026")),   # private-scan: synthetic
        }
        res, rows, items, marks, st, out = run_seed(tmp, mails)
        check("three statements used (Sep-26 a requested one), Jun-26 to Sep-26, Jul-26 is a gap",
              res.get("ok") and res["first"] == "2026-06" and res["last"] == "2026-09" and res["lastTo"] == "2026-09-30" and res["months"] == 3 and res["gaps"] == ["2026-07"], json.dumps(res))
        adj = [r for r in rows if r.get("src") == "history-adjust"]
        check("the same stock under its ISIN (snapshot) and its name (trade line) is one asset, with the readable name and the ticker",
              sorted(items) == ["Commercial International Bank", "EFG Holding"] and items["Commercial International Bank"].get("symbol") == "COMI"
              and {r.get("a") for r in rows if r.get("a")} == {"Commercial International Bank", "EFG Holding"}, json.dumps(items))
        check("adjustments: Aug-26's opening cash (after the gap), then Sep-26's stock not on the snapshot and its cash",
              [(r["d"], r["t"], r.get("a"), r.get("q"), r["amt"]) for r in adj] == [("2026-08-01", "Deposit", None, None, 355), ("2026-09-30", "Sell", "Commercial International Bank", 15, 1350), ("2026-09-30", "Withdrawal", None, None, -1350)]
              and all(r["note"].startswith("Adjustment") for r in adj) and res["adjustments"] == 3 and res["adjustedMonths"] == ["2026-08", "2026-09"], json.dumps(adj))
        cash = round(sum(r["amt"] for r in rows), 2)
        sh = {}
        for r in rows:
            if r["t"] in ("Buy", "Sell"):
                sh[r["a"]] = sh.get(r["a"], 0) + (1 if r["t"] == "Buy" else -1) * r["q"]
        check("the ledger ends exactly on Sep-26's statement: cash 9,950 and 30 EFG Holding", cash == 9950 and {k: v for k, v in sh.items() if v} == {"EFG Holding": 30}, json.dumps([cash, sh]))
        check("each month's mark is its statement's; settings track from Sep-26's last day",
              sorted(marks) == ["2026-06", "2026-08", "2026-09"] and all(m["source"] == "statement" for m in marks.values()) and marks["2026-09"]["securities"] == 630
              and st["inception"] == "2026-06" and st["trackFrom"] == "2026-09-30" and st["cash"] == 9950 and st["historyImport"]["status"] == "done", json.dumps([marks, st.get("historyImport")]))
        check("one import per month, posted by the history import", sorted(f for f in os.listdir(out) if f.startswith("import_")) == ["import_2026-06.json", "import_2026-08.json", "import_2026-09.json"])

        # the second portfolio: names and fund units the snapshots do not give
        tmp2 = os.path.join(tmp, "b"); os.makedirs(tmp2)
        isin2 = "EGS38191C010"   # private-scan: synthetic
        mails = {
            "b-jan": ("1767300000000", statement(tmp2, "2026-01", "--snap", f"ABUK|{isin}|1|48", "--snap", f"OCDI|{isin2}|1|18")),   # private-scan: synthetic
            "b-feb": ("1770000000000", statement(tmp2, "2026-02", "--start", "9145", "--deposit", "1000", "--qty", "5", "--price", "90", "--close", "91", "--hold", "15",   # private-scan: synthetic
                                                 "--row", "5|Sell Abu Qir Fertilizers ( 1 @ 49.02 )|49.02", "--row", "5|Sell SODIC ( 1 @ 17.32 )|17.32",
                                                 "--row", "10|Transfer From Mutual Funds Account|1550", "--mfrow", "9|Sell CCB ( 100 @ 15.50 EGP )|1550")),
        }
        market = {"market/latest.json": {"quotes": {"ABUK": {"name": "Abou Kir Fertilizers & Chemical Industries Co.", "price": 50}, "OCDI": {"name": "Six of October Development & Investment (SODIC)", "price": 18},
                                                    "COMI": {"name": "Commercial International Bank (Egypt)", "price": 90}, "ORAS": {"name": "Orascom Construction Plc", "price": 300}}},
                  "history/2026-02.json": {"month": "2026-02", "days": {"2026-02-05": {"ABUK": 49.1, "OCDI": 17.2, "COMI": 90, "ORAS": 300}}}}
        res, rows, items, marks, st, out = run_seed(tmp2, mails, market)
        check("names: both stocks sold under their company names are tied to their tickers (one asset each, the readable name)",
              res.get("ok") and {n: a.get("symbol") for n, a in items.items() if not a.get("fund")} == {"Commercial International Bank": "COMI", "Abu Qir Fertilizers": "ABUK", "SODIC": "OCDI"}, json.dumps([res, items]))
        check("funds: the units sold in Feb-26 are held from the start (not on the Jan-26 snapshot), priced at that sale's NAV",
              res["openingFunds"] == ["CCB"] and [(r["a"], r["q"], r["p"]) for r in rows if r.get("opening") and r.get("acc") == "MF"] == [("CCB", 100, 15.5)], json.dumps([r for r in rows if r.get("opening")]))
        check("no adjustment at all: every month ends on Thndr's holdings and cash from the statements' own rows", res["adjustments"] == 0 and not [r for r in rows if r.get("src") == "history-adjust"], json.dumps([r for r in rows if r.get("src") == "history-adjust"]))
        sh = {}
        for r in rows:
            if r["t"] in ("Buy", "Sell"):
                sh[r["a"]] = sh.get(r["a"], 0) + (1 if r["t"] == "Buy" else -1) * r["q"]
        check("the ledger ends on Feb-26's statement: 15 COMI, nothing else, cash 11,311.34", {k: v for k, v in sh.items() if abs(v) > 1e-9} == {"Commercial International Bank": 15} and round(sum(r["amt"] for r in rows), 2) == 11311.34, json.dumps([sh, sum(r["amt"] for r in rows)]))   # private-scan: synthetic
        check("Jan-26's month-end includes the fund units the snapshot left out (926 stocks + 1,550 fund)", marks["2026-01"]["securities"] == 2476, json.dumps(marks))
        # the third: an earlier statement without a snapshot
        for hold, used in (("15", True), ("20", False)):
            tmp3 = os.path.join(tmp, "c" + hold); os.makedirs(tmp3)
            mails = {"c-apr": ("1777500000000", statement(tmp3, "2026-04", "--nosnap", subject="Your requested E-statement - Apr 2026")),   # private-scan: synthetic
                     "c-may": ("1780200000000", statement(tmp3, "2026-05", "--start", "9145", "--deposit", "1000", "--qty", "5", "--price", "90", "--close", "91", "--hold", hold))}   # private-scan: synthetic
            market = {"history/2026-04.json": {"month": "2026-04", "days": {"2026-04-30": {"COMI": 86}}}}
            res, rows, items, marks, st, out = run_seed(tmp3, mails, market)
            if used:
                check("an earlier statement without a snapshot is used when its rows reach the first snapshot exactly: the portfolio starts from nothing in Apr-26",
                      res.get("earlier") == {"from": "2026-04", "used": True} and st["inception"] == "2026-04" and res["adjustments"] == 0 and not [r for r in rows if r.get("opening")]
                      and sorted((r["d"], r["t"]) for r in rows) == [("2026-04-01", "Deposit"), ("2026-04-02", "Buy"), ("2026-05-01", "Deposit"), ("2026-05-02", "Buy")], json.dumps([res, rows])[:700])
                check("its month-end (no snapshot) is valued at the month's last close, marked as an estimate",
                      marks["2026-04"] == {"cash": 9145, "securities": 860, "provisional": False, "source": "price-estimate", "note": marks["2026-04"].get("note")} and marks["2026-05"]["source"] == "statement", json.dumps(marks))
            else:
                check("... and not used when they do not (the account held something before): the portfolio starts at May-26's snapshot",
                      res.get("earlier") == {"from": "2026-04", "used": False} and st["inception"] == "2026-05" and [r["t"] for r in rows if r.get("opening")] == ["Deposit", "Buy"], json.dumps([res, rows])[:700])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("ALL PASS" if not fails else f"{fails} FAILED")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
