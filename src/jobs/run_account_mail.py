#!/usr/bin/env python3
"""Emails, and the Thndr inbox import, for site ACCOUNTS that switched them on (Account → Email updates / Thndr emails on
the site): heads-up alerts after each market close, the weekly summary on Thursday evening, the month-end report (Excel
workbook + PDF factsheet) when a monthly statement is posted, and (accounts that connected their Gmail) new Thndr
invoices and statements posted to the portfolio. Nothing is done for an account that has not opted in.

    python3 run_account_mail.py --engine DIR [--code DIR] [--now ISO] [--weekly | --no-weekly] [--dry-run]

An account that opts in stores Firestore mail/{uid} = {pkg}: an envelope sealed in its browser to the MAIL key (the public
key of p/khaled/keys.json on the site, label 'portfolio-mail-v1'; this job opens it with SETUP_KEY = KHALED_SETUP_KEY)
holding {uid, email, refresh, pk8, prefs: {alerts, weekly, reports, gmail}}. That is the account's own choice to let this job open
its portfolio (the site says so when it is switched on). For each package this job:
  1. exchanges the refresh token for an ID token (Secure Token API) and reads users/{uid}/docs AS THAT ACCOUNT (the
     Firestore rules are unchanged: only the account itself can read its documents), opening each with the account key;
  2. Gmail (prefs.gmail): opens the account's own document sync/gmail {address, appPassword} (written by the site,
     encrypted to the account key), fetches new Thndr emails with imap_fetch.py (read-only, the same search as the
     owner's sync), runs src/tools/sync.js on the account's documents and the shared market data, and saves what it
     wrote in ONE Firestore commit pinned to the versions read (redone once on a conflict). The sync summary email
     (heads-up items included) goes to the account's address when it notifies. The result, or the Gmail error, is kept
     in sync/mail.gmail; a new error is emailed once. When the import ran, its heads-up digest replaces step 3.
     History import (settings.historyImport.status 'pending', the site's "Build it from my Thndr emails"): first only the
     monthly statements since 2019 are fetched and src/tools/history_seed.js builds the portfolio from them (the earliest
     one's holdings and cash as opening rows, then every later month's rows, each month-end matched to Thndr's holdings
     and cash with labelled adjustments); then every Thndr email after the latest statement is fetched and sync.js
     applies them, all in the same commit. Older months' reports are marked skipped (only the latest is emailed) and one summary email
     says what was built. With no usable monthly statement yet, nothing is written: the account is told once, and every
     run looks again.
  3. adds the shared market data (engine shared/: latest, history, bench) and runs src/jobs/account_alerts.js (the same
     PA.headsUp checks the page shows); items whose key is not in its alertsSent list are emailed, once;
  4. on Thursday from 18:00 Cairo (or --weekly), runs src/tools/weekly.js and emails the summary, once a week;
  5. month-end report (prefs.reports, default on): every imports/<M> that is a full month posted since 2026-09-28 and
     has no reports.emailedAt gets excel.js + excel.py (workbook) and factsheet.js (HTML + PDF, on the page built from
     src/; Playwright is installed by JOBS_PLAYWRIGHT_SETUP the first time one is due), emailed to the account's address
     with both files attached, then stamped reports.emailedAt (reportsPending removed) in the account;
  6. friends: a new friend request (links/{uid}/with/*, 'received') is emailed once; for every friend ('friends') the
     portfolio's PERCENTAGES profile (tools/profile.js: returns by month, holdings by weight, trades as %; never an
     amount) is sealed to the friend's key as shares/{uid}/to/{friend} when it changed or is a day old. The site owner's
     own account (its sign-in email hashes to OWNER_HASH, verified, prefs.shareMain) shares the MAIN portfolio's profile
     instead (the engine's documents, opened with the same key as the mail packages). In the first days of a month
     (prefs.leaderboard; older packages follow the other emails) the account gets one leaderboard email: last month's
     return of the account and of each friend (their shares/{friend}/to/{uid} profiles), ranked, with the index and the
     month's best sale, percentages only; sent once every friend's copy covers the month, or from the 8th (to the 10th)
     with the late ones shown as no figure;
  6b. the monthly trading report card (prefs.reportCard; older packages follow the other emails): from the 1st to the
     10th, once, as soon as last month's statement is in or from the 5th: tools/report_card.js -> emails.report_card;
  6c. the yearly wrap-up (January 1st-10th, once, for last year; with the report card's tick; the owner's account sends
     the MAIN portfolio's): tools/wrapped.js -> emails.wrapped, ranked among friends on the year's return;
  7. writes status/{uid}.job {at, gmail, report, friends, error} for the site owner's admin screen (no figures);
  8. saves {alertsSent, weeklySent, gmail, friendMailed, shares, leaderboardSent, reportCardSent, wrappedSent, lastReport} back to the account as users/{uid}/docs/sync__mail, encrypted to the account key.
Emails go from GMAIL_ADDRESS to the address in the package only. One account failing never stops the others; the job
exits 1 (and emails the owner) only when nothing could be done at all. Logs carry counts, never figures or addresses.
"""
import os, sys, json, base64, hashlib, argparse, datetime, subprocess, tempfile, shutil, urllib.request, urllib.error, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402
import emails  # noqa: E402
import store  # noqa: E402

JOB = "account emails"
API_KEY = "AIzaSyAYvh69A5VWAgmhKXt07RTgLpB_1hYBjA8"
PROJECT = "portfolio-desk-4d14a"
FS = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"
MAIL_LABEL = b"portfolio-mail-v1"
SHARE_LABEL = b"portfolio-share-v1"
OWNER_HASH = "467022c320757248bf70115c83d305a7e4d139c35e1be5f8117fb30d7f769347"     # SHA-256 of the site owner's sign-in email (the address is not published here)
SITE = "https://khaledamin2001-lgtm.github.io/portfolio/"


class Http:
    """The network calls, one place (tests replace it)."""
    def json(self, method, url, body=None, headers=None, form=False):
        data = None
        h = dict(headers or {})
        if body is not None:
            data = urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode()
            h["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.load(e)
            except Exception:
                return e.code, {}


def open_mail_pkg(priv, blob):
    """The package envelope (string) -> dict. Same scheme as store.unseal, with the mail label."""
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    e = json.loads(blob)
    b = base64.b64decode
    epk = b(e["epk"])
    key = HKDF(hashes.SHA256(), 32, epk, MAIL_LABEL).derive(priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), epk)))
    return json.loads(AESGCM(key).decrypt(b(e["iv"]), b(e["ct"]), MAIL_LABEL))


def account_key(pk8_b64):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    priv = serialization.load_der_private_key(base64.b64decode(pk8_b64), None)
    pub = priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return priv, {"pub": base64.b64encode(pub).decode()}


def list_packages(http):
    out, tok = [], ""
    while True:
        st, j = http.json("GET", f"{FS}/mail?pageSize=300" + (f"&pageToken={urllib.parse.quote(tok)}" if tok else ""))
        if st == 404:
            return out
        if st == 403:      # the mail/ rule is not published yet: nobody can have opted in
            jc.log("mail/ is not readable (the Firestore rules do not include it yet): no account has email updates")
            return out
        if st != 200:
            raise jc.JobError("list", f"Firestore answered {st} for mail/")
        for d in j.get("documents") or []:
            v = ((d.get("fields") or {}).get("pkg") or {}).get("stringValue")
            if v:
                out.append({"uid": d["name"].rsplit("/", 1)[-1], "pkg": v})
        tok = j.get("nextPageToken") or ""
        if not tok:
            return out


def id_token(http, refresh):
    st, j = http.json("POST", f"https://securetoken.googleapis.com/v1/token?key={API_KEY}", {"grant_type": "refresh_token", "refresh_token": refresh}, form=True)
    if st != 200 or not j.get("id_token"):
        raise jc.JobError("sign-in", ((j.get("error") or {}).get("message")) or f"answered {st}")
    return j["id_token"], j.get("user_id")


def token_claims(tok):
    """The ID token's claims (it came straight from Google's token endpoint over TLS, so it is not re-verified here)."""
    try:
        part = tok.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except Exception:
        return {}


def read_account(http, tok, uid, priv):
    """users/{uid}/docs -> {"coll/doc": {"version", "updatedAt", "data", "updateTime"}}"""
    docs, page = {}, ""
    while True:
        st, j = http.json("GET", f"{FS}/users/{uid}/docs?pageSize=300" + (f"&pageToken={urllib.parse.quote(page)}" if page else ""), headers={"Authorization": "Bearer " + tok})
        if st != 200:
            raise jc.JobError("read", f"Firestore answered {st}")
        for d in j.get("documents") or []:
            name = d["name"].rsplit("/", 1)[-1]
            if "__" not in name:
                continue
            c, doc = name.split("__", 1)
            blob = d["fields"]["blob"]["stringValue"]
            p = json.loads(store.unseal(priv, blob).decode("utf-8"))
            docs[f"{c}/{doc}"] = {"version": p["version"], "updatedAt": p.get("updatedAt"), "data": p["data"], "updateTime": d.get("updateTime")}
        page = j.get("nextPageToken") or ""
        if not page:
            return docs


def write_state(http, tok, uid, keys, cur, data, now_iso):
    """users/{uid}/docs/sync__mail, encrypted to the account key, pinned to its updateTime."""
    version = (cur or {}).get("version", 0) + 1
    env = store.encode_doc(keys, "mail", version, data, now_iso).decode().strip()
    q = ("currentDocument.updateTime=" + urllib.parse.quote(cur["updateTime"])) if cur and cur.get("updateTime") else "currentDocument.exists=false"
    st, j = http.json("PATCH", f"{FS}/users/{uid}/docs/sync__mail?{q}", {"fields": {"blob": {"stringValue": env}, "v": {"integerValue": str(version)}, "at": {"stringValue": now_iso}}},
                      headers={"Authorization": "Bearer " + tok})
    if st != 200:
        raise jc.JobError("save", f"Firestore answered {st} saving the email record")


def materialize(docs, shared, out):
    """The account's documents plus the shared market data as <coll>/<doc>.json (what sync.js / weekly.js /
    account_alerts.js read). Never the Gmail login (sync/gmail) or this job's own record (sync/mail)."""
    for k, v in docs.items():
        c, d = k.split("/", 1)
        if c in ("market", "history", "bench") or k in ("sync/gmail", "sync/mail"):
            continue
        os.makedirs(os.path.join(out, c), exist_ok=True)
        with open(os.path.join(out, c, d + ".json"), "w", encoding="utf-8") as f:
            json.dump({"id": d, "data": v["data"]}, f)
    os.makedirs(os.path.join(out, "market"), exist_ok=True)
    os.makedirs(os.path.join(out, "bench"), exist_ok=True)
    os.makedirs(os.path.join(out, "history"), exist_ok=True)
    shutil.copyfile(os.path.join(shared, "latest.json"), os.path.join(out, "market", "latest.json"))
    if os.path.exists(os.path.join(shared, "macro.json")):
        shutil.copyfile(os.path.join(shared, "macro.json"), os.path.join(out, "market", "macro.json"))
    if os.path.exists(os.path.join(shared, "bench.json")):
        shutil.copyfile(os.path.join(shared, "bench.json"), os.path.join(out, "bench", "egx30.json"))
    for f in sorted(os.listdir(os.path.join(shared, "history"))):
        shutil.copyfile(os.path.join(shared, "history", f), os.path.join(out, "history", f))


def alerts_email(name, items, site):
    return emails.alerts(name, items)


# ---------------------------------------------------------------- Thndr emails from the account's own Gmail
DOC_NAME = f"projects/{PROJECT}/databases/(default)/documents/users/{{uid}}/docs/{{c}}__{{d}}"


def commit_writes(http, tok, uid, keys, docs, writes, now_iso):
    """sync.js writes (run_sync.writes_from_plan) as ONE Firestore commit, each document pinned to the updateTime read
    (or to not existing). Returns the documents changed; raises Conflict when one changed meanwhile."""
    out = []
    for w in writes:
        k = f"{w['collection']}/{w['doc_id']}"
        cur = docs.get(k)
        data = store.deep_merge((cur or {}).get("data") or {}, w["data"]) if w["op"] == "update" else store.strip_markers(w["data"])
        version = (cur or {}).get("version", 0) + 1
        env = store.encode_doc(keys, w["doc_id"], version, data, now_iso).decode().strip()
        pre = {"updateTime": cur["updateTime"]} if cur and cur.get("updateTime") else {"exists": False}
        out.append({"update": {"name": DOC_NAME.format(uid=uid, c=w["collection"], d=w["doc_id"]),
                               "fields": {"blob": {"stringValue": env}, "v": {"integerValue": str(version)}, "at": {"stringValue": now_iso}}},
                    "currentDocument": pre})
    if not out:
        return []
    st, j = http.json("POST", f"{FS}:commit", {"writes": out}, headers={"Authorization": "Bearer " + tok})
    if st != 200:
        status = (j.get("error") or {}).get("status") or ""
        if status in ("FAILED_PRECONDITION", "ABORTED", "NOT_FOUND", "ALREADY_EXISTS") or st == 409:
            raise Conflict()
        raise jc.JobError("save", f"Firestore answered {st} {status} saving the import")
    return [f"{w['collection']}/{w['doc_id']}" for w in writes]


class Conflict(Exception):
    pass


class HistoryWait(Exception):
    """The history import has no starting point yet (no usable monthly statement in the Gmail)."""
    def __init__(self, detail):
        super().__init__(detail)
        self.detail = detail


HISTORY_AFTER = "2019/01/01"


def apply_to_data(data, writes):
    """Writes (run_sync.writes_from_plan shape) applied to a materialized data dir, so sync.js starts from them."""
    for w in writes:
        p = os.path.join(data, w["collection"], w["doc_id"] + ".json")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        cur = jc.load_data(p, {}) if w["op"] == "update" else {}
        body = store.deep_merge(cur or {}, w["data"]) if w["op"] == "update" else store.strip_markers(w["data"])
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"id": w["doc_id"], "data": body}, f)


def merge_writes(first, second):
    """One write per document: a later 'set' wins; a later 'update' merges into what is there."""
    out = {}
    for w in list(first) + list(second):
        k = (w["collection"], w["doc_id"])
        if k in out and w["op"] == "update":
            out[k] = dict(out[k], data=store.deep_merge(out[k]["data"], w["data"]))
        else:
            out[k] = w
    return list(out.values())


def gmail_after(code, state, settings, now):
    """The Gmail search start: plan.js from the last import (minus 5 days); the first time, the day tracking started
    (settings.trackFrom; everything before it is in the opening rows) or else the last 7 days."""
    last = state.get("lastRun")
    if not last and settings.get("trackFrom"):
        return settings["trackFrom"].replace("-", "/")
    cmd = ["node", os.path.join(code, "src", "tools", "plan.js"), "--now", now.isoformat()] + (["--lastRun", last] if last else [])
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise jc.JobError("plan", "plan.js failed")
    return json.loads(r.stdout)["gmailAfter"]


def gmail_import(http, tok, pkg, keys, docs, shared, code, work, now, dry, read_again):
    """Fetch new Thndr emails, run sync.js, save its writes. Returns (summary, write_dir, data_dir, counts)."""
    import imap_fetch, run_sync
    login = (docs.get("sync/gmail") or {}).get("data") or {}
    if not login.get("address") or not login.get("appPassword"):
        raise jc.JobError("Gmail", "no Gmail login saved in the account (connect Gmail again on the site)")
    settings = (docs.get("portfolio/settings") or {}).get("data") or {}
    st = (docs.get("sync/state") or {}).get("data") or {}
    hist = (settings.get("historyImport") or {}).get("status") == "pending"
    today = now.strftime("%Y-%m-%d")
    seed = None
    try:
        if hist:
            # the starting point first: the earliest monthly statement (only those are fetched for it)
            inbox_m = os.path.join(work, "inbox-monthly")
            imap_fetch.fetch(HISTORY_AFTER, set(), inbox_m, login["address"], login["appPassword"], query=imap_fetch.QUERY_MONTHLY)
            d0 = os.path.join(work, "seed-data")
            materialize(docs, shared, d0)
            seed_out = os.path.join(work, "seed")
            r = subprocess.run(["node", os.path.join(code, "src", "tools", "history_seed.js"), "--data", d0, "--inbox", inbox_m, "--out", seed_out, "--now", jc.now_iso()],
                               capture_output=True, text=True, timeout=900)
            seed = json.loads((r.stdout or "{}").strip().splitlines()[-1] if (r.stdout or "").strip() else "{}")
            if not seed.get("ok"):
                raise HistoryWait(seed.get("error") or "the starting point could not be made")
            after = (seed.get("lastTo") or seed["to"]).replace("-", "/")
        else:
            after = gmail_after(code, st, settings, now)
        inbox = os.path.join(work, "inbox")
        c = imap_fetch.fetch(after, set(st.get("seen") or {}), inbox, login["address"], login["appPassword"])
    except imap_fetch.FetchError as e:
        raise jc.JobError("Gmail", str(e)) from None
    for attempt in range(2):
        data, run = os.path.join(work, f"sdata{attempt}"), os.path.join(work, f"srun{attempt}")
        materialize(docs, shared, data)
        # heads-up items already emailed by the plain alerts (before Gmail was connected) are not emailed again
        sp = os.path.join(data, "sync", "state.json")
        sd = jc.load_data(sp, {}) or {}
        sd["alertsSent"] = {**(((docs.get("sync/mail") or {}).get("data") or {}).get("alertsSent") or {}), **(sd.get("alertsSent") or {})}
        os.makedirs(os.path.dirname(sp), exist_ok=True)
        with open(sp, "w", encoding="utf-8") as f:
            json.dump({"id": "state", "data": sd}, f)
        seed_writes = run_sync.writes_from_plan(os.path.join(work, "seed"), {}) if seed else []
        apply_to_data(data, seed_writes)
        os.makedirs(run)
        r = subprocess.run(["node", os.path.join(code, "src", "tools", "sync.js"), "--data", data, "--inbox", inbox, "--out", run, "--today", today],
                           capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise jc.JobError("sync.js", jc.mask((r.stderr or r.stdout or "failed").strip().splitlines()[-1][:200]))
        with open(os.path.join(run, "summary.json"), encoding="utf-8") as f:
            summary = json.load(f)
        vers = {k: v.get("version", 0) for k, v in docs.items()}
        writes = merge_writes(seed_writes, run_sync.writes_from_plan(os.path.join(run, "write"), vers))
        if seed:   # a history import: only the latest month's report is emailed; the rest are history
            months = sorted(w["doc_id"] for w in writes if w["collection"] == "imports")
            for w in writes:
                if w["collection"] == "imports" and w["doc_id"] != months[-1]:
                    w["data"] = dict({k: v for k, v in w["data"].items() if k != "reportsPending"}, reports={"emailedAt": "skipped (history import)"})
            summary["_history"] = seed
        if dry:
            break
        try:
            commit_writes(http, tok, pkg["uid"], keys, docs, writes, jc.now_iso())
            break
        except Conflict:
            if attempt:
                raise jc.JobError("save", "the portfolio changed again while saving the import; nothing was saved")
            docs.clear()
            docs.update(read_again())
    return summary, os.path.join(run, "write"), data, {"after": after, **c}


# ---------------------------------------------------------------- month-end report
REPORTS_FROM = "2026-09-28"     # full months posted before this are not sent (no backlog when the feature started)
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def pending_reports(docs):
    out = []
    for k, v in docs.items():
        if not k.startswith("imports/"):
            continue
        d = v.get("data") or {}
        if d.get("fullMonth") and str(d.get("postedAt") or "") >= REPORTS_FROM and not (d.get("reports") or {}).get("emailedAt"):
            out.append(k.split("/", 1)[1])
    return sorted(out)


_PAGE = {}


def report_page(code):
    """The desk page built from src/ once per run (the same page the owner's month-end uses), Playwright installed."""
    if "path" not in _PAGE:
        import atexit
        work = tempfile.mkdtemp(prefix="acct-page-", dir=os.environ.get("RUNNER_TEMP") or None)
        atexit.register(shutil.rmtree, work, True)
        cmd = os.environ.get("JOBS_PLAYWRIGHT_SETUP")
        if cmd:
            jc.run(["bash", "-c", cmd], "month-end: install Playwright", timeout=900)
        import run_sync
        from types import SimpleNamespace
        _PAGE["path"] = run_sync.desk_page(SimpleNamespace(code=code, config={"portfolioId": "account"}), work)
    return _PAGE["path"]


def month_end(code, data, M, name, work):
    """-> (subject, text, html, attachments) for month M; the workbook is required, the PDF is attached when it renders."""
    S = jc.short(M)
    base = f"{''.join(ch for ch in name if ch.isalnum()) or 'Portfolio'}-{S}"
    tools = os.path.join(code, "src", "tools")
    xl, xlsx, html_p, pdf_p = (os.path.join(work, f) for f in (f"xl-{M}.json", base + ".xlsx", f"factsheet-{M}.html", base + ".pdf"))
    jc.run(["node", os.path.join(tools, "excel.js"), "--data", data, "--month", M, "--out", xl], "month-end: excel.js")
    jc.run([sys.executable, os.path.join(tools, "excel.py"), xl, xlsx], "month-end: excel.py")
    att = [(base + ".xlsx", open(xlsx, "rb").read(), XLSX)]
    sm_p = os.path.join(work, f"summary-{M}.json")
    try:
        fs = ["node", os.path.join(tools, "factsheet.js"), "--page", report_page(code), "--data", data, "--month", M, "--out", html_p, "--summary", sm_p]
        try:
            jc.run(fs + ["--pdf", pdf_p], "month-end: factsheet", timeout=600)
        except jc.JobError:
            jc.run(fs, "month-end: factsheet", timeout=600)
        if os.path.exists(pdf_p):
            att.insert(0, (base + ".pdf", open(pdf_p, "rb").read(), "application/pdf"))
    except jc.JobError as e:
        jc.log(f"month-end {M}: factsheet not made ({jc.mask(e.detail)[:120]}); sending the workbook")
    sm = json.load(open(sm_p)) if os.path.exists(sm_p) else None
    files = (["the PDF factsheet"] if len(att) == 2 else []) + ["the Excel workbook"]
    subj, text, html = emails.monthend(name, M, sm, files, account=True)
    return subj, text, html, att


# ---------------------------------------------------------------- friends and the admin status line
def list_links(http, tok, uid):
    st, j = http.json("GET", f"{FS}/links/{uid}/with?pageSize=300", headers={"Authorization": "Bearer " + tok})
    if st in (403, 404):     # rules without friends yet, or none
        return []
    if st != 200:
        raise jc.JobError("friends", f"Firestore answered {st} listing friends")
    out = []
    for d in j.get("documents") or []:
        f = {k: v.get("stringValue") for k, v in (d.get("fields") or {}).items()}
        f["uid"] = d["name"].rsplit("/", 1)[-1]
        out.append(f)
    return out


def share_profile(docs, shared, code, work, name, handle, tag):
    """What a friend sees: {v: 2, at, name, profile}, the portfolio's PERCENTAGES profile (tools/profile.js, engine2.js
    friendProfile: returns by month, holdings by weight, trades as %), never an amount, a share count or a price. docs:
    the portfolio's documents ({"coll/doc": {"data": ...}}), with the shared market data."""
    d = os.path.join(work, "share-" + tag)
    shutil.rmtree(d, ignore_errors=True)
    materialize({k: (v if isinstance(v, dict) and "data" in v else {"data": v}) for k, v in docs.items()}, shared, d)
    r = subprocess.run(["node", os.path.join(code, "src", "tools", "profile.js"), "--data", d, "--name", name] + (["--handle", handle] if handle else []),
                       capture_output=True, text=True, timeout=300)
    out = json.loads((r.stdout or "{}").strip().splitlines()[-1] if (r.stdout or "").strip() else "{}")
    if not out.get("ok"):
        raise jc.JobError("friends", out.get("error") or "profile.js failed")
    return {"v": 2, "at": jc.now_iso(), "name": name, "profile": out["profile"]}


def own_handle(http, tok, uid):
    """The account's @username (status/{uid}.handle, written by the site), or ''."""
    try:
        st, j = http.json("GET", f"{FS}/status/{uid}", headers={"Authorization": "Bearer " + tok})
        return (((j or {}).get("fields") or {}).get("handle") or {}).get("stringValue") or "" if st == 200 else ""
    except Exception:
        return ""


def seal_json(obj, pub_b64, label):
    """gzip(JSON) sealed to a public key: the envelope the site opens with unseal(e, label) (as store.seal, other label)."""
    import gzip, hashlib  # noqa: F401
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization, hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    plain = gzip.compress(json.dumps(obj, separators=(",", ":")).encode(), 9)
    peer = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), base64.b64decode(pub_b64))
    eph = ec.generate_private_key(ec.SECP256R1())
    epk = eph.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    key = HKDF(hashes.SHA256(), 32, epk, label).derive(eph.exchange(ec.ECDH(), peer))
    iv = os.urandom(12)
    b = lambda x: base64.b64encode(x).decode()
    return json.dumps({"v": 1, "epk": b(epk), "iv": b(iv), "ct": b(AESGCM(key).encrypt(iv, plain, label))}, separators=(",", ":"))


def open_json(priv, blob, label):
    """The inverse of seal_json: an envelope sealed to this account's key -> the object (gzipped or plain JSON)."""
    import gzip
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    e = json.loads(blob)
    b = base64.b64decode
    epk = b(e["epk"])
    key = HKDF(hashes.SHA256(), 32, epk, label).derive(priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), epk)))
    plain = AESGCM(key).decrypt(b(e["iv"]), b(e["ct"]), label)
    return json.loads(gzip.decompress(plain) if plain[:2] == b"\x1f\x8b" else plain)


def friend_profiles(http, tok, uid, priv, friends):
    """[(link, profile)] for the friends whose copy for this account (shares/{friend}/to/{uid}) is a percentages profile
    (v2). Older copies (v1, whole documents) are skipped: the friend's site replaces them the next time it opens."""
    out = []
    for f in friends:
        st, j = http.json("GET", f"{FS}/shares/{f['uid']}/to/{uid}", headers={"Authorization": "Bearer " + tok})
        if st != 200:
            continue
        try:
            snap = open_json(priv, (((j or {}).get("fields") or {}).get("pkg") or {}).get("stringValue") or "", SHARE_LABEL)
        except Exception:
            continue
        if isinstance(snap, dict) and snap.get("v") == 2 and isinstance(snap.get("profile"), dict):
            out.append((f, snap["profile"]))
    return out


def prev_month(now):
    first = now.date().replace(day=1)
    return (first - datetime.timedelta(days=1)).strftime("%Y-%m")


def month_label(M):
    return datetime.date(int(M[:4]), int(M[5:7]), 1).strftime("%B %Y")


def month_figures(p, M):
    """A profile's return in month M and its year up to M (compounded), each None when it has no figure."""
    rows = {x.get("m"): x for x in (p or {}).get("months") or [] if x.get("r") is not None}
    m = rows.get(M)
    ytd, any_ = 1.0, False
    for k in sorted(rows):
        if k[:4] == M[:4] and k <= M:
            ytd, any_ = ytd * (1 + rows[k]["r"]), True
    return (m["r"] if m else None), (ytd - 1 if any_ else None)


def fresh_for(p, M):
    """True when a profile covers month M to its last EGX session (the last Sunday-Thursday of the month: Friday and
    Saturday are the weekend), so its month return is the whole month's."""
    last = datetime.date(int(M[:4]), int(M[5:7]), 1) + datetime.timedelta(days=32)
    last = last.replace(day=1) - datetime.timedelta(days=1)
    while last.weekday() in (4, 5):
        last -= datetime.timedelta(days=1)
    return str((p or {}).get("asOf") or "") >= last.isoformat()


def leaderboard(mine, theirs, M):
    """The month-M ranking: (rows ranked by the month's return, the index's month, the month's best sale or None).
    mine: this account's profile; theirs: [(name, profile)]. Percentages only, as everything a friend sees."""
    rows = []
    for who, p, me in [("You", mine, True)] + [(n, p, False) for n, p in theirs]:
        m, ytd = month_figures(p, M) if (me or fresh_for(p, M)) else (None, None)
        rows.append({"who": who, "me": me, "m": m, "ytd": ytd, "p": p})
    rows.sort(key=lambda r: (r["m"] is None, -(r["m"] or 0), not r["me"]))
    bench = next((x.get("b") for x in (mine or {}).get("months") or [] if x.get("m") == M), None)
    if bench is None:
        bench = next((x.get("b") for _, p in theirs for x in (p or {}).get("months") or [] if x.get("m") == M and x.get("b") is not None), None)
    best = None
    for r in rows:
        if r["m"] is None:
            continue
        for t in (r["p"] or {}).get("trades") or []:
            if t.get("side") == "sell" and t.get("ret") is not None and str(t.get("d") or "")[:7] == M and (best is None or t["ret"] > best["ret"]):
                best = {"who": r["who"], "s": t.get("s") or t.get("n") or "a stock", "ret": t["ret"]}
    return [{k: v for k, v in r.items() if k != "p"} for r in rows], bench, best


def confirmed_friend(http, tok, f):
    """A link's name, email and key are written by the other person: seal to that key only when directory/{email} (which
    only the owner of that sign-in email can write) names the same account and the same key. A request sent to an
    @username has no email on the asker's side until it is accepted: then handles/{handle} (which only that account can
    hold) is the check instead (site/lock.js confirmedFriend does the same)."""
    email = str(f.get("email") or "").lower()
    handle = str(f.get("handle") or "").strip().lstrip("@").lower()
    if not f.get("pub") or not (email or handle):
        return False
    path = f"directory/{urllib.parse.quote(email, safe='')}" if email else f"handles/{urllib.parse.quote(handle, safe='')}"
    st, j = http.json("GET", f"{FS}/{path}", headers={"Authorization": "Bearer " + tok})
    if st != 200:
        return False
    d = {k: (v or {}).get("stringValue") for k, v in ((j or {}).get("fields") or {}).items()}
    return d.get("uid") == f["uid"] and d.get("pub") == f["pub"]


def share_to_friends(http, tok, uid, friends, snap, state, now):
    """Writes shares/{uid}/to/{friend} where the copy changed or is 20 hours old, for friends whose link matches their
    account (confirmed_friend). Returns how many were written."""
    import hashlib
    h = hashlib.sha256(json.dumps(snap["profile"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:32]
    done, n = dict(state.get("shares") or {}), 0
    for f in friends:
        o = done.get(f["uid"]) or {}
        if o.get("h") == h and o.get("at") and now - datetime.datetime.fromisoformat(o["at"]) < datetime.timedelta(hours=20):
            continue
        if not confirmed_friend(http, tok, f):
            jc.log("friends: a link does not match its account; no copy written")
            continue
        env = seal_json(snap, f["pub"], SHARE_LABEL)
        st, _ = http.json("PATCH", f"{FS}/shares/{uid}/to/{f['uid']}", {"fields": {"pkg": {"stringValue": env}, "name": {"stringValue": snap["name"]}, "at": {"stringValue": snap["at"]}}},
                          headers={"Authorization": "Bearer " + tok})
        if st != 200:
            raise jc.JobError("friends", f"Firestore answered {st} saving a friend's copy")
        done[f["uid"]] = {"h": h, "at": now.isoformat()}
        n += 1
    state["shares"] = {k: v for k, v in done.items() if k in {f["uid"] for f in friends}}
    return n


def friend_email(name, who, site):
    return emails.friend(name, who)


def signup_email(rows, site):
    return emails.signup(rows)


def write_status_job(http, tok, uid, job):
    """status/{uid}.job for the admin screen; the rest of the status document is the site's."""
    try:
        http.json("PATCH", f"{FS}/status/{uid}?updateMask.fieldPaths=job", {"fields": {"job": {"stringValue": json.dumps(job, separators=(",", ":"))}}},
                  headers={"Authorization": "Bearer " + tok})
    except Exception as e:     # the admin line is a courtesy: never fail an account on it
        jc.log(f"status not written ({type(e).__name__})")


def history_email(name, seed, summary, site):
    return emails.built(name, seed, summary, jc.short)


def history_wait_email(name, reason, site):
    return emails.waiting(name, reason)


def gmail_error_email(name, err, site):
    return emails.gmail_error(name, err)


def run_one(http, pkg, shared, code, now, weekly_due, dry, send, main_docs=None):
    """Returns a short status string for the log (no figures, no address). main_docs: a callable giving the owner's main
    portfolio documents (only used for the verified owner account with prefs.shareMain)."""
    tok, uid = id_token(http, pkg["refresh"])
    if uid and uid != pkg["uid"]:
        raise jc.JobError("sign-in", "the package belongs to another account")
    try:
        return _run_one(http, tok, pkg, shared, code, now, weekly_due, dry, send, main_docs)
    except Exception as e:
        if not dry:
            write_status_job(http, tok, pkg["uid"], {"at": jc.now_iso(), "error": f"{getattr(e, 'step', type(e).__name__)}: {jc.mask(str(getattr(e, 'detail', e)))[:160]}"})
        raise


def _run_one(http, tok, pkg, shared, code, now, weekly_due, dry, send, main_docs):
    priv, keys = account_key(pkg["pk8"])
    docs = read_account(http, tok, pkg["uid"], priv)
    settings = (docs.get("portfolio/settings") or {}).get("data") or {}
    name = settings.get("name") or "Your portfolio"
    state_doc = docs.get("sync/mail")
    state = dict((state_doc or {}).get("data") or {})
    sent = dict(state.get("alertsSent") or {})
    prefs = pkg.get("prefs") or {}
    # the site owner's own account is only a sign-in for the admin screen and friends: the main portfolio already reads
    # the owner's Thndr emails and sends the owner's emails, so this account gets no import and no emails of its own
    owner_acct = hashlib.sha256(str(token_claims(tok).get("email") or "").lower().encode()).hexdigest() == OWNER_HASH
    # the monthly friends leaderboard: its own tick on the site; packages from before it follow the other emails
    lb_on = prefs.get("leaderboard", owner_acct or any(prefs.get(k, True) for k in ("alerts", "weekly", "reports")))
    # the monthly trading report card: the same (the owner's sign-in account has no portfolio of its own: never)
    card_on = not owner_acct and prefs.get("reportCard", any(prefs.get(k, True) for k in ("alerts", "weekly", "reports")))
    # the yearly wrap-up (January) goes with the report card tick; the owner's, from the main portfolio, always
    wrap_on = owner_acct or card_on
    if owner_acct:
        prefs = {"alerts": False, "weekly": False, "reports": False, "gmail": False, "shareMain": prefs.get("shareMain")}
    today = now.strftime("%Y-%m-%d")
    site = SITE
    work = tempfile.mkdtemp(prefix="acct-", dir=os.environ.get("RUNNER_TEMP") or None)
    notes = []
    try:
        data = os.path.join(work, "data")
        materialize(docs, shared, data)
        changed = False

        def save_state():
            cutoff = (now - datetime.timedelta(days=400)).strftime("%Y-%m-%d")
            state["alertsSent"] = {k: v for k, v in sent.items() if not (isinstance(v, str) and v < cutoff)}
            state["at"] = jc.now_iso()
            write_state(http, tok, pkg["uid"], keys, state_doc, state, jc.now_iso())

        # Every email sent below is recorded in `state` right after it goes out; when a later step fails, what was already
        # sent is still saved before the error is raised, so the next run never sends it again.
        try:
            overlay = None
            if prefs.get("gmail"):
                prev = state.get("gmail") or {}
                outgoing = []   # sent after the import, so a mail-server error is not mistaken for a Gmail problem
                try:
                    summary, overlay, data, c = gmail_import(http, tok, pkg, keys, docs, shared, code, work, now, dry,
                                                             lambda: read_account(http, tok, pkg["uid"], priv))
                    em = summary.get("email") or {}
                    imported = summary.get("held") or summary.get("alert") or any(e.get("kind") != "invoice" and e.get("status") == "applied" for e in summary.get("log") or [])
                    if summary.get("_history"):
                        outgoing.append(history_email(name, summary["_history"], summary, site))
                        state["history"] = {"status": "done", "from": summary["_history"]["month"], "at": jc.now_iso()}
                        notes.append("history import done")
                    elif em.get("notify") and (prefs.get("alerts", True) or imported):
                        outgoing.append(emails.sync_email(em["subject"], em["parts"], account=True) if em.get("parts") else (em["subject"], em["text"], None))
                        notes.append("import email sent")
                    for k in (summary.get("digest") or {}).get("emailed") or []:
                        sent[k] = today
                    state["gmail"] = {"ok": True, "at": jc.now_iso(), "found": c.get("found", 0), "new": c.get("kept", 0),
                                      "applied": summary.get("applied", 0), "held": summary.get("held", 0)}
                    notes.append(f"gmail {c.get('kept', 0)} new, {summary.get('applied', 0)} applied, {summary.get('held', 0)} held")
                except HistoryWait as e:
                    reason = str(e.detail)[:200]
                    state["gmail"] = {"ok": True, "at": jc.now_iso(), "found": 0, "new": 0, "applied": 0, "held": 0}
                    if (state.get("history") or {}).get("reason") != reason:
                        subj, body, html = history_wait_email(name, reason, site)
                        if not dry:
                            send(pkg["email"], subj, body, html)
                    state["history"] = {"status": "waiting", "reason": reason, "at": jc.now_iso()}
                    notes.append("history import waiting for a monthly statement")
                    overlay = None
                    data = os.path.join(work, "data")
                except Exception as e:
                    err = jc.mask(str(getattr(e, "detail", e)))[:200]
                    state["gmail"] = {"ok": False, "at": jc.now_iso(), "error": err, "errorSent": prev.get("errorSent")}
                    if prev.get("errorSent") != err:
                        subj, body, html = gmail_error_email(name, err, site)
                        if not dry:
                            send(pkg["email"], subj, body, html)
                        state["gmail"]["errorSent"] = err
                    notes.append(f"gmail not done ({getattr(e, 'step', type(e).__name__)})")
                    overlay = None
                    data = os.path.join(work, "data")
                changed = True
                for subj, body, html in outgoing:
                    if not dry:
                        send(pkg["email"], subj, body, html)
            if prefs.get("alerts", True) and overlay is None:
                r = subprocess.run(["node", os.path.join(code, "src", "jobs", "account_alerts.js"), "--data", data, "--today", today], capture_output=True, text=True, timeout=300)
                out = json.loads((r.stdout or "{}").strip().splitlines()[-1] if r.stdout.strip() else "{}")
                if not out.get("ok"):
                    raise jc.JobError("alerts", out.get("error") or "account_alerts.js failed")
                new = [i for i in out.get("items") or [] if i.get("key") and i["key"] not in sent]
                if new:
                    subj, body, html = alerts_email(name, new, site)
                    if not dry:
                        send(pkg["email"], subj, body, html)
                    for i in new:
                        sent[i["key"]] = today
                    changed = True
                notes.append(f"alerts {len(new)} new of {len(out.get('items') or [])}")
            if prefs.get("weekly", True) and weekly_due and state.get("weeklySent") != today:
                htmlp, txtp, jsp = (os.path.join(work, f) for f in ("weekly.html", "weekly.txt", "weekly.json"))
                r = subprocess.run(["node", os.path.join(code, "src", "tools", "weekly.js"), "--data", data, "--week-ending", today, "--today", today,
                                    "--out", htmlp, "--text", txtp, "--json", jsp] + (["--overlay", overlay] if overlay else []), capture_output=True, text=True, timeout=300)
                if r.returncode == 2:
                    notes.append("weekly skipped (no closes this week)")
                elif r.returncode != 0:
                    raise jc.JobError("weekly", "weekly.js failed")
                else:
                    w = json.load(open(jsp))
                    wk = w.get("week") or {}
                    if not wk.get("valueEnd") and not wk.get("valueStart") and not w.get("trades") and not wk.get("flows"):
                        notes.append("weekly skipped (nothing in the portfolio yet)")    # an all-zero summary says nothing
                    else:
                        if not dry:
                            send(pkg["email"], w["subject"], open(txtp, encoding="utf-8").read(), open(htmlp, encoding="utf-8").read())
                        state["weeklySent"] = today
                        changed = True
                        notes.append("weekly sent")
            cur_docs = read_account(http, tok, pkg["uid"], priv) if (overlay and not dry) else docs    # after an import: what was saved
            if prefs.get("reports", True) and not dry:
                fresh = cur_docs
                months = pending_reports(fresh)
                if months:
                    rdata = os.path.join(work, "rdata")
                    materialize(fresh, shared, rdata)
                    for M in months:
                        subj, text, html, att = month_end(code, rdata, M, name, work)
                        send(pkg["email"], subj, text, html, att)
                        for attempt in range(2):
                            try:
                                commit_writes(http, tok, pkg["uid"], keys, fresh, [{"op": "update", "collection": "imports", "doc_id": M,
                                              "data": {"reports": {"emailedAt": jc.now_iso(), "factsheetSentAt": jc.now_iso()}, "reportsPending": {"__delete__": True}}}], jc.now_iso())
                                break
                            except Conflict:
                                fresh = read_account(http, tok, pkg["uid"], priv)
                        else:
                            raise jc.JobError("month-end", f"{M} was emailed but could not be marked as sent (the portfolio kept changing)")
                        notes.append(f"month-end {M} sent ({len(att)} files)")
                        state["lastReport"] = f"{jc.short(M)} sent {today}"
                        changed = True
                    cur_docs = read_account(http, tok, pkg["uid"], priv)     # with the months marked as sent
            # the monthly trading report card: last month, once, from the 1st to the 10th, as soon as last month's statement
            # is in (imports/<M> fullMonth) or from the 5th
            CM = prev_month(now)
            if card_on and not dry and now.day <= 10 and state.get("reportCardSent") != CM and (
                    now.day >= 5 or (((cur_docs.get(f"imports/{CM}") or {}).get("data") or {}).get("fullMonth"))):
                try:
                    cdata = os.path.join(work, "cdata")
                    materialize(cur_docs, shared, cdata)
                    r = subprocess.run(["node", os.path.join(code, "src", "tools", "report_card.js"), "--data", cdata, "--month", CM, "--today", today],
                                       capture_output=True, text=True, timeout=300)
                    out = json.loads((r.stdout or "{}").strip().splitlines()[-1] if (r.stdout or "").strip() else "{}")
                    if not out.get("ok"):
                        raise jc.JobError("report card", out.get("error") or "report_card.js failed")
                    if emails.card_empty(out["card"]):
                        notes.append("report card skipped (nothing in the month)")
                    else:
                        subj, body, html = emails.report_card(name, out["card"], emails.ACCOUNT_FOOT)
                        send(pkg["email"], subj, body, html)
                        notes.append("report card sent")
                    state["reportCardSent"] = CM
                    changed = True
                except Exception as e:      # the card never stops the rest; the next run tries again (until the 10th)
                    notes.append(f"report card not done ({getattr(e, 'step', type(e).__name__)})")
            friends_n = None
            if not dry:
                try:
                    links = list_links(http, tok, pkg["uid"])
                    fm = {k: v for k, v in (state.get("friendMailed") or {}).items() if any(f["uid"] == k and f.get("status") == "received" for f in links)}
                    for f in links:
                        if f.get("status") == "received" and f["uid"] not in fm:
                            subj, body, html = friend_email(name, f.get("name") or "Someone", site)
                            send(pkg["email"], subj, body, html)
                            fm[f["uid"]] = today
                            notes.append("friend request emailed")
                    if fm != (state.get("friendMailed") or {}):
                        state["friendMailed"] = fm
                        changed = True
                    friends = [f for f in links if f.get("status") == "friends" and f.get("pub")]
                    friends_n = len(friends)
                    own_st = ((cur_docs.get("portfolio/settings") or {}).get("data") or {})
                    if friends and not own_st.get("inception") and not (prefs.get("shareMain") and owner_acct):
                        notes.append("friends: nothing to share yet (no portfolio)")
                        friends = []
                    if friends:
                        cl = token_claims(tok)
                        owner = hashlib.sha256(str(cl.get("email") or "").lower().encode()).hexdigest() == OWNER_HASH
                        main = bool(prefs.get("shareMain") and main_docs and owner and cl.get("email_verified"))
                        handle = own_handle(http, tok, pkg["uid"])
                        if main:
                            md = main_docs()
                            snap = share_profile(md, shared, code, work, ((md.get("portfolio/settings") or {}).get("data") or {}).get("name") or "Main portfolio", handle, "main")
                        else:
                            snap = share_profile(cur_docs, shared, code, work, name, handle, "own")
                        before = json.dumps(state.get("shares") or {}, sort_keys=True)
                        n = share_to_friends(http, tok, pkg["uid"], friends, snap, state, now)
                        if n or json.dumps(state.get("shares") or {}, sort_keys=True) != before:
                            changed = True
                        if n:
                            notes.append(f"{n} friend cop{'y' if n == 1 else 'ies'} refreshed{' (main portfolio)' if main else ''}")
                        # on the 1st of the month (or the first days, until every friend's copy covers the month): how
                        # you and your friends ranked last month, in percentages, to this account's own address
                        M = prev_month(now)
                        if lb_on and now.day <= 10 and state.get("leaderboardSent") != M:
                            theirs = [(f.get("name") or ("@" + f["handle"] if f.get("handle") else "A friend"), p) for f, p in friend_profiles(http, tok, pkg["uid"], priv, friends)]
                            all_fresh = len(theirs) == len(friends) and all(fresh_for(p, M) for _, p in theirs)
                            if all_fresh or now.day > 7:
                                rows, bench, best = leaderboard(snap["profile"], theirs, M)
                                if any(r["m"] is not None for r in rows if not r["me"]):
                                    subj, body, html = emails.leaderboard(name, month_label(M), rows, bench, best, emails.ACCOUNT_FOOT)
                                    send(pkg["email"], subj, body, html)
                                    notes.append("leaderboard sent")
                                else:
                                    notes.append("leaderboard skipped (no friend's figures for the month)")
                                state["leaderboardSent"] = M
                                changed = True
                except Exception as e:      # friends never stop the rest
                    notes.append(f"friends not done ({getattr(e, 'step', type(e).__name__)})")
            # the yearly wrap-up: the 1st to the 10th of January, once, for last year (the owner's from the MAIN portfolio),
            # ranked among friends on the year's return once their copies cover December (or from the 8th)
            WY = now.year - 1
            if wrap_on and not dry and now.month == 1 and now.day <= 10 and state.get("wrappedSent") != WY:
                try:
                    cl = token_claims(tok)
                    use_main = owner_acct and main_docs and cl.get("email_verified")
                    wdocs = main_docs() if use_main else cur_docs
                    wname = ((wdocs.get("portfolio/settings") or {}).get("data") or {}).get("name") or name
                    if not ((wdocs.get("portfolio/settings") or {}).get("data") or {}).get("inception"):
                        state["wrappedSent"] = WY       # no portfolio: nothing to wrap
                        changed = True
                    else:
                        friends = [f for f in list_links(http, tok, pkg["uid"]) if f.get("status") == "friends" and f.get("pub")]
                        theirs = [(f.get("name") or ("@" + f["handle"] if f.get("handle") else "A friend"), p) for f, p in friend_profiles(http, tok, pkg["uid"], priv, friends)] if friends else []
                        DM = f"{WY}-12"
                        if friends and now.day <= 7 and not (len(theirs) == len(friends) and all(fresh_for(p, DM) for _, p in theirs)):
                            notes.append("wrapped waiting for friends' December")
                        else:
                            wd = os.path.join(work, "wdata")
                            materialize({k: (v if isinstance(v, dict) and "data" in v else {"data": v}) for k, v in wdocs.items()}, shared, wd)
                            r = subprocess.run(["node", os.path.join(code, "src", "tools", "wrapped.js"), "--data", wd, "--year", str(WY), "--today", today],
                                               capture_output=True, text=True, timeout=300)
                            out = json.loads((r.stdout or "{}").strip().splitlines()[-1] if (r.stdout or "").strip() else "{}")
                            if not out.get("ok"):
                                raise jc.JobError("wrapped", out.get("error") or "wrapped.js failed")
                            w = out["wrapped"]
                            if w.get("months"):
                                ranking = None
                                if theirs:
                                    ranking = [{"who": "You", "me": True, "y": w.get("ret")}] + [
                                        {"who": n, "y": month_figures(p, DM)[1] if fresh_for(p, DM) else None} for n, p in theirs]
                                    ranking.sort(key=lambda r: (r["y"] is None, -(r["y"] or 0), not r.get("me")))
                                subj, body, html = emails.wrapped(wname, w, ranking, emails.ACCOUNT_FOOT)
                                send(pkg["email"], subj, body, html)
                                notes.append("wrapped sent")
                            state["wrappedSent"] = WY
                            changed = True
                except Exception as e:      # never stops the rest; the next run tries again (until the 10th)
                    notes.append(f"wrapped not done ({getattr(e, 'step', type(e).__name__)})")
            # the owner hears about every new account (the admin list, read with the owner's verified sign-in)
            if owner_acct and not dry:
                try:
                    st, j = http.json("GET", f"{FS}/status?pageSize=300", headers={"Authorization": "Bearer " + tok})
                    if st == 200:
                        rows = {d["name"].rsplit("/", 1)[-1]: {k: v.get("stringValue") for k, v in (d.get("fields") or {}).items()} for d in j.get("documents") or []}
                        known = state.get("knownAccounts")
                        new = [u for u in sorted(rows) if u != pkg["uid"] and known is not None and u not in known]
                        if new:
                            subj, body, html = signup_email([rows[u] for u in new], site)
                            send(pkg["email"], subj, body, html)
                            notes.append(f"{len(new)} new account(s) emailed")
                        if known is None or sorted(known) != sorted(rows):
                            state["knownAccounts"] = sorted(rows)
                            changed = True
                except Exception as e:
                    notes.append(f"new accounts not checked ({type(e).__name__})")
        except Exception:
            if changed and not dry:
                try:
                    save_state()
                except Exception as e2:      # the original error is the one to report
                    jc.log(f"account state not saved after a failure ({type(e2).__name__})")
            raise
        if changed and not dry:
            save_state()
        if not dry:
            g = state.get("gmail") if prefs.get("gmail") else None
            write_status_job(http, tok, pkg["uid"], {"at": jc.now_iso(), "gmail": {k: v for k, v in (g or {}).items() if k != "errorSent"} or None,
                                                     "report": state.get("lastReport"), "friends": friends_n})
        return ", ".join(notes) or "nothing due"
    finally:
        shutil.rmtree(work, ignore_errors=True)


def smtp_sender():
    import mail_send
    sender, pw = mail_send._sender()
    def send(to, subject, text, html, attachments=None):
        mail_send.smtp_send(mail_send.build(sender, to, subject, text, html, attachments), sender, pw, to)
    return send


def main(argv=None, http=None, send=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--engine", required=True)
    ap.add_argument("--code", default=jc.CODE_DEFAULT)
    ap.add_argument("--now")
    ap.add_argument("--weekly", action="store_true", help="send the weekly summary whatever the day")
    ap.add_argument("--no-weekly", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="read and compute, send and save nothing")
    a = ap.parse_args(argv)
    step = "setup"
    try:
        import zoneinfo
        t = datetime.datetime.fromisoformat(a.now.replace("Z", "+00:00")) if a.now else datetime.datetime.now(datetime.timezone.utc)
        now = t.astimezone(zoneinfo.ZoneInfo("Africa/Cairo"))
        weekly_due = not a.no_weekly and (a.weekly or (now.strftime("%a") == "Thu" and now.hour >= 18))
        shared = os.path.join(os.path.abspath(a.engine), "shared")
        if not os.path.exists(os.path.join(shared, "latest.json")):
            raise jc.JobError("setup", "no shared market data yet (shared/latest.json)")
        step = "mail key"
        keys = store.load_keys(os.path.join(a.code, "p", "khaled", "keys.json"))
        key = os.environ.get("SETUP_KEY", "").strip()
        if not key:
            raise jc.JobError("mail key", "SETUP_KEY is not set")
        priv = store.unlock(keys, key)
        http = http or Http()
        step = "list"
        pkgs = list_packages(http)
        send = send or (None if a.dry_run else smtp_sender())
        ok = bad = 0
        main_cache = {}
        def main_docs():
            if "d" not in main_cache:
                main_cache["d"] = store.read_all(os.path.abspath(a.engine), os.path.join(a.code, "p", "khaled", "keys.json"), priv)
            return main_cache["d"]
        for i, p in enumerate(pkgs, 1):
            try:
                pkg = open_mail_pkg(priv, p["pkg"])
                if pkg.get("uid") != p["uid"]:
                    raise jc.JobError("package", "the package names another account")
                jc.log(f"account {i}: " + run_one(http, pkg, shared, a.code, now, weekly_due, a.dry_run, send, main_docs))
                ok += 1
            except Exception as e:      # one account never stops the others
                bad += 1
                jc.log(f"account {i}: not done ({getattr(e, 'step', type(e).__name__)}: {jc.mask(str(getattr(e, 'detail', e)))[:160]})")
        jc.log(f"account emails: {len(pkgs)} opted in, {ok} done, {bad} not done{' (weekly day)' if weekly_due else ''}")
        if pkgs and not ok:
            raise jc.JobError("accounts", f"none of the {bad} opted-in accounts could be handled")
        return 0
    except jc.JobError as e:
        jc.report_failure(None, JOB, e.step, e.detail)
        return 1
    except Exception as e:
        jc.report_failure(None, JOB, step, f"{type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
