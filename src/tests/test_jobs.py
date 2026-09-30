#!/usr/bin/env python3
"""Public unit tests of the engine-repo jobs (src/jobs/*) on synthetic data only - no network, no secrets, no private
fixtures. Covers the rules the Claude routines followed: the market job's never-overwrite marks patch and its write
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
    subj, body = run_market.success_email(o2, info, True)
    check("market email: subject names the close date", subj == "Portfolio: market updated 2026-09-28")
    fig = "EGX30 Capped: 1,234.50 (-0.42% on the day)"   # private-scan: synthetic
    check("market email: market figures in the body", fig in body and "CBE policy rate: 22.00% (since 2026-08)" in body
          and "History written: 2026-08, 2026-09" in body and "The live site is updated." in body)
    check("market email: nothing from the portfolio's own documents", "Alpha Co" not in body and "cash" not in body.lower())
finally:
    shutil.rmtree(tmp)

# ---- sync: write/ files -> store writes
tmp = tempfile.mkdtemp()
try:
    for f in ("ledger_y2026.json", "marks.json", "settings.json", "assets_update.json", "import_2026-09.json", "sync_state.json"):
        json.dump({"x": f}, open(f"{tmp}/{f}", "w"))
    w = run_sync.writes_from_plan(tmp, {"ledger/y2026": 9, "portfolio/marks": 2, "portfolio/settings": 3, "portfolio/assets": 4, "sync/state": 5})
    got = {(x["op"], x["collection"], x["doc_id"], x["if_version"]) for x in w}
    check("sync plan: every file maps to the routine's batch entry, pinned (0 = new doc)", got == {
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
check("gate: sync 18:16 no, 18:17 early, 22:16 early, 22:17 late, 23:59 late",
      [jc.gate(P(t), run_sync.WINDOWS, {}, False)[0] for t in ("18:16", "18:17", "22:16", "22:17", "23:59")] == [None, "early", "early", "late", "late"])
check("gate: a slot already run today is skipped, yesterday's is not",
      jc.gate(P("19:17"), run_sync.WINDOWS, {"early": "2026-09-28"}, False)[0] is None and jc.gate(P("19:17"), run_sync.WINDOWS, {"early": "2026-09-27"}, False)[0] == "early")
check("gate: market before 15:10 no, 15:10 yes; manual always", jc.gate(P("15:09"), run_market.WINDOW, {}, False)[0] is None
      and jc.gate(P("15:10"), run_market.WINDOW, {}, False)[0] == "day" and jc.gate(P("03:00"), run_market.WINDOW, {"day": "2026-09-28"}, True)[0] == "manual")

# ---- IMAP helpers
check("imap: the routine's Gmail query", imap_fetch.QUERY.format(after="2026/09/22") ==
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

# ---- recipient: config.json "recipient" wins over settings.factsheetEmail (Yassin's emails go to Khaled)
class RCtx:
    def __init__(self, config, settings):
        self.config, self._s = config, settings
    def settings(self):
        return self._s
check("recipient: settings.factsheetEmail by default", jc.Ctx.recipient(RCtx({}, {"factsheetEmail": "a@example.com"})) == "a@example.com")
check("recipient: config.json recipient overrides it", jc.Ctx.recipient(RCtx({"recipient": "owner@example.com"}, {"factsheetEmail": "b@example.com"})) == "owner@example.com")
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

print(f"{'ALL PASS' if not fails else str(fails) + ' FAILED'}")
sys.exit(1 if fails else 0)
