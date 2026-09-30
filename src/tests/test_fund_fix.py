#!/usr/bin/env python3
"""src/tools/fund_fix.js on a synthetic Thndr statement with a fund account page (src/tests/fixtures/make_statement_pdf.py):
an unconfirmed fund buy two days off with a different NAV is corrected to the statement; one that matches is confirmed
with a note; one the statement does not show is listed and left alone; statement-confirmed rows are not touched.

    python3 src/tests/test_fund_fix.py <tools dir with fund_fix.js, statement.js and node_modules/pdfjs-dist>
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


def main():
    tmp = tempfile.mkdtemp(prefix="fundfix-")
    try:
        d = os.path.join(tmp, "pdf")
        subprocess.run([sys.executable, os.path.join(ROOT, "tests", "fixtures", "make_statement_pdf.py"), d, "--month", "2025-10",
                        "--row", "6|Transfer To Mutual Funds Account|-1510", "--row", "20|Transfer To Mutual Funds Account|-800",
                        "--mfrow", "6|Buy CCB ( 100 @ 15.10 EGP )|-1510", "--mfrow", "20|Buy CCB ( 50 @ 16.00 EGP )|-800"], check=True, capture_output=True)
        m = EmailMessage()
        m["Authentication-Results"] = "mx.google.com; dkim=pass header.i=@thndr.app header.s=s1 header.b=x; spf=pass smtp.mailfrom=system.thndr.app"
        m["From"] = "Thndr <no-reply@system.thndr.app>"
        m["Subject"] = "Your requested E-statement - Oct 2025"
        m.set_content("x")
        for f in sorted(os.listdir(d)):
            m.add_attachment(open(os.path.join(d, f), "rb").read(), maintype="application", subtype="pdf", filename=f)
        inbox = os.path.join(tmp, "inbox"); os.makedirs(inbox)
        json.dump({"id": "s1", "raw": base64.urlsafe_b64encode(m.as_bytes()).decode()}, open(os.path.join(inbox, "s1.json"), "w"))
        json.dump([{"id": "s1", "subject": "Your requested E-statement - Oct 2025", "date": "1761900000000"}], open(os.path.join(inbox, "manifest.json"), "w"))   # private-scan: synthetic
        data = os.path.join(tmp, "data")
        for c in ("portfolio", "ledger"):
            os.makedirs(os.path.join(data, c))
        json.dump({"data": {"name": "Fund Test", "account": {"holder": "Test Friend", "unifiedCode": ""}}}, open(os.path.join(data, "portfolio", "settings.json"), "w"))   # private-scan: synthetic
        json.dump({"data": {"items": {"CCB": {"name": "CCB", "fund": True, "sector": "Mutual Funds"}}}}, open(os.path.join(data, "portfolio", "assets.json"), "w"))
        rows = [{"id": "a", "d": "2025-10-08", "t": "Buy", "a": "CCB", "q": 100, "p": 15.0, "amt": -1500, "acc": "MF"},
                {"id": "b", "d": "2025-10-20", "t": "Buy", "a": "CCB", "q": 50, "p": 16.0, "amt": -800, "acc": "MF"},
                {"id": "c", "d": "2025-10-25", "t": "Sell", "a": "CCB", "q": 10, "p": 16.2, "amt": 162, "acc": "MF"},
                {"id": "d", "d": "2025-10-02", "t": "Buy", "a": "Commercial International Bank", "q": 10, "p": 85.5, "amt": -855, "acc": "Main", "src": "stmt-2025-10"}]
        json.dump({"data": {"rows": rows}}, open(os.path.join(data, "ledger", "y2025.json"), "w"))
        out = os.path.join(tmp, "out")
        r = subprocess.run(["node", os.path.join(TOOLS, "fund_fix.js"), "--data", data, "--inbox", inbox, "--out", out], capture_output=True, text=True, timeout=300)
        res = json.loads(r.stdout.strip().splitlines()[-1])
        check("counts: 3 unconfirmed fund rows, 1 corrected, 1 confirmed, 1 not on the statement, 2025 changed",
              res.get("ok") and (res["unconfirmed"], res["corrected"], res["confirmed"], res["notOnStatements"], res["changedYears"]) == (3, 1, 1, 1, ["2025"]), json.dumps(res) + r.stderr[-300:])
        new = {t["id"]: t for t in json.load(open(os.path.join(out, "write", "ledger_y2025.json")))["rows"]}
        a, b, c, dd = new["a"], new["b"], new["c"], new["d"]
        check("the buy two days off is moved to the statement's date, NAV and amount, with a note",
              (a["d"], a["q"], a["p"], a["amt"]) == ("2025-10-06", 100, 15.1, -1510) and "corrected: checked against the Thndr Oct-25 statement" in a["note"], json.dumps(a))
        check("the matching buy keeps its figures and is noted as checked", (b["d"], b["q"], b["p"], b["amt"]) == ("2025-10-20", 50, 16.0, -800) and b["note"] == "checked against the Thndr Oct-25 statement", json.dumps(b))
        check("the sell the statement does not show is left alone", c == rows[2], json.dumps(c))
        check("a statement-confirmed stock row is not touched", dd == rows[3], json.dumps(dd))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("ALL PASS" if not fails else f"{fails} FAILED")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
