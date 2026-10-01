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
              ("box", "info", "If you accept", ["You both see each other's portfolio: holdings, returns and activity, read-only.", "Either of you can remove it any time."]),
              ("p", "To answer, sign in on the site: the request is under Account, then Friends.")]
    text, html = email(name, f"{who} wants to be friends", blocks, button=("Answer the request", SITE + "?friends"), foot=ACCOUNT_FOOT)
    return f"{who} wants to be friends on the portfolio site", text, html


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
