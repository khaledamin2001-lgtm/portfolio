#!/usr/bin/env python3
"""Emails, and the Thndr inbox import, for site ACCOUNTS that switched them on (Account → Email updates / Thndr emails on
the site): heads-up alerts after each market close, the weekly summary on Thursday night, and (accounts that connected
their Gmail) new Thndr invoices and statements posted to the portfolio. Nothing is done for an account that has not
opted in.

    python3 run_account_mail.py --engine DIR [--code DIR] [--now ISO] [--weekly | --no-weekly] [--dry-run]

An account that opts in stores Firestore mail/{uid} = {pkg}: an envelope sealed in its browser to the MAIL key (the public
key of p/khaled/keys.json on the site, label 'portfolio-mail-v1'; this job opens it with SETUP_KEY = KHALED_SETUP_KEY)
holding {uid, email, refresh, pk8, prefs: {alerts, weekly, gmail}}. That is the account's own choice to let this job open
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
  4. on Thursday from 21:00 Cairo (or --weekly), runs src/tools/weekly.js and emails the summary, once a week;
  5. saves {alertsSent, weeklySent, gmail} back to the account as users/{uid}/docs/sync__mail, encrypted to the account key.
Emails go from GMAIL_ADDRESS to the address in the package only. One account failing never stops the others; the job
exits 1 (and emails the owner) only when nothing could be done at all. Logs carry counts, never figures or addresses.
"""
import os, sys, json, base64, argparse, datetime, subprocess, tempfile, shutil, urllib.request, urllib.error, urllib.parse

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


def gmail_error_email(name, err, site):
    text = (f"The site could not read the Thndr emails in your Gmail for {name}:\n\n  {err}\n\n"
            "Usually the app password was deleted or changed. To fix it: open the site, tap Account, then Thndr emails, "
            "then Change app password, and follow the steps.\n\n"
            f"Nothing in your portfolio was changed. {site}\n")
    return f"{name}: Thndr emails could not be read", text


def run_one(http, pkg, shared, code, now, weekly_due, dry, send):
    """Returns a short status string for the log (no figures, no address)."""
    tok, uid = id_token(http, pkg["refresh"])
    if uid and uid != pkg["uid"]:
        raise jc.JobError("sign-in", "the package belongs to another account")
    priv, keys = account_key(pkg["pk8"])
    docs = read_account(http, tok, pkg["uid"], priv)
    settings = (docs.get("portfolio/settings") or {}).get("data") or {}
    name = settings.get("name") or "Your portfolio"
    state_doc = docs.get("sync/mail")
    state = dict((state_doc or {}).get("data") or {})
    sent = dict(state.get("alertsSent") or {})
    prefs = pkg.get("prefs") or {}
    today = now.strftime("%Y-%m-%d")
    site = "https://khaledamin2001-lgtm.github.io/portfolio/"
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
        if changed and not dry:
            cutoff = (now - datetime.timedelta(days=400)).strftime("%Y-%m-%d")
            state["alertsSent"] = {k: v for k, v in sent.items() if not (isinstance(v, str) and v < cutoff)}
            state["at"] = jc.now_iso()
            write_state(http, tok, pkg["uid"], keys, state_doc, state, jc.now_iso())
        return ", ".join(notes) or "nothing due"
    finally:
        shutil.rmtree(work, ignore_errors=True)


def smtp_sender():
    import mail_send
    sender, pw = mail_send._sender()
    def send(to, subject, text, html):
        mail_send.smtp_send(mail_send.build(sender, to, subject, text, html), sender, pw, to)
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
        weekly_due = not a.no_weekly and (a.weekly or (now.strftime("%a") == "Thu" and now.hour >= 21))
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
        for i, p in enumerate(pkgs, 1):
            try:
                pkg = open_mail_pkg(priv, p["pkg"])
                if pkg.get("uid") != p["uid"]:
                    raise jc.JobError("package", "the package names another account")
                jc.log(f"account {i}: " + run_one(http, pkg, shared, a.code, now, weekly_due, a.dry_run, send))
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
