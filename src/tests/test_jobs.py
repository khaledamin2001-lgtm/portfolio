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
import run_market, run_sync, imap_fetch, publish, mail_send   # noqa: E402

fails = 0


def check(name, ok):
    global fails
    print(("PASS " if ok else "FAIL ") + name)
    fails += 0 if ok else 1


# ---- market: marks patch (synthetic figures)   private-scan: synthetic
out = {"prevMonth": {"month": "2026-08", "benchClose": 100.5}, "currentMonth": "2026-09",
       "macro": {"cpiMoM": {"2026-07": 0.01, "2026-08": 0.02, "2026-09": 0.03}, "cpiSource": "CPI src",
                 "fxEom": {"2026-07": 48.1, "2026-08": None}, "fxSource": "FX src",
                 "cashRate": {"2026-07": 0.2, "2026-08": 0.19}, "cashRateSource": "Rate src"}}
marks = {"months": {"2026-07": {"cash": 1, "securities": 2, "cpi": 0.5, "usdegp": 47.0, "provisional": False},
                    "2026-08": {"cash": 3, "source": "statement", "benchClose": None, "cashRate": 0.18},
                    "2026-09": {"cash": 4}}}
p = run_market.marks_patch(marks, out)
check("marks: benchClose filled for prevMonth when missing/non-numeric", p.get("2026-08", {}).get("benchClose") == 100.5)
check("marks: existing numeric values never overwritten (cpi, usdegp, cashRate)", "cpi" not in p.get("2026-07", {}) and "usdegp" not in p.get("2026-07", {})
      and "cashRate" not in p.get("2026-08", {}))
check("marks: missing values filled with their source", p["2026-07"]["cashRate"] == 0.2 and p["2026-07"]["cashRateSource"] == "Rate src"
      and p["2026-08"]["cpi"] == 0.02 and p["2026-08"]["cpiSource"] == "CPI src")
check("marks: a null macro value is not written", "usdegp" not in p.get("2026-08", {}))
check("marks: the current month and months not in the marks are never touched", "2026-09" not in p and set(p) <= set(marks["months"]))
check("marks: cash/securities/source/provisional never in the patch", not any(k in v for v in p.values() for k in ("cash", "securities", "source", "provisional")))
p2 = run_market.marks_patch({"months": {"2026-08": {"benchClose": 99.0}}}, out)
check("marks: benchClose kept when already numeric", "benchClose" not in p2.get("2026-08", {}))

# ---- market: write plan pinned to versions
tmp = tempfile.mkdtemp()
try:
    def put(c, d, v, data):
        os.makedirs(f"{tmp}/{c}", exist_ok=True)
        json.dump({"id": d, "version": v, "data": data}, open(f"{tmp}/{c}/{d}.json", "w"))
    put("market", "latest", 7, {"quotes": {}})
    put("history", "2026-09", 3, {"month": "2026-09", "days": {}})
    put("bench", "egx30", 2, {"members": [], "capWeight": 0.15, "actions": []})
    put("portfolio", "marks", 5, marks)
    put("portfolio", "assets", 4, {"items": {"Alpha Co": {"name": "Alpha Co", "symbol": "ALPH"}}})
    o = dict(out, latest={"quotes": {"ALPH": {"price": 1}}}, bench={"members": [{"s": "ALPH"}], "asOf": "2026-09-28", "divYield": None},
             histories=[{"month": "2026-08", "days": {"2026-08-31": {"ALPH": 1}}}, {"month": "2026-09", "days": {"2026-09-01": {"ALPH": 1}}}],
             newAssets={"Alpha Co": {"name": "Alpha Co", "watch": True}, "Beta Co": {"name": "Beta Co", "symbol": "BETA", "watch": True}})
    w, info = run_market.build_writes(tmp, o)
    byk = {(x["collection"], x["doc_id"]): x for x in w}
    check("market plan: market/latest set, pinned", byk[("market", "latest")]["op"] == "set" and byk[("market", "latest")]["if_version"] == 7)
    check("market plan: history set when absent (if_version 0), update {days} when present",
          byk[("history", "2026-08")]["op"] == "set" and byk[("history", "2026-08")]["if_version"] == 0
          and byk[("history", "2026-09")] == {"op": "update", "collection": "history", "doc_id": "2026-09", "data": {"days": {"2026-09-01": {"ALPH": 1}}}, "if_version": 3})
    check("market plan: bench update touches members/asOf only (divYield not a number)", byk[("bench", "egx30")]["data"] == {"members": [{"s": "ALPH"}], "asOf": "2026-09-28"})
    check("market plan: only new index members become watch entries", byk[("portfolio", "assets")]["data"] == {"items": {"Beta Co": o["newAssets"]["Beta Co"]}}
          and byk[("portfolio", "assets")]["if_version"] == 4)
    check("market plan: never a ledger/settings/imports/sync write", not any(x["collection"] in ("ledger", "imports", "sync") or x["doc_id"] == "settings" for x in w))
    o2 = dict(o, latest={"asOf": "2026-09-28T15:12+03:00", "quotes": {"ALPH": {"price": 1}}, "missing": [],
                         "index": {"EGX30CAPPED": {"close": 1234.5, "chg": -0.42, "date": "2026-09-28"}}, "rates": {"policy": {"rate": 0.22, "date": "2026-08"}}})   # private-scan: synthetic
    subj, body, html = run_market.success_email(o2, info, True)
    check("market email: subject names the close date", subj == "Portfolio: market updated 2026-09-28")
    fig = "EGX30 Capped: 1,234.50 (−0.42% on the day)"   # private-scan: synthetic
    check("market email: market figures in the body", fig in body and "CBE policy rate: 22.00% (since August 2026)" in body
          and "Price history saved: August 2026, September 2026" in body and "The site is updated." in body)
    check("market email: the same figures in the HTML", "1,234.50" in html and "22.00%" in html and "Open the site" in html and html.startswith("<!doctype html>"))   # private-scan: synthetic
    check("market email: nothing from the portfolio's own documents", "Alpha Co" not in body and "cash" not in body.lower())
    o3 = dict(o2, fillErrors={"ZZA": "x"}, latest=dict(o2["latest"], missing=["ZZA", "ZZB"]))
    check("market email: a symbol both unfilled and missing is listed once", "ZZA, ZZB — the last known price is kept." in run_market.success_email(o3, info, True)[1])
finally:
    shutil.rmtree(tmp)

# ---- sync: write/ files -> store writes
tmp = tempfile.mkdtemp()
try:
    for f in ("ledger_y2026.json", "marks.json", "settings.json", "assets_update.json", "import_2026-09.json", "sync_state.json"):
        json.dump({"x": f}, open(f"{tmp}/{f}", "w"))
    w = run_sync.writes_from_plan(tmp, {"ledger/y2026": 9, "portfolio/marks": 2, "portfolio/settings": 3, "portfolio/assets": 4, "sync/state": 5})
    got = {(x["op"], x["collection"], x["doc_id"], x["if_version"]) for x in w}
    check("sync plan: every file maps to its store write, pinned (0 = new doc)", got == {
        ("set", "ledger", "y2026", 9), ("set", "portfolio", "marks", 2), ("set", "portfolio", "settings", 3),
        ("update", "portfolio", "assets", 4), ("set", "imports", "2026-09", 0), ("set", "sync", "state", 5)})
    json.dump({}, open(f"{tmp}/surprise.json", "w"))
    try:
        run_sync.writes_from_plan(tmp, {})
        check("sync plan: an unknown write file is an error", False)
    except jc.JobError:
        check("sync plan: an unknown write file is an error", True)
finally:
    shutil.rmtree(tmp)

# ---- time gate
P = lambda t, d="2026-09-28": {"today": d, "minuteOfDay": int(t[:2]) * 60 + int(t[3:])}
check("gate: sync 16:14 no, 16:15 afternoon, 18:14 afternoon, 18:15 evening, 23:00 night, 00:30 after midnight, 07:00 no",
      [jc.gate(P(t), run_sync.WINDOWS, {}, False)[0] for t in ("16:14", "16:15", "18:14", "18:15", "22:59", "23:00", "23:59", "00:30", "07:00")]
      == [None, "afternoon", "afternoon", "evening", "evening", "night", "night", "after midnight", None])
check("gate: a slot already run today is skipped, yesterday's is not",
      jc.gate(P("19:17"), run_sync.WINDOWS, {"evening": "2026-09-28"}, False)[0] is None and jc.gate(P("19:17"), run_sync.WINDOWS, {"evening": "2026-09-27"}, False)[0] == "evening")
check("gate: market before 15:10 no, 15:10 yes; manual always", jc.gate(P("15:09"), run_market.WINDOW, {}, False)[0] is None
      and jc.gate(P("15:10"), run_market.WINDOW, {}, False)[0] == "day" and jc.gate(P("03:00"), run_market.WINDOW, {"day": "2026-09-28"}, True)[0] == "manual")

# ---- IMAP helpers
check("imap: the Gmail query", imap_fetch.QUERY.format(after="2026/09/22") ==
      'from:no-reply@system.thndr.app (subject:Invoice OR subject:E-statement) -subject:"US Market" after:2026/09/22')
check("imap: quoted for IMAP", imap_fetch.imap_quote('a "b" c') == '"a \\"b\\" c"')
check("imap: INTERNALDATE -> ms", imap_fetch.internal_ms("31-Dec-2025 08:32:02 +0000") == "1767169922000"   # private-scan: synthetic
      and imap_fetch.internal_ms(" 1-Jan-2026 02:00:00 +0200") == "1767225600000")   # private-scan: synthetic
check("imap: X-GM-MSGID -> Gmail API id (hex)", format(1853011970335501012, "x") == "19b73891c064ead4")   # private-scan: synthetic
check("imap: subjects kept", all(s.startswith(imap_fetch.KEEP) for s in ("Your Thndr Invoice", "Your requested E-statement - Sep 2026", "Your monthly E-statement - Aug 2026"))
      and not "Invoice ready".startswith(imap_fetch.KEEP))

# ---- publish allow-list
ok = ["data.enc.json", "data.fingerprint", "exports/A-Portfolio-Sep-26.xlsx.enc.json", "exports/index.json"]
bad = ["data.json", "exports/A.xlsx", "exports/a/b.enc.json", "keys.json", "../x.enc.json", "exports/.hidden.enc.json"]
check("publish: allow-list", all(publish.ALLOWED.match(x) for x in ok) and not any(publish.ALLOWED.match(x) for x in bad))
tmp = tempfile.mkdtemp()
try:
    json.dump({"v": 1, "name": "x", "bytes": 3, "epk": "QUJD", "iv": "QUJD", "ct": "QUJDREVGR0hJSktMTU5PUA=="}, open(f"{tmp}/e.json", "w"))
    json.dump({"v": 1, "plain": "no"}, open(f"{tmp}/p.json", "w"))
    check("publish: envelope shape check", publish.is_envelope(f"{tmp}/e.json") and not publish.is_envelope(f"{tmp}/p.json"))
finally:
    shutil.rmtree(tmp)

# ---- the monthly report card: due once last month's statement is in; its email with and without sales
tmp = tempfile.mkdtemp()
try:
    os.makedirs(f"{tmp}/data/imports"); os.makedirs(f"{tmp}/write")
    check("report card: no statement for the month yet", not run_sync.statement_posted(f"{tmp}/data", f"{tmp}/write", "2026-09"))
    json.dump({"id": "2026-09", "data": {"fullMonth": True}}, open(f"{tmp}/data/imports/2026-09.json", "w"))
    json.dump({"fullMonth": True}, open(f"{tmp}/write/import_2026-10.json", "w"))
    check("report card: a statement in the data, or one this run posted, counts",
          run_sync.statement_posted(f"{tmp}/data", f"{tmp}/write", "2026-09") and run_sync.statement_posted(f"{tmp}/data", f"{tmp}/write", "2026-10"))
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

# ---- recipient: config.json "recipient" wins over settings.factsheetEmail; "failureRecipient" takes the FAILED notices
class RCtx:
    def __init__(self, config, settings):
        self.config, self._s = config, settings
    def settings(self):
        return self._s
check("recipient: settings.factsheetEmail by default", jc.Ctx.recipient(RCtx({}, {"factsheetEmail": "a@example.com"})) == "a@example.com")
check("recipient: config.json recipient overrides it", jc.Ctx.recipient(RCtx({"recipient": "owner@example.com"}, {"factsheetEmail": "b@example.com"})) == "owner@example.com")
fc = RCtx({"recipient": "friend@example.com", "failureRecipient": "owner@example.com"}, {})
fc.recipient = lambda: jc.Ctx.recipient(fc)
check("recipient: a portfolio's emails to its own person, its FAILED notices to the platform owner",
      jc.Ctx.recipient(fc) == "friend@example.com" and jc.Ctx.failure_recipient(fc) == "owner@example.com")
fc2 = RCtx({"recipient": "friend@example.com"}, {})
fc2.recipient = lambda: jc.Ctx.recipient(fc2)
check("recipient: without failureRecipient, FAILED notices go to the recipient", jc.Ctx.failure_recipient(fc2) == "friend@example.com")
try:
    jc.Ctx.recipient(RCtx({"recipient": "not an address"}, {}))
    check("recipient: an invalid address is refused", False)
except jc.JobError:
    check("recipient: an invalid address is refused", True)

# ---- reports: months already on the site are skipped
import run_reports   # noqa: E402
tmp = tempfile.mkdtemp()
try:
    os.makedirs(f"{tmp}/p/demo/exports")
    json.dump([{"month": "2026-08", "file": "exports/x.enc.json"}], open(f"{tmp}/p/demo/exports/index.json", "w"))
    class PCtx:
        code = tmp
        config = {"siteFolder": "p/demo"}
    check("reports: published months come from the site's exports index", run_reports.published_months(PCtx()) == {"2026-08"})
    PCtx.config = {"siteFolder": "p/none"}
    check("reports: no index means nothing published yet", run_reports.published_months(PCtx()) == set())
finally:
    shutil.rmtree(tmp)

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

# ---- an inbox email that could not be sent is kept (sync/outbox, encrypted like any document) and sent by the next run
tmp = tempfile.mkdtemp()
try:
    os.makedirs(os.path.join(tmp, "sync"))
    commits_, sends_ = [], []
    real_apply, real_send = jc.apply_and_commit, mail_send.send
    jc.apply_and_commit = lambda ctx, writes, msg: commits_.append(writes) or ({"changed": [], "results": []}, None)
    def failing_send(ctx, s, t, h=None, to=None, attachments=None):
        raise OSError("smtp down")
    run_sync.keep_unsent(None, tmp, "Subj", "Text", "<b>Html</b>", OSError("smtp down"))
    kept = commits_[-1][0] if commits_ else {}
    check("unsent email: kept as sync/outbox, created only if absent", kept.get("op") == "set" and kept.get("collection") == "sync" and kept.get("doc_id") == "outbox"
          and kept.get("if_version") == 0 and kept["data"]["subject"] == "Subj" and kept["data"]["html"] == "<b>Html</b>")
    json.dump({"data": kept["data"], "version": 1}, open(os.path.join(tmp, "sync", "outbox.json"), "w"))
    mail_send.send = failing_send; commits_.clear()
    run_sync.resend_outbox(None, tmp)
    check("unsent email: still failing, it stays (nothing deleted)", not commits_ and os.path.exists(os.path.join(tmp, "sync", "outbox.json")))
    mail_send.send = lambda ctx, s, t, h=None, to=None, attachments=None: sends_.append((s, t, h)) or "sent"
    run_sync.resend_outbox(None, tmp)
    check("unsent email: the next run sends it and then deletes it", sends_ == [("Subj", "Text", "<b>Html</b>")] and commits_ and commits_[-1][0]["op"] == "delete"
          and not os.path.exists(os.path.join(tmp, "sync", "outbox.json")))
finally:
    jc.apply_and_commit, mail_send.send = real_apply, real_send
    shutil.rmtree(tmp)

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

print(f"{'ALL PASS' if not fails else str(fails) + ' FAILED'}")
sys.exit(1 if fails else 0)
