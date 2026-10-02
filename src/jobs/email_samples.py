#!/usr/bin/env python3
"""One sample of every email the portfolio jobs send, made from SYNTHETIC data (src/tests/fixtures/make_synthetic.js,
"Demo Portfolio" and friends: nothing from a real portfolio), sent to the owner only (engine workflow email-samples.yml).

    python3 email_samples.py --engine DIR --code DIR --pdfjs NODE_MODULES [--dry-run OUTDIR]

Each subject starts with "[Sample]". The first email lists them all: who gets each one and when. The account emails
come from src/tests/test_account_mail.py (fake Firebase and mailer, DUMP_EMAILS), the owner's from the job functions
themselves. Recipient: the owner's settings.factsheetEmail (jobs_common.Ctx.recipient), never anyone else.
Env: SETUP_KEY, GMAIL_ADDRESS / GMAIL_APP_PASSWORD. Needs node, a node_modules with pdfjs-dist OUTSIDE the code
checkout (--pdfjs; the test copies the checkout) and Playwright (for the PDF factsheet)."""
import os, sys, json, base64, shutil, argparse, tempfile, subprocess, urllib.request, datetime
from email.message import EmailMessage

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402
import mail_send, run_market, run_sync, alarm_key, emails  # noqa: E402

SITE = "https://khaledamin2001-lgtm.github.io/portfolio/"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# (key, who gets it and when) in the order they are sent; the key is matched against the samples made below
GUIDE = [
    ("market", "You · after each EGX close, Sun-Thu about 3:45 pm"),
    ("posted", "You · at the 4:15 / 6:15 / 11 pm check, when a Thndr statement or invoice was added (friends get the same for their own portfolio)"),
    ("review", "You · at a check, when a Thndr email could not be used (friends: the same, for their own)"),
    ("missing", "You · at a check from the 10th, when last month's statement has not arrived (friends: the same, for their own)"),
    ("weekly", "You · Thursday evening (friends who switch it on get their own)"),
    ("factsheet", "You · when your monthly statement is posted"),
    ("reminder", "You · on the 11th, if last month's statement is still not posted"),
    ("signup", "You · when someone new signs up on the site"),
    ("token", "You · 14 days before the site's publishing key expires"),
    ("alarmkey", "You · 14, 7, 3, 2 and 1 days before the on-time alarm key expires"),
    ("failed", "You · only when a job fails"),
    ("alerts", "Friends · after a market close, when there is a new heads-up on their portfolio"),
    ("monthend", "Friends · when their monthly statement is posted: the Excel workbook and PDF factsheet attached"),
    ("friend", "Friends · when someone sends them a friend request on the site"),
    ("built", "Friends · once, when \"Build it from my Thndr emails\" has built their portfolio"),
    ("waiting", "Friends · once, when their portfolio cannot be built yet (no monthly statement in their Gmail)"),
    ("gmail", "Friends · once, when their Gmail app password stops working"),
    ("leaderboard", "Friends · on the 1st of the month: how they and their friends ranked last month (percentages only)"),
    ("card", "You and friends · early each month (once last month's statement is in, or the 5th): your trading report card"),
]


def account_samples(code, tools, work):
    """The account job's emails from test_account_mail.py, keyed like GUIDE."""
    syn, dump = os.path.join(work, "synthetic"), os.path.join(work, "mails")
    jc.run(["node", os.path.join(code, "src", "tests", "fixtures", "make_synthetic.js"), syn], "samples: synthetic data")
    r = subprocess.run([sys.executable, os.path.join(code, "src", "tests", "test_account_mail.py"), syn, tools], capture_output=True, text=True,
                       env={**os.environ, "DUMP_EMAILS": dump, "REQUIRE_PDF": "1"}, timeout=1800)
    if not os.path.isdir(dump):
        raise jc.JobError("samples: account emails", (r.stdout + r.stderr)[-300:])
    out = {}
    for f in sorted(x for x in os.listdir(dump) if x.endswith(".txt")):
        n = f[:-4]
        head, _, text = open(os.path.join(dump, f), encoding="utf-8").read().partition("\n\n")
        subj = next(l[9:] for l in head.splitlines() if l.startswith("Subject: "))
        html = open(os.path.join(dump, n + ".html"), encoding="utf-8").read() or None
        att = [(x[len(n) + 1:], open(os.path.join(dump, x), "rb").read(), XLSX if x.endswith(".xlsx") else "application/pdf")
               for x in sorted(os.listdir(dump)) if x.startswith(n + "-")]
        key = ("alerts" if "heads-up" in subj else "weekly" if " week to " in subj else "friend" if "wants to be friends" in subj
               else "posted" if "statement posted" in subj else "monthend" if "month-end report" in subj else "built" if "built from your" in subj
               else "waiting" if "waiting for" in subj else "signup" if subj.startswith("New on your") else "gmail" if "could not be read" in subj else "leaderboard" if " leaderboard: " in subj else "card" if " report card" in subj else None)
        if key and key not in out:
            out[key] = {"subject": subj, "text": text, "html": html, "att": att}
    return out, syn


def sync_email(tools, syn, work, today, pdf_args=None, subject="Your monthly E-statement - Sep 2026"):
    """sync.js on a copy of the synthetic portfolio, with an empty inbox or one made-up statement email."""
    t = tempfile.mkdtemp(dir=work)
    data, inbox, out = os.path.join(t, "data"), os.path.join(t, "inbox"), os.path.join(t, "out")
    shutil.copytree(syn, data)
    os.makedirs(inbox)
    man = []
    if pdf_args:
        d = os.path.join(t, "pdf")
        jc.run([sys.executable, os.path.join(CODE, "src", "tests", "fixtures", "make_statement_pdf.py"), d] + pdf_args, "samples: statement pdf")
        m = EmailMessage()
        m["Authentication-Results"] = "mx.google.com; dkim=pass header.i=@thndr.app header.s=s1 header.b=x; spf=pass smtp.mailfrom=system.thndr.app"
        m["From"], m["Subject"] = "Thndr <no-reply@system.thndr.app>", subject
        m.set_content("x")
        for f in sorted(os.listdir(d)):
            m.add_attachment(open(os.path.join(d, f), "rb").read(), maintype="application", subtype="pdf", filename=f)
        json.dump({"id": "m1", "raw": base64.urlsafe_b64encode(m.as_bytes()).decode()}, open(os.path.join(inbox, "m1.json"), "w"))
        man.append({"id": "m1", "subject": subject, "date": "1790800000000"})   # private-scan: synthetic
    json.dump(man, open(os.path.join(inbox, "manifest.json"), "w"))
    jc.run(["node", os.path.join(tools, "sync.js"), "--data", data, "--inbox", inbox, "--out", out, "--today", today], "samples: sync.js")
    e = json.load(open(os.path.join(out, "summary.json"))).get("email")
    if not e:
        return None
    subj, text, html = emails.sync_email(e["subject"], e["parts"])
    return {"subject": subj, "text": text, "html": html, "att": []}


class _Demo:
    """Just enough of jobs_common.Ctx for the owner's email functions, on the demo portfolio."""
    config = {"name": "Demo Portfolio", "siteRepo": "khaledamin2001-lgtm/portfolio"}
    live = True
    def settings(self): return {"name": "Demo Portfolio"}
    def today(self): return "2026-10-11"


def owner_samples(tools, syn, work, acct):
    got = []
    real = (mail_send.send, mail_send.send_failure, urllib.request.urlopen)
    mail_send.send = lambda ctx, subject, text, html=None, to=None, attachments=None: got.append({"subject": subject, "text": text, "html": html, "att": attachments or []}) or "kept"
    mail_send.send_failure = lambda ctx, e, c, subject, body, html=None: got.append({"subject": subject, "text": body, "html": html, "att": []}) or "kept"
    out = {}
    try:
        o = {"latest": {"asOf": "2026-09-30T15:12+03:00", "quotes": {f"S{i}": {} for i in range(296)}, "missing": ["ZZB"],
                        "index": {"EGX30CAPPED": {"close": 64525.40, "chg": -0.65, "date": "2026-09-30"}}, "rates": {"policy": {"rate": 0.19, "date": "2026-09"}}},   # private-scan: synthetic
             "fillErrors": {"ZZA": "x"}, "bench": {"divYield": 0.0372}}   # private-scan: synthetic
        s, t, h = run_market.success_email(o, {"historyMonths": ["2026-09"], "sessions": 1, "newAssets": 0, "marksFilled": {}}, True)
        out["market"] = {"subject": s, "text": t, "html": h, "att": []}
        out["missing"] = sync_email(tools, syn, work, "2026-10-11")
        out["review"] = sync_email(tools, syn, work, "2026-10-02", ["--name", "Someone Else", "--month", "2026-09"])
        mk = tempfile.mkdtemp(dir=work)
        os.makedirs(os.path.join(mk, "portfolio"))
        json.dump({"data": {"months": {"2026-09": {"cash": 1, "securities": 2, "provisional": True}}}}, open(os.path.join(mk, "portfolio", "marks.json"), "w"))
        run_sync.site_url = lambda ctx: SITE
        got.clear(); run_sync.backstop(_Demo(), {"prevMonth": "2026-09", "dayOfMonth": 11, "today": "2026-10-11"}, mk, os.path.join(mk, "w"), {}); out["reminder"] = got[0]

        class R:
            headers = {"github-authentication-token-expiration": "2026-10-25 00:00:00 UTC"}
            def __enter__(self): return self
            def __exit__(self, *a): pass
        urllib.request.urlopen = lambda *a, **k: R()
        env = os.environ.get("SITE_TOKEN")
        os.environ["SITE_TOKEN"] = "sample"
        got.clear(); run_sync.token_check(_Demo(), {"today": "2026-10-11"}, {}); out["token"] = got[0]
        os.environ.pop("SITE_TOKEN") if env is None else os.environ.__setitem__("SITE_TOKEN", env)
        s, t, h = alarm_key.reminder(datetime.date(2026, 10, 18), datetime.date(2026, 10, 11))
        out["alarmkey"] = {"subject": s, "text": t, "html": h, "att": []}
        mark = os.environ.get("JOBS_FAILURE_MARK")
        os.environ["JOBS_FAILURE_MARK"] = os.path.join(work, "failure-mark")
        got.clear(); jc.report_failure(_Demo(), "market", "fetch prices", "the EGX price source did not answer (HTTP 503)"); out["failed"] = got[0]
        os.environ.pop("JOBS_FAILURE_MARK") if mark is None else os.environ.__setitem__("JOBS_FAILURE_MARK", mark)
    finally:
        mail_send.send, mail_send.send_failure, urllib.request.urlopen = real
    # the owner's month-end email: the demo portfolio's own factsheet (PDF + headline figures) and workbook
    import run_account_mail
    M, rp = "2026-08", os.path.join(work, "report")
    os.makedirs(rp)
    sm_p, pdf_p, xl_p, xlsx_p = (os.path.join(rp, f) for f in ("summary.json", "Demo-Portfolio-Aug-26.pdf", "xl.json", "Demo-Portfolio-Aug-26.xlsx"))
    jc.run(["node", os.path.join(tools, "factsheet.js"), "--page", run_account_mail.report_page(CODE), "--data", syn, "--month", M,
            "--out", os.path.join(rp, "f.html"), "--pdf", pdf_p, "--summary", sm_p], "samples: factsheet", timeout=600)
    jc.run(["node", os.path.join(tools, "excel.js"), "--data", syn, "--month", M, "--out", xl_p], "samples: excel.js")
    jc.run([sys.executable, os.path.join(tools, "excel.py"), xl_p, xlsx_p], "samples: excel.py")
    s, t, h = emails.monthend("Demo Portfolio", M, json.load(open(sm_p)), ["the PDF factsheet", "the Excel workbook"])
    out["factsheet"] = {"subject": s, "text": t, "html": h, "att": [(os.path.basename(pdf_p), open(pdf_p, "rb").read(), "application/pdf"),
                                                                  (os.path.basename(xlsx_p), open(xlsx_p, "rb").read(), XLSX)]}
    return out


def main(argv=None):
    global CODE
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code", required=True)
    ap.add_argument("--pdfjs", required=True, help="a node_modules directory with pdfjs-dist")
    ap.add_argument("--dry-run", metavar="OUTDIR")
    a = ap.parse_args(argv)
    CODE = os.path.abspath(a.code)
    work = tempfile.mkdtemp(prefix="samples-", dir=os.environ.get("RUNNER_TEMP") or None)
    try:
        tools = os.path.join(work, "tools")
        shutil.copytree(os.path.join(CODE, "src", "tools"), tools, ignore=shutil.ignore_patterns("node_modules"))
        shutil.copytree(a.pdfjs, os.path.join(tools, "node_modules"))
        acct, syn = account_samples(CODE, tools, work)
        samples = {**acct, **owner_samples(tools, syn, work, acct)}
        order = [k for k, _ in GUIDE if samples.get(k)]
        from mail_html import email as mail
        guide = dict(GUIDE)
        mine = [f"{i + 1}. {samples[k]['subject']} — {guide[k].split(' · ', 1)[1]}" for i, k in enumerate(order) if guide[k].startswith("You")]
        theirs = [f"{i + 1}. {samples[k]['subject']} — {guide[k].split(' · ', 1)[1]}" for i, k in enumerate(order) if not guide[k].startswith("You")]
        it, ih = mail("Email samples", "Every email the portfolio sends", [
            ("p", "One sample of each, made from a made-up \"Demo Portfolio\": none of the figures are yours. The number matches the [Sample] number in each subject."),
            ("h", "Emails you get", "you run the platform; these are about your own portfolio and the jobs"), ("list", mine),
            ("h", "Emails your friends get", "only to their own address, only when they switch them on in their account; never to you"), ("list", theirs),
            ("box", "info", None, ["Real emails never start with [Sample]."])], button=("Open the site", SITE))
        msgs = [("[Sample] 0 · every email the portfolio sends", it, ih, [])]
        msgs += [(f"[Sample] {i + 1} · {samples[k]['subject']}", samples[k]["text"], samples[k]["html"], samples[k]["att"]) for i, k in enumerate(order)]
        missing = [k for k, _ in GUIDE if not samples.get(k)]
        if a.dry_run:
            os.makedirs(a.dry_run, exist_ok=True)
            for i, (s, t, h, att) in enumerate(msgs):
                json.dump({"subject": s, "text": t, "html": h, "att": [x[0] for x in att]}, open(os.path.join(a.dry_run, f"{i:02d}.json"), "w"))
            print(f"samples: {len(msgs)} written to {a.dry_run}" + (f"; not made: {', '.join(missing)}" if missing else ""))
            return 0 if not missing else 1
        ctx = jc.Ctx(a.engine, a.code)
        to = ctx.recipient()
        sender, pw = mail_send._sender()
        for s, t, h, att in msgs:
            mail_send.smtp_send(mail_send.build(sender, to, s, t, h, att), sender, pw, to)
        print(f"samples: {len(msgs)} emails sent" + (f"; not made: {', '.join(missing)}" if missing else ""))
        return 0 if not missing else 1
    except jc.JobError as e:
        print(f"samples: not done: {e.step}: {jc.mask(str(e.detail))[:300]}")
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)


CODE = None
if __name__ == "__main__":
    sys.exit(main())
