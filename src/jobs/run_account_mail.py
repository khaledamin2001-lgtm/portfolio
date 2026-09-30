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
  3. adds the shared market data (engine shared/: latest, history, bench) and runs src/jobs/account_alerts.js (the same
     PA.headsUp checks the page shows); items whose key is not in its alertsSent list are emailed, once;
  4. on Thursday from 18:00 Cairo (or --weekly), runs src/tools/weekly.js and emails the summary, once a week;
  5. month-end report (prefs.reports, default on): every imports/<M> that is a full month posted since 2026-09-28 and
     has no reports.emailedAt gets excel.js + excel.py (workbook) and factsheet.js (HTML + PDF, on the page built from
     src/; Playwright is installed by JOBS_PLAYWRIGHT_SETUP the first time one is due), emailed to the account's address
     with both files attached, then stamped reports.emailedAt (reportsPending removed) in the account;
  6. friends: a new friend request (links/{uid}/with/*, 'received') is emailed once; for every friend ('friends') a
     fresh copy of the portfolio (portfolio, ledger, imports; the Thndr account number and email settings left out) is
     sealed to the friend's key as shares/{uid}/to/{friend} when it changed or is a day old. The site owner's own account
     (its sign-in email hashes to OWNER_HASH, verified, prefs.shareMain) shares the MAIN portfolio instead: the engine's own documents (all but sync),
     opened with the same key as the mail packages;
  7. writes status/{uid}.job {at, gmail, report, friends, error} for the site owner's admin screen (no figures);
  8. saves {alertsSent, weeklySent, gmail, friendMailed, shares, lastReport} back to the account as users/{uid}/docs/sync__mail, encrypted to the account key.
Emails go from GMAIL_ADDRESS to the address in the package only. One account failing never stops the others; the job
exits 1 (and emails the owner) only when nothing could be done at all. Logs carry counts, never figures or addresses.
"""
import os, sys, json, base64, hashlib, argparse, datetime, subprocess, tempfile, shutil, urllib.request, urllib.error, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402
import store  # noqa: E402

JOB = "account emails"
API_KEY = "AIzaSyAYvh69A5VWAgmhKXt07RTgLpB_1hYBjA8"
PROJECT = "portfolio-desk-4d14a"
FS = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"
MAIL_LABEL = b"portfolio-mail-v1"
SHARE_LABEL = b"portfolio-share-v1"
SHARE_COLLS = ("portfolio", "ledger", "imports")
OWNER_HASH = "467022c320757248bf70115c83d305a7e4d139c35e1be5f8117fb30d7f769347"     # SHA-256 of the site owner's sign-in email (the address is not published here)
SITE = "https://khaledamin2001-lgtm.github.io/portfolio/"
ALERT_KINDS = {"exdiv": "Ex-dividend", "target": "Target reached", "stop": "Stop reached", "drawdown": "Drawdown"}


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
    lines = [f"Heads-up for {name}:", ""] + [f"• {ALERT_KINDS.get(i['kind'], 'Note')}: {i['text']}" for i in items]
    lines += ["", f"Open your portfolio: {site}", "", "You get these because you switched on email updates in your account. Switch them off there any time."]
    subj = f"{name}: heads-up — " + (items[0]["text"] if len(items) == 1 else f"{len(items)} new items")
    return subj[:180], "\n".join(lines) + "\n"


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
    after = gmail_after(code, st, settings, now)
    inbox = os.path.join(work, "inbox")
    try:
        c = imap_fetch.fetch(after, set(st.get("seen") or {}), inbox, login["address"], login["appPassword"])
    except imap_fetch.FetchError as e:
        raise jc.JobError("Gmail", str(e)) from None
    today = now.strftime("%Y-%m-%d")
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
        os.makedirs(run)
        r = subprocess.run(["node", os.path.join(code, "src", "tools", "sync.js"), "--data", data, "--inbox", inbox, "--out", run, "--today", today],
                           capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise jc.JobError("sync.js", jc.mask((r.stderr or r.stdout or "failed").strip().splitlines()[-1][:200]))
        with open(os.path.join(run, "summary.json"), encoding="utf-8") as f:
            summary = json.load(f)
        vers = {k: v.get("version", 0) for k, v in docs.items()}
        writes = run_sync.writes_from_plan(os.path.join(run, "write"), vers)
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
    html, pdf_note = None, ""
    try:
        fs = ["node", os.path.join(tools, "factsheet.js"), "--page", report_page(code), "--data", data, "--month", M, "--out", html_p]
        try:
            jc.run(fs + ["--pdf", pdf_p], "month-end: factsheet", timeout=600)
        except jc.JobError:
            jc.run(fs, "month-end: factsheet", timeout=600)
        html = open(html_p, encoding="utf-8").read()
        if os.path.exists(pdf_p):
            att.append((base + ".pdf", open(pdf_p, "rb").read(), "application/pdf"))
        else:
            pdf_note = " (the PDF could not be made this time; the factsheet is in this email)"
    except jc.JobError as e:
        jc.log(f"month-end {M}: factsheet not made ({jc.mask(e.detail)[:120]}); sending the workbook")
        pdf_note = " (the factsheet could not be made this time)"
    what = "Excel workbook and PDF factsheet" if len(att) == 2 else "Excel workbook"
    text = (
        f"Your {S} month-end report is attached: {what}{pdf_note}. Excel sheets: Summary, Monthly, Holdings, Ledger, "
        f"Closed trades, Income, Attribution, Marks & inputs.\n\nYou get this because email updates or Thndr emails are on "
        f"in your account.\n")
    return f"{name} · month-end report {S}", text, html, att


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


def share_snapshot(docs, name, full, at):
    """The copy a friend sees: {v, at, name, full, docs: {"coll/doc": data}} (full = every collection but sync, for the
    owner's main portfolio, which brings its own market data)."""
    out = {}
    for k, v in docs.items():
        c = k.split("/", 1)[0]
        if (full and c != "sync") or (not full and c in SHARE_COLLS):
            out[k] = v.get("data") if isinstance(v, dict) and "data" in v and "version" in v else v
    if isinstance(out.get("portfolio/settings"), dict):
        out["portfolio/settings"] = {k: v for k, v in out["portfolio/settings"].items() if k not in ("account", "factsheetEmail", "recipient")}
    return {"v": 1, "at": at, "name": name, "full": bool(full), "docs": out}


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


def share_to_friends(http, tok, uid, friends, snap, state, now):
    """Writes shares/{uid}/to/{friend} where the copy changed or is 20 hours old. Returns how many were written."""
    import hashlib
    h = hashlib.sha256(json.dumps(snap["docs"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:32]
    done, n = dict(state.get("shares") or {}), 0
    for f in friends:
        o = done.get(f["uid"]) or {}
        if o.get("h") == h and o.get("at") and now - datetime.datetime.fromisoformat(o["at"]) < datetime.timedelta(hours=20):
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
    text = (f"{who} sent you a friend request on the portfolio site.\n\nIf you accept, you both see each other's portfolio "
            f"(read-only: holdings, returns and activity). Either of you can remove it any time.\n\n"
            f"To answer: open {site}?friends and sign in; the request is under Account, then Friends.\n\n"
            f"You get this because email updates are on for {name}.\n")
    return f"{who} wants to be friends on the portfolio site", text


def write_status_job(http, tok, uid, job):
    """status/{uid}.job for the admin screen; the rest of the status document is the site's."""
    try:
        http.json("PATCH", f"{FS}/status/{uid}?updateMask.fieldPaths=job", {"fields": {"job": {"stringValue": json.dumps(job, separators=(",", ":"))}}},
                  headers={"Authorization": "Bearer " + tok})
    except Exception as e:     # the admin line is a courtesy: never fail an account on it
        jc.log(f"status not written ({type(e).__name__})")


def gmail_error_email(name, err, site):
    text = (f"The site could not read the Thndr emails in your Gmail for {name}:\n\n  {err}\n\n"
            "Usually the app password was deleted or changed. To fix it: open the site, tap Account, then Thndr emails, "
            "then Change app password, and follow the steps.\n\n"
            f"Nothing in your portfolio was changed. {site}\n")
    return f"{name}: Thndr emails could not be read", text


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
    if hashlib.sha256(str(token_claims(tok).get("email") or "").lower().encode()).hexdigest() == OWNER_HASH:
        prefs = {"alerts": False, "weekly": False, "reports": False, "gmail": False, "shareMain": prefs.get("shareMain")}
    today = now.strftime("%Y-%m-%d")
    site = SITE
    work = tempfile.mkdtemp(prefix="acct-", dir=os.environ.get("RUNNER_TEMP") or None)
    notes = []
    try:
        data = os.path.join(work, "data")
        materialize(docs, shared, data)
        changed = False
        overlay = None
        if prefs.get("gmail"):
            prev = state.get("gmail") or {}
            try:
                summary, overlay, data, c = gmail_import(http, tok, pkg, keys, docs, shared, code, work, now, dry,
                                                         lambda: read_account(http, tok, pkg["uid"], priv))
                em = summary.get("email") or {}
                imported = summary.get("held") or summary.get("alert") or any(e.get("kind") != "invoice" and e.get("status") == "applied" for e in summary.get("log") or [])
                if em.get("notify") and (prefs.get("alerts", True) or imported):
                    if not dry:
                        send(pkg["email"], em["subject"], em["text"], None)
                    notes.append("import email sent")
                for k in (summary.get("digest") or {}).get("emailed") or []:
                    sent[k] = today
                state["gmail"] = {"ok": True, "at": jc.now_iso(), "found": c.get("found", 0), "new": c.get("kept", 0),
                                  "applied": summary.get("applied", 0), "held": summary.get("held", 0)}
                notes.append(f"gmail {c.get('kept', 0)} new, {summary.get('applied', 0)} applied, {summary.get('held', 0)} held")
            except Exception as e:
                err = jc.mask(str(getattr(e, "detail", e)))[:200]
                state["gmail"] = {"ok": False, "at": jc.now_iso(), "error": err, "errorSent": prev.get("errorSent")}
                if prev.get("errorSent") != err:
                    subj, body = gmail_error_email(name, err, site)
                    if not dry:
                        send(pkg["email"], subj, body, None)
                    state["gmail"]["errorSent"] = err
                notes.append(f"gmail not done ({getattr(e, 'step', type(e).__name__)})")
                overlay = None
                data = os.path.join(work, "data")
            changed = True
        if prefs.get("alerts", True) and overlay is None:
            r = subprocess.run(["node", os.path.join(code, "src", "jobs", "account_alerts.js"), "--data", data, "--today", today], capture_output=True, text=True, timeout=300)
            out = json.loads((r.stdout or "{}").strip().splitlines()[-1] if r.stdout.strip() else "{}")
            if not out.get("ok"):
                raise jc.JobError("alerts", out.get("error") or "account_alerts.js failed")
            new = [i for i in out.get("items") or [] if i.get("key") and i["key"] not in sent]
            if new:
                subj, body = alerts_email(name, new, site)
                if not dry:
                    send(pkg["email"], subj, body, None)
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
        friends_n = None
        if not dry:
            try:
                links = list_links(http, tok, pkg["uid"])
                fm = {k: v for k, v in (state.get("friendMailed") or {}).items() if any(f["uid"] == k and f.get("status") == "received" for f in links)}
                for f in links:
                    if f.get("status") == "received" and f["uid"] not in fm:
                        subj, body = friend_email(name, f.get("name") or "Someone", site)
                        send(pkg["email"], subj, body, None)
                        fm[f["uid"]] = today
                        notes.append("friend request emailed")
                if fm != (state.get("friendMailed") or {}):
                    state["friendMailed"] = fm
                    changed = True
                friends = [f for f in links if f.get("status") == "friends" and f.get("pub")]
                friends_n = len(friends)
                if friends:
                    cl = token_claims(tok)
                    owner = hashlib.sha256(str(cl.get("email") or "").lower().encode()).hexdigest() == OWNER_HASH
                    if prefs.get("shareMain") and main_docs and owner and cl.get("email_verified"):
                        md = main_docs()
                        snap = share_snapshot(md, ((md.get("portfolio/settings") or {}).get("data") or {}).get("name") or "Main portfolio", True, jc.now_iso())
                    else:
                        snap = share_snapshot(cur_docs, name, False, jc.now_iso())
                    before = json.dumps(state.get("shares") or {}, sort_keys=True)
                    n = share_to_friends(http, tok, pkg["uid"], friends, snap, state, now)
                    if n or json.dumps(state.get("shares") or {}, sort_keys=True) != before:
                        changed = True
                    if n:
                        notes.append(f"{n} friend cop{'y' if n == 1 else 'ies'} refreshed{' (main portfolio)' if snap['full'] else ''}")
            except Exception as e:      # friends never stop the rest
                notes.append(f"friends not done ({getattr(e, 'step', type(e).__name__)})")
        if changed and not dry:
            cutoff = (now - datetime.timedelta(days=400)).strftime("%Y-%m-%d")
            state["alertsSent"] = {k: v for k, v in sent.items() if not (isinstance(v, str) and v < cutoff)}
            state["at"] = jc.now_iso()
            write_state(http, tok, pkg["uid"], keys, state_doc, state, jc.now_iso())
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
