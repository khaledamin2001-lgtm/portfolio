#!/usr/bin/env python3
"""Every email the jobs send, in one place and one design (src/jobs/mail_html.py). Each function returns
(subject, text, html): the plain text is the alternative for mail apps that do not show HTML.

The owner's (the site owner, who runs the platform): market, sync_email (his own portfolio's Thndr emails), monthend,
reminder, token, alarm_key, failure, signup. A site account's (each to its own address only): alerts, sync_email,
weekly (src/tools/weekly.js), monthend, friend, built, waiting, gmail_error."""
import datetime
from mail_html import email, tone_of

SITE = "https://khaledamin2001-lgtm.github.io/portfolio/"
ACCOUNT_FOOT = "You get this because you switched on email updates in your account on the portfolio site. Switch them off there any time (Account, then Email updates)."
MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


def isnum(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def day(d, year=True):
    """'2026-09-30' -> 'Wed 30 Sep 2026'."""
    try:
        t = datetime.date.fromisoformat(str(d)[:10])
    except ValueError:
        return str(d)
    return f"{t.strftime('%a')} {t.day} {MON[t.month - 1]}" + (f" {t.year}" if year else "")


def month_name(M):
    """'2026-09' -> 'September 2026'."""
    return f"{MONTH[int(M[5:7]) - 1]} {M[:4]}" if len(str(M)) >= 7 else str(M)


def human_dates(t):
    """'2026-08-31' inside a sentence -> '31 Aug 2026'."""
    import re
    return re.sub(r"\b(\d{4})-(\d{2})-(\d{2})\b", lambda m: f"{int(m.group(3))} {MON[int(m.group(2)) - 1]} {m.group(1)}", str(t or ""))


def holding_name(t):
    """'COMI · Commercial International Bank'; a Thndr fund with no ticker ('thndrgold') -> 'Thndr Gold'."""
    sym, nm = t.get("symbol"), t.get("name") or ""
    if not sym and nm.lower().startswith("thndr") and " " not in nm:
        nm = "Thndr " + nm[5:].capitalize()
    return f"{sym} · {nm}" if sym and nm and nm != sym else (sym or nm)


def pct(x, dp=2, sign=True):
    if not isnum(x):
        return "—"
    s = f"{x * 100:+.{dp}f}%" if sign else f"{x * 100:.{dp}f}%"
    return s.replace("-", "−")


def egp(x, dp=0):
    return "—" if not isnum(x) else f"{x:,.{dp}f}".replace("-", "−") + " EGP"


# ---------------------------------------------------------------- the owner's
def market(out, info, published):
    """After each EGX close: what the market update fetched and saved."""
    L = out.get("latest") or {}
    ix = (L.get("index") or {}).get("EGX30CAPPED") or {}
    close_date = ix.get("date") or max((d for H in out.get("histories") or [] for d in (H.get("days") or {})), default=None) or (L.get("asOf") or "")[:10]
    pol = (L.get("rates") or {}).get("policy") or {}
    bench = out.get("bench") or {}
    asof = str(L.get("asOf") or "")
    missing = sorted(set(out.get("fillErrors") or {}) | set(L.get("missing") or []))
    names = {"cpi": "Inflation (CPI)", "usdegp": "USD/EGP", "cashRate": "CBE rate"}
    filled = [f"{names[k]}: {', '.join(v)}" for k, v in (info.get("marksFilled") or {}).items() if v and k in names]
    chg = ix.get("chg")
    tiles = [("EGX30 Capped", f"{ix['close']:,.2f}" if isnum(ix.get("close")) else "—",
              f"{chg:+.2f}% on the day".replace("-", "−") if isnum(chg) else None, tone_of(chg, 0.005) if isnum(chg) else None),
             ("Stocks priced", str(len(L.get("quotes") or {})), f"as of {asof[11:16]} Cairo" if len(asof) >= 16 else None, None)]
    facts = [("CBE policy rate", pct(pol.get("rate"), sign=False) + (f" (since {month_name(pol['date'])})" if pol.get("date") else "")),
             ("Index dividend yield", pct(bench.get("divYield"), sign=False)),
             ("Price history saved", f"{', '.join(month_name(m) for m in info['historyMonths']) or 'none'} · {info['sessions']} session{'' if info['sessions'] == 1 else 's'}"),
             ("New index members", str(info.get("newAssets") or "none"))]
    if filled:
        facts.append(("Month-end figures filled", "; ".join(filled)))
    blocks = [("tiles", tiles), ("facts", facts)]
    if missing:
        blocks.append(("box", "warn", f"No price today for {len(missing)} stock{'' if len(missing) == 1 else 's'}", [", ".join(missing) + " — the last known price is kept."]))
    blocks.append(("box", "good", "The site is updated." if published else "The site already had today's data.", []))
    title = f"EGX30 Capped {pct(chg / 100, 2)} today" if isnum(chg) else "Market update"
    text, html = email("Market update", title, blocks, subtitle=day(close_date), button=("Open the site", SITE),
                       preheader=f"EGX30 Capped {tiles[0][1]} ({tiles[0][2] or ''})")
    return f"Portfolio: market updated {close_date}", text, html


def sync_email(subject, parts, account=False):
    """The Thndr inbox email (statement posted / needs review / not arrived / heads-up) from sync.js summary.email.parts."""
    name = parts.get("name") or "Portfolio"
    held, applied, heads, missing = parts.get("held") or [], parts.get("applied") or [], parts.get("heads") or [], parts.get("missing") or []
    if held:
        title = f"{len(held)} Thndr email{'s need' if len(held) > 1 else ' needs'} your review"
    elif any(a.get("monthly") for a in applied):
        title = f"{', '.join(a['monthly'] for a in applied if a.get('monthly'))} statement posted"
    elif missing and not applied:
        title = f"{', '.join(missing)} statement not arrived"
    elif applied:
        title = "Updated from your Thndr emails"
    else:
        title = "Heads-up"
    blocks = []
    for h in held:
        reasons = [human_dates(r.replace("refused: ", "").replace("; nothing from it was used", "")) for r in h.get("reasons") or []]
        blocks.append(("box", "bad", f"Needs review: {h['title']}" + (f" ({human_dates(h['period'])})" if h.get("period") else ""),
                       ["Nothing from this email was saved."] + [r[0].upper() + r[1:] if r else r for r in reasons]))
        if h.get("proposed"):
            blocks += [("h", "What it would have changed", "not saved"), ("list", [human_dates(x) for x in h["proposed"]])]
    if heads:
        blocks.append(("box", "warn", "Heads-up", heads))
    for a in applied:
        items = [human_dates(x) for x in a.get("items") or []]
        blocks += [("h", a["title"], human_dates(a.get("period")) if a.get("period") else None), ("list", [x[0].upper() + x[1:] if x else x for x in items] or ["Nothing to change."])]
    if missing:
        blocks.append(("box", "info", f"Monthly statement still missing: {', '.join(missing)}",
                       ["Thndr usually emails it in the first days of the month. If it is not in your Gmail, request it in the Thndr app: it is added at the next check."]))
    text, html = email(name, title, blocks, subtitle=day(parts.get("checked")) if parts.get("checked") else None,
                       button=("Open your portfolio" if account else "Open the portfolio", parts.get("url") or SITE),
                       foot=("You get this because Thndr emails are on in your account on the portfolio site." if account else None))
    return subject, text, html


def monthend(name, M, sm, files, account=False, guest=False):
    """The month-end email: the headline figures (factsheet.js --summary) and the files attached. guest: a portfolio the
    site owner runs for someone without an account (Yassin's): no site button, a line saying where it comes from."""
    S = f"{MON[int(M[5:7]) - 1]}-{M[2:4]}"
    blocks = []
    idx = lambda b: f"EGX30 Capped {pct(b, 1)}" if isnum(b) else None
    if sm:
        blocks.append(("tiles", [("Value at month-end", egp(sm.get("value")), None, None),
                                 ("Return in " + MON[int(M[5:7]) - 1], pct(sm.get("monthRet"), 1), idx(sm.get("monthBench")), tone_of(sm.get("monthRet")))]))
        blocks.append(("tiles", [("Year to date", pct(sm.get("ytd"), 1), idx(sm.get("ytdBench")), tone_of(sm.get("ytd"))),
                                 ("Since " + month_name(sm.get("inception") or "")[:3] + " " + str(sm.get("inception") or "")[:4] if sm.get("inception") else "Since inception",
                                  pct(sm.get("si"), 1), idx(sm.get("siBench")), tone_of(sm.get("si")))]))
        top = sm.get("top") or []
        if top:
            rows = [[holding_name(t), pct(t.get("w"), 1, sign=False)] for t in top]
            if isnum(sm.get("cashW")) and sm["cashW"] > 0.0005:
                rows.append(["Cash & savings", pct(sm["cashW"], 1, sign=False)])
            blocks += [("h", "Biggest holdings", "share of the portfolio at month-end"), ("table", ["Holding", "Weight"], rows)]
        inc = sm.get("income") or {}
        if any(abs(inc.get(k) or 0) >= 0.005 for k in ("div", "reb", "fee")):
            blocks += [("h", f"Income in {month_name(M)}"), ("facts", [("Dividends", egp(inc.get("div"), 2)), ("Rebates", egp(inc.get("reb"), 2)), ("Fees", egp(inc.get("fee"), 2))])]
    if files:
        blocks.append(("box", "info", "Attached: " + " and ".join(files), ["The PDF is the full factsheet (returns vs the index, risk, sectors, attribution). The Excel workbook has every sheet: Summary, Monthly, Holdings, Ledger, Closed trades, Income, Attribution, Marks & inputs."]))
    else:
        blocks.append(("p", "The full factsheet and the Excel workbook are on the site: Reports, then " + S + "." if not guest else "The full factsheet could not be attached this time."))
    subj = f"{name} · month-end report {S}" if account or guest else f"{name} · factsheet {S}"
    text, html = email(name, f"{month_name(M)} report", blocks, subtitle="Month-end report" if guest else "Month-end, from your Thndr statement",
                       button=None if guest else ("Open your portfolio" if account else "Open Reports", SITE),
                       foot=(ACCOUNT_FOOT if account else "Your portfolio is tracked for you on a private portfolio site; this report comes once a month. Reply to this email with any question." if guest else None),
                       preheader=(f"Value {egp(sm.get('value'))} · {MON[int(M[5:7]) - 1]} {pct(sm.get('monthRet'), 1)}" if sm else None))
    return subj, text, html


def reminder(name, P, state):
    """The 11th of the month: last month's statement is still not posted."""
    S = f"{MON[int(P[5:7]) - 1]}-{P[2:4]}"
    blocks = [("p", f"Your {month_name(P)} Thndr monthly statement has not been added to {name} yet."),
              ("box", "info", "What to do", [
                  "Already in your Gmail? Then it was held: look for the \"needs your review\" email.",
                  "Not in your Gmail? Request it in the Thndr app. It is added at the next check (4:15 pm, 6:15 pm or 11 pm)."]),
              ("p", f"{MONTH[int(P[5:7]) - 1]}'s month-end value is {state}; the statement replaces it with Thndr's own figures.")]
    text, html = email(name, f"{S} statement not posted yet", blocks, button=("Open the portfolio", SITE))
    return f"{name}: {S} Thndr statement not posted yet", text, html


def token(d, today=None):
    """14 days before the site's publishing key (SITE_TOKEN) expires."""
    left = (d - today).days if today else None
    when = "" if left is None else (" tomorrow" if left == 1 else f" in {left} days")
    blocks = [("p", f"The key the jobs use to publish your site expires{when}, on {day(d)}. After that the site stops updating until it is renewed."),
              ("h", "To renew it (5 minutes)"),
              ("steps", ["GitHub → your photo → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.",
                         "Repository access: only the portfolio (site) repository. Permissions: Contents → Read and write. Copy the key.",
                         "The portfolio-engine repository → Settings → Secrets and variables → Actions → SITE_TOKEN → Update → paste it.",
                         "Actions → Setup check → Run workflow, to confirm."]),
              ("box", "warn", None, ["Don't paste the key anywhere else (not in emails or chats)."])]
    text, html = email("Portfolio jobs", f"Publishing key expires{when}", blocks, subtitle=day(d))
    return f"Portfolio: publishing token expires {d}", text, html


def alarm_key(expires, today):
    """14, 7, 3, 2 and 1 days before the on-time alarm key (ENGINE_TOKEN, cron-job.org) expires."""
    left = (expires - today).days
    when = "tomorrow" if left == 1 else f"in {left} days"
    d = f"{expires.day} {MON[expires.month - 1]} {expires.year}"
    blocks = [("p", "The GitHub key named \"on-time alarm\" lets cron-job.org start the market update at 3:40 pm and the Thndr email checks "
                    "at 4:15 pm, 6:15 pm and 11 pm, and lets the site start a new friend's account within minutes."),
              ("box", "warn", None, ["If it expires, the updates still happen, but up to a few hours late (on GitHub's own timers)."]),
              ("h", "To renew it (5 minutes)"),
              ("steps", ["GitHub → your photo → Settings → Developer settings → Personal access tokens → Fine-grained tokens → \"on-time alarm\" → Regenerate token. Copy the new key (it starts with github_pat_).",
                         "cron-job.org → each of the 4 jobs → Advanced → Headers → Authorization: replace the old key after \"Bearer \" with the new one → Save.",
                         "GitHub → the portfolio repository → Settings → Secrets and variables → Actions → ENGINE_TOKEN → Update → paste the new key."]),
              ("p", "Don't paste the key anywhere else (not in emails or chats).")]
    text, html = email("Portfolio jobs", f"On-time alarm key expires {when}", blocks, subtitle=day(expires))
    return f"Portfolio: on-time alarm key expires {d}", text, html


def failure(job, date, step, detail, run_url=None):
    """A job failed: which step, the error, the run log."""
    blocks = [("box", "bad", "What went wrong", [f"Step: {step}", f"Error: {detail}"]),
              ("p", "Nothing after this step was done. The next scheduled run tries again by itself; if it keeps failing, open the run log.")]
    url = run_url if run_url and run_url.startswith("http") else None
    text, html = email("Portfolio jobs", f"{job[0].upper() + job[1:]} job failed", blocks, subtitle=day(date), button=("Open the run log", url) if url else None)
    return f"Portfolio: {job} FAILED {date}", text, html


def signup(rows):
    """New accounts on the site (the platform owner's notice)."""
    names = [r.get("name") or "(no name)" for r in rows]
    blocks = [("list", [f"{r.get('name') or '(no name)'} · {r.get('email') or 'no email'}" for r in rows]),
              ("p", "Their portfolios and emails are their own: you only see who signed up.")]
    title = f"{len(rows)} new account{'s' if len(rows) != 1 else ''} on your site"
    text, html = email("Portfolio site", title, blocks, button=("See everyone (Account → Admin)", SITE))
    return ("New on your portfolio site: " + (names[0] if len(names) == 1 else f"{len(names)} people"))[:180], text, html


# ---------------------------------------------------------------- a site account's (to its own address)
def alerts(name, items):
    """New heads-up items after a market close."""
    title = items[0]["text"].split(" (")[0].split(";")[0] if len(items) == 1 else f"{len(items)} new things to look at"
    blocks = [("box", "warn", None, [i["text"] for i in items])]
    text, html = email(name, "Heads-up", blocks, subtitle=f"{len(items)} new item{'s' if len(items) != 1 else ''}", button=("Open your portfolio", SITE), foot=ACCOUNT_FOOT)
    return f"{name}: heads-up — {title}"[:180], text, html


def friend(name, who):
    blocks = [("p", f"{who} sent you a friend request on the portfolio site."),
              ("box", "info", "If you accept", ["You both see each other's returns, holdings and trades in percentages. Nobody sees anyone's amounts.", "Either of you can remove it any time."]),
              ("p", "To answer, sign in on the site: the request is under Account, then Friends.")]
    text, html = email(name, f"{who} wants to be friends", blocks, button=("Answer the request", SITE + "?friends"), foot=ACCOUNT_FOOT)
    return f"{who} wants to be friends on the portfolio site", text, html


def leaderboard(name, month_label, rows, bench, best, foot):
    """The monthly friends leaderboard: you and your friends ranked by last month's return, in percentages only.
    rows: [{"who", "me", "m" (the month's return or None), "ytd"}] already ranked; bench: the index's month return;
    best: {"who", "s", "ret"} the month's best sale among you, or None."""
    pct = lambda x: "—" if x is None else ("+" if x > 0.00005 else "−" if x < -0.00005 else "") + f"{abs(x) * 100:.1f}%"
    me = next((r for r in rows if r.get("me")), None)
    place = lambda r: 1 + sum(1 for o in rows if o.get("m") is not None and o["m"] > r["m"]) if r.get("m") is not None else None    # a tie shares the place
    rank = place(me) if me else None
    tiles = [("Your rank", f"#{rank} of {len(rows)}" if rank else "—", None, None),
             ("Your return", pct(me and me.get("m")), month_label.split(" ")[0], tone_of(me and me.get("m"))),
             ("EGX30 Capped", pct(bench), "the index", tone_of(bench))]
    table = [[f"#{place(r)}" if r.get("m") is not None else "", ("You" if r.get("me") else r["who"]), (pct(r.get("m")), tone_of(r.get("m"))), (pct(r.get("ytd")), tone_of(r.get("ytd")))]
             for r in rows]
    blocks = [("tiles", tiles), ("h", "The ranking", f"{month_label} return, and the year so far"),
              ("table", ["", "Who", month_label.split(" ")[0][:3], "This year"], table, ["l", "l", "r", "r"])]
    if best:
        blocks.append(("box", "good", "Best trade of the month", [f"{best['who']} sold {best['s']}: {pct(best['ret'])} on the money put in."]))
    top = [r for r in rows if r.get("m") is not None and place(r) == 1]
    if top:
        names = ["you" if r.get("me") else r["who"] for r in top]
        who = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]
        blocks.insert(0, ("p", who[0].upper() + who[1:] + (" came first" if len(top) == 1 else " shared first place") + f" in {month_label} with {pct(top[0]['m'])}."))
    blocks.append(("p", "Percentages only: nobody sees anyone's amounts. Each figure is the portfolio's time-weighted return, so deposits and withdrawals do not count as gains."))
    text, html = email(name, f"{month_label} leaderboard", blocks, subtitle="You and your friends", button=("See the rankings", SITE), foot=foot)
    head = f"you are #{rank} of {len(rows)}" if rank else "the friends ranking"
    return f"{month_label} leaderboard: {head}", text, html


def morning(name, b, foot=None, evening=False):
    """The morning brief (tools/brief.js, engine2.js morningBrief), before the EGX opens: the last session, each holding's
    move, the week ahead (ex-dividend, earnings), holdings near their target or stop, unusual volume, limits, a 5% drop.
    evening=True: the after-close recap (4:30 pm Cairo, run_morning.py --evening): the same figures for the session that
    just closed (today), worded for the evening, without the 5% drop paragraph."""
    import datetime as _dt
    dlabel = lambda d: _dt.date.fromisoformat(d).strftime("%a %-d %b") if d else ""
    sess = "today" if evening else dlabel(b.get("session")) if b.get("session") else "the last session"
    tiles = [("Value", egp(b.get("value")), "at today's close" if evening else f"at the close {sess}", None),
             ("Today" if evening else "Last session", (("+" if (b.get("pl") or 0) >= 0 else "−") + f"{abs(b.get('pl') or 0):,.0f}") if b.get("pl") is not None else "—",
              pct(b.get("ret"), 2) if b.get("ret") is not None else "", tone_of(b.get("pl"))),
             ("EGX30 Capped", pct(b.get("index"), 2), f"{b['indexClose']:,.1f}" if b.get("indexClose") is not None else "", tone_of(b.get("index")))]
    blocks = [("tiles", tiles)]
    mv = [m for m in b.get("movers") or [] if m.get("fresh", True)]
    if mv:
        blocks += [("h", "Your holdings", f"{'Today' if evening else sess}, best to worst"),
                   ("table", ["Stock", "Move", "EGP"], [[m["s"], (pct(m["chg"], 2), tone_of(m["chg"])), (f"{m['pl']:+,.0f}".replace("-", "−"), tone_of(m["pl"]))] for m in mv], ["l", "r", "r"])]
    up = b.get("upcoming") or []
    if up:
        blocks += [("h", "Next 7 days" if evening else "This week", "held and watch-list stocks"),
                   ("list", [f"{dlabel(u['d'])}: {u['s']}{'' if u.get('held') else ' (watch list)'} " +
                             (f"goes ex-dividend" + (f", {u['divUp']:g} EGP a share" if u.get("divUp") is not None else "") if u["kind"] == "exdiv" else "reports earnings")
                             for u in up])]
    lv = b.get("levels") or []
    if lv:
        blocks.append(("box", "warn", "Near your levels", [
            f"{x['s']} at {x['price']:,.2f}: " + (("past" if x["gap"] <= 0 else f"{x['gap'] * 100:.1f}% below") + f" its target {x['level']:,.2f}" if x["kind"] == "target"
                                                  else ("past" if x["gap"] >= 0 else f"{-x['gap'] * 100:.1f}% above") + f" its stop {x['level']:,.2f}") for x in lv]))
    vol = b.get("volume") or []
    if vol:
        blocks.append(("box", "info", "Unusual volume", [f"{v['s']}{'' if v.get('held') else ' (watch list)'}: {v['x']:.1f}× its usual volume on {dlabel(v['d'])}, {pct((v.get('chg') or 0) / 100, 1)}" for v in vol]))
    if b.get("limits"):
        blocks.append(("box", "bad", "Over your limits", [f"{(x.get('s') or x['n']) if x['kind'] == 'stock' else 'The ' + x['n'] + ' sector'} is {x['w'] * 100:.1f}% (limit {x['limit'] * 100:g}%)" for x in b["limits"]]))
    if b.get("stress") and not evening:
        st = b["stress"]
        blocks.append(("p", f"If the EGX30 Capped fell 5% today, the portfolio would likely fall about {abs(st['drop5']) * 100:.1f}% ({egp(abs(st['egp5']))}); its beta is {st['beta']:.2f}."))
    text, html = email(name, "After the close" if evening else "Morning brief", blocks,
                       subtitle=f"{'Today’s close' if evening else 'Before the open'} · {dlabel(b.get('today'))}", button=("Open Today", SITE + "?today"), foot=foot,
                       preheader=f"{sess[:1].upper() + sess[1:]}: {pct(b.get('ret'), 2)} vs index {pct(b.get('index'), 2)}" + (f" · {len(up)} event{'s' if len(up) != 1 else ''} {'in the next 7 days' if evening else 'this week'}" if up else ""))
    if evening:
        head = f"{pct(b.get('ret'), 1)} today vs index {pct(b.get('index'), 1)}" if b.get("ret") is not None else "today's close"
        return f"{name}: after the close · {head}", text, html
    head = f"{pct(b.get('ret'), 1)} {sess}" if b.get("ret") is not None else "before the open"
    return f"{name}: morning brief · {head}", text, html


def wrapped(name, w, ranking=None, foot=None):
    """The yearly wrap-up (tools/wrapped.js, engine2.js yearWrapped), early in January: the year's return against the index,
    best and worst month and sale, the most traded stock, the longest hold, dividends, and the ranking among friends
    (ranking: [{"who", "me", "y"}] best first, percentages only). The portfolio's own figures, so amounts are fine here."""
    Y = w["year"]
    mlabel = lambda m: month_name(m).split(" ")[0] if m else ""
    days = lambda x: f"{x:,} day{'s' if x != 1 else ''}"
    rank = None
    if ranking:
        me = next((r for r in ranking if r.get("me")), None)
        if me and me.get("y") is not None:
            rank = 1 + sum(1 for r in ranking if r.get("y") is not None and r["y"] > me["y"])
    tiles = [(f"Your {Y}", pct(w.get("ret"), 1), "time-weighted", tone_of(w.get("ret"))),
             ("EGX30 Capped", pct(w.get("bench"), 1), "the index", tone_of(w.get("bench")))]
    tiles.append(("Among friends", f"#{rank} of {len(ranking)}", "by the year's return", None) if rank else ("Value now", egp(w.get("end")), "at the year's end", None))
    blocks = []
    if w.get("ret") is not None:
        vs = "" if w.get("bench") is None else (f", ahead of the EGX30 Capped's {pct(w['bench'], 1)}" if w["ret"] > w["bench"] else f", behind the EGX30 Capped's {pct(w['bench'], 1)}")
        blocks.append(("p", f"The portfolio returned {pct(w['ret'], 1)} in {Y}{vs}."))
    blocks.append(("tiles", tiles))
    sl = w.get("sales") or {}
    facts = []
    if w.get("best"):
        facts.append(("Best month", f"{mlabel(w['best']['m'])} {pct(w['best']['r'], 1)}", tone_of(w["best"]["r"])))
    if w.get("worst"):
        facts.append(("Worst month", f"{mlabel(w['worst']['m'])} {pct(w['worst']['r'], 1)}", tone_of(w["worst"]["r"])))
    if w.get("months"):
        facts.append(("Months up", f"{w.get('posMonths', 0)} of {len(w['months'])}"))
    if sl.get("n"):
        facts.append(("Sales", f"{sl['n']} · {sl['wins']} at a profit ({sl['winRate'] * 100:.0f}%)"))
        facts.append(("Profit or loss on sales", egp(sl.get("pl")), tone_of(sl.get("pl"))))
    if w.get("mostTraded"):
        mt = w["mostTraded"]; facts.append(("Most traded", f"{mt['s'] or mt['n']} ({mt['trades']} trades)"))
    if w.get("longest"):
        lg = w["longest"]; facts.append(("Longest hold", f"{lg['s'] or lg['n']}, {days(lg['days'])}" + (" and counting" if lg.get("open") else "")))
    if w.get("buys"):
        facts.append(("Buys", str(w["buys"])))
    if w.get("dividends"):
        facts.append(("Dividends received", egp(w["dividends"])))
    if w.get("deposits") or w.get("withdrawals"):
        facts.append(("Money in / out", f"{egp(w.get('deposits') or 0)} / {egp(w.get('withdrawals') or 0)}"))
    blocks += [("h", f"{Y} in numbers"), ("facts", facts)]
    sale = lambda x: f"{x['s'] or x['n']}: {pct(x['roi'], 1)} ({egp(x['pl'])}), held {days(x['days']) if x.get('days') is not None else '—'}"
    if sl.get("best"):
        blocks.append(("box", "good", "Best sale of the year", [sale(sl["best"])]))
    if sl.get("worst") and sl["worst"]["roi"] < sl["best"]["roi"]:
        blocks.append(("box", "bad" if sl["worst"]["pl"] < 0 else "info", "Weakest sale of the year", [sale(sl["worst"])]))
    if ranking and len(ranking) > 1:
        place = lambda r: 1 + sum(1 for o in ranking if o.get("y") is not None and o["y"] > r["y"]) if r.get("y") is not None else None
        blocks += [("h", "You and your friends", f"{Y} return, percentages only"),
                   ("table", ["", "Who", str(Y)], [[f"#{place(r)}" if place(r) else "", "You" if r.get("me") else r["who"], (pct(r.get("y"), 1), tone_of(r.get("y")))] for r in ranking], ["l", "l", "r"])]
    ms = w.get("months") or []
    if ms and ms[0]["m"] != f"{Y}-01":
        blocks.append(("p", f"Counted from {month_name(ms[0]['m'])}, the portfolio's first month."))
    elif ms and ms[-1].get("live"):
        blocks.append(("p", f"{month_name(ms[-1]['m'])}'s month-end value is still provisional until its Thndr statement is posted."))
    text, html = email(name, f"Your {Y}, wrapped", blocks, subtitle="A year in the market", button=("Open your portfolio", SITE), foot=foot,
                       preheader=f"{pct(w.get('ret'), 1)} in {Y}" + (f" · #{rank} among friends" if rank else ""))
    return f"{name}: your {Y} wrapped · {pct(w.get('ret'), 1)}", text, html


def card_empty(card):
    """A report card with nothing in it (no sale, no return, no activity in the month or the one before): not sent."""
    a = card.get("activity") or {}
    return not (card.get("cur") or card.get("prev") or card.get("ret") is not None or any(a.get(k) for k in ("buys", "sells", "deposits", "withdrawals")))


def report_card(name, card, foot=None):
    """The monthly trading report card (tools/report_card.js, engine2.js reportCard), to the portfolio's own address: last
    month's sales (every sale, a part sale too) next to the month before, the best and worst, the month's return vs the
    index, and plain tips. The portfolio's own figures, so amounts are fine here."""
    M, P = card["month"], card.get("prevMonth")
    cur, prev = card.get("cur"), card.get("prev")
    mn, pn = month_name(M), month_name(P) if P else "last month"
    short = lambda m: MON[int(m[5:7]) - 1]
    days = lambda x: "—" if x is None else f"{round(x)} day{'s' if round(x) != 1 else ''}"
    delta = lambda a, b, unit: (None if a is None or b is None or abs(a - b) < 1e-9 else
                                f"{'up' if a > b else 'down'} {abs(a - b) * 100:.0f} pts from {short(P)}" if unit == "pts" else
                                f"{'up' if a > b else 'down'} from {b:.0f} in {short(P)}")
    if cur:
        lead = f"You sold {cur['n']} time{'s' if cur['n'] != 1 else ''} in {mn}: {cur['wins']} at a profit, {cur['losses']} at a loss."
    else:
        lead = f"You sold nothing in {mn}."
    if card.get("ret") is not None:
        lead += f" The portfolio returned {pct(card['ret'], 1)}" + (f", the EGX30 Capped {pct(card['bench'], 1)}." if card.get("bench") is not None else ".")
    blocks = [("p", lead)]
    if cur:
        blocks.append(("tiles", [("Win rate", f"{cur['winRate'] * 100:.0f}%", delta(cur["winRate"], prev and prev["winRate"], "pts") or f"{cur['wins']} of {cur['n']} sale{'s' if cur['n'] != 1 else ''}", None),
                                 ("Avg per sale", pct(cur["avgRoi"], 1), "on the cost of the shares sold", tone_of(cur["avgRoi"])),
                                 ("Avg held", days(cur["avgHold"]), "from the buy", None)]))
    row = lambda lab, a, b, f, tone=False: [lab, (f(a), tone_of(a) if tone else None), (f(b), tone_of(b) if tone else None)]
    g = lambda k: (lambda x: x.get(k) if x else None)
    num = lambda x: "—" if x is None else f"{x:.0f}"
    rate = lambda x: "—" if x is None else f"{x * 100:.0f}%"
    rows = [row("Sales", g("n")(cur) or 0, g("n")(prev) or 0, num),
            row("Win rate", g("winRate")(cur), g("winRate")(prev), rate),
            row("Avg return per sale", g("avgRoi")(cur), g("avgRoi")(prev), lambda x: pct(x, 1), True),
            row("Profit or loss on sales", g("pl")(cur), g("pl")(prev), egp, True),
            row("Days held, winners", g("holdWin")(cur), g("holdWin")(prev), days),
            row("Days held, losers", g("holdLoss")(cur), g("holdLoss")(prev), days),
            row("Portfolio return", card.get("ret"), card.get("prevRet"), lambda x: pct(x, 1), True),
            row("EGX30 Capped", card.get("bench"), card.get("prevBench"), lambda x: pct(x, 1), True)]
    rows = [r for i, r in enumerate(rows) if (cur or prev or i >= 6) and (i == 0 or r[1][0] != "—" or r[2][0] != "—")]    # no row of dashes
    blocks += [("h", f"{mn} next to {pn}"), ("table", ["", short(M), short(P) if P else ""], rows, ["l", "r", "r"])]
    sale = lambda x: f"{x['s'] or x['n']}: {pct(x['roi'], 1)} ({egp(x['pl'])}), held {days(x['days'])}" + (" · part sale" if x.get("kind") == "trimmed" else "")
    if card.get("best"):
        blocks.append(("box", "good", "Best sale", [sale(card["best"])]))
    if card.get("worst") and card["worst"]["roi"] < card["best"]["roi"]:
        blocks.append(("box", "bad" if card["worst"]["pl"] < 0 else "info", "Weakest sale", [sale(card["worst"])]))
    a = card.get("activity") or {}
    acts = [("Buys", str(a.get("buys", 0))), ("Sales", str(a.get("sells", 0)))]
    if a.get("deposits"):
        acts.append(("Money in", egp(a["deposits"])))
    if a.get("withdrawals"):
        acts.append(("Money out", egp(a["withdrawals"])))
    blocks += [("h", "Activity"), ("facts", acts)]
    lim = card.get("limits")
    if lim:
        blocks.append(("box", "bad" if lim.get("over") else "good", "Your limits", [
            "All within your limits right now." if not lim.get("over") else
            "; ".join(f"{(x['s'] or x['n']) if x['kind'] == 'stock' else 'The ' + x['n'] + ' sector'} is {x['w'] * 100:.1f}% (limit {x['limit'] * 100:g}%)" for x in lim["over"]) + "."]))
    if card.get("tips"):
        blocks.append(("box", "info", "What the numbers say", card["tips"]))
    if card.get("provisional"):
        blocks.append(("p", f"{mn}'s month-end value is provisional until its Thndr statement is posted, so the returns may still move a little."))
    head = f"{cur['wins']} of {cur['n']} sale{'s' if cur['n'] != 1 else ''} at a profit" if cur else "no sales"
    text, html = email(name, f"{mn} report card", blocks, subtitle="Your trading last month", button=("See your trading", SITE), foot=foot,
                       preheader=f"{head} · portfolio {pct(card.get('ret'), 1)} vs index {pct(card.get('bench'), 1)}")
    return f"{name}: {mn} report card · {head}", text, html


def built(name, seed, summary, short):
    """'Build it from my Thndr emails' is done."""
    held = [e for e in summary.get("log") or [] if e.get("status") == "hold"]
    n, adj = seed.get("months") or 1, seed.get("adjustments") or 0
    first, last = short(seed.get("first") or seed["month"]), short(seed.get("last") or seed["month"])
    h = seed.get("holdings", 0)
    facts = [("Starting point", f"{first} statement" + (" (account empty then)" if (seed.get("earlier") or {}).get("used") else f" · {h} holding{'s' if h != 1 else ''} and cash")),
             ("Monthly statements used", f"{n} (up to {last})"),
             ("Adjustments", f"{adj} ({', '.join(short(m) for m in seed.get('adjustedMonths') or [])})" if adj else "none needed")]
    if summary.get("applied"):
        facts.append((f"Newer Thndr emails", f"{summary['applied']} added"))
    blocks = [("p", "Every deposit, trade, dividend and fee on your monthly Thndr statements is now in your portfolio, and each month ends exactly on Thndr's holdings and cash."),
              ("facts", facts)]
    if adj:
        blocks.append(("p", "Adjustments are small corrections so a month ends on Thndr's figures; they are labelled \"Adjustment\" in your ledger."))
    if seed.get("gaps"):
        blocks.append(("box", "info", "Statements not in your Gmail: " + ", ".join(short(m) for m in seed["gaps"]), ["The month after each is matched to Thndr's figures."]))
    if held:
        blocks.append(("box", "bad", f"{len(held)} newer email{'s' if len(held) > 1 else ''} could not be used", [
            f"{e.get('subject')}: {(e.get('reasons') or ['see the site'])[0]}" for e in held[:8]]))
    blocks.append(("p", "From now on, new Thndr emails are added three times a day: 4:15 pm, 6:15 pm and 11 pm Cairo time."))
    text, html = email(name, "Your portfolio is ready", blocks, subtitle="Built from your Thndr emails", button=("Open your portfolio", SITE), foot=ACCOUNT_FOOT)
    return f"{name}: built from your Thndr emails", text, html


def waiting(name, reason):
    blocks = [("box", "info", "Not built yet", [reason[0].upper() + reason[1:] + "."]),
              ("p", "Thndr emails a monthly statement at the start of every month (subject \"Your monthly E-statement\"). As soon as one is in your Gmail, your portfolio is built by itself: nothing else to do."),
              ("p", "Don't want to wait? Request a statement in the Thndr app.")]
    text, html = email(name, "Waiting for a Thndr statement", blocks, button=("Open the site", SITE), foot=ACCOUNT_FOOT)
    return f"{name}: waiting for a monthly Thndr statement", text, html


def gmail_error(name, err):
    blocks = [("box", "bad", "Your Thndr emails could not be read", [err[0].upper() + err[1:] if err else err]),
              ("p", "Usually the Gmail app password was deleted or changed. Nothing in your portfolio was changed."),
              ("h", "To fix it"),
              ("steps", ["Open the site and sign in.", "Account → Thndr emails → Change app password.", "Follow the steps there to make a new app password."])]
    text, html = email(name, "Gmail connection stopped", blocks, button=("Open the site", SITE), foot=ACCOUNT_FOOT)
    return f"{name}: Thndr emails could not be read", text, html
