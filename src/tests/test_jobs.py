#!/usr/bin/env python3
"""Public unit tests of the engine-repo jobs (src/jobs/*) on synthetic data only - no network, no secrets, no private
fixtures. Covers the rules the jobs follow: the market job's never-overwrite marks patch and its write
plan, the sync job's mapping of sync.js write files to pinned store writes, the Cairo time gate, the IMAP search query
and id/date conversions, the publish allow-list and index.json merge, and mail_send's recipient lock.
    python3 src/tests/test_jobs.py        (exit 0 = all pass; needs: cryptography)"""
import os, sys, json, tempfile, shutil
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "jobs"))
import jobs_common as jc      # noqa: E402
import email_gate, imap_fetch, site_git, mail_send, run_account_mail as ram   # noqa: E402

fails = 0


def check(name, ok):
    global fails
    print(("PASS " if ok else "FAIL ") + name)
    fails += 0 if ok else 1


# ---- sync: write/ files -> store writes
tmp = tempfile.mkdtemp()
try:
    for f in ("ledger_y2026.json", "marks.json", "settings.json", "assets_update.json", "import_2026-09.json", "sync_state.json"):
        json.dump({"x": f}, open(f"{tmp}/{f}", "w"))
    w = ram.writes_from_plan(tmp, {"ledger/y2026": 9, "portfolio/marks": 2, "portfolio/settings": 3, "portfolio/assets": 4, "sync/state": 5})
    got = {(x["op"], x["collection"], x["doc_id"], x["if_version"]) for x in w}
    check("sync plan: every file maps to its store write, pinned (0 = new doc)", got == {
        ("set", "ledger", "y2026", 9), ("set", "portfolio", "marks", 2), ("set", "portfolio", "settings", 3),
        ("update", "portfolio", "assets", 4), ("set", "imports", "2026-09", 0), ("set", "sync", "state", 5)})
    json.dump({}, open(f"{tmp}/surprise.json", "w"))
    try:
        ram.writes_from_plan(tmp, {})
        check("sync plan: an unknown write file is an error", False)
    except jc.JobError:
        check("sync plan: an unknown write file is an error", True)
finally:
    shutil.rmtree(tmp)

# ---- time gate
P = lambda t, d="2026-09-28": {"today": d, "minuteOfDay": int(t[:2]) * 60 + int(t[3:])}
check("gate: the email run 16:14 no, 16:15 afternoon, 18:14 afternoon, 18:15 evening, 23:00 night, 00:30 after midnight, 07:00 no",
      [jc.gate(P(t), email_gate.WINDOWS, {}, False)[0] for t in ("16:14", "16:15", "18:14", "18:15", "22:59", "23:00", "23:59", "00:30", "07:00")]
      == [None, "afternoon", "afternoon", "evening", "evening", "night", "night", "after midnight", None])
check("gate: a slot already run today is skipped, yesterday's is not",
      jc.gate(P("19:17"), email_gate.WINDOWS, {"evening": "2026-09-28"}, False)[0] is None and jc.gate(P("19:17"), email_gate.WINDOWS, {"evening": "2026-09-27"}, False)[0] == "evening")
check("gate: a run by hand always counts", jc.gate(P("03:00"), email_gate.WINDOWS, {"after midnight": "2026-09-28"}, True)[0] == "manual")
# the gate itself on a throwaway engine checkout: the first firing in a slot runs and is recorded, a second one does not
import subprocess   # noqa: E402
tmp = tempfile.mkdtemp()
try:
    eng, out, code = os.path.join(tmp, "engine"), os.path.join(tmp, "gh_output"), os.path.join(tmp, "code")
    os.makedirs(eng); os.makedirs(code)
    os.symlink(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), os.path.join(code, "src"))   # this checkout's src/ (CI runs a copy)
    json.dump({"siteRepo": "x/y", "ownerEmail": "owner@example.com"}, open(os.path.join(eng, "config.json"), "w"))
    for c in (["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed"]):
        subprocess.run(["git", "-C", eng] + c, check=True, capture_output=True)
    _tok = os.environ.pop("SITE_TOKEN", None)
    os.environ["GITHUB_OUTPUT"] = out
    try:
        rc1 = email_gate.main(["--engine", eng, "--code", code, "--now", "2026-09-28T13:20:00Z"])          # Monday 16:20 Cairo
        st = json.load(open(os.path.join(eng, "jobs.json")))
        rc2 = email_gate.main(["--engine", eng, "--code", code, "--now", "2026-09-28T14:00:00Z"])          # 17:00, the same slot
        rc3 = email_gate.main(["--engine", eng, "--code", code, "--now", "2026-09-28T10:00:00Z"])          # 13:00, no slot
    finally:
        os.environ.pop("GITHUB_OUTPUT", None)
        if _tok is not None:
            os.environ["SITE_TOKEN"] = _tok
    ran = [l for l in open(out).read().splitlines() if l.startswith("ran=")]
    log = subprocess.run(["git", "-C", eng, "log", "--format=%s"], capture_output=True, text=True).stdout
    check("email gate: the first firing in a slot runs and is recorded (jobs.json committed), a second or one outside the slots does not",
          (rc1, rc2, rc3) == (0, 0, 0) and ran == ["ran=true", "ran=false", "ran=false"] and st["sync"]["slots"] == {"afternoon": "2026-09-28"}
          and "jobs: email run 2026-09-28 afternoon" in log)
finally:
    shutil.rmtree(tmp)

# ---- IMAP helpers
check("imap: the Gmail query", imap_fetch.QUERY.format(after="2026/09/22") ==
      'from:(no-reply@system.thndr.app OR no-reply@mail.thndr.app) (subject:Invoice OR subject:E-statement OR subject:"top-up request" '
      'OR subject:"withdrawal has been processed" OR subject:"Cash Dividends Added" OR subject:"custody fees") -subject:"US Market" after:2026/09/22')
_mk = {"2026-07": {"source": "statement"}, "2026-08": {"source": "reconstructed", "provisional": False}, "2026-09": {"provisional": True}}
check("imap: the search starts 3 days before the first month not yet closed by a statement",
      imap_fetch.mail_floor({}, _mk, {}, "2026/09/27") == "2026/08/29"
      and imap_fetch.mail_floor({}, {"2026-07": {"source": "statement"}}, {"2026-08": {"fullMonth": True}}, "2026/09/27") == "2026/08/29")
check("imap: never later than the last run's window, and tracking start counts",
      imap_fetch.mail_floor({}, {"2026-11": {"source": "statement"}}, {}, "2026/09/27") == "2026/09/27"
      and imap_fetch.mail_floor({"trackFrom": "2026-09-20"}, _mk, {}, "2026/10/01") == "2026/09/17"
      and imap_fetch.mail_floor({}, {}, {}, "2026/09/27") == "2026/09/27")
check("imap: Thndr's money emails are kept", all(s.startswith(imap_fetch.KEEP) for s in ("Your top-up request has been accepted ", "Your withdrawal has been processed ", "Cash Dividends Added", "Your annual custody fees "))
      and not "Withdrawal request submitted ".startswith(imap_fetch.KEEP))
check("imap: quoted for IMAP", imap_fetch.imap_quote('a "b" c') == '"a \\"b\\" c"')
check("imap: INTERNALDATE -> ms", imap_fetch.internal_ms("31-Dec-2025 08:32:02 +0000") == "1767169922000"   # private-scan: synthetic
      and imap_fetch.internal_ms(" 1-Jan-2026 02:00:00 +0200") == "1767225600000")   # private-scan: synthetic
check("imap: X-GM-MSGID -> Gmail API id (hex)", format(1853011970335501012, "x") == "19b73891c064ead4")   # private-scan: synthetic
_seen = {"i1": {"kind": "invoice"}, "m1": {"kind": "monthly"}, "x": {"kind": None}}
check("imap: seen invoices are read again only while a stock has no ticker",
      imap_fetch.skip_ids(_seen, {"CIB": {"name": "CIB", "symbol": "COMI"}, "thndrgold": {"name": "thndrgold", "fund": True}}) == {"i1", "m1", "x"}
      and imap_fetch.skip_ids(_seen, {"Raya": {"name": "Raya", "sector": "Unclassified"}}) == {"m1", "x"}
      and imap_fetch.skip_ids(None, None) == set())
check("imap: a statement an earlier run held is read again",
      imap_fetch.skip_ids({"r1": {"kind": "requested", "status": "hold"}, "r2": {"kind": "requested", "status": "applied"}, "i2": {"kind": "invoice", "status": "hold"}}, {}) == {"r2", "i2"})
check("imap: subjects kept", all(s.startswith(imap_fetch.KEEP) for s in ("Your Thndr Invoice", "Your requested E-statement - Sep 2026", "Your monthly E-statement - Aug 2026"))
      and not "Invoice ready".startswith(imap_fetch.KEEP))

# ---- what the jobs publish to the site is always an encrypted envelope
tmp = tempfile.mkdtemp()
try:
    json.dump({"v": 1, "name": "x", "bytes": 3, "epk": "QUJD", "iv": "QUJD", "ct": "QUJDREVGR0hJSktMTU5PUA=="}, open(f"{tmp}/e.json", "w"))
    json.dump({"v": 1, "plain": "no"}, open(f"{tmp}/p.json", "w"))
    check("publish: envelope shape check", site_git.is_envelope(f"{tmp}/e.json") and not site_git.is_envelope(f"{tmp}/p.json"))
finally:
    shutil.rmtree(tmp)

# ---- the monthly report card email, with and without sales
tmp = tempfile.mkdtemp()
try:
    import emails
    base = {"month": "2026-09", "prevMonth": "2026-08", "ret": 0.03, "bench": 0.05, "prevRet": 0.051, "prevBench": 0.01, "provisional": False,
            "activity": {"buys": 2, "sells": 3, "deposits": 1000, "withdrawals": 0}, "limits": None, "tips": ["A tip."]}
    cur = {"n": 3, "wins": 2, "losses": 1, "winRate": 2 / 3, "avgRoi": 0.05, "pl": 1234.5, "avgHold": 20, "holdWin": 10, "holdLoss": 40, "avgWin": 900, "avgLoss": -565.5}
    s1, t1, h1 = emails.report_card("Demo", dict(base, cur=cur, prev=dict(cur, winRate=0.5), best={"d": "2026-09-07", "s": "COMI", "n": "x", "kind": "closed", "roi": 0.2, "pl": 900, "days": 12},
                                                worst={"d": "2026-09-09", "s": "ETEL", "n": "y", "kind": "trimmed", "roi": -0.1, "pl": -565.5, "days": 40}))
    check("report card email: the month, the score next to the month before, best and weakest sale",
          s1 == "Demo: September 2026 report card · 2 of 3 sales at a profit" and "up 17 pts from Aug" in t1 and "COMI: +20.0% (900 EGP), held 12 days" in t1
          and "ETEL: −10.0% (−566 EGP), held 40 days · part sale" in t1 and "A tip." in t1 and "<html" in h1.lower())
    s2, t2, _ = emails.report_card("Demo", dict(base, cur=None, prev=None, best=None, worst=None, provisional=True))
    check("report card email: a month with no sale, and a provisional month-end", s2.endswith("· no sales") and "You sold nothing in September 2026." in t2 and "provisional" in t2)
finally:
    shutil.rmtree(tmp)

# ---- mail_send: recipient lock (no network: refused before connecting)
class FakeCtx:
    live = True
    def recipient(self):
        return "owner@example.com"
try:
    mail_send.send(FakeCtx(), "s", "t", to="other@example.com")
    check("mail: another recipient is refused", False)
except jc.JobError:
    check("mail: another recipient is refused", True)

# ---- the site owner's address: config.json ownerEmail, else GMAIL_ADDRESS; FAILED notices go there too
class RCtx:
    def __init__(self, config):
        self.config = config
_g = os.environ.pop("GMAIL_ADDRESS", None)
try:
    check("owner address: config.json ownerEmail", jc.Ctx.recipient(RCtx({"ownerEmail": "owner@example.com"})) == "owner@example.com")
    os.environ["GMAIL_ADDRESS"] = "mailbox@example.com"
    check("owner address: else the GMAIL_ADDRESS secret", jc.Ctx.recipient(RCtx({})) == "mailbox@example.com")
    fc = RCtx({"ownerEmail": "owner@example.com"}); fc.recipient = lambda: jc.Ctx.recipient(fc)
    check("owner address: FAILED notices go to the owner too", jc.Ctx.failure_recipient(fc) == "owner@example.com")
    try:
        jc.Ctx.recipient(RCtx({"ownerEmail": "not an address"}))
        check("owner address: an invalid address is refused", False)
    except jc.JobError:
        check("owner address: an invalid address is refused", True)
finally:
    os.environ.pop("GMAIL_ADDRESS", None)
    if _g is not None:
        os.environ["GMAIL_ADDRESS"] = _g

# ---- shared market: history days merge, macro accumulates, month-end index closes from history
import run_shared_market as rsm   # noqa: E402
tmp = tempfile.mkdtemp()
try:
    o1 = {"latest": {"asOf": "x", "quotes": {"AAA": {"price": 1}}}, "currentMonth": "2026-09",
          "histories": [{"month": "2026-08", "days": {"2026-08-30": {"AAA": 1, "EGX30CAPPED": 100.5}, "2026-08-31": {"AAA": 2, "EGX30CAPPED": 101.5}}}],
          "bench": {"members": [{"s": "AAA"}], "asOf": "2026-09-01", "divYield": None}, "macro": {"cpiMoM": {"2026-07": 0.01}, "cpiSource": "s"},
          "prevMonth": {"month": "2026-08", "benchClose": None}}
    os.makedirs(f"{tmp}/history")
    json.dump({"capWeight": 0.15, "actions": []}, open(f"{tmp}/bench.json", "w"))
    rsm.merge(tmp, o1)
    o2 = dict(o1, histories=[{"month": "2026-09", "days": {"2026-09-01": {"AAA": 3}}}, {"month": "2026-08", "days": {"2026-08-31": {"BBB": 9}}}],
              macro={"cpiMoM": {"2026-08": 0.02}})
    info = rsm.merge(tmp, o2)
    h8 = json.load(open(f"{tmp}/history/2026-08.json"))
    check("shared market: history days merge (a new symbol joins, the old ones stay)", h8["days"]["2026-08-31"] == {"AAA": 2, "EGX30CAPPED": 101.5, "BBB": 9} and info["months"] == ["2026-09", "2026-08"])
    m = json.load(open(f"{tmp}/macro.json"))
    check("shared market: macro accumulates run after run", m["cpiMoM"] == {"2026-07": 0.01, "2026-08": 0.02} and m["cpiSource"] == "s")
    check("shared market: a closed month's index close comes from its last session", m["benchClose"] == {"2026-08": 101.5})
    b = json.load(open(f"{tmp}/bench.json"))
    check("shared market: bench keeps capWeight/actions, takes members", b["capWeight"] == 0.15 and b["members"] == [{"s": "AAA"}] and "divYield" not in b)
    docs = rsm.bundle(tmp)
    check("shared market: the bundle holds latest, bench, macro and every history month", sorted(docs) == ["bench/egx30", "history/2026-08", "history/2026-09", "market/latest", "market/macro"])
finally:
    shutil.rmtree(tmp)

# ---- log masking
m = jc.mask("value 1,234,567.89 and 98765.43 at line 12")   # private-scan: synthetic
check("mask: figures hidden in logs, small numbers kept", "1,234" not in m and "98765" not in m and "12" in m)

# ---- the on-time alarm key: the watcher's daily expiry check and the reminder email
import datetime, urllib.request, kick_new_accounts as kna, alarm_key   # noqa: E402
calls = []
class _R:
    def __init__(self, exp): self.headers = {"github-authentication-token-expiration": exp} if exp else {}
    def __enter__(self): return self
    def __exit__(self, *a): pass
    def read(self): return b""
def _fake(exp, runs=()):
    def urlopen(req, timeout=None):
        calls.append((req.get_method(), req.full_url, req.data))
        return _R(exp)
    urllib.request.urlopen = urlopen
    kna.get = lambda url, headers=None: {"workflow_runs": [{"created_at": r} for r in runs]}
real_urlopen, real_get = urllib.request.urlopen, kna.get
try:
    at10 = datetime.datetime(2026, 10, 8, 7, 0, tzinfo=datetime.timezone.utc)      # 10:00 Cairo (summer time)
    _fake("2026-10-15 00:00:00 UTC"); calls.clear()
    check("alarm key: before 10:00 Cairo nothing is checked", kna.key_check(at10 - datetime.timedelta(minutes=5), "k") is None and not calls)
    check("alarm key: no key, nothing checked", kna.key_check(at10, "") is None and not calls)
    out = kna.key_check(at10, "k")
    post = [c for c in calls if c[0] == "POST"]
    check("alarm key: 7 days before, the reminder workflow is started with the date", out == "alarm key: expires 2026-10-15; reminder started"
          and len(post) == 1 and post[0][1].endswith("/actions/workflows/alarm-key.yml/dispatches") and json.loads(post[0][2])["inputs"] == {"expires": "2026-10-15"})
    _fake("2026-10-15 00:00:00 UTC", ["2026-10-08T07:00:30Z"]); calls.clear()
    check("alarm key: only once a day", kna.key_check(at10, "k") == "alarm key: expires 2026-10-15; reminder already sent today" and not [c for c in calls if c[0] == "POST"])
    _fake("2026-10-20 00:00:00 UTC"); calls.clear()
    check("alarm key: 12 days before, no email", kna.key_check(at10, "k") == "alarm key: valid until 2026-10-20" and not [c for c in calls if c[0] == "POST"])
    # the morning brief: Sunday to Thursday, 9:00-9:59 Cairo, once a day
    at9 = datetime.datetime(2026, 10, 8, 6, 0, tzinfo=datetime.timezone.utc)       # Thursday 9:00 Cairo (summer time)
    _fake(None); calls.clear()
    out = kna.morning_check(at9, "k"); post = [c for c in calls if c[0] == "POST"]
    check("morning brief: at 9:00 on a weekday the workflow is started", out == "morning brief: started" and len(post) == 1 and post[0][1].endswith("/actions/workflows/morning.yml/dispatches"))
    _fake(None, ["2026-10-08T06:00:20Z"]); calls.clear()
    check("morning brief: only once a day", kna.morning_check(at9 + datetime.timedelta(minutes=5), "k") == "morning brief: already started today" and not [c for c in calls if c[0] == "POST"])
    _fake(None); calls.clear()
    check("morning brief: not before 9:00, not after 9:59, not on Friday or Saturday, not without a key",
          kna.morning_check(at9 - datetime.timedelta(minutes=1), "k") is None and kna.morning_check(at9 + datetime.timedelta(minutes=60), "k") is None
          and kna.morning_check(at9 + datetime.timedelta(days=1), "k") is None and kna.morning_check(at9 + datetime.timedelta(days=2), "k") is None
          and kna.morning_check(at9, "") is None and not calls)
    # the after-close recap: Sunday to Thursday, 16:30-17:59 Cairo, once a day
    at1630 = datetime.datetime(2026, 10, 8, 13, 30, tzinfo=datetime.timezone.utc)   # Thursday 16:30 Cairo (summer time)
    _fake(None); calls.clear()
    out = kna.evening_check(at1630, "k"); post = [c for c in calls if c[0] == "POST"]
    check("after-close recap: at 16:30 on a weekday the workflow is started", out == "after-close recap: started" and len(post) == 1 and post[0][1].endswith("/actions/workflows/evening.yml/dispatches"))
    _fake(None, ["2026-10-08T13:30:20Z"]); calls.clear()
    check("after-close recap: only once a day", kna.evening_check(at1630 + datetime.timedelta(minutes=5), "k") == "after-close recap: already started today" and not [c for c in calls if c[0] == "POST"])
    _fake(None); calls.clear()
    check("after-close recap: not before 16:30, not from 18:00, not on Friday or Saturday, and the morning window is not the evening's",
          kna.evening_check(at1630 - datetime.timedelta(minutes=1), "k") is None and kna.evening_check(at1630 + datetime.timedelta(minutes=90), "k") is None
          and kna.evening_check(at1630 + datetime.timedelta(days=1), "k") is None and kna.evening_check(at1630 + datetime.timedelta(days=2), "k") is None
          and kna.evening_check(at9, "k") is None and kna.morning_check(at1630, "k") is None and not calls)
    # a new account while the scheduled email run is going: wait (both would email the same account), start it after
    import io, contextlib
    os.environ["ENGINE_TOKEN"] = "k"
    acct = {"name": "x/mail/U1", "createTime": "2026-10-08T05:58:00Z", "updateTime": "2026-10-08T05:58:00Z"}
    def runs_get(busy):
        return lambda url, headers=None: ({"documents": [acct]} if "firestore" in url else
                                          {"workflow_runs": [{"created_at": "2026-10-08T05:59:00Z", "status": "in_progress"}] if (busy and "email-run" in url) else []})
    for busy, want in ((True, "checking again next time"), (False, "started now")):
        _fake(None); kna.get = runs_get(busy); calls.clear(); buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            kna.main(["--now", "2026-10-08T06:00:00Z"])
        posts = [c for c in calls if c[0] == "POST" and c[1].endswith("/account-mail.yml/dispatches")]
        check(f"new account, email run {'going' if busy else 'idle'}: {'waits' if busy else 'starts the account job'}", want in buf.getvalue() and len(posts) == (0 if busy else 1))
    os.environ.pop("ENGINE_TOKEN", None)
finally:
    urllib.request.urlopen, kna.get = real_urlopen, real_get
subj, body, html = alarm_key.reminder(datetime.date(2026, 10, 9), datetime.date(2026, 10, 8))
check("alarm key email: subject with the date, body says tomorrow and how to renew", subj == "Portfolio: on-time alarm key expires 9 Oct 2026"
      and "expires tomorrow" in body and "cron-job.org" in body and "ENGINE_TOKEN" in body and "github_pat_" in body and "ENGINE_TOKEN" in html)

import run_account_mail as _ram   # noqa: E402
_t = tempfile.mkdtemp()
os.makedirs(os.path.join(_t, "portfolio")); os.makedirs(os.path.join(_t, "market"))
json.dump({"id": "marks", "data": {"months": {"2026-07": {"cash": 1, "benchClose": 9}, "2026-08": {"cash": 1}, "2999-01": {}}}}, open(os.path.join(_t, "portfolio", "marks.json"), "w"))
json.dump({"benchClose": {"2026-07": 1, "2026-08": 2}, "cpiMoM": {"2026-08": 0.01}, "cpiSource": "s", "fxEom": {"2026-08": 50}, "cashRate": {"2026-08": 0.2}}, open(os.path.join(_t, "market", "macro.json"), "w"))
_ram.macro_marks(_t)
_m = json.load(open(os.path.join(_t, "portfolio", "marks.json")))["data"]["months"]
check("account reports: closed months get the shared index close, CPI, USD/EGP and policy rate; a value already there stays",
      _m["2026-07"]["benchClose"] == 9 and _m["2026-08"]["benchClose"] == 2 and _m["2026-08"]["cpi"] == 0.01 and _m["2026-08"]["cpiSource"] == "s"
      and _m["2026-08"]["usdegp"] == 50 and _m["2026-08"]["cashRate"] == 0.2 and "benchClose" not in _m["2999-01"])
shutil.rmtree(_t, ignore_errors=True)

import mail_send as _ms   # noqa: E402
_env0 = {k: os.environ.get(k) for k in ("GMAIL_ADDRESS", "GMAIL_APP_PASSWORD", "SENDER_ADDRESS", "SENDER_APP_PASSWORD", "SENDER_NAME")}
try:
    os.environ.update({"GMAIL_ADDRESS": "owner@example.com", "GMAIL_APP_PASSWORD": "aaaa bbbb cccc dddd"})
    for k in ("SENDER_ADDRESS", "SENDER_APP_PASSWORD", "SENDER_NAME"):
        os.environ.pop(k, None)
    try:
        first = _ms._sender()
    except jc.JobError as e:
        first = e.step
    os.environ.update({"SENDER_ADDRESS": "updates@example.com", "SENDER_APP_PASSWORD": "eeee ffff gggg hhhh"})
    second = _ms._sender()
    msg = _ms.build(second[0], "friend@example.com", "Hi", "text")
    check("sending: only ever from the Portfolio Desk mailbox, never the owner's Gmail (nothing is sent without it)",
          first == "email" and second == ("updates@example.com", "eeeeffffgggghhhh") and msg["From"] == "Portfolio Desk <updates@example.com>")
    check("sending: the sending mailbox's password never shows in a log", "eeee ffff gggg hhhh" not in jc.redact("x eeee ffff gggg hhhh y") and "eeeeffffgggghhhh" not in jc.redact("eeeeffffgggghhhh"))
finally:
    for k, v in _env0.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

print(f"{'ALL PASS' if not fails else str(fails) + ' FAILED'}")
sys.exit(1 if fails else 0)
