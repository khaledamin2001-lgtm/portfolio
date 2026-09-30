#!/usr/bin/env python3
"""Synthetic Thndr-style statement PDFs for the tests (made-up account, names and figures; no library needed).

    python3 make_statement_pdf.py <out dir> [--code 1234567] [--name "Test Friend"] [--month 2026-09] [--symbol COMI]   # private-scan: synthetic
        [--company "Commercial International Bank"] [--qty 10] [--price 85.50] [--close 86.00] [--deposit 10000]
        [--start 0] [--hold N] [--snapname LABEL]   (opening cash; shares on the snapshot, default --qty; the snapshot's
        label for the stock, default --company: an ISIN such as EGS60121C018 is printed the way Thndr prints one)   # private-scan: synthetic

Writes <out dir>/account-statement.pdf (the brokerage cash account: header with the holder name and Unified Code, the
period "From d/m/yyyy To d/m/yyyy", Start/End Balance and two rows: a deposit on the 1st and a buy on the 2nd) and
<out dir>/position-snapshot.pdf (the month-end "Position Snapshot" with one stock holding), laid out the way
src/statement.js reads Thndr's PDFs (one text line per row). Prints one JSON line with the file names and the figures."""
import os, sys, json, argparse, calendar


def pdf(lines):
    """A one-page PDF with each line drawn at the left margin, top to bottom (Helvetica 10 pt)."""
    esc = lambda s: s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    ops = ["BT", "/F1 10 Tf"]
    y = 800
    for l in lines:
        ops.append(f"1 0 0 1 40 {y} Tm ({esc(l)}) Tj")
        y -= 16
    ops.append("ET")
    stream = "\n".join(ops).encode("latin-1")
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
            b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]
    out, offs = bytearray(b"%PDF-1.4\n"), []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--code", default="1234567")   # private-scan: synthetic
    ap.add_argument("--name", default="Test Friend")
    ap.add_argument("--month", default="2026-09")
    ap.add_argument("--symbol", default="COMI")
    ap.add_argument("--company", default="Commercial International Bank")
    ap.add_argument("--qty", type=float, default=10)
    ap.add_argument("--price", type=float, default=85.50)
    ap.add_argument("--close", type=float, default=86.00)
    ap.add_argument("--deposit", type=float, default=10000)
    ap.add_argument("--start", type=float, default=0)
    ap.add_argument("--hold", type=float, default=None)
    ap.add_argument("--snapname", default=None)
    a = ap.parse_args()
    y, m = int(a.month[:4]), int(a.month[5:])
    last = calendar.monthrange(y, m)[1]
    f = lambda x: f"{x:,.2f}"
    cost = round(a.qty * a.price, 2)
    end = round(a.start + a.deposit - cost, 2)
    hold = a.qty if a.hold is None else a.hold
    q = int(a.qty) if a.qty == int(a.qty) else a.qty
    hq = int(hold) if hold == int(hold) else hold
    acct = ["Thndr Securities Brokerage", "Account Statement", f"Client Name {a.name} Unified Code {a.code}",
            f"From 1/{m}/{y} To {last}/{m}/{y}", f"Start Balance {f(a.start)}", "Date Description Value Balance",
            f"1/{m}/{y} Deposit {f(a.deposit)} {f(a.start + a.deposit)}",
            f"2/{m}/{y} Buy {a.company} ( {q} @ {a.price:.2f} ) -{f(cost)} {f(end)}",
            f"End Balance {f(end)}"]
    snap = ["Thndr Securities Brokerage", f"Client Name {a.name} Unified Code {a.code}",
            f"Position Snapshot as of {calendar.month_name[m]} {last}, {y}", "Stocks holdings",
            "Ticker Name Quantity Price Value",
            f"{a.symbol} {a.snapname or a.company} EGP {hq} {a.close:.2f} {f(round(hold * a.close, 2))}"]
    os.makedirs(a.out, exist_ok=True)
    for name, lines in (("account-statement.pdf", acct), ("position-snapshot.pdf", snap)):
        with open(os.path.join(a.out, name), "wb") as fh:
            fh.write(pdf(lines))
    print(json.dumps({"ok": True, "files": ["account-statement.pdf", "position-snapshot.pdf"], "code": a.code, "month": a.month,
                      "deposit": a.deposit, "buy": {"symbol": a.symbol, "qty": a.qty, "price": a.price, "cost": cost}, "cashEnd": end,
                      "securities": round(hold * a.close, 2)}))


if __name__ == "__main__":
    main()
