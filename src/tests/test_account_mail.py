#!/usr/bin/env python3
"""The account email job (src/jobs/run_account_mail.py) end to end with a fake Firebase and a fake mailer, on synthetic
data and throwaway keys: an opted-in account's package opens with the mail key, its documents are read with its own
token and opened with its own key, new heads-up items and the Thursday summary are emailed once each, the record of what
was sent is saved back encrypted, a second run sends nothing, and an account that did not opt in is never touched.
    python3 src/tests/test_account_mail.py <synthetic export dir>      (exit 0 = all pass)"""
import os, sys, json, base64, shutil, tempfile, subprocess
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "jobs"))
import store, run_account_mail as ram   # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

fails = 0
def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + (f" · {detail}" if detail and not ok else ""))
    fails += 0 if ok else 1

SYN = sys.argv[1]
tmp = tempfile.mkdtemp()
try:
    # the mail key = a throwaway stand-in for p/khaled/keys.json, opened with its setup key like the job does
    code = os.path.join(tmp, "code"); os.makedirs(os.path.join(code, "p", "khaled"))
    for d in ("src",):
        shutil.copytree(os.path.join(ROOT), os.path.join(code, "src"))
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
    FS = ram.FS
    calls = []
    class FakeHttp:
        def json(self, method, url, body=None, headers=None, form=False):
            calls.append((method, url.split("?")[0].replace(FS, "")))
            tok = (headers or {}).get("Authorization", "").replace("Bearer ", "")
            if url.startswith("https://securetoken"):
                return (200, {"id_token": "ID-" + UID, "user_id": UID}) if body.get("refresh_token") == "RT1" else (400, {"error": {"message": "INVALID_REFRESH_TOKEN"}})
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
    check("two emails to the opted-in account's address only: new heads-up items, then the weekly summary",
          [m["to"] for m in sent] == ["friend@example.com", "friend@example.com"] and "heads-up" in sent[0]["subject"] and sent[1]["html"], json.dumps([m["subject"] for m in sent]))
    check("the heads-up email lists the synthetic ex-dividend and target items", "Ex-dividend" in sent[0]["text"] and "Target reached" in sent[0]["text"])
    rec = DB.get(f"users/{UID}/docs/sync__mail")
    st = json.loads(store.unseal(acct, rec["blob"]).decode())["data"] if rec else {}
    check("what was sent is saved back to the account, encrypted to its key", len(st.get("alertsSent", {})) == 2 and st.get("weeklySent") == "2026-09-24")
    check("the account that did not opt in is never read", not any(u.startswith(f"/users/{OTHER}") for _, u in calls))
    sent.clear()
    rc2 = ram.main(argv, http=FakeHttp(), send=send)
    check("a second run sends nothing (each alert once, one summary a week)", rc2 == 0 and sent == [], json.dumps([m["subject"] for m in sent]))
    DB[f"mail/{UID}"]["pkg"] = seal_mail({"uid": "Usomeoneelse", "email": "x@example.com", "refresh": "RT1", "pk8": pk8})
    sent.clear()
    ram.main(argv, http=FakeHttp(), send=send)
    check("a package naming another account is refused", sent == [])
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print("ALL PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
