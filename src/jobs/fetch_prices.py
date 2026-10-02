#!/usr/bin/env python3
"""Prices for the market jobs (run_market.py, run_shared_market.py), from TradingView's public scanner (15-min delayed) plus a short daily-bar
backfill from TradingView's chart websocket so a missed run never leaves a hole in the price history.

Usage: python3 fetch_prices.py <assets.json> [--fill N] [--no-fill] [--all]
    <assets.json>  a portfolio/assets document ({items:{name:{symbol,...}}}, optionally wrapped in {id, version, data})
    --fill N       fill the last N EGX sessions (default 10; N+5 daily bars are fetched per symbol, at least 15)
    --no-fill      scanner snapshot only (history for the latest session, nothing older)
    --all          daily history for EVERY EGX-listed stock, not just the assets file's symbols (the shared market job
                   for all members; the assets argument may then be "-" for none)

Prints ONE JSON object:
    latest        market/latest — a quote for EVERY EGX-listed stock, the four indices, USD/EGP and gold
    histories     [{month, days:{'YYYY-MM-DD': {SYM: close, ...}}}, ...] one entry per month touched, oldest first; the
                  market job merges each into history/<month> with "update" (set when the document does not exist yet).
                  Days cover the last N sessions for the portfolios' own symbols, the EGX30 members, the four indices,
                  USDEGP and GOLD24K; for the latest session the scanner close wins (it is the most recent).
    historyMonth  month of the latest session; history = the histories entry for that month
    fillErrors    {SYM: error} symbols whose daily bars could not be fetched after retries (they are simply skipped)
    fill          {sessions, symbols, bars, seconds} statistics of the backfill
    prevMonth     EGX30 Capped close of the previous month; bench: bench/egx30 members plus divYield (the index's estimated
                  annual dividend yield, a fraction: capped member weight x dividend yield) and divYieldAsOf; newAssets:
                  index members not in the asset list (as watch entries); macro: Egypt CPI month-on-month, USD/EGP
                  month-end closes and cashRate {YYYY-MM: CBE policy rate in force that month, as a fraction} for the last
                  18 months (the market job fills marks[M].cashRate/cashRateSource for closed months lacking it, like cpi).
    Each quote carries price, chg, date, prevMonthClose, name, dy (dividend yield %), exDate/divUp, exRecent/divRecent and
    the valuation fields pe (P/E ttm), pb (P/B), roe (return on equity %), mcap (market cap, EGP), hi52/lo52 (52-week
    high/low), vol / avgVol (the session's volume in shares and the 30-session average) and earn (the next earnings
    release date, when TradingView has one); any of them may be null. latest.rates.policy = {rate (fraction), date YYYY-MM, source}.
Needs: pip install websocket-client."""
import json, sys, urllib.request, datetime, zoneinfo, time, re, random, string, os, argparse
from concurrent.futures import ThreadPoolExecutor

UA = {"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"}
CAIRO = zoneinfo.ZoneInfo("Africa/Cairo")
COLS = ["close", "change", "time", "close[1]|1M", "description", "dividends_yield_current", "ex_dividend_date_upcoming", "dividend_amount_upcoming", "ex_dividend_date_recent", "dividend_amount_recent",
        "price_earnings_ttm", "price_book_fq", "return_on_equity", "market_cap_basic", "price_52_week_high", "price_52_week_low",
        "volume", "average_volume_30d_calc", "earnings_release_next_date"]
TV_SECTOR = {"Finance": "Financial Services", "Technology Services": "Technology & Fintech", "Process Industries": "Basic Resources",
             "Non-Energy Minerals": "Basic Resources", "Consumer Non-Durables": "Food & Beverage", "Health Technology": "Healthcare & Pharma",
             "Health Services": "Healthcare & Pharma", "Communications": "Telecom", "Energy Minerals": "Energy", "Transportation": "Transport & Logistics",
             "Industrial Services": "Contracting & Engineering", "Consumer Durables": "Real Estate", "Distribution Services": "Trade & Distribution"}
IDX = ["EGX30CAPPED", "EGX30", "EGX70EWI", "EGX100EWI"]
GRAM = 31.1035          # troy ounce in grams: GOLD24K (EGP per gram) = XAUUSD × USDEGP ÷ GRAM
FILL_WORKERS = 3        # websocket fetches in flight at once
FILL_RETRIES = 3        # retries per symbol after the first attempt (backoff 2, 4, 8 s)
CAP_WEIGHT = 0.15       # EGX30 Capped: no member above 15% (same rule as engine2.js capWeights / bench.capWeight)
RATE_MONTHS = 18        # months of CBE policy rate in macro.cashRate

def scan(market, body):
    data = json.dumps(body).encode()
    for attempt in range(4):
        try:
            req = urllib.request.Request(f"https://scanner.tradingview.com/{market}/scan", data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return {row["s"]: row["d"] for row in json.load(r)["data"]}
        except Exception:
            if attempt == 3: raise
            time.sleep(2 ** (attempt + 1))

def tv_history(sym, bars, tf, adjustment="splits", timeout=25):
    """Daily/monthly bars [ts, o, h, l, c, v] from TradingView's chart websocket (needs: pip install websocket-client).
    adjustment "splits" returns closes scaled for bonus issues/splits, "none" the prices as traded (what the ledger uses)."""
    import websocket
    from urllib.parse import urlparse
    rs = lambda n=12: "".join(random.choice(string.ascii_lowercase) for _ in range(n))
    msg = lambda f, p: (lambda s: f"~m~{len(s)}~m~{s}")(json.dumps({"m": f, "p": p}, separators=(",", ":")))
    kw = {}
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if proxy:
        u = urlparse(proxy); kw = dict(http_proxy_host=u.hostname, http_proxy_port=u.port, proxy_type="http")
        if u.username: kw["http_proxy_auth"] = (u.username, u.password)
    ca = "/root/.ccr/ca-bundle.crt"
    ws = websocket.create_connection("wss://data.tradingview.com/socket.io/websocket", header=["Origin: https://www.tradingview.com"], timeout=timeout,
                                     sslopt={"ca_certs": ca} if os.path.exists(ca) else {}, **kw)
    try:
        cs = "cs_" + rs()
        spec = json.dumps({"symbol": sym, "adjustment": adjustment}, separators=(",", ":"))
        for f, p in [("set_auth_token", ["unauthorized_user_token"]), ("chart_create_session", [cs, ""]),
                     ("resolve_symbol", [cs, "s1", "=" + spec]), ("create_series", [cs, "sds_1", "s1", "s1", tf, bars, ""])]:
            ws.send(msg(f, p))
        out = []
        while True:
            r = ws.recv()
            for hb in re.findall(r"~m~\d+~m~(~h~\d+)", r): ws.send(f"~m~{len(hb)}~m~{hb}")
            if '"s":[' in r and "timescale_update" in r:
                m = re.search(r'"s":\[(.+?)\}\]', r); out = [x["v"] for x in json.loads("[" + m.group(1) + "}]")]
            if "symbol_error" in r: raise ValueError(f"TradingView cannot resolve {sym}")
            if "series_completed" in r: break
        return out
    finally:
        ws.close()

def month_add(m, k):
    y, mo = int(m[:4]), int(m[5:]) - 1 + k
    return f"{y + mo // 12}-{mo % 12 + 1:02d}"

def policy_rates(bars, months_n, last_month):
    """CBE policy rate in force for each of the months_n calendar months ending last_month, as a fraction. The monthly
    ECONOMICS:EGINTR bars skip months without a new reading (e.g. no bar for a month with no MPC meeting), so a month
    without a bar carries the last earlier reading forward. Returns ({YYYY-MM: rate}, latest {rate, date})."""
    lv = {datetime.datetime.utcfromtimestamp(b[0]).strftime("%Y-%m"): b[4] for b in bars if b[4] is not None}
    ks = sorted(lv)
    out, first = {}, month_add(last_month, 1 - months_n)
    for i in range(months_n):
        m = month_add(first, i)
        prior = [k for k in ks if k <= m]
        if prior: out[m] = round(lv[prior[-1]] / 100, 6)
    latest = {"rate": round(lv[ks[-1]] / 100, 6), "date": ks[-1]} if ks else None
    return out, latest

def macro(last_month=None):
    res = {"cpiMoM": {}, "cpiSource": "CAPMAS urban CPI index via TradingView ECONOMICS:EGCPI", "fxEom": {}, "fxSource": "USD/EGP month-end market close (TradingView FX_IDC)",
           "cashRate": {}, "cashRateSource": POLICY_SOURCE}
    try:
        bars = tv_history("ECONOMICS:EGINTR", RATE_MONTHS + 12, "1M", adjustment="none")
        res["cashRate"], res["policy"] = policy_rates(bars, RATE_MONTHS, last_month or datetime.datetime.now(CAIRO).strftime("%Y-%m"))
    except Exception as e: res["cashRateError"] = str(e)
    try:
        bars = tv_history("ECONOMICS:EGCPI", 18, "1M")
        lv = {datetime.datetime.utcfromtimestamp(b[0]).strftime("%Y-%m"): b[4] for b in bars if b[4]}
        ks = sorted(lv)
        for a, b in zip(ks, ks[1:]): res["cpiMoM"][b] = round(lv[b] / lv[a] - 1, 6)
    except Exception as e: res["cpiError"] = str(e)
    try:
        bars = tv_history("FX_IDC:USDEGP", 400, "1D")
        for b in bars:  # last close in each calendar month
            res["fxEom"][datetime.datetime.fromtimestamp(b[0], CAIRO).strftime("%Y-%m")] = b[4]
    except Exception as e: res["fxError"] = str(e)
    return res

POLICY_SOURCE = "CBE policy rate via TradingView ECONOMICS:EGINTR"

def cap_weights(ws, cap):
    """Python copy of engine2.js capWeights: clip every weight above cap and hand the excess to the uncapped members in
    proportion to their weight, repeated until none is over (cap raised to 1/n when n*cap < 1)."""
    w = list(ws); n = len(w)
    if not n: return w
    if cap * n < 1: cap = 1 / n
    for _ in range(50):
        over = [x > cap + 1e-12 for x in w]
        if not any(over): break
        excess = sum(x - cap for x, o in zip(w, over) if o)
        free = sum(x for x, o in zip(w, over) if not o)
        w = [cap if o else x + (excess * x / free if free else 0) for x, o in zip(w, over)]
    return w

def bench_div_yield(members, prices, dys):
    """EGX30 Capped estimated dividend yield (annual fraction) = sum of capped member weight x member dividend yield.
    Weights are price x float shares, capped at CAP_WEIGHT and renormalised; a member without a dividend yield counts as
    0 (non-payer); a member without a price is left out of the weights. Returns (yield or None, members used)."""
    mem = [(m["s"], prices.get(m["s"]) * m["floatShares"]) for m in members if prices.get(m["s"]) and m.get("floatShares")]
    tot = sum(v for _, v in mem)
    if not mem or not tot: return None, 0
    w = cap_weights([v / tot for _, v in mem], CAP_WEIGHT)
    return round(sum(wi * (dys.get(s) or 0) / 100 for (s, _), wi in zip(mem, w)), 6), len(mem)

def day(ts):
    return datetime.datetime.fromtimestamp(ts, CAIRO).strftime("%Y-%m-%d") if ts else None

def quote(d, today):
    return {"price": d[0], "chg": round(d[1] or 0, 4), "date": day(d[2]) or today, "prevMonthClose": d[3], "name": d[4], "dy": round(d[5], 4) if d[5] is not None else None,
            "exDate": day(d[6]), "divUp": d[7], "exRecent": day(d[8]), "divRecent": d[9],
            "pe": rnd(d[10], 4), "pb": rnd(d[11], 4), "roe": rnd(d[12], 4), "mcap": rnd(d[13], 0), "hi52": d[14], "lo52": d[15],
            "vol": rnd(at(d, 16), 0), "avgVol": rnd(at(d, 17), 0), "earn": day(at(d, 18))}

def at(d, i):
    return d[i] if len(d) > i else None

def rnd(x, n):
    return None if x is None else (int(round(x)) if n == 0 else round(x, n))

def fill(targets, sessions_n, bars_n):
    """Daily closes for the last sessions_n EGX sessions. targets = {key: TradingView ticker}; keys are the history keys
    (EGX symbols, the four indices, USDEGP, XAUUSD). Returns (days, errors, stats). Bar timestamps are converted to the
    Cairo date: EGX bars are stamped at the session open (07:00 UTC), FX/gold bars at the New York day boundary, which
    is already the next Cairo date - both give the calendar day the stored history uses. Sessions come from the
    EGX30CAPPED bars (fallback: every date any stock traded). USDEGP/XAUUSD carry forward over EGX sessions with no FX
    bar (Sundays), like the scanner does on those days; a stock without a bar on a session is simply absent that day."""
    t0 = time.time()
    def one(k):
        last = None
        for attempt in range(FILL_RETRIES + 1):
            try:
                bars = tv_history(targets[k], bars_n, "1D", adjustment="none")
                return k, {day(b[0]): b[4] for b in bars if b[4] is not None}, None
            except Exception as e:
                last = e
                if attempt < FILL_RETRIES: time.sleep(2 ** (attempt + 1))
        return k, None, f"{type(last).__name__}: {last}"
    series, errors = {}, {}
    with ThreadPoolExecutor(max_workers=FILL_WORKERS) as ex:
        for k, s, err in ex.map(one, sorted(targets)):
            if err: errors[k] = err
            else: series[k] = s
    stocks = [k for k in series if k not in ("USDEGP", "XAUUSD")]
    sessions = sorted(series["EGX30CAPPED"]) if series.get("EGX30CAPPED") else sorted({d for k in stocks for d in series[k]})
    sessions = sessions[-sessions_n:]
    def carry(k, d):  # last FX/gold close on or before the session date
        s = series.get(k, {}); ks = [x for x in s if x <= d]
        return s[max(ks)] if ks else None
    days = {}
    for d in sessions:
        row = {k: series[k][d] for k in stocks if d in series[k]}
        usd, xau = carry("USDEGP", d), carry("XAUUSD", d)
        if usd is not None: row["USDEGP"] = usd
        if usd is not None and xau is not None: row["GOLD24K"] = round(xau * usd / GRAM, 2)
        days[d] = row
    stats = {"sessions": sessions, "symbols": len(series), "bars": bars_n, "seconds": round(time.time() - t0, 1)}
    return days, errors, stats

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("assets", help="portfolio/assets document (JSON) - decides which symbols get daily history")
    ap.add_argument("--fill", type=int, default=10, metavar="N", help="backfill the last N EGX sessions (default 10)")
    ap.add_argument("--no-fill", action="store_true", help="skip the backfill: history for the scanner's latest session only")
    ap.add_argument("--all", action="store_true", help="daily history for every EGX-listed stock (assets may be '-')")
    args = ap.parse_args()
    doc = {} if args.assets == "-" else json.load(open(args.assets))
    doc = doc.get("data", doc)
    items = doc.get("items", {})
    by_sym = {a["symbol"].upper(): a for a in items.values() if a.get("symbol")}
    syms = sorted(s for s in by_sym if s not in ("SAVINGS", "THNDRGOLD"))
    now = datetime.datetime.now(CAIRO); today = now.strftime("%Y-%m-%d")
    every = scan("egypt", {"columns": COLS, "range": [0, 800], "symbols": {"query": {"types": ["stock", "dr", "fund"]}}})   # every EGX-listed stock
    eg = scan("egypt", {"symbols": {"tickers": [f"EGX:{s}" for s in IDX]}, "columns": COLS})
    gl = scan("global", {"symbols": {"tickers": ["FX_IDC:USDEGP", "OANDA:XAUUSD"]}, "columns": ["close", "change", "close[1]|1M"]})
    cons = scan("egypt", {"symbols": {"symbolset": ["SYML:EGX;EGX30"]}, "columns": ["name", "description", "sector", "float_shares_outstanding", "total_shares_outstanding", "close", "market_cap_basic"], "range": [0, 60]})
    quotes, index = {}, {}
    for t, d in every.items():
        if d and d[0] is not None: quotes[t.split(":", 1)[1]] = quote(d, today)
    missing = [s for s in syms if s not in quotes]
    if args.all:
        syms = sorted(set(syms) | set(quotes))
    for s in IDX:
        d = eg.get(f"EGX:{s}")
        if d and d[0] is not None:
            index[s] = {"close": d[0], "chg": round(d[1] or 0, 4), "date": day(d[2]) or today, "prevMonthClose": d[3]}
    fx = gl.get("FX_IDC:USDEGP"); xau = gl.get("OANDA:XAUUSD")
    fxo = {"USDEGP": {"price": fx[0], "chg": round(fx[1] or 0, 4), "prevMonthClose": fx[2], "date": today}} if fx else {}
    gold = {"XAUUSD": xau[0], "gram24kEgp": round(xau[0] * fx[0] / GRAM, 2), "date": today} if fx and xau else {}
    # EGX30 members: when two share lines exist for one company, keep the one whose price matches its market cap
    members, seen, cons_px = [], {}, {}
    for t, d in cons.items():
        sym, desc, sec, fl, tot, cl, mc = d
        if not fl or not cl: continue
        err = abs(cl * (tot or 0) - (mc or 0)) / (mc or 1)
        if desc in seen and seen[desc][1] <= err: continue
        seen[desc] = (sym, err)
    keep = {v[0] for v in seen.values()}
    new_assets = {}
    for t, d in cons.items():
        sym, desc, sec, fl, tot, cl, mc = d
        if sym not in keep: continue
        a = by_sym.get(sym.upper())
        sector = (a or {}).get("sector") or TV_SECTOR.get(sec, "Unclassified")
        members.append({"s": sym, "name": desc, "sector": sector, "floatShares": fl, "totalShares": tot})
        cons_px[sym] = cl
        if not a: new_assets[desc] = {"name": desc, "symbol": sym, "sector": sector, "watch": True}
    # daily history only for the portfolios' own symbols, the index members, the indices, USD/EGP and gold
    snap = {s: quotes[s]["price"] for s in syms if s in quotes}
    snap.update({s: v["close"] for s, v in index.items()})
    for m in members:
        if m["s"] in quotes: snap.setdefault(m["s"], quotes[m["s"]]["price"])
    if fx: snap["USDEGP"] = fx[0]
    if gold: snap["GOLD24K"] = gold["gram24kEgp"]
    ix_date = index.get("EGX30CAPPED", {}).get("date", today)
    # backfill: the same symbol set for the last N sessions, so a run the job missed is filled in the next time
    days, fill_errors, fill_stats = {}, {}, {"sessions": [], "symbols": 0, "bars": 0, "seconds": 0, "skipped": True}
    if not args.no_fill:
        targets = {s: f"EGX:{s}" for s in syms}
        targets.update({m["s"]: f"EGX:{m['s']}" for m in members})
        targets.update({s: f"EGX:{s}" for s in IDX})
        targets.update({"USDEGP": "FX_IDC:USDEGP", "XAUUSD": "OANDA:XAUUSD"})
        days, fill_errors, fill_stats = fill(targets, max(1, args.fill), max(15, args.fill + 5))
    days.setdefault(ix_date, {}).update(snap)   # the scanner close is the most recent for the latest session
    months = sorted({d[:7] for d in days})
    histories = [{"month": mo, "days": {d: days[d] for d in sorted(days) if d[:7] == mo}} for mo in months]
    month = max(days)[:7]; y, mo = int(month[:4]), int(month[5:])
    prev = f"{y - (mo == 1)}-{12 if mo == 1 else mo - 1:02d}"
    mac = macro(today[:7])
    pol = mac.pop("policy", None)
    rates = {"policy": {**pol, "source": POLICY_SOURCE}} if pol else {}
    div_yield, _ = bench_div_yield(members, cons_px, {s: q["dy"] for s, q in quotes.items()})
    latest = {"asOf": now.isoformat(timespec="minutes"), "source": "TradingView scanner (15-min delayed), every EGX-listed stock", "quotes": quotes, "index": index, "fx": fxo, "gold": gold, "missing": missing, "rates": rates}
    print(json.dumps({"latest": latest, "historyMonth": month, "histories": histories, "history": next(h for h in histories if h["month"] == month),
                      "fillErrors": fill_errors, "fill": fill_stats,
                      "prevMonth": {"month": prev, "benchClose": index.get("EGX30CAPPED", {}).get("prevMonthClose")},
                      "bench": {"members": sorted(members, key=lambda m: m["s"]), "asOf": today, "divYield": div_yield, "divYieldAsOf": today},
                      "newAssets": new_assets, "macro": mac, "currentMonth": today[:7]}, separators=(",", ":")))

if __name__ == "__main__":
    main()
