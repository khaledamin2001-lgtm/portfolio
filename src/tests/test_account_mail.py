#!/usr/bin/env python3
"""The account email job (src/jobs/run_account_mail.py) end to end with a fake Firebase and a fake mailer, on synthetic
data and throwaway keys: an opted-in account's package opens with the mail key, its documents are read with its own
token and opened with its own key, new heads-up items and the Thursday summary are emailed once each, the record of what
was sent is saved back encrypted, a second run sends nothing, and an account that did not opt in is never touched.
A second account connected its Gmail: a synthetic Thndr monthly statement (src/tests/fixtures/make_statement_pdf.py) is
"fetched" by a fake imap_fetch, sync.js posts it from the day after the account's tracking start (the opening rows typed
at sign-up are kept, the earlier statement rows are not added twice), everything is saved in one pinned Firestore commit
encrypted to that account's key, the summary email goes to its own address, a second run does nothing new, and a wrong
app password is emailed once and recorded without touching the portfolio.
    python3 src/tests/test_account_mail.py <synthetic export dir> <tools dir with node_modules/pdfjs-dist>   (exit 0 = all pass)"""
import os, sys, json, base64, shutil, tempfile, subprocess
from email.message import EmailMessage
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "jobs"))
import store, imap_fetch, run_account_mail as ram   # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

fails = 0
def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + (f" · {detail}" if detail and not ok else ""))
    fails += 0 if ok else 1

SYN, PDFJS_TOOLS = sys.argv[1], sys.argv[2]
tmp = tempfile.mkdtemp()
try:
    # the mail key = a throwaway stand-in for p/khaled/keys.json, opened with its setup key like the job does
    code = os.path.join(tmp, "code"); os.makedirs(os.path.join(code, "p", "khaled"))
    shutil.copytree(os.path.join(ROOT), os.path.join(code, "src"), ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(os.path.join(PDFJS_TOOLS, "node_modules"), os.path.join(code, "src", "tools", "node_modules"), symlinks=True)
    sec = os.path.join(tmp, "sec")
    subprocess.run([sys.executable, os.path.join(ROOT, "site", "make_keys.py"), os.path.join(code, "p", "khaled", "keys.json"), sec], check=True, capture_output=True)
    os.environ["SETUP_KEY"] = open(os.path.join(sec, "setup_key.txt")).read().strip()
    mail_pub = store.load_keys(os.path.join(code, "p", "khaled", "keys.json"))["pub"]
    # an account: its own key pair, its documents from the synthetic export sealed to it (as the browser stores them)
    acct = ec.generate_private_key(ec.SECP256R1())
    pk8 = base64.b64encode(acct.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())).decode()
    apub = base64.b64encode(acct.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)).decode()
    UID, OTHER = "Uacct1", "Uother"
    DB, t = {}, [0]
    def stamp():
        t[0] += 1; return f"2026-09-24T19:00:{t[0]:02d}.000000Z"
    for c in ("portfolio", "ledger"):
        for f in os.listdir(os.path.join(SYN, c)):
            x = json.load(open(os.path.join(SYN, c, f))); data = x.get("data", x) if isinstance(x, dict) and isinstance(x.get("data"), dict) else x
            DB[f"users/{UID}/docs/{c}__{f[:-5]}"] = {"blob": store.encode_doc({"pub": apub}, f[:-5], 1, data, "2026-09-20T00:00:00Z").decode().strip(), "updateTime": stamp()}
    DB[f"users/{OTHER}/docs/portfolio__settings"] = {"blob": "x", "updateTime": stamp()}
    # the package, sealed with the mail label to the mail key (what the site's Email updates switch writes)
    def seal_mail(obj):
        site = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), base64.b64decode(mail_pub))
        eph = ec.generate_private_key(ec.SECP256R1())
        epk = eph.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        key = HKDF(hashes.SHA256(), 32, epk, b"portfolio-mail-v1").derive(eph.exchange(ec.ECDH(), site))
        iv = os.urandom(12)
        b = lambda x: base64.b64encode(x).decode()
        return json.dumps({"v": 1, "epk": b(epk), "iv": b(iv), "ct": b(AESGCM(key).encrypt(iv, json.dumps(obj).encode(), b"portfolio-mail-v1"))})
    DB[f"mail/{UID}"] = {"pkg": seal_mail({"uid": UID, "email": "friend@example.com", "refresh": "RT1", "pk8": pk8, "prefs": {"alerts": True, "weekly": True}})}
    # the engine's shared market data from the synthetic export
    eng = os.path.join(tmp, "engine"); sh = os.path.join(eng, "shared", "history"); os.makedirs(sh)
    unwrap = lambda p: (lambda x: x.get("data", x) if isinstance(x, dict) and isinstance(x.get("data"), dict) else x)(json.load(open(p)))
    json.dump(unwrap(os.path.join(SYN, "market", "latest.json")), open(os.path.join(eng, "shared", "latest.json"), "w"))
    json.dump(unwrap(os.path.join(SYN, "bench", "egx30.json")), open(os.path.join(eng, "shared", "bench.json"), "w"))
    for f in os.listdir(os.path.join(SYN, "history")):
        json.dump(unwrap(os.path.join(SYN, "history", f)), open(os.path.join(sh, f), "w"))
    # a second account that connected its Gmail: it signed up on 2026-08-15 holding 10 COMI and 9,145 cash (opening rows),
    # so August's statement (a deposit on the 1st, the COMI buy on the 2nd) is used from the 16th only
    gacct = ec.generate_private_key(ec.SECP256R1())
    gpk8 = base64.b64encode(gacct.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())).decode()
    gpub = base64.b64encode(gacct.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)).decode()
    GUID = "Ugmail1"
    syn_settings = json.load(open(os.path.join(SYN, "portfolio", "settings.json")))
    syn_settings = syn_settings.get("data", syn_settings) if isinstance(syn_settings.get("data"), dict) else syn_settings
    gdocs = {
        "portfolio/settings": {**syn_settings, "name": "Friend Portfolio", "portfolioId": "acct-x", "inception": "2026-08", "trackFrom": "2026-08-15",
                               "cash": 9145, "cashDate": "2026-08-15", "account": {"holder": "Test Friend", "unifiedCode": ""}, "factsheetEmail": ""},   # private-scan: synthetic
        "portfolio/assets": {"items": {"Commercial International Bank": {"name": "Commercial International Bank", "symbol": "COMI", "sector": "Banks"}}},
        "portfolio/marks": {"months": {}},
        "ledger/y2026": {"rows": [
            {"id": "o1", "d": "2026-08-15", "t": "Deposit", "amt": 10000, "acc": "Main", "src": "manual", "opening": True},
            {"id": "o2", "d": "2026-08-15", "t": "Buy", "a": "Commercial International Bank", "q": 10, "p": 85.5, "amt": -855, "acc": "Main", "src": "manual", "opening": True}]},
        "sync/gmail": {"address": "friend.gmail@example.com", "appPassword": "abcdefghijklmnop"},
    }
    for k, v in gdocs.items():
        DB[f"users/{GUID}/docs/{k.replace('/', '__')}"] = {"blob": store.encode_doc({"pub": gpub}, k.split("/")[1], 1, v, "2026-08-15T10:00:00Z").decode().strip(), "updateTime": stamp()}
    DB[f"mail/{GUID}"] = {"pkg": seal_mail({"uid": GUID, "email": "friend2@example.com", "refresh": "RT2", "pk8": gpk8, "prefs": {"alerts": True, "weekly": False, "gmail": True}})}
    # the Thndr email: the synthetic statement PDFs in a DKIM-passed message from Thndr, as Gmail stores it
    pdfs = os.path.join(tmp, "pdfs")
    subprocess.run([sys.executable, os.path.join(ROOT, "tests", "fixtures", "make_statement_pdf.py"), pdfs, "--month", "2026-08"], check=True, capture_output=True)
    msg = EmailMessage()
    msg["Authentication-Results"] = "mx.google.com; dkim=pass header.i=@thndr.app header.s=s1 header.b=x; spf=pass smtp.mailfrom=system.thndr.app"
    msg["From"] = "Thndr <no-reply@system.thndr.app>"
    msg["To"] = "friend.gmail@example.com"
    msg["Subject"] = "Your monthly E-statement"
    msg.set_content("Your monthly statement is attached.")
    for f in ("account-statement.pdf", "position-snapshot.pdf"):
        msg.add_attachment(open(os.path.join(pdfs, f), "rb").read(), maintype="application", subtype="pdf", filename=f)
    RAW = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    fetches = []
    def fake_fetch(after, seen, out_dir, addr=None, pw=None):
        fetches.append({"after": after, "addr": addr, "pw": pw})
        if pw != "abcdefghijklmnop":
            raise imap_fetch.FetchError("Gmail refused the app password (IMAP login)")
        os.makedirs(out_dir, exist_ok=True)
        man = [] if "18a0b0c0d0e0f001" in seen else [{"id": "18a0b0c0d0e0f001", "subject": "Your monthly E-statement", "date": "1788400000000"}]   # private-scan: synthetic
        if man:
            json.dump({"id": man[0]["id"], "raw": RAW, "internalDate": man[0]["date"]}, open(os.path.join(out_dir, man[0]["id"] + ".json"), "w"))
        json.dump(man, open(os.path.join(out_dir, "manifest.json"), "w"))
        return {"found": len(man), "kept": len(man), "seen": 0 if man else 1, "otherSubject": 0}
    imap_fetch.fetch = fake_fetch
    commits = []
    def gdoc(k):
        rec = DB.get(f"users/{GUID}/docs/{k.replace('/', '__')}")
        return json.loads(store.unseal(gacct, rec["blob"]).decode())["data"] if rec else None
    FS = ram.FS
    calls = []
    class FakeHttp:
        def json(self, method, url, body=None, headers=None, form=False):
            calls.append((method, url.split("?")[0].replace(FS, "")))
            tok = (headers or {}).get("Authorization", "").replace("Bearer ", "")
            if url.startswith("https://securetoken"):
                u = {"RT1": UID, "RT2": GUID}.get(body.get("refresh_token"))
                return (200, {"id_token": "ID-" + u, "user_id": u}) if u else (400, {"error": {"message": "INVALID_REFRESH_TOKEN"}})
            if url.startswith(FS + ":commit"):
                commits.append(len(body["writes"]))
                for w in body["writes"]:
                    k = w["update"]["name"].split("/documents/", 1)[1]
                    if tok != "ID-" + k.split("/")[1]: return 403, {"error": {"status": "PERMISSION_DENIED"}}
                    cur, pre = DB.get(k), w["currentDocument"]
                    if ("exists" in pre and bool(cur) != pre["exists"]) or ("updateTime" in pre and (not cur or cur["updateTime"] != pre["updateTime"])):
                        return 400, {"error": {"status": "FAILED_PRECONDITION"}}
                for w in body["writes"]:
                    DB[w["update"]["name"].split("/documents/", 1)[1]] = {"blob": w["update"]["fields"]["blob"]["stringValue"], "updateTime": stamp()}
                return 200, {"writeResults": []}
            path = url.split("?")[0].replace(FS + "/", "")
            if path == "mail":
                return 200, {"documents": [{"name": f"projects/p/databases/(default)/documents/mail/{k.split('/')[1]}", "fields": {"pkg": {"stringValue": v["pkg"]}}} for k, v in DB.items() if k.startswith("mail/")]}
            if path.startswith("users/"):
                uid = path.split("/")[1]
                if tok != "ID-" + uid: return 403, {"error": {"status": "PERMISSION_DENIED"}}
                if method == "GET":
                    return 200, {"documents": [{"name": "x/" + k, "fields": {"blob": {"stringValue": v["blob"]}}, "updateTime": v["updateTime"]} for k, v in sorted(DB.items()) if k.startswith(path + "/")]}
                if method == "PATCH":
                    q = url.split("?", 1)[1]
                    cur = DB.get(path)
                    if ("exists=false" in q and cur) or ("updateTime=" in q and (not cur or cur["updateTime"] not in q.replace("%3A", ":"))):
                        return 400, {"error": {"status": "FAILED_PRECONDITION"}}
                    DB[path] = {"blob": body["fields"]["blob"]["stringValue"], "updateTime": stamp()}
                    return 200, {"updateTime": DB[path]["updateTime"]}
            return 404, {}
    sent = []
    send = lambda to, subj, text, html: sent.append({"to": to, "subject": subj, "text": text, "html": bool(html)})
    argv = ["--engine", eng, "--code", code, "--now", "2026-09-24T19:30:00Z"]     # Thursday 22:30 Cairo
    rc = ram.main(argv, http=FakeHttp(), send=send)
    check("the job succeeds", rc == 0)
    gsent = [m for m in sent if m["to"] == "friend2@example.com"]
    sent[:] = [m for m in sent if m["to"] != "friend2@example.com"]
    check("two emails to the opted-in account's address only: new heads-up items, then the weekly summary",
          [m["to"] for m in sent] == ["friend@example.com", "friend@example.com"] and "heads-up" in sent[0]["subject"] and sent[1]["html"], json.dumps([m["subject"] for m in sent]))
    # the Gmail account
    check("gmail: its own Gmail login is used, searching from the day tracking started", fetches and fetches[0] == {"after": "2026/08/15", "addr": "friend.gmail@example.com", "pw": "abcdefghijklmnop"}, json.dumps(fetches))
    rows = (gdoc("ledger/y2026") or {}).get("rows") or []
    check("gmail: the opening rows are kept and the statement rows before the tracking start are not added again",
          sorted(r["id"] for r in rows) == ["o1", "o2"], json.dumps(rows)[:400])
    mk = ((gdoc("portfolio/marks") or {}).get("months") or {}).get("2026-08") or {}
    check("gmail: August is posted from the statement (month-end cash and securities, final)", mk.get("source") == "statement" and not mk.get("provisional") and abs(mk.get("cash", 0) - 9145) < 0.01 and abs(mk.get("securities", 0) - 860) < 0.01, json.dumps(mk))
    check("gmail: the Thndr account code is recorded from the statement", ((gdoc("portfolio/settings") or {}).get("account") or {}).get("unifiedCode") == "1234567")   # private-scan: synthetic
    check("gmail: the import and sync state are saved in ONE commit", len(commits) == 1 and (gdoc("imports/2026-08") or {}).get("fullMonth") and "18a0b0c0d0e0f001" in ((gdoc("sync/state") or {}).get("seen") or {}), json.dumps(commits))
    check("gmail: the summary email goes to the account's own address", len(gsent) == 1 and "Aug-26 statement posted" in gsent[0]["subject"], json.dumps([m["subject"] for m in gsent]))
    gm = (gdoc("sync/mail") or {}).get("gmail") or {}
    check("gmail: the result is recorded for the site (ok, 1 new, 1 applied)", gm.get("ok") and gm.get("new") == 1 and gm.get("applied") == 1, json.dumps(gm))
    check("the heads-up email lists the synthetic ex-dividend and target items", "Ex-dividend" in sent[0]["text"] and "Target reached" in sent[0]["text"])
    rec = DB.get(f"users/{UID}/docs/sync__mail")
    st = json.loads(store.unseal(acct, rec["blob"]).decode())["data"] if rec else {}
    check("what was sent is saved back to the account, encrypted to its key", len(st.get("alertsSent", {})) == 2 and st.get("weeklySent") == "2026-09-24")
    check("the account that did not opt in is never read", not any(u.startswith(f"/users/{OTHER}") for _, u in calls))
    sent.clear(); commits.clear()
    rc2 = ram.main(argv, http=FakeHttp(), send=send)
    check("a second run sends nothing (each alert once, one summary a week)", rc2 == 0 and sent == [], json.dumps([m["subject"] for m in sent]))
    check("gmail: a second run finds nothing new and changes no portfolio document", commits == [1] and sorted(r["id"] for r in (gdoc("ledger/y2026") or {}).get("rows") or []) == ["o1", "o2"], json.dumps(commits))
    # a wrong app password: emailed once, recorded, the portfolio untouched
    before = {k: v["updateTime"] for k, v in DB.items() if k.startswith(f"users/{GUID}/docs/") and not k.endswith("sync__mail")}
    login = DB[f"users/{GUID}/docs/sync__gmail"]
    DB[f"users/{GUID}/docs/sync__gmail"] = {"blob": store.encode_doc({"pub": gpub}, "gmail", 2, {"address": "friend.gmail@example.com", "appPassword": "wrongwrongwrongw"}, "2026-09-24T00:00:00Z").decode().strip(), "updateTime": stamp()}
    before[f"users/{GUID}/docs/sync__gmail"] = DB[f"users/{GUID}/docs/sync__gmail"]["updateTime"]
    for _ in range(2):
        sent.clear(); ram.main(argv, http=FakeHttp(), send=send)
        if _ == 0:
            first_err = [m["subject"] for m in sent if m["to"] == "friend2@example.com"]
    gm = (gdoc("sync/mail") or {}).get("gmail") or {}
    check("gmail: a refused app password is emailed once and recorded for the site",
          first_err == ["Friend Portfolio: Thndr emails could not be read"] and not [m for m in sent if m["to"] == "friend2@example.com"] and gm.get("ok") is False and "refused" in gm.get("error", ""), json.dumps([first_err, gm]))
    check("gmail: nothing in the portfolio changed", before == {k: v["updateTime"] for k, v in DB.items() if k.startswith(f"users/{GUID}/docs/") and not k.endswith("sync__mail")})
    DB[f"users/{GUID}/docs/sync__gmail"] = login
    DB[f"mail/{UID}"]["pkg"] = seal_mail({"uid": "Usomeoneelse", "email": "x@example.com", "refresh": "RT1", "pk8": pk8})
    sent.clear()
    ram.main(argv, http=FakeHttp(), send=send)
    check("a package naming another account is refused", sent == [])
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print("ALL PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
