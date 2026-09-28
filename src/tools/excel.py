#!/usr/bin/env python3
"""Month-end Excel workbook from the JSON that excel.js writes.
   python3 excel.py <data.json> <out.xlsx>      (also writes <out.xlsx>.b64 for emailing)
   Sheets: Summary, Monthly, Holdings, Ledger, Closed trades, Income, Attribution, Marks & inputs.
   Values are the page's figures; the Monthly sheet keeps live formulas for the return chain so the workbook stays auditable."""
import sys, json, base64, datetime
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

d = json.load(open(sys.argv[1]))
wb = Workbook()
INK = "0F1A17"; ACC = "0B6E5F"; RULE = "DAE2DE"; INPUT = "2256C7"
H = Font(bold=True, color="FFFFFF", size=10); HF = PatternFill("solid", fgColor=ACC)
T = Font(bold=True, size=14, color=INK); S = Font(size=9, color="6F7D78"); B = Font(bold=True)
thin = Side(style="thin", color=RULE); bottom = Border(bottom=thin)
PCT = "+0.0%;-0.0%;0.0%"; PCT2 = "+0.00%;-0.00%;0.00%"; EGP = "#,##0;(#,##0);-"; EGP2 = "#,##0.00;(#,##0.00);-"; NUM = "0.00"; DT = "yyyy-mm-dd"
MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
lbl = lambda m: f"{MON[int(m[5:7]) - 1]}-{m[2:4]}"

def sheet(title, header, rows, fmts=None, widths=None, freeze="A2", note=None, start=1):
    ws = wb.create_sheet(title) if wb.active.title != "Sheet" else wb.active
    ws.title = title
    r0 = start
    if note:
        ws.cell(r0, 1, note).font = S; r0 += 2
    for j, h in enumerate(header, 1):
        c = ws.cell(r0, j, h); c.font = H; c.fill = HF; c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.row_dimensions[r0].height = 30
    for i, row in enumerate(rows, r0 + 1):
        for j, v in enumerate(row, 1):
            c = ws.cell(i, j, v)
            if fmts and fmts[j - 1]: c.number_format = fmts[j - 1]
            if isinstance(v, (int, float)) and not isinstance(v, bool): c.alignment = Alignment(horizontal="right")
    for j, w in enumerate(widths or [14] * len(header), 1): ws.column_dimensions[get_column_letter(j)].width = w
    ws.freeze_panes = ws.cell(r0 + 1, 1)
    ws.sheet_view.showGridLines = False
    return ws, r0

# ---------- Summary ----------
ws = wb.active; ws.title = "Summary"; ws.sheet_view.showGridLines = False
ws["A1"] = d["name"]; ws["A1"].font = T
ws["A2"] = f"Month-end report · {lbl(d['month'])} · benchmark {d['benchmark']} · EGP · inception {lbl(d['inception'])} · generated {d['generated']}"; ws["A2"].font = S
r = 4
groups = [("Value", ["Portfolio value (EGP)", "Cash (EGP)", "Securities (EGP)"]),
          ("Returns", ["Month return", "Benchmark month return", "Month alpha", "Since inception TWR", "Since inception benchmark", "Alpha since inception", "Annualized TWR", "Money-weighted return (XIRR, annual)", "Return in USD", "Real return (after CPI)"]),
          ("Risk", ["Monthly volatility", "Annualized volatility", "Sharpe ratio", "Sortino ratio", "Calmar ratio", "Beta vs benchmark", "Correlation", "Tracking error (annual)", "Upside capture", "Downside capture", "Max drawdown (month-end)", "Positive months", "Months in period", "Months beating benchmark"]),
          ("Capital", ["Opening value before inception (EGP)", "Deposits since inception (EGP)", "Withdrawals since inception (EGP)", "Investment gain since inception (EGP)", "Dividends received since inception (EGP)", "Realized trading P/L (EGP)", "Risk-free rate used"])]
pct_keys = {"Month return", "Benchmark month return", "Month alpha", "Since inception TWR", "Since inception benchmark", "Alpha since inception", "Annualized TWR", "Money-weighted return (XIRR, annual)", "Return in USD", "Real return (after CPI)", "Monthly volatility", "Annualized volatility", "Tracking error (annual)", "Upside capture", "Downside capture", "Max drawdown (month-end)", "Risk-free rate used"}
for g, keys in groups:
    ws.cell(r, 1, g.upper()).font = Font(bold=True, size=9, color="6F7D78"); r += 1
    for k in keys:
        v = d["summary"].get(k)
        ws.cell(r, 1, k).border = bottom
        c = ws.cell(r, 2, v if v is not None else "—"); c.border = bottom; c.alignment = Alignment(horizontal="right")
        c.number_format = PCT if k in pct_keys else EGP if "(EGP)" in k else NUM if isinstance(v, float) else "0"
        r += 1
    r += 1
ws.cell(r, 1, "TRAILING RETURNS").font = Font(bold=True, size=9, color="6F7D78"); r += 1
for j, h in enumerate(["Period", "Portfolio", "Benchmark", "Difference"], 1):
    c = ws.cell(r, j, h); c.font = H; c.fill = HF
r += 1
for t in d["trailing"]:
    ws.cell(r, 1, t["period"])
    for j, k in enumerate(["portfolio", "benchmark", "difference"], 2):
        c = ws.cell(r, j, t[k] if t[k] is not None else "—"); c.number_format = PCT; c.alignment = Alignment(horizontal="right")
    r += 1
ws.column_dimensions["A"].width = 42; ws.column_dimensions["B"].width = 18; ws.column_dimensions["C"].width = 14; ws.column_dimensions["D"].width = 14

# ---------- Monthly (with live formulas for the return chain) ----------
# Columns: A Month, B Opening, C Deposits, D Withdrawals, E Net flow, F Day-weighted flow, G Dividends, H Cash, I Securities,
#          J Month-end value, K Return, L Benchmark, M Alpha, N Cumulative, O Cumulative benchmark, P Drawdown, Q..W inputs/source
hdr = ["Month", "Opening value", "Deposits", "Withdrawals", "Net flow", "Day-weighted flow", "Dividends", "Cash", "Securities", "Month-end value", "Return", "Benchmark", "Alpha", "Cumulative", "Cumulative benchmark", "Drawdown", "EGX30 Capped close", "USD/EGP", "CPI MoM", "USD return", "Real return", "Trades", "Month-end source"]
rows = []
for i, m in enumerate(d["monthly"]):
    R = 4 + i  # note row, blank, header, then data
    rows.append([lbl(m["month"]), m["opening"], m["deposits"], m["withdrawals"], f"=C{R}-D{R}", m.get("weightedFlow", m["deposits"] - m["withdrawals"]), m["dividends"], m["cash"], m["securities"], f"=H{R}+I{R}",
                 f"=(J{R}-B{R}-E{R})/(B{R}+F{R})", m["bench"], f"=K{R}-L{R}", f"=(1+K{R})*{'(1+N' + str(R - 1) + ')' if i else '1'}-1", f"=(1+L{R})*{'(1+O' + str(R - 1) + ')' if i else '1'}-1",
                 f"=(1+N{R})/MAX(1,1+MAX($N$4:N{R}))-1", m["benchClose"], m["usdegp"], m["cpi"], m["usdRet"], m["realRet"], m["trades"], m["source"]])
fm = [None, EGP, EGP, EGP, EGP, EGP2, EGP, EGP2, EGP2, EGP2, PCT2, PCT2, PCT2, PCT, PCT, PCT, "#,##0.0", "0.00", PCT2, PCT, PCT, "0", None]
sheet("Monthly", hdr, rows, fm, [9, 14, 12, 12, 12, 13, 11, 13, 14, 15, 10, 11, 10, 11, 12, 10, 13, 9, 9, 10, 10, 7, 22],
      note="Return = Modified Dietz: (month-end value − opening − net flow) ÷ (opening + day-weighted net flow), where each deposit or withdrawal is weighted by the share of the month it was invested (a flow on the 1st counts fully); months are chain-linked. Columns E, J, K, M, N, O, P are live formulas; the rest are the page's figures.")

# ---------- Holdings ----------
rows = [[h["symbol"], h["name"], h["sector"], h["shares"], h["avgCost"], h["price"], h["priceSource"], h["cost"], h["mv"], h["unreal"], h["ret"], h["weight"], h["dividends"]] for h in d["holdings"]]
rows.append(["", "Cash", "Cash", None, None, None, "", None, d["holdingsCash"], None, None, (d["holdingsCash"] / d["holdingsTotal"]) if d["holdingsTotal"] else 0, None])
rows.append(["", "TOTAL", "", None, None, None, "", sum(h["cost"] for h in d["holdings"]), d["holdingsTotal"], sum((h["unreal"] or 0) for h in d["holdings"]), None, 1, sum(h["dividends"] for h in d["holdings"])])
ws, r0 = sheet("Holdings", ["Symbol", "Company", "Sector", "Shares", "Avg cost", "Price", "Price source", "Cost basis", "Market value", "Unrealized P/L", "Return", "Weight", "Dividends received"], rows,
      [None, None, None, "#,##0.####", "0.000", "0.00", None, EGP, EGP, EGP, PCT, "0.0%", EGP], [10, 38, 22, 12, 10, 9, 11, 14, 14, 14, 9, 8, 13],
      note=f"Positions at {d['month']} month-end: stocks at closing prices, funds at their last traded NAV (gold funds moved with the 24K gold price). Average-cost basis.")
for c in ws[r0 + 1 + len(rows)]: c.font = B

# ---------- Ledger ----------
rows = [[datetime.date.fromisoformat(t["date"]), t["type"], t["asset"], t["symbol"], t["shares"], t["price"], t["amount"], t["basisSold"], t["realized"], t["account"], t["source"], t["note"]] for t in d["ledger"]]
sheet("Ledger", ["Date", "Type", "Asset", "Symbol", "Shares", "Price", "Net amount", "Cost basis sold", "Realized P/L", "Account", "Source", "Note"], rows,
      [DT, None, None, None, "#,##0.####", "0.####", EGP2, EGP2, EGP2, None, None, None], [11, 10, 38, 9, 12, 10, 14, 14, 13, 8, 16, 30],
      note="Every transaction as reconciled with Thndr statements. Buys, withdrawals and fees are negative; sells, deposits, dividends and rebates are positive.")

# ---------- Closed trades ----------
rows = [[c["name"], c["symbol"], datetime.date.fromisoformat(c["firstBuy"]), datetime.date.fromisoformat(c["lastSell"]), c["holdDays"], c["buyCost"], c["proceeds"], c["dividends"], c["total"], c["roi"], c["outcome"]] for c in d["closed"]]
sheet("Closed trades", ["Asset", "Symbol", "First buy", "Last sell", "Days held", "Buy cost", "Sell proceeds", "Dividends", "Total P/L", "ROI", "Outcome"], rows,
      [None, None, DT, DT, "0", EGP, EGP, EGP, EGP, PCT, None], [38, 10, 11, 11, 9, 13, 13, 11, 13, 9, 9],
      note="Positions fully exited by month-end. P/L covers every lot since the first buy, including dividends.")

# ---------- Income ----------
rows = [[Y["year"]] + Y["div"] + [Y["divT"], Y["rebT"], Y["feeT"], Y["net"]] for Y in d["incomeYears"]]
ws, r0 = sheet("Income", ["Year"] + MON + ["Dividends", "Rebates", "Fees", "Net income"], rows, [None] + [EGP] * 16, [8] + [9] * 12 + [12, 11, 10, 12],
      note="Dividends by month (EGP). Rebates are Thndr commission kickbacks; fees are subscriptions, custody and transfers.")
r = r0 + len(rows) + 3
ws.cell(r, 1, "DIVIDENDS BY STOCK").font = Font(bold=True, size=9, color="6F7D78"); r += 1
for j, h in enumerate(["Stock", "Symbol", "Payments", "Total received", "Last paid"], 1):
    c = ws.cell(r, j, h); c.font = H; c.fill = HF
r += 1
for x in d["incomeByStock"]:
    ws.cell(r, 1, x["name"]); ws.cell(r, 2, x["symbol"]); ws.cell(r, 3, x["payments"]); c = ws.cell(r, 4, x["total"]); c.number_format = EGP
    ws.cell(r, 5, datetime.date.fromisoformat(x["last"]) if x["last"] else "").number_format = DT; r += 1
ws.column_dimensions["A"].width = 30

# ---------- Attribution ----------
A = d.get("attribution")
if A:
    rows = [[s["sector"], s["wp"], s["wb"], s["wp"] - s["wb"], s["rp"], s["rb"], s["alloc"], s["sel"], s["total"]] for s in A["sectors"]]
    rows.append(["TOTAL", 1, 1, 0, None, None, A["allocation"], A["selection"], A["allocation"] + A["selection"]])
    ws, r0 = sheet("Attribution", ["Sector", "Portfolio weight", "Index weight", "Active weight", "Portfolio return", "Index return", "Allocation", "Selection", "Total"], rows,
          [None, "0.0%", "0.0%", "+0.0%;-0.0%;0.0%", PCT, PCT, PCT2, PCT2, PCT2], [26, 12, 12, 12, 12, 12, 11, 11, 11],
          note=f"Brinson-Fachler vs a free-float model of EGX30 Capped, since inception to {lbl(d['month'])}, Carino-linked. Active return {A['active']:+.2%} = allocation {A['allocation']:+.2%} + selection {A['selection']:+.2%} + trading {A['trading']:+.2%} + index model gap {A['replication']:+.2%}.")
    for c in ws[r0 + len(rows)]: c.font = B

# ---------- Marks & inputs ----------
rows = [[lbl(m["month"]), m.get("cash"), m.get("securities"), m.get("benchClose"), m.get("benchReturn"), m.get("usdegp"), m.get("cpi"), m.get("source", "typed"), m.get("cpiSource", ""), m.get("usdegpSource", ""), m.get("note", "")] for m in d["marks"]]
ws, r0 = sheet("Marks & inputs", ["Month", "Cash", "Securities", "EGX30 Capped close", "EGX30 Capped % (typed)", "USD/EGP", "CPI MoM", "Month-end source", "CPI source", "USD/EGP source", "Note"], rows,
      [None, EGP2, EGP2, "#,##0.0", PCT2, "0.00", PCT2, None, None, None, None], [9, 14, 15, 14, 12, 9, 9, 15, 30, 30, 30],
      note="Month-end inputs behind every figure. Blue = values entered or imported (spreadsheet convention for hard-coded inputs).")
for row in ws.iter_rows(min_row=r0 + 1, max_row=r0 + len(rows), min_col=2, max_col=7):
    for c in row: c.font = Font(color=INPUT)
r = r0 + len(rows) + 3
ws.cell(r, 1, "SETTINGS").font = Font(bold=True, size=9, color="6F7D78"); r += 1
for k in ["name", "inception", "openingValue", "benchCloseStart", "fxStart", "riskFree", "cash", "cashDate", "cashSource", "openThreshold", "staleDays"]:
    ws.cell(r, 1, k); c = ws.cell(r, 2, d["settings"].get(k)); c.font = Font(color=INPUT); r += 1
r += 2
ws.cell(r, 1, "ASSETS").font = Font(bold=True, size=9, color="6F7D78"); r += 1
for j, h in enumerate(["Asset", "Symbol", "Sector", "Target", "Stop loss", "Fund"], 1):
    c = ws.cell(r, j, h); c.font = H; c.fill = HF
r += 1
for a in d["assets"]:
    for j, v in enumerate([a["name"], a["symbol"], a["sector"], a["target"], a["stop"], "yes" if a["fund"] else ""], 1): ws.cell(r, j, v)
    r += 1

wb.save(sys.argv[2])
b = open(sys.argv[2], "rb").read()
open(sys.argv[2] + ".b64", "w").write(base64.b64encode(b).decode())
print(json.dumps({"ok": True, "file": sys.argv[2], "bytes": len(b), "sheets": wb.sheetnames}))
